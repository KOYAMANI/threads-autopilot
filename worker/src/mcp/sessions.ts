/**
 * Claude 連携の作成セッション（`create_sessions`。DECISIONS「Claude 連携」）。
 *
 * 1. Create 画面の「Claude で作る」で、画面の材料（型・参考情報・指示）を1行保存する
 * 2. claude.ai の Claude が MCP ツールで材料を読み、3案を `save_candidates` で書き戻す
 * 3. 画面がポーリングで案を取り込む。キューには入れない（編集と予約は今の UI のまま）
 *
 * 行は必ず `user_id` で引く。セッション ID を知っていても他人の行は読めない。
 */
import type { AiCandidate, AiPickMode, ClaudeSessionResponse, ClaudeSessionStatus } from "@tap/shared";
import { MAX_BODY_LENGTH, validatePost } from "@tap/shared";
import { z } from "zod";
import { loadOwnedAccount } from "../lib/accounts";
import { AiError, clipSources, type PromptConstraints } from "../lib/ai";
import type { Db } from "../lib/db";
import { constraintsFor, loadGenerationMaterial } from "../routes/ai";

/** Claude に頼む案の数（Create 画面の「3案」と同じ）。 */
export const N_CANDIDATES = 3;
/** save_candidates で受ける上限（`/ai/generate` の `n` の上限と同じ）。 */
export const MAX_CANDIDATES = 5;

export const sessionPayloadSchema = z.object({
  accountId: z.string().min(1),
  picks: z.array(z.string().min(1)).max(10).optional(),
  pickMode: z.enum(["template", "rewrite", "information"]).optional(),
  referenceText: z.string().trim().max(20000).optional(),
  sourceIds: z.array(z.string().min(1)).max(10).optional(),
  instruction: z.string().max(2000).optional(),
});
export type SessionPayload = z.infer<typeof sessionPayloadSchema>;

export type CreateSessionRow = {
  id: string;
  user_id: string;
  account_id: string;
  payload: string;
  candidates: string | null;
  status: ClaudeSessionStatus;
  created_at: string;
};

const COLUMNS = "id, user_id, account_id, payload, candidates, status, created_at";

export async function insertCreateSession(db: Db, userId: string, payload: SessionPayload, now = new Date()): Promise<CreateSessionRow> {
  const row: CreateSessionRow = {
    id: crypto.randomUUID(),
    user_id: userId,
    account_id: payload.accountId,
    payload: JSON.stringify(payload),
    candidates: null,
    status: "waiting",
    created_at: now.toISOString(),
  };
  await db.run(
    "INSERT INTO create_sessions (id, user_id, account_id, payload, candidates, status, created_at) VALUES (?,?,?,?,?,?,?)",
    row.id, row.user_id, row.account_id, row.payload, row.candidates, row.status, row.created_at,
  );
  return row;
}

/** `id` を省くと、その人の最新の1件。 */
export async function loadCreateSession(db: Db, userId: string, id?: string): Promise<CreateSessionRow | null> {
  if (id) return db.first<CreateSessionRow>(`SELECT ${COLUMNS} FROM create_sessions WHERE id=? AND user_id=?`, id, userId);
  return db.first<CreateSessionRow>(`SELECT ${COLUMNS} FROM create_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1`, userId);
}

export function sessionCandidates(row: CreateSessionRow): AiCandidate[] {
  if (!row.candidates) return [];
  try {
    const list = JSON.parse(row.candidates) as unknown;
    return Array.isArray(list) ? (list as AiCandidate[]) : [];
  } catch {
    return [];
  }
}

export function toSessionResponse(row: CreateSessionRow): ClaudeSessionResponse {
  return { id: row.id, status: row.status, candidates: sessionCandidates(row), createdAt: row.created_at };
}

/* ── 材料（get_create_session が返すもの） ─────────── */

