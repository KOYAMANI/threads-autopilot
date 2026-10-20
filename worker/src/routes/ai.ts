import { AI_GENERATION_TIMEOUT_MS } from "@tap/shared";
import { thinkingCapabilities, thinkingConfig } from "../lib/ai-capabilities";
import { readOwnTree } from "../lib/reference-thread";
/**
 * AI（SPEC §7.6 / §10）。
 *
 * - Settings: server-encrypted credentials only; legacy clientKey is rejected.
 * - `POST /ai/test`     … 1回だけ短い生成を試す
 * - `POST /ai/generate` … 3案（SPEC §10.2 の `buildContext` ＋ §10.3 のプロンプト）
 * - `POST /ai/revise`   … 1案を直す（会話履歴つき）
 *
 * 生成と修正以外に AI は使わない（§10 冒頭）。
 */
import { Hono } from "hono";
import { classifyHook, ok, AI_DATA_POLICY_VERSION, hasAiDataConsent, isAllowedAiModel } from "@tap/shared";
import type { AiCandidate, AiGenerateResponse, AiHistoryTurn, AiProvider, BuzzDiagnosisResponse } from "@tap/shared";
import { z } from "zod";
import { fail, type AppEnv } from "../app";
import { loadOwnedAccount, type AccountRow } from "../lib/accounts";
import {
  AiError,
  readCandidates,
  defaultModel,
  generateRaw,
  systemPrompt,
  type PromptConstraints,
} from "../lib/ai";
import { compose, abstractTemplate } from "../lib/composition";
import { audit } from "../lib/audit";
import { decrypt, encrypt } from "../lib/crypto";
import { RATE_LIMITS, aiKey, rateAllow, rateRecord } from "../lib/rate";
import type { Db } from "../lib/db";
import type { Budget } from "../lib/budget";
import type { Env } from "../env";
import { SOURCE_SELECT, type SourceRow } from "./sources";

const PROVIDERS = ["gemini", "openrouter"] as const;

/** `/ai/test` `/ai/generate` `/ai/revise` の回数制限（1分10回、`ai:<user_id>`）。 */
export async function aiRateLimit(
  c: { get: (k: "db" | "userId") => any },
  next: () => Promise<void>,
): Promise<Response | void> {
  const db = c.get("db");
  const userId = c.get("userId") as string | null;
  if (!userId) return next();
  const key = aiKey(userId);
  const now = new Date();
  const allowed = await rateAllow(db, key, RATE_LIMITS.ai.limit, RATE_LIMITS.ai.windowMin, now);
  await rateRecord(db, key, now);
  if (!allowed) {
    return fail(
      "RATE_LIMITED",
      "少し早すぎます。1分ほど空けてからもう一度お試しください",
      429,
    );
  }
  return next();
}

/** 文体の見本に使う本数（SPEC §10.2）。 */
const TEMPLATE_COUNT = 3;

const putSchema = z.object({
  acceptDataPolicy: z.literal(true),
  geminiBillingConfirmed: z.boolean().optional(),
  provider: z.enum(PROVIDERS),
  key: z.string().trim().max(500).optional(),
  model: z.string().trim().max(200).optional(),
  storeOnServer: z.literal(true).default(true),
});

export const generateSchema = z.object({
  thinking: z.string().max(80).optional(),
  clarificationMode: z.enum(["ask", "delegate"]).optional(),
  conversation: z.array(z.object({role:z.enum(["user", "assistant"]),text:z.string().trim().min(1).max(1000)})).max(8).optional(),
  accountId: z.string().min(1),
  picks: z.array(z.string().min(1)).max(10).optional(),
  referenceReplyIds: z.array(z.string().min(1)).max(3).optional(),
  pickMode: z.enum(["template", "rewrite", "information"]).optional(),
  referenceText: z.string().trim().max(20000).optional(),
  sourceIds: z.array(z.string().min(1)).max(10).optional(),
  instruction: z.string().max(2000).optional(),
  purpose: z.enum(["awareness", "trust", "action"]).optional(),
  fidelity: z.number().int().min(50).max(90).optional(),
  n: z.number().int().min(1).max(5).optional(),
  clientKey: z.never().optional(),
});
export type GenerateInput = z.infer<typeof generateSchema>;

