/**
 * AI（SPEC §7.6 / §10）。
 *
 * - `GET /ai/settings` / `PUT /ai/settings` … BYOK。`storeOnServer=false` ならキーを保存せず、
 *   `hasKey=false` かつ `autopilotAvailable=false`（サーバーが自動生成のときにキーを読めない）
 * - `POST /ai/test`     … 1回だけ短い生成を試す
 * - `POST /ai/generate` … 3案（SPEC §10.2 の `buildContext` ＋ §10.3 のプロンプト）
 * - `POST /ai/revise`   … 1案を直す（会話履歴つき）
 *
 * 生成と修正以外に AI は使わない（§10 冒頭）。
 */
import { Hono } from "hono";
import { classifyHook, ok } from "@tap/shared";
import type { AiCandidate, AiHistoryTurn, AiProvider } from "@tap/shared";
import { z } from "zod";
import { fail, type AppEnv } from "../app";
import { loadOwnedAccount, type AccountRow } from "../lib/accounts";
import {
  AiError,
  buildContext,
  buildRevisePrompt,
  defaultModel,
  generateRaw,
  readCandidates,
  systemPrompt,
  type PromptConstraints,
} from "../lib/ai";
import { decrypt, encrypt } from "../lib/crypto";
import type { Db } from "../lib/db";
import type { Env } from "../env";
import { SOURCE_SELECT, type SourceRow } from "./sources";

const PROVIDERS = ["gemini", "openrouter"] as const;

/** 文体の見本に使う本数（SPEC §10.2）。 */
const TEMPLATE_COUNT = 3;

const putSchema = z.object({
  provider: z.enum(PROVIDERS),
  key: z.string().trim().max(500).optional(),
  model: z.string().trim().max(200).optional(),
  storeOnServer: z.boolean(),
});

const generateSchema = z.object({
  accountId: z.string().min(1),
  picks: z.array(z.string().min(1)).max(10).optional(),
  pickMode: z.enum(["template", "rewrite"]).optional(),
  sourceIds: z.array(z.string().min(1)).max(10).optional(),
  instruction: z.string().max(2000).optional(),
  n: z.number().int().min(1).max(5).optional(),
  clientKey: z.string().trim().max(500).optional(),
});

const candidateSchema = z.object({
  key: z.string().max(8),
  hook: z.string().max(50),
  body: z.string().max(5000),
  comments: z.array(z.string().max(5000)).max(3),
  basis: z.string().max(1000),
});

const reviseSchema = z.object({
  accountId: z.string().min(1),
  candidate: candidateSchema,
  instruction: z.string().min(1).max(2000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(5000) }))
    .max(20)
    .optional(),
  clientKey: z.string().trim().max(500).optional(),
});

type AiSettingsRow = {
  user_id: string;
  provider: string;
  key_enc: string | null;
  model: string | null;
  store_on_server: number;
  updated_at: string;
};

async function loadSettings(db: Db, userId: string): Promise<AiSettingsRow | null> {
  return db.first<AiSettingsRow>(
    "SELECT user_id, provider, key_enc, model, store_on_server, updated_at FROM ai_settings WHERE user_id=?",
    userId,
  );
}

function toSummary(row: AiSettingsRow | null) {
  if (!row) {
    return {
      provider: null,
      model: null,
      hasKey: false,
      storeOnServer: true,
      autopilotAvailable: false,
    };
  }
  const storeOnServer = Boolean(row.store_on_server);
  const hasKey = storeOnServer && Boolean(row.key_enc);
  return {
    provider: row.provider as AiProvider,
    model: row.model,
    hasKey,
    storeOnServer,
    // サーバーが自動生成のときにキーを読めないので、端末保存ではオートパイロットを使えない
    autopilotAvailable: hasKey,
  };
}

/** 使うキーを決める（SPEC §10.1「キーの所在」）。 */
async function resolveKey(
  env: Env,
  row: AiSettingsRow | null,
  clientKey: string | undefined,
): Promise<{ provider: AiProvider; model: string; apiKey: string }> {
  if (!row) {
    throw new AiError("AI_KEY_REQUIRED", "AIキーが設定されていません。設定から登録してください");
  }
  const provider = row.provider as AiProvider;
  const model = row.model && row.model.trim() !== "" ? row.model : defaultModel(provider);

  if (row.store_on_server) {
    if (!row.key_enc) {
      throw new AiError("AI_KEY_REQUIRED", "AIキーが設定されていません。設定から登録してください");
    }
    return { provider, model, apiKey: await decrypt(row.key_enc, env.ENC_KEY) };
  }
  if (!clientKey || clientKey.trim() === "") {
    throw new AiError(
      "AI_KEY_REQUIRED",
      "この端末にキーが見つかりません。設定からもう一度キーを入力してください",
    );
  }
  return { provider, model, apiKey: clientKey.trim() };
}