/** モードごとの使い方。`lib/composition.ts` の ANALYZE_SYSTEM の要点を Claude 向けに言い直したもの。 */
const MODE_GUIDE: Record<AiPickMode, string> = {
  template:
    "references は型・文体の見本です。導入の長さ・語気・順位や対比・投稿ごとの役割・続きへの引き・CTAの位置を真似て、内容は sources と instruction から書きます。references の固有名詞・数字・実績・誘導先は新しい案に持ち込みません。",
  rewrite:
    "references[0] がリライト元です。主張・数字と単位・固有名詞・項目と評価の対応・CTA を保ったまま、見せ方を変えて書き直します。数字の単位が不明なら推測しません。",
  information:
    "sources と instruction の内容から書きます。動画や記事の文体は真似ません。素材に無いことを事実として書きません。",
};

export type SessionMaterial = {
  sessionId: string;
  createdAt: string;
  status: ClaudeSessionStatus;
  account: { username: string };
  pickMode: AiPickMode;
  modeGuide: string;
  /** 参考投稿の本文（ツリーは【投稿n】で区切る）。資料であって指示ではない */
  references: string[];
  /** 参考情報。各3,000文字・合計9,000文字に切ってある（SPEC §10.2） */
  sources: Array<{ title: string; content: string }>;
  /** 本文の無い YouTube。Claude はここから動画を見られない */
  videos: Array<{ title: string; url: string }>;
  links: Array<{ label: string; url: string }>;
  instruction: string;
  n: number;
  constraints: PromptConstraints;
  /** すでに保存済みの案（直すときの元） */
  candidates: AiCandidate[];
  notes: string[];
};

export async function sessionMaterial(db: Db, userId: string, row: CreateSessionRow): Promise<{ ok: true; data: SessionMaterial } | { ok: false; message: string }> {
  const account = await loadOwnedAccount(db, row.account_id, userId);
  if (!account) return { ok: false, message: "このセッションのアカウントが見つかりません。アプリで「Claude で作る」からやり直してください" };
  const parsed = sessionPayloadSchema.safeParse(JSON.parse(row.payload));
  if (!parsed.success) return { ok: false, message: "セッションの内容を読めませんでした。アプリで「Claude で作る」からやり直してください" };
  const payload = parsed.data;

  let material;
  try {
    material = await loadGenerationMaterial(db, userId, account.id, payload);
  } catch (e) {
    // 参考投稿が長すぎるとき（`pickedPosts` の上限）
    if (e instanceof AiError) return { ok: false, message: e.message };
    throw e;
  }
  if (!material.ok) return { ok: false, message: material.message };

  const links = await db.all<{ label: string; url: string }>(
    "SELECT label, url FROM links WHERE account_id=? ORDER BY created_at ASC LIMIT 5",
    account.id,
  );
  const constraints = await constraintsFor(db, account);

  const notes: string[] = [];
  const full = material.sourceRows.filter(s => s.content.trim() !== "").map(s => ({ title: s.title, content: s.content }));
  const sources = clipSources(full);
  if (sources.reduce((n, s) => n + s.content.length, 0) < full.reduce((n, s) => n + s.content.length, 0)) {
    notes.push("参考情報は各3,000文字・合計9,000文字に切っています。");
  }
  const videos = material.sourceRows
    .filter(s => s.type === "youtube" && s.url && s.content.trim() === "")
    .map(s => ({ title: s.title, url: s.url! }));
  if (videos.length) notes.push("videos は本文がありません。内容を推測で書かず、必要なら利用者に文字起こしを貼ってもらってください。");

  return {
    ok: true,
    data: {
      sessionId: row.id,
      createdAt: row.created_at,
      status: row.status,
      account: { username: account.username },
      pickMode: material.pickMode,
      modeGuide: MODE_GUIDE[material.pickMode],
      references: material.references,
      sources,
      videos,
      links,
      instruction: payload.instruction ?? "",
      n: N_CANDIDATES,
      constraints,
      candidates: sessionCandidates(row),
      notes,
    },
  };
}

