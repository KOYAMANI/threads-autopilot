/**
 * AI 連携（SPEC §10）。
 *
 * AI を使うのは **本文の生成と修正だけ**（`POST /ai/generate` / `POST /ai/revise` /
 * `ap_plan` の生成）。採点（§9.2）・集計（`learning`）・枠と型の選択（§9.3 / §9.4）・
 * 重複判定（§8.3）・クリックの按分（§8.5）に AI は一切使わない。
 *
 * - 出力は JSON 固定（Gemini: `responseMimeType`、OpenRouter: `response_format`）
 * - ダメなら ```json フェンスを剥がしてパース、それでもダメなら `AI_BAD_OUTPUT`
 * - タイムアウト60秒、1回リトライ
 * - キーの所在: `store_on_server=1` なら DB の `key_enc`、`0` ならリクエストの `clientKey`
 */
import type { AiCandidate, AiHistoryTurn, AiProvider } from "@tap/shared";
import { AI_DEFAULT_MODEL } from "@tap/shared";
import { DEV, type Env } from "../env";
import type { Budget } from "./budget";
import { redact } from "./redact";

export const AI_TIMEOUT_MS = 60_000;
/** 失敗時の再試行は1回だけ（SPEC §10.1）。 */
export const AI_RETRIES = 1;

/** 型の候補（SPEC §10.3 の User プロンプト）。`shared/src/tags.ts` の型名と揃える。 */
export const HOOK_TYPES = [
  "呼びかけ型",
  "警告型",
  "意外性型",
  "疑問型",
  "数字型",
  "断定型",
  "体験談型",
] as const;

export class AiError extends Error {
  readonly code: "AI_BAD_OUTPUT" | "AI_FAILED" | "AI_KEY_REQUIRED";
  readonly raw: string | null;
  constructor(
    code: "AI_BAD_OUTPUT" | "AI_FAILED" | "AI_KEY_REQUIRED",
    message: string,
    raw: string | null = null,
  ) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.raw = raw === null ? null : redact(raw).slice(0, 500);
  }
}

/* ── JSON の取り出し（SPEC §10.1） ───────────────────── */

/** ```json フェンスを剥がす。前後の説明文も落とす。 */
export function stripJsonFence(text: string): string {
  const t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]) return fence[1].trim();
  return t;
}

/** JSON として読む。フェンス剥がし → 最初の { … } の切り出し、まで試す。 */
export function parseJsonLoose(text: string): unknown {
  const candidates = [text.trim(), stripJsonFence(text)];
  const stripped = stripJsonFence(text);
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(stripped.slice(first, last + 1));

  for (const c of candidates) {
    if (c === "") continue;
    try {
      return JSON.parse(c) as unknown;
    } catch {
      // 次の候補
    }
  }
  throw new AiError("AI_BAD_OUTPUT", "AIの応答をJSONとして読めませんでした", text.slice(0, 500));
}

/* ── プロンプト（SPEC §10.3） ────────────────────────── */

export type PromptConstraints = {
  linkPlacement: "comment" | "body" | "none";
  ngWords: string;
  /** 絵文字方針（設定 `emoji: none|few`。SPEC §10.2） */
  emoji: "none" | "few";
};

export function systemPrompt(c: PromptConstraints): string {
  const placement =
    c.linkPlacement === "comment" ? "コメント" : c.linkPlacement === "body" ? "本文" : "使わない";
  const lines = [
    "あなたはThreads（Meta）の投稿を書く編集者です。読者はスマホで流し読みしています。",
    "ルール:",
    "- 1行目で「誰に向けた話か」か「結論」を言う。前置きは書かない",
    "- 1投稿目は500文字以内。改行で区切り、1段落は3行以内",
    `- リンクは ${placement} に置く。${c.linkPlacement === "comment" ? "本文にURLを書かない" : c.linkPlacement === "none" ? "URLを書かない" : "本文に置いてよい"}`,
    `- 使わない言葉: ${c.ngWords.trim() === "" ? "（指定なし）" : c.ngWords.replace(/\s*\n\s*/g, ", ")}`,
    '- 文体は「文体の見本」に合わせる。語尾・一人称・改行の癖を真似る。内容は真似ない',
    "- 参考情報に無いことを事実として書かない。数字は参考情報にあるものだけ使う",
    c.emoji === "none" ? "- 絵文字は使わない" : "- 絵文字は多くても1〜2個",
    "出力はJSONのみ:",
    '{"candidates":[{"hook":"型名","body":"1投稿目","comments":["コメント①"],"basis":"参考情報のどこを使ったか1文"}]}',
  ];
  return lines.join("\n");
}