/* ── 生成の材料（SPEC §10.2） ────────────────────────── */

type PostTextRow = { id: string; text: string; tags_json: string; views: number };

function hookOf(row: PostTextRow): string {
  try {
    const tags = JSON.parse(row.tags_json) as { hook?: unknown };
    if (typeof tags.hook === "string" && tags.hook !== "") return tags.hook;
  } catch {
    // タグが無ければ本文から出す（`shared/src/tags.ts` と同じ関数）
  }
  return classifyHook(row.text);
}

/** 指定が無いときの文体の見本。型が重ならないように上位から3本（SPEC §10.2）。 */
export async function topTemplates(db: Db, accountId: string): Promise<string[]> {
  const rows = await db.all<PostTextRow>(
    `SELECT id, text, tags_json, views FROM posts
       WHERE account_id=? AND is_reply=0 AND deleted=0 AND text<>''
       ORDER BY views DESC LIMIT 30`,
    accountId,
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const hook = hookOf(row);
    if (seen.has(hook)) continue;
    seen.add(hook);
    out.push(row.text);
    if (out.length >= TEMPLATE_COUNT) break;
  }
  return out;
}

async function pickedPosts(db: Db, accountId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  const rows = await db.all<PostTextRow>(
    `SELECT id, text, tags_json, views FROM posts WHERE account_id=? AND id IN (${marks})`,
    accountId,
    ...ids,
  );
  // 呼び出し側が並べた順を保つ
  const byId = new Map(rows.map((r) => [r.id, r.text]));
  return ids.map((id) => byId.get(id) ?? "").filter((t) => t.trim() !== "");
}

/** 制約（SPEC §10.2）。`autopilot` 行が無ければ既定（リンクはコメント）。 */
async function constraintsFor(db: Db, account: AccountRow): Promise<PromptConstraints> {
  const ap = await db.first<{ ng_words: string; link_placement: string }>(
    "SELECT ng_words, link_placement FROM autopilot WHERE account_id=?",
    account.id,
  );
  let emoji: "none" | "few" = "none";
  try {
    const s = JSON.parse(account.settings_json) as { emoji?: unknown };
    if (s.emoji === "few") emoji = "few";
  } catch {
    // 既定のまま
  }
  return {
    linkPlacement: (ap?.link_placement as PromptConstraints["linkPlacement"]) ?? "comment",
    ngWords: ap?.ng_words ?? "",
    emoji,
  };
}

