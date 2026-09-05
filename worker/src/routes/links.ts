/**
 * リンク（SPEC §7.5 の links 側）。sources は M5。
 * 同期で見つかったURLは `full_sync` が `normalizeUrl()` を通して `label=url` で自動追加する。
 */
import { Hono } from "hono";
import { normalizeUrl, ok } from "@tap/shared";
import type { LinkSummary } from "@tap/shared";
import { z } from "zod";
import { fail, type AppEnv } from "../app";
import { loadOwnedAccount } from "../lib/accounts";

const KINDS = ["line", "affiliate", "other"] as const;

const createSchema = z.object({
  url: z.string().trim().url().max(2000),
  label: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(KINDS).optional(),
});

const patchSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(KINDS).optional(),
  enabledForAp: z.boolean().optional(),
});

type LinkRow = {
  id: string;
  url: string;
  label: string;
  kind: string;
  enabled_for_ap: number;
  last_used_at: string | null;
  created_at: string;
};

function toSummary(row: LinkRow): LinkSummary {
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    kind: (row.kind as LinkSummary["kind"]) ?? "other",
    enabledForAp: Boolean(row.enabled_for_ap),
    lastUsedAt: row.last_used_at,
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

export function linkRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/:id/links", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const rows = await db.all<LinkRow>(
      "SELECT id, url, label, kind, enabled_for_ap, last_used_at, created_at FROM links WHERE account_id=? ORDER BY created_at ASC",
      account.id,
    );
    return c.json(ok({ links: rows.map(toSummary) }));
  });

  r.post("/:id/links", async (c) => {
    const parsed = createSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail("BAD_REQUEST", "URLの形式が正しくありません", 400);
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const url = normalizeUrl(parsed.data.url);
    if (url === "") return fail("BAD_REQUEST", "URLの形式が正しくありません", 400);
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO links (id, account_id, url, label, kind, enabled_for_ap, last_used_at, created_at)
         VALUES (?,?,?,?,?,1,NULL,?)
         ON CONFLICT(account_id, url) DO UPDATE SET label=excluded.label, kind=excluded.kind`,
      id,
      account.id,
      url,
      parsed.data.label ?? url,
      parsed.data.kind ?? "other",
      new Date().toISOString(),
    );
    const row = (await db.first<LinkRow>(
      "SELECT id, url, label, kind, enabled_for_ap, last_used_at, created_at FROM links WHERE account_id=? AND url=?",
      account.id,
      url,
    ))!;
    return c.json(ok({ link: toSummary(row) }), 201);
  });

  r.patch("/:id/links/:linkId", async (c) => {
    const parsed = patchSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const { label, kind, enabledForAp } = parsed.data;
    const res = await db.run(
      "UPDATE links SET label=COALESCE(?,label), kind=COALESCE(?,kind), enabled_for_ap=COALESCE(?,enabled_for_ap) WHERE id=? AND account_id=?",
      label ?? null,
      kind ?? null,
      enabledForAp === undefined ? null : enabledForAp ? 1 : 0,
      c.req.param("linkId"),
      account.id,
    );
    if (res.changes === 0) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const row = (await db.first<LinkRow>(
      "SELECT id, url, label, kind, enabled_for_ap, last_used_at, created_at FROM links WHERE id=? AND account_id=?",
      c.req.param("linkId"),
      account.id,
    ))!;
    return c.json(ok({ link: toSummary(row) }));
  });

  r.delete("/:id/links/:linkId", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const res = await db.run(
      "DELETE FROM links WHERE id=? AND account_id=?",
      c.req.param("linkId"),
      account.id,
    );
    if (res.changes === 0) return fail("NOT_FOUND", "見つかりませんでした", 404);
    return c.json(ok({ deleted: true }));
  });

  return r;
}