export type BuildContextInput = {
  /** 文体の見本（picks か score 上位3本）。本文だけ渡す */
  templates: string[];
  /** リライト元（pickMode='rewrite' の1本目） */
  rewriteFrom: string | null;
  /** 参考情報。各3,000字・合計9,000字までに切ってから渡す */
  sources: Array<{ title: string; content: string }>;
  /** Gemini に動画として渡す YouTube URL */
  youtubeUrls: string[];
  links: Array<{ label: string; url: string }>;
  instruction: string;
  n: number;
};

/** 参考情報の上限（SPEC §10.2）。 */
export const SOURCE_CHARS_EACH = 3_000;
export const SOURCE_CHARS_TOTAL = 9_000;

/** 各3,000字・合計9,000字に収める（SPEC §10.2）。 */
export function clipSources(
  sources: Array<{ title: string; content: string }>,
): Array<{ title: string; content: string }> {
  const out: Array<{ title: string; content: string }> = [];
  let total = 0;
  for (const s of sources) {
    if (total >= SOURCE_CHARS_TOTAL) break;
    const room = Math.min(SOURCE_CHARS_EACH, SOURCE_CHARS_TOTAL - total);
    const content = (s.content ?? "").slice(0, room);
    out.push({ title: s.title, content });
    total += content.length;
  }
  return out;
}

/** User プロンプト（作る画面。SPEC §10.3）。 */
export function buildContext(input: BuildContextInput): string {
  const parts: string[] = [];

  if (input.templates.length > 0) {
    parts.push(
      "# 文体の見本（語尾・一人称・改行の癖だけ真似る。内容は真似ない）\n" +
        input.templates.map((t, i) => `## 見本${i + 1}\n${t}`).join("\n\n"),
    );
  }
  if (input.rewriteFrom) {
    parts.push(
      "# リライト元\nこの投稿を、内容を保ったまま別の切り口で書き直す。\n\n" + input.rewriteFrom,
    );
  }
  const sources = clipSources(input.sources);
  if (sources.length > 0) {
    parts.push(
      "# 参考情報（ここに無いことを事実として書かない）\n" +
        sources.map((s) => `## ${s.title}\n${s.content}`).join("\n\n"),
    );
  }
  if (input.youtubeUrls.length > 0) {
    parts.push("# 参考動画\n" + input.youtubeUrls.join("\n"));
  }
  if (input.links.length > 0) {
    parts.push("# リンク\n" + input.links.map((l) => `${l.label}: ${l.url}`).join("\n"));
  }
  parts.push("# 指示\n" + (input.instruction.trim() === "" ? "（指定なし）" : input.instruction));
  parts.push(
    `型を変えて${input.n}案。型の候補: ${HOOK_TYPES.join(", ")}`,
  );
  return parts.join("\n\n");
}

/** Revise（SPEC §10.3）。直前の候補JSON＋会話履歴＋指示 → 同じJSON形式で1案。 */
export function buildRevisePrompt(
  candidate: AiCandidate,
  instruction: string,
  history: AiHistoryTurn[],
): string {
  const parts: string[] = [];
  if (history.length > 0) {
    parts.push(
      "# これまでのやりとり\n" +
        history
          .slice(-10)
          .map((h) => `${h.role === "user" ? "指示" : "AI"}: ${h.text}`)
          .join("\n"),
    );
  }
  parts.push(
    "# 直前の案\n" +
      JSON.stringify(
        { hook: candidate.hook, body: candidate.body, comments: candidate.comments },
        null,
        2,
      ),
  );
  parts.push("# 指示\n" + instruction);
  parts.push("この1案だけを直して、同じJSON形式で1案だけ返す（candidates の要素は1つ）。");
  return parts.join("\n\n");
}

/* ── プロバイダ（SPEC §10.1） ────────────────────────── */

export type AiCallInput = {
  provider: AiProvider;
  model: string;
  apiKey: string;
  system: string;
  user: string;
  /** Gemini のときだけ渡す。`file_data` として contents に足す（SPEC §10.2） */
  youtubeUrls?: string[];
  appOrigin: string;
};