export function aiRoutes() {
  const r = new Hono<AppEnv>();

  /* ── 設定（SPEC §7.6） ───────────────────────────── */

  r.get("/settings", async (c) => {
    const row = await loadSettings(c.get("db"), c.get("userId")!);
    return c.json(ok(toSummary(row)));
  });

  r.put("/settings", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const input = parsed.data;
    const db = c.get("db");
    const userId = c.get("userId")!;
    const prev = await loadSettings(db, userId);

    // 端末保存を選んだら、サーバーに残っているキーも消す（SPEC §7.6）
    let keyEnc: string | null = null;
    if (input.storeOnServer) {
      if (input.key && input.key !== "") {
        keyEnc = await encrypt(input.key, c.env.ENC_KEY);
      } else if (prev && prev.store_on_server && prev.provider === input.provider) {
        keyEnc = prev.key_enc; // キーを送らずにモデルだけ変えたとき
      }
    }

    await db.run(
      `INSERT INTO ai_settings (user_id, provider, key_enc, model, store_on_server, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           provider=excluded.provider, key_enc=excluded.key_enc, model=excluded.model,
           store_on_server=excluded.store_on_server, updated_at=excluded.updated_at`,
      userId,
      input.provider,
      keyEnc,
      input.model && input.model !== "" ? input.model : defaultModel(input.provider),
      input.storeOnServer ? 1 : 0,
      new Date().toISOString(),
    );

    const next = await loadSettings(db, userId);
    return c.json(ok(toSummary(next)));
  });

  /* ── 疎通（SPEC §7.6） ───────────────────────────── */

  r.post("/test", async (c) => {
    let body: { clientKey?: unknown } = {};
    try {
      body = ((await c.req.json()) ?? {}) as { clientKey?: unknown };
    } catch {
      body = {};
    }
    const row = await loadSettings(c.get("db"), c.get("userId")!);
    const key = await resolveKey(
      c.env,
      row,
      typeof body.clientKey === "string" ? body.clientKey : undefined,
    );

    const started = Date.now();
    const raw = await generateRaw(
      c.env,
      {
        provider: key.provider,
        model: key.model,
        apiKey: key.apiKey,
        system: systemPrompt({ linkPlacement: "comment", ngWords: "", emoji: "none" }),
        user: "動作確認です。「つながりました」とだけ書いた1案を返す。型を変えて1案。型の候補: 断定型",
        appOrigin: c.env.APP_ORIGIN,
      },
      { budget: c.get("budget") },
    );
    readCandidates(raw, 1); // 形が違えば AI_BAD_OUTPUT
    return c.json(ok({ ok: true, model: key.model, latencyMs: Date.now() - started }));
  });

  /* ── 生成（SPEC §7.6 / §10.2 / §10.3） ───────────── */

  r.post("/generate", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const input = parsed.data;
    const db = c.get("db");
    const userId = c.get("userId")!;

    const account = await loadOwnedAccount(db, input.accountId, userId);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const settings = await loadSettings(db, userId);
    const key = await resolveKey(c.env, settings, input.clientKey);

    const picks = input.picks ?? [];
    const pickMode = input.pickMode ?? "template";
    const pickedTexts = await pickedPosts(db, account.id, picks);

    const templates =
      pickMode === "template" && pickedTexts.length > 0
        ? pickedTexts
        : await topTemplates(db, account.id);
    const rewriteFrom = pickMode === "rewrite" ? (pickedTexts[0] ?? null) : null;

    const sourceIds = input.sourceIds ?? [];
    let sourceRows: SourceRow[] = [];
    if (sourceIds.length > 0) {
      const marks = sourceIds.map(() => "?").join(",");
      sourceRows = await db.all<SourceRow>(
        `SELECT ${SOURCE_SELECT} FROM sources WHERE user_id=? AND id IN (${marks})`,
        userId,
        ...sourceIds,
      );
    }

    const notes: string[] = [];
    const youtubeUrls: string[] = [];
    for (const s of sourceRows) {
      if (s.type !== "youtube" || !s.url) continue;
      if (key.provider === "gemini") {
        youtubeUrls.push(s.url);
      } else if (s.content.trim() === "") {
        // OpenRouter は動画を読めない（SPEC §10.2）
        notes.push(`「${s.title}」は動画です。OpenRouter では読めないので、文字起こしを貼ってください`);
      }
    }

    const links = await db.all<{ label: string; url: string }>(
      "SELECT label, url FROM links WHERE account_id=? ORDER BY created_at ASC LIMIT 5",
      account.id,
    );

    const constraints = await constraintsFor(db, account);
    const n = input.n ?? 3;
    const raw = await generateRaw(
      c.env,
      {
        provider: key.provider,
        model: key.model,
        apiKey: key.apiKey,
        system: systemPrompt(constraints),
        user: buildContext({
          templates,
          rewriteFrom,
          sources: sourceRows
            .filter((s) => s.content.trim() !== "")
            .map((s) => ({ title: s.title, content: s.content })),
          youtubeUrls,
          links,
          instruction: input.instruction ?? "",
          n,
        }),
        youtubeUrls,
        appOrigin: c.env.APP_ORIGIN,
      },
      { budget: c.get("budget") },
    );

    const candidates = readCandidates(raw, n);

    if (sourceRows.length > 0) {
      const marks = sourceRows.map(() => "?").join(",");
      await db.run(
        `UPDATE sources SET last_used_at=?, use_count=use_count+1 WHERE user_id=? AND id IN (${marks})`,
        new Date().toISOString(),
        userId,
        ...sourceRows.map((s) => s.id),
      );
    }

    return c.json(ok({ candidates, notes }));
  });

  /* ── 修正（SPEC §7.6 / §10.3） ───────────────────── */

  r.post("/revise", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = reviseSchema.safeParse(body);
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const input = parsed.data;
    const db = c.get("db");
    const userId = c.get("userId")!;

    const account = await loadOwnedAccount(db, input.accountId, userId);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const settings = await loadSettings(db, userId);
    const key = await resolveKey(c.env, settings, input.clientKey);
    const constraints = await constraintsFor(db, account);

    const raw = await generateRaw(
      c.env,
      {
        provider: key.provider,
        model: key.model,
        apiKey: key.apiKey,
        system: systemPrompt(constraints),
        user: buildRevisePrompt(
          input.candidate as AiCandidate,
          input.instruction,
          (input.history ?? []) as AiHistoryTurn[],
        ),
        appOrigin: c.env.APP_ORIGIN,
      },
      { budget: c.get("budget") },
    );

    const [first] = readCandidates(raw, 1);
    return c.json(ok({ candidate: { ...first!, key: input.candidate.key } }));
  });

  return r;
}