const candidateSchema = z.object({
  key: z.string().max(8),
  hook: z.string().max(50),
  body: z.string().max(5000),
  comments: z.array(z.string().max(5000)).max(3),
  basis: z.string().max(1000),
  angle: z.string().max(40).optional(),
});

const reviseSchema = z.object({
  thinking: z.string().max(80).optional(),
  context: generateSchema.omit({ accountId: true, clientKey: true, n: true }).optional(),
  accountId: z.string().min(1),
  candidate: candidateSchema,
  instruction: z.string().min(1).max(2000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(5000) }))
    .max(20)
    .optional(),
  clientKey: z.never().optional(),
});

const buzzDiagnosisInputSchema = z.object({
  accountId: z.string().min(1),
  body: z.string().trim().min(1).max(4000),
  purpose: z.enum(["awareness", "trust", "action"]),
  hasMedia: z.boolean(),
  mediaCount: z.number().int().min(0).max(5),
});
const buzzDiagnosisOutputSchema = z.object({
  score: z.number().int().min(0).max(100),
  priority: z.enum(["hook", "body", "cta"]),
  sections: z.array(z.object({
    key: z.enum(["hook", "body", "cta"]),
    label: z.string().min(1).max(20),
    score: z.number().int().min(0).max(50),
    maxScore: z.number().int().min(1).max(50),
    feedback: z.string().min(1).max(240),
  })).length(3),
  hookSuggestions: z.array(z.string().trim().min(1).max(160)).length(3),
  mediaAnalyzed: z.literal(false),
});

type AiSettingsRow = {
  user_id: string;
  provider: string;
  key_enc: string | null;
  model: string | null;
  store_on_server: number;
  updated_at: string;
  data_policy_version: string | null;
};

async function loadSettings(db: Db, userId: string): Promise<AiSettingsRow | null> {
  return db.first<AiSettingsRow>(
    "SELECT user_id, provider, key_enc, model, store_on_server, updated_at, data_policy_version FROM ai_settings WHERE user_id=?",
    userId,
  );
}