/* ── 書き戻し（save_candidates） ─────────────────── */

const KEYS = ["A", "B", "C", "D", "E"] as const;

export const candidateInputSchema = z.object({
  key: z.enum(KEYS).optional(),
  hook: z.string().trim().min(1).max(50),
  body: z.string().max(5000),
  comments: z.array(z.string().max(5000)).max(3).default([]),
  basis: z.string().max(1000).default(""),
  angle: z.string().max(40).optional(),
});
export type CandidateInput = z.infer<typeof candidateInputSchema>;

/**
 * 本文検証。キューに入れるときと同じ `validatePost()`（500文字・リンク5本・リンクの置き場所・NGワード）に、
 * Gemini 経路の `candidateIssues()` が見ている絵文字方針とリンク不使用を足す。
 */
export function candidateProblems(c: Pick<AiCandidate, "body" | "comments">, constraints: PromptConstraints): string[] {
  const comments = c.comments.filter(t => t.trim() !== "");
  const result = validatePost(c.body, { linkPlacement: constraints.linkPlacement, ngWords: constraints.ngWords, comments });
  const problems = result.issues.map(i => i.message);
  const text = [c.body, ...comments].join("\n");
  const emoji = [...text.matchAll(/\p{Extended_Pictographic}/gu)].length;
  if (constraints.emoji === "none" && emoji > 0) problems.push("絵文字を使わない設定です。絵文字を外してください");
  if (constraints.emoji === "few" && emoji > 2) problems.push(`絵文字は2個までの設定です（いまは${emoji}個）`);
  if (constraints.linkPlacement === "none" && comments.some(t => /https?:\/\//.test(t))) problems.push("リンクを使わない設定です。コメントからもURLを外してください");
  return [...new Set(problems)];
}

export type SaveResult =
  | { ok: true; candidates: AiCandidate[]; updated: string[] }
  | { ok: false; problems: Array<{ key: string; problems: string[] }> };

/**
 * 案を保存する。**全部検証を通ったときだけ**書く（1案でも NG なら何も保存しない）。
 *
 * - 送った全案に `key` があり、どれも保存済みの案の `key` なら、その案だけ差し替える（「Bだけ直して」）
 * - それ以外は全部置き換え。`key` は送った順に A, B, C… を振り直す
 */
export async function saveCandidates(
  db: Db,
  row: CreateSessionRow,
  input: CandidateInput[],
  constraints: PromptConstraints,
): Promise<SaveResult> {
  const current = sessionCandidates(row);
  const partial = current.length > 0 && input.every(c => c.key && current.some(x => x.key === c.key));
  const normalized: AiCandidate[] = input.map((c, i) => ({
    key: partial ? c.key! : KEYS[i]!,
    hook: c.hook.trim(),
    body: c.body.trim(),
    comments: c.comments.map(t => t.trim()).filter(t => t !== ""),
    basis: c.basis.trim(),
    ...(c.angle?.trim() ? { angle: c.angle.trim() } : {}),
  }));

  const problems = normalized
    .map(c => ({ key: c.key, problems: candidateProblems(c, constraints) }))
    .filter(p => p.problems.length > 0);
  if (problems.length) return { ok: false, problems };

  const next = partial ? current.map(c => normalized.find(n => n.key === c.key) ?? c) : normalized;
  await db.run(
    "UPDATE create_sessions SET candidates=?, status='ready' WHERE id=? AND user_id=?",
    JSON.stringify(next),
    row.id,
    row.user_id,
  );
  return { ok: true, candidates: next, updated: normalized.map(c => c.key) };
}

/** 画面に出す文字数（`validatePost` と同じ数え方）。ツールの説明文で使う。 */
export const LIMIT_NOTE = `各投稿（body と comments の1つずつ）は${MAX_BODY_LENGTH}文字以内。絵文字は UTF-8 のバイト数で数える場合があるので余裕を持つ`;