export type AiRequestPlan = { url: string; init: RequestInit };

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** リクエストの組み立て。テストはここを直接見る。 */
export function buildRequest(input: AiCallInput): AiRequestPlan {
  if (input.provider === "gemini") {
    const parts: unknown[] = [{ text: input.user }];
    for (const url of input.youtubeUrls ?? []) {
      parts.push({ file_data: { file_uri: url } });
    }
    return {
      url: `${GEMINI_BASE}/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.9 },
        }),
      },
    };
  }

  return {
    url: OPENROUTER_URL,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
        "HTTP-Referer": input.appOrigin,
        "X-Title": "Threads Autopilot",
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.9,
      }),
    },
  };
}

/** 応答から本文テキストを取り出す。形が違えば `AI_BAD_OUTPUT`。 */
export function readResponseText(provider: AiProvider, json: unknown): string {
  if (provider === "gemini") {
    const parts = (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
      ?.candidates?.[0]?.content?.parts;
    const text = (parts ?? [])
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("")
      .trim();
    if (text === "") {
      throw new AiError("AI_BAD_OUTPUT", "AIの応答が空でした", JSON.stringify(json).slice(0, 500));
    }
    return text;
  }
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new AiError("AI_BAD_OUTPUT", "AIの応答が空でした", JSON.stringify(json).slice(0, 500));
  }
  return content;
}

export type AiCallOptions = {
  budget?: Budget;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
};

/** 1回だけ叩く（リトライは `callAi` 側）。 */
async function callOnce(
  input: AiCallInput,
  options: AiCallOptions,
): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const plan = buildRequest(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? AI_TIMEOUT_MS);
  options.budget?.subrequests.use();
  try {
    const res = await doFetch(plan.url, { ...plan.init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new AiError(
        "AI_FAILED",
        `AIの呼び出しに失敗しました（${res.status}）`,
        text.slice(0, 500),
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new AiError("AI_BAD_OUTPUT", "AIの応答をJSONとして読めませんでした", text.slice(0, 500));
    }
    return readResponseText(input.provider, json);
  } catch (e) {
    if (e instanceof AiError) throw e;
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new AiError(
      "AI_FAILED",
      aborted
        ? "AIの応答が60秒以内に返りませんでした。もう一度お試しください"
        : "AIの呼び出しに失敗しました。キーとモデル名をご確認ください",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生の応答テキストを返す。タイムアウト60秒・1回リトライ（SPEC §10.1）。
 * `AI_BAD_OUTPUT`（応答の形が違う）も1回だけ引き直す。
 */
export async function callAi(input: AiCallInput, options: AiCallOptions = {}): Promise<string> {
  const retries = options.retries ?? AI_RETRIES;
  let last: AiError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callOnce(input, options);
    } catch (e) {
      if (!(e instanceof AiError)) throw e;
      last = e;
      if (e.code === "AI_KEY_REQUIRED") break;
    }
  }
  throw last ?? new AiError("AI_FAILED", "AIの呼び出しに失敗しました");
}

/* ── 候補の取り出し ─────────────────────────────────── */

const KEYS = ["A", "B", "C", "D", "E"];

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : "")).filter((x) => x.trim() !== "");
}

/** `{"candidates":[{hook,body,comments,basis}]}` を読む。形が違えば `AI_BAD_OUTPUT`。 */
export function readCandidates(raw: string, n: number): AiCandidate[] {
  const json = parseJsonLoose(raw);
  const list = (json as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list) || list.length === 0) {
    throw new AiError("AI_BAD_OUTPUT", "AIの応答に案が入っていませんでした", raw.slice(0, 500));
  }
  const out: AiCandidate[] = [];
  for (const item of list.slice(0, Math.max(1, n))) {
    const o = item as Record<string, unknown>;
    const body = typeof o.body === "string" ? o.body.trim() : "";
    if (body === "") continue;
    out.push({
      key: KEYS[out.length] ?? String(out.length + 1),
      hook: typeof o.hook === "string" && o.hook.trim() !== "" ? o.hook.trim() : "その他",
      body,
      comments: asStringArray(o.comments).slice(0, 3),
      basis: typeof o.basis === "string" ? o.basis.trim() : "",
    });
  }
  if (out.length === 0) {
    throw new AiError("AI_BAD_OUTPUT", "AIの応答に本文が入っていませんでした", raw.slice(0, 500));
  }
  return out;
}

/* ── モック（SPEC §11 と同じ形の DEV ガード） ────────── */

/**
 * `AI_MOCK=1` かつ DEV ビルドのときだけ、固定の JSON を返す。
 * 本番バンドルには含めない（`scripts/check-bundle.sh` が識別子を数える）。
 * `lib/threads.ts` の `call()` と同じで、**`__DEV__` を識別子のまま**分岐に書く。
 */
export function aiMockAvailable(env: Env): boolean {
  return DEV && env.AI_MOCK === "1";
}

export async function generateRaw(
  env: Env,
  input: AiCallInput,
  options: AiCallOptions = {},
): Promise<string> {
  if (__DEV__ && env.AI_MOCK === "1") {
    const mod = await import("../mock/ai");
    return mod.default({ system: input.system, user: input.user, provider: input.provider });
  }
  return callAi(input, options);
}

export function defaultModel(provider: AiProvider): string {
  return AI_DEFAULT_MODEL[provider];
}