function toSummary(row: AiSettingsRow | null) {
  if (!row) {
    return {
      savedAt: null,
      provider: null,
      model: null,
      hasKey: false,
      storeOnServer: true,
      autopilotAvailable: false,
      dataPolicyAccepted: false,
    };
  }
  const storeOnServer = Boolean(row.store_on_server);
  const hasKey = storeOnServer && Boolean(row.key_enc);
  const model = isAllowedAiModel(row.provider, row.model) ? row.model : defaultModel(row.provider as AiProvider);
  const consented = hasAiDataConsent({ ...row, model });
  return {
    savedAt: row.updated_at,
    provider: row.provider as AiProvider,
    model,
    hasKey,
    storeOnServer,
    // サーバーが自動生成のときにキーを読めないので、端末保存ではオートパイロットを使えない
    autopilotAvailable: hasKey && consented,
    dataPolicyAccepted: consented,
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
  const model = isAllowedAiModel(provider, row.model) ? row.model!.trim() : defaultModel(provider);
  if (!hasAiDataConsent({ ...row, model })) throw new AiError("AI_KEY_REQUIRED", "設定でAIの送信先と利用条件を確認して保存してください", null, false);

  if (row.store_on_server) {
    if (!row.key_enc) {
      throw new AiError("AI_KEY_REQUIRED", "AIキーが設定されていません。設定から登録してください");
    }
    return { provider, model, apiKey: await decrypt(row.key_enc, env.ENC_KEY) };
  }
  throw new AiError("AI_KEY_REQUIRED", "端末保存は終了しました。設定からキーを登録してください");
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

export async function pickedPosts(db: Db, accountId: string, ids: string[], selectedReplyIds?: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  const rows = await db.all<{ id: string; text: string; own_thread_json: string | null }>(
    `SELECT id,text,own_thread_json FROM posts WHERE account_id=? AND deleted=0 AND is_reply=0 AND id IN (${marks})`, accountId, ...ids,
  );
  const byId = new Map(rows.map(row => {
    const tree = readOwnTree(row.own_thread_json);
    if (!tree?.complete) throw new AiError("AI_BAD_OUTPUT", "本人のツリーを確認できていません。画面を再読み込みして、参考投稿を選び直してください", null, false, "reference_unresolved");
    const selected = tree.chain;
    if (selectedReplyIds?.some(id => !selected.some(child => child.id === id))) throw new AiError("AI_BAD_OUTPUT", "本人のツリー以外の返信は使えません。参考投稿を選び直してください", null, false, "reference_invalid");
    if (selected.length > 3) throw new AiError("AI_BAD_OUTPUT", "このツリーは4投稿を超えています。使いたい範囲を4投稿以内で貼り付けてください", null, false, "reference_too_long");
    const parts = [row.text, ...selected.map(child => child.text)];
    return [row.id, parts.length === 1 ? row.text : parts.map((text, i) => `【投稿${i + 1}】\n${text}`).join("\n\n")];
  }));
  const texts = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  if (texts.some(text => text.length > 20000) || texts.join("\n").length > 40000) {
    throw new AiError("AI_BAD_OUTPUT", "参考投稿が長すぎます。1ツリー20,000文字・合計40,000文字以内にしてください");
  }
  return texts;
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

export class AiGenerationInputError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "NOT_FOUND",
    message: string,
    readonly status: 400 | 404 | 422,
  ) {
    super(message);
    this.name = "AiGenerationInputError";
  }
}

/**
 * 同期APIとバックグラウンドジョブが共有する生成本体。
 * 入力や生成結果をログへ出さず、復号したキーはこの関数内で使い切る。
 */
export async function executeGeneration(options: {
  env: Env;
  db: Db;
  budget: Budget;
  userId: string;
  input: GenerateInput;
  deadlineMs?: number;
  signal?: AbortSignal;
}): Promise<AiGenerateResponse> {
  const { env, db, budget, userId, input, signal } = options;
  const account = await loadOwnedAccount(db, input.accountId, userId);
  if (!account) throw new AiGenerationInputError("NOT_FOUND", "見つかりませんでした", 404);

  const settings = await loadSettings(db, userId);
  const key = await resolveKey(env, settings, input.clientKey);
  try {
    thinkingConfig(key.provider, key.model, input.thinking);
  } catch (error) {
    throw new AiGenerationInputError("BAD_REQUEST", (error as Error).message, 400);
  }

  const picks = [...new Set(input.picks ?? [])];
  const pickMode = input.pickMode ?? (picks.length || input.referenceText?.trim() ? "template" : "information");
  if (pickMode === "rewrite" && !((picks.length === 1 && !input.referenceText?.trim()) || (picks.length === 0 && input.referenceText?.trim()))) {
    throw new AiGenerationInputError("BAD_REQUEST", "リライト元を1本選ぶか、投稿をツリー全体で貼り付けてください", 400);
  }
  const pickedTexts = pickMode === "information" ? [] : await pickedPosts(db, account.id, picks, input.referenceReplyIds);
  if (pickMode !== "information" && pickedTexts.length !== picks.length) {
    throw new AiGenerationInputError("NOT_FOUND", "参考投稿が見つかりませんでした", 404);
  }
  const references = [...pickedTexts, ...(pickMode !== "information" && input.referenceText?.trim() ? [input.referenceText.trim()] : [])];
  if (pickMode === "template" && !references.length) {
    throw new AiGenerationInputError("BAD_REQUEST", "参考にする投稿を選ぶか、ツリー全体を貼り付けてください", 400);
  }

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
  if (sourceRows.length !== new Set(sourceIds).size) {
    throw new AiGenerationInputError("NOT_FOUND", "選択した参考資料が見つかりませんでした", 404);
  }

  const youtubeUrls: string[] = [];
  for (const source of sourceRows) {
    if (source.type !== "youtube" || !source.url) continue;
    if (key.provider === "gemini") youtubeUrls.push(source.url);
    else if (source.content.trim() === "") {
      throw new AiGenerationInputError("BAD_REQUEST", `「${source.title}」の動画をこのモデルでは読めません。文字起こしを追加してください`, 422);
    }
  }

  const links = await db.all<{ label: string; url: string }>(
    "SELECT label, url FROM links WHERE account_id=? ORDER BY created_at ASC LIMIT 5",
    account.id,
  );
  const constraints = await constraintsFor(db, account);
  const n = input.n ?? 3;
  const sources = sourceRows.filter(source => source.content.trim() !== "").map(source => ({ title: source.title, content: source.content }));
  if (sources.reduce((sum, source) => sum + source.content.length, 0) > 60000) {
    throw new AiGenerationInputError("BAD_REQUEST", "資料は合計60,000文字以内で選んでください。本文は切り捨てずに使います。", 422);
  }
  if (sourceRows.some(source => source.type !== "youtube" && !source.content.trim())) {
    throw new AiGenerationInputError("BAD_REQUEST", "本文を読み込めていない資料があります。資料を確認してください。", 422);
  }

  const deadlineMs = options.deadlineMs ?? Date.now() + AI_GENERATION_TIMEOUT_MS;
  const call: import("../lib/composition").CompositionCall = (system, user, videoUrls, responseJsonSchema) => generateRaw(
    env,
    { ...key, thinking: input.thinking, system, user, responseJsonSchema, youtubeUrls: videoUrls, appOrigin: env.APP_ORIGIN },
    // Retry only the selected model, within the shared five-minute deadline.
    { budget, retries: 1, deadlineMs, signal },
  );
  const abstractReference = pickMode === "template" && references.length
    ? await abstractTemplate(references[0]!, call, references.slice(1), input.instruction ?? "", sources, input.fidelity)
    : undefined;
  const result = await compose({
    mode: pickMode,
    abstractReference,
    referenceOrigin: input.referenceText?.trim() ? "paste" : "own",
    account: { username: account.username },
    references,
    sources,
    youtubeUrls,
    links,
    instruction: input.instruction ?? "",
    purpose: input.purpose,
    fidelity: input.fidelity,
    clarificationMode: input.clarificationMode,
    conversation: input.conversation,
    n,
    constraints,
  }, call);

  if (result.candidates.length && sourceRows.length > 0) {
    const marks = sourceRows.map(() => "?").join(",");
    await db.run(
      `UPDATE sources SET last_used_at=?, use_count=use_count+1 WHERE user_id=? AND id IN (${marks})`,
      new Date().toISOString(),
      userId,
      ...sourceRows.map(source => source.id),
    );
  }

  return {
    candidates: result.candidates,
    notes: result.notes,
    analysis: result.analysis,
    clarification: result.clarification,
  };
}

export function aiRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c,next) => {
    await next();
    const operation=c.req.path.split("/").at(-1);
    if (c.req.method==="POST" && ["test","generate","revise","buzz-diagnose"].includes(operation ?? "")) {
      await audit(c.get("db"), c.get("userId")!, "ai_request", {operation, success:c.res.status<400});
    }
  });

  /**
   * AI を実際に呼ぶ3経路だけ回数制限をかける（M7。SPEC §5.1 の `rate_events` を流用）。
   * 1リクエスト = 買い手の AI キーの課金1回なので、無制限にはしない。
   * 設定の読み書き（`/settings`）は課金しないので対象外。
   */
  r.use("/test", aiRateLimit);
  r.use("/generate", aiRateLimit);
  r.use("/revise", aiRateLimit);
  r.use("/buzz-diagnose", aiRateLimit);

  /* ── 設定（SPEC §7.6） ───────────────────────────── */

  r.get("/capabilities", async (c) => {
    const row=await loadSettings(c.get("db"),c.get("userId")!);
    const settings=toSummary(row);
    const provider=settings.provider ?? "gemini";
    return c.json(ok(thinkingCapabilities(provider,settings.model ?? defaultModel(provider))));
  });

  r.get("/settings", async (c) => {
    const row = await loadSettings(c.get("db"), c.get("userId")!);
    const last = row ? await c.get("db").first<{at: string; detail: string}>("SELECT at,detail FROM audit_log WHERE user_id=? AND action='ai_test' AND json_extract(detail,'$.settingsUpdatedAt')=? AND json_extract(detail,'$.model')=? ORDER BY at DESC LIMIT 1", c.get("userId")!, row.updated_at, toSummary(row).model) : null;
    const usage=await c.get("db").first<{count:number}>("SELECT count(*) as count FROM audit_log WHERE user_id=? AND action='ai_request' AND at>=?",c.get("userId")!,new Date(Date.now()-86400000).toISOString());
    return c.json(ok({...toSummary(row), requestsLast24h:usage?.count ?? 0, lastTest: last ? {at: last.at, success: JSON.parse(last.detail).success === true} : null}));
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
    if (!isAllowedAiModel(input.provider, input.model)) return fail("BAD_REQUEST", "このAI設定は利用できません。ページを再読み込みして保存してください", 400);
    if (input.key && !/^[\x21-\x7e]+$/.test(input.key)) return fail("BAD_REQUEST", "APIキーに空白・改行・全角文字が含まれています。キーだけをコピーして入力してください", 400);
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

    if (!keyEnc) return fail("BAD_REQUEST", "APIキーを入力してください。保存済みキーはプロバイダーを変更すると引き継げません", 400);
    await db.run(
      `INSERT INTO ai_settings (user_id, provider, key_enc, model, store_on_server, updated_at, data_policy_version)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           provider=excluded.provider, key_enc=excluded.key_enc, model=excluded.model,
           store_on_server=excluded.store_on_server, updated_at=excluded.updated_at, data_policy_version=excluded.data_policy_version`,
      userId,
      input.provider,
      keyEnc,
      input.model || defaultModel(input.provider),
      input.storeOnServer ? 1 : 0,
      new Date().toISOString(),
      AI_DATA_POLICY_VERSION,
    );

    const next = await loadSettings(db, userId);
    // キーの変更は監査に残す（SPEC §13 M7「キー変更」）。**キーそのものは書かない**
    await audit(db, userId, "ai_key_change", {
      provider: input.provider,
      storeOnServer: input.storeOnServer,
      keyReplaced: Boolean(input.key && input.key !== ""),
      dataPolicyVersion: AI_DATA_POLICY_VERSION,
      geminiBillingConfirmed: input.provider === "gemini" && input.geminiBillingConfirmed === true,
    });
    return c.json(ok(toSummary(next)));
  });

  r.delete("/settings/key", async (c) => {
    const db = c.get("db"), userId = c.get("userId")!;
    await db.batch([
      { sql: "UPDATE ai_settings SET key_enc=NULL, data_policy_version=NULL, store_on_server=1, updated_at=? WHERE user_id=?", params: [new Date().toISOString(), userId] },
      { sql: "UPDATE autopilot SET enabled=0 WHERE account_id IN (SELECT id FROM accounts WHERE user_id=?)", params: [userId] },
    ]);
    await audit(db, userId, "ai_key_delete", {});
    return c.json(ok({ deleted: true }));
  });

  /* ── 疎通（SPEC §7.6） ───────────────────────────── */

  r.post("/test", async (c) => {
    let body: { clientKey?: unknown } = {};
    try {
      body = ((await c.req.json()) ?? {}) as { clientKey?: unknown };
    } catch {
      body = {};
    }
    if (body.clientKey !== undefined) return fail("BAD_REQUEST", "キーは設定画面からサーバーへ保存してください", 400);
    const row = await loadSettings(c.get("db"), c.get("userId")!);
    const key = await resolveKey(
      c.env,
      row,
      typeof body.clientKey === "string" ? body.clientKey : undefined,
    );

    const started = Date.now();
    try {
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
    await audit(c.get("db"), c.get("userId")!, "ai_test", {success:true,settingsUpdatedAt:row?.updated_at,model:key.model});
    return c.json(ok({ ok: true, model: key.model, latencyMs: Date.now() - started }));
    } catch (error) {
      await audit(c.get("db"), c.get("userId")!, "ai_test", {success:false,settingsUpdatedAt:row?.updated_at,model:key.model});
      throw error;
    }
  });

  /* ── 生成（SPEC §7.6 / §10.2 / §10.3） ───────────── */

  r.post("/generate", async (c) => {
    const deadlineMs=Date.now()+AI_GENERATION_TIMEOUT_MS;
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    try {
      const result = await executeGeneration({
        env: c.env,
        db: c.get("db"),
        budget: c.get("budget"),
        userId: c.get("userId")!,
        input: parsed.data,
        deadlineMs,
        signal: c.req.raw.signal,
      });
      return c.json(ok(result));
    } catch (error) {
      if (error instanceof AiGenerationInputError) return fail(error.code, error.message, error.status);
      throw error;
    }
  });

  /* ── 修正（SPEC §7.6 / §10.3） ───────────────────── */

  r.post("/revise", async (c) => {
    const deadlineMs=Date.now()+AI_GENERATION_TIMEOUT_MS;
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
    try { thinkingConfig(key.provider,key.model,input.thinking); } catch(error) { return fail("BAD_REQUEST",(error as Error).message,400); }
    const constraints = await constraintsFor(db, account);

    const ctx=input.context;
    const ids=[...new Set(ctx?.picks ?? [])];
    const references=ctx ? await pickedPosts(db,account.id,ids,ctx.referenceReplyIds) : [];
    if(references.length!==ids.length)return fail("NOT_FOUND","参考投稿が見つかりませんでした",404);
    if(ctx?.referenceText)references.push(ctx.referenceText);
    const sourceIds=[...new Set(ctx?.sourceIds ?? [])];
    const rows=sourceIds.length ? await db.all<SourceRow>(
      `SELECT ${SOURCE_SELECT} FROM sources WHERE user_id=? AND id IN (${sourceIds.map(()=>"?").join(",")})`,userId,...sourceIds) : [];
    if(rows.length!==sourceIds.length)return fail("NOT_FOUND","参考資料が見つかりませんでした",404);
    if(rows.some(s=>!s.content.trim() && (s.type!=="youtube" || key.provider!=="gemini")))return fail("BAD_REQUEST","読み込めない資料があります。本文を追加してください。",422);
    const sources=rows.filter(s=>s.content.trim()).map(s=>({title:s.title,content:s.content}));
    if(sources.reduce((n,s)=>n+s.content.length,0)>60000)return fail("BAD_REQUEST","資料は合計60,000文字以内にしてください。",422);
    const result=await compose({mode:ctx?.pickMode ?? "rewrite",references,sources,links:[],youtubeUrls:rows.filter(s=>s.type==="youtube"&&s.url&&key.provider==="gemini").map(s=>s.url!),
      currentDraft:input.candidate, referenceOrigin:ctx?.referenceText?"paste":"own",account:{username:account.username},
      instruction:input.instruction,n:1,constraints,clarificationMode:"delegate"},
      (system,user,youtubeUrls,responseJsonSchema)=>generateRaw(c.env,{...key,thinking:input.thinking ?? ctx?.thinking,system,user,youtubeUrls,responseJsonSchema,appOrigin:c.env.APP_ORIGIN},
        {budget:c.get("budget"),retries:1,deadlineMs,signal:c.req.raw.signal}));
    const first=result.candidates[0];
    if(!first)throw new AiError("AI_BAD_OUTPUT","修正する本文がありません",null,false,"input");
    return c.json(ok({candidate:{...first,key:input.candidate.key,angle:input.candidate.angle},notes:result.notes}));
  });

  r.post("/buzz-diagnose", async (c) => {
    let rawInput: unknown = null;
    try { rawInput = await c.req.json(); } catch { rawInput = null; }
    const parsed = buzzDiagnosisInputSchema.safeParse(rawInput);
    if (!parsed.success) return fail("BAD_REQUEST", "診断する投稿本文を確認してください", 400);
    const account = await loadOwnedAccount(c.get("db"), parsed.data.accountId, c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "投稿先のアカウントが見つかりません", 404);
    const settings = await loadSettings(c.get("db"), c.get("userId")!);
    const key = await resolveKey(c.env, settings, undefined);
    const responseJsonSchema = {
      type: "object",
      required: ["score", "priority", "sections", "hookSuggestions", "mediaAnalyzed"],
      properties: {
        score: { type: "integer", minimum: 0, maximum: 100 },
        priority: { type: "string", enum: ["hook", "body", "cta"] },
        sections: { type: "array", minItems: 3, maxItems: 3, items: { type: "object", required: ["key", "label", "score", "maxScore", "feedback"], properties: {
          key: { type: "string", enum: ["hook", "body", "cta"] }, label: { type: "string" }, score: { type: "integer" }, maxScore: { type: "integer" }, feedback: { type: "string" },
        } } },
        hookSuggestions: { type: "array", minItems: 3, maxItems: 3, items: { type: "string" } },
        mediaAnalyzed: { type: "boolean", enum: [false] },
      },
    };
    const raw = await generateRaw(c.env, {
      ...key,
      appOrigin: c.env.APP_ORIGIN,
      responseJsonSchema,
      system: "あなたはThreads投稿の編集者です。バズを保証せず、投稿目的に照らして1行目50点・本文35点・締め15点で診断します。priorityは得点率（score/maxScore）が最も低い項目にします。認知目的などでCTAが不要なら、CTAがないこと自体を減点しません。hookSuggestionsは1行目だけの置換候補を3つ、各80文字以内・改行なしで返し、本文や締めを含めません。画像は受け取っていないので内容を推測しません。具体的で短い日本語を使い、JSONだけを返してください。",
      user: JSON.stringify({ task: "buzz-diagnosis", body: parsed.data.body, purpose: parsed.data.purpose, hasMedia: parsed.data.hasMedia, mediaCount: parsed.data.mediaCount }),
    }, { budget: c.get("budget"), retries: 1, signal: c.req.raw.signal });
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw new AiError("AI_BAD_OUTPUT", "診断結果を読み取れませんでした", raw.slice(0, 500)); }
    const result = buzzDiagnosisOutputSchema.safeParse(json);
    if (!result.success) throw new AiError("AI_BAD_OUTPUT", "診断結果の形式が正しくありません", null, false, "content_validation");
    const priority = result.data.sections.reduce((lowest, section) =>
      section.score / section.maxScore < lowest.score / lowest.maxScore ? section : lowest,
    ).key;
    const hookSuggestions = result.data.hookSuggestions.map((suggestion) =>
      suggestion.replace(/\r/g, "").split("\n").find((line) => line.trim() !== "")?.trim().slice(0, 80) ?? suggestion.trim().slice(0, 80),
    );
    return c.json(ok({ ...result.data, priority, hookSuggestions } satisfies BuzzDiagnosisResponse));
  });

  return r;
}
