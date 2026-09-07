/**
 * 参考情報（SPEC §7.5 の sources 側）。ユーザー単位のプールで、
 * オートパイロットのネタ源にもなる（design-v0.2 §3-4）。
 *
 * - `url` 型はサーバーで本文を抽出する（§10.4）。失敗は `EXTRACT_FAILED`
 * - `youtube` 型は URL を正規化してタイトルだけ取る。本文は取らない
 * - `file` / `text` 型は `content` をそのまま受ける（ファイルはブラウザで読む）
 * - `content` は 50,000 文字で切る
 */
import { Hono } from "hono";
import { ok } from "@tap/shared";
import type { SourceSummary, SourceType } from "@tap/shared";
import { z } from "zod";
import { fail, type AppEnv } from "../app";
import {
  ExtractError,
  MAX_CONTENT_CHARS,
  extractUrlSource,
  extractYoutubeSource,
} from "../lib/extract";

const TYPES = ["text", "youtube", "file", "url"] as const;

const createSchema = z.object({
  type: z.enum(TYPES),
  title: z.string().trim().max(200).optional(),
  url: z.string().trim().max(2000).optional(),
  content: z.string().max(4_000_000).optional(),
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(4_000_000).optional(),
  enabledForAp: z.boolean().optional(),
});

export type SourceRow = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  url: string | null;
  content: string;
  char_count: number;
  enabled_for_ap: number;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
};

export const SOURCE_SELECT =
  "id, user_id, type, title, url, content, char_count, enabled_for_ap, last_used_at, use_count, created_at";

export function toSourceSummary(row: SourceRow): SourceSummary {
  return {
    id: row.id,
    type: row.type as SourceType,
    title: row.title,
    url: row.url,
    charCount: row.char_count,
    contentPreview: row.content.slice(0, 160),
    enabledForAp: Boolean(row.enabled_for_ap),
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    createdAt: row.created_at,
  };
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function sourceRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    const rows = await c.get("db").all<SourceRow>(
      `SELECT id,user_id,type,title,url,substr(content,1,160) AS content,char_count,enabled_for_ap,last_used_at,use_count,created_at FROM sources WHERE user_id=? ORDER BY created_at DESC LIMIT 200`,
      c.get("userId")!,
    );
    return c.json(ok({ sources: rows.map(toSourceSummary) }));
  });

  r.post("/", async (c) => {
    const parsed = createSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const input = parsed.data;

    let title = input.title ?? "";
    let url: string | null = input.url ?? null;
    let content = input.content ?? "";

    try {
      if (input.type === "url") {
        if (!input.url) return fail("BAD_REQUEST", "記事のURLを入力してください", 400);
        const got = await extractUrlSource(input.url);
        url = got.url;
        content = got.content;
        if (title === "") title = got.title;
      } else if (input.type === "youtube") {
        if (!input.url) return fail("BAD_REQUEST", "YouTube のURLを入力してください", 400);
        const got = await extractYoutubeSource(input.url);
        url = got.url;
        if (title === "") title = got.title;
      }
    } catch (e) {
      if (e instanceof ExtractError) return fail("EXTRACT_FAILED", e.message, 422);
      throw e;
    }

    if (input.type === "text" || input.type === "file") {
      if (content.trim() === "") return fail("BAD_REQUEST", "本文が空です", 400);
    }

    content = content.slice(0, MAX_CONTENT_CHARS);
    if (title === "") title = content.slice(0, 30) || "無題";

    const id = crypto.randomUUID();
    const inserted = await c.get("db").run(
      `INSERT INTO sources (id, user_id, type, title, url, content, char_count, enabled_for_ap, last_used_at, use_count, created_at)
         SELECT ?,?,?,?,?,?,?,1,NULL,0,? WHERE (SELECT COUNT(*) FROM sources WHERE user_id=?) < 200`,
      id,
      c.get("userId")!,
      input.type,
      title,
      url,
      content,
      content.length,
      new Date().toISOString(),
      c.get("userId")!,
    );
    if (inserted.changes === 0) return fail("LIMIT_REACHED", "参考情報は200件までです。不要な情報を削除してください", 409);
    const row = (await c.get("db").first<SourceRow>(
      `SELECT ${SOURCE_SELECT} FROM sources WHERE id=? AND user_id=?`,
      id,
      c.get("userId")!,
    ))!;
    return c.json(ok({ source: toSourceSummary(row) }), 201);
  });

  r.patch("/:sid", async (c) => {
    const parsed = patchSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const row = await db.first<SourceRow>(
      `SELECT ${SOURCE_SELECT} FROM sources WHERE id=? AND user_id=?`,
      c.req.param("sid"),
      c.get("userId")!,
    );
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const { title, enabledForAp } = parsed.data;
    const content =
      parsed.data.content === undefined ? row.content : parsed.data.content.slice(0, MAX_CONTENT_CHARS);
    await db.run(
      "UPDATE sources SET title=COALESCE(?,title), content=?, char_count=?, enabled_for_ap=COALESCE(?,enabled_for_ap) WHERE id=? AND user_id=?",
      title ?? null,
      content,
      content.length,
      enabledForAp === undefined ? null : enabledForAp ? 1 : 0,
      row.id,
      c.get("userId")!,
    );
    const next = (await db.first<SourceRow>(
      `SELECT ${SOURCE_SELECT} FROM sources WHERE id=? AND user_id=?`,
      row.id,
      c.get("userId")!,
    ))!;
    return c.json(ok({ source: toSourceSummary(next) }));
  });

  r.delete("/:sid", async (c) => {
    const res = await c.get("db").run(
      "DELETE FROM sources WHERE id=? AND user_id=?",
      c.req.param("sid"),
      c.get("userId")!,
    );
    if (res.changes === 0) return fail("NOT_FOUND", "見つかりませんでした", 404);
    return c.json(ok({ deleted: true }));
  });

  return r;
}
