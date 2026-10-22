/**
 * note 記事（SPEC §7.10）。
 *
 * - 下書き（memo・資料・文体）は各ステップで `PATCH` して保存する（リロードに強い）
 * - `POST /:id/outline` … Gemini が目次を作る。確かめたいことがあれば質問を1つ返す（最大3回）
 * - `POST /:id/write`   … 章を `todo` で並べ、ジョブ `note_write` を投入する（章ごとに届く）
 * - `POST /:id/sections/:sid/revise` … 1章を指示で直す（同期）
 * - 原稿の書き出しは画面側（`shared/src/note-export.ts`）。サーバーは持たない
 */
import { Hono } from "hono";
import { z } from "zod";
import { NOTE_MAX_CHAPTERS, NOTE_MAX_QUESTIONS, noteCharCount, ok } from "@tap/shared";
import type { NoteDetail, NoteOutline, NoteOutlineResponse, NoteQa, NoteRefProfile, NoteSection, NoteStatus, NoteStyle, NoteSummary, NoteVolume } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { loadOwnedAccount } from "../lib/accounts";
import { AiError, generateRaw } from "../lib/ai";
import { resolveServerKey } from "../lib/ai-key";
import { audit } from "../lib/audit";
import type { Db } from "../lib/db";
import type { Env } from "../env";
import { createJobContext, enqueueJob, jobContextFrom, runJobs } from "../lib/jobs";
import {
  NOTE_MEMO_MAX,
  NOTE_OUTLINE_MAX_TOKENS,
  NOTE_OUTLINE_SYSTEM,
  NOTE_REF_MAX,
  NOTE_REVISE_SYSTEM,
  NOTE_WRITE_MAX_TOKENS,
  buildOutlinePrompt,
  buildRevisePrompt,
  normalizeOutline,
  readChapter,
  readOutline,
  NOTE_DIGEST_SYSTEM,
  NOTE_DIGEST_TIMEOUT_MS,
  buildDigestPrompt,
  needsVideoDigest,
  readDigest,
  sourcesForNote,
  type NoteSourceRow,
} from "../lib/note-writing";
import { wakeJob } from "../jobs/note-write";
import { RATE_LIMITS, aiKey, rateAllow, rateRecord } from "../lib/rate";

const STYLES = ["story", "general"] as const;
const VOLUMES = ["short", "standard", "same"] as const;
/** 目次と直しは同期で1回ずつ。投稿の生成（60秒）より長い章立てもあるので余裕を持つ。 */
const OUTLINE_TIMEOUT_MS = 90_000;
const REVISE_TIMEOUT_MS = 120_000;

const createSchema = z.object({
  accountId: z.string().min(1),
  title: z.string().trim().max(120).optional(),
  memo: z.string().max(NOTE_MEMO_MAX).default(""),
});

const outlineSchema = z.object({
  chapters: z.array(z.object({
    heading: z.string().trim().min(1).max(120),
    targetChars: z.number().int().min(300).max(12_000),
    sections: z.array(z.object({ title: z.string().trim().min(1).max(120), caution: z.string().trim().max(300).optional() })).max(12),
  })).min(1).max(NOTE_MAX_CHAPTERS),
});

const patchSchema = z.object({
  title: z.string().trim().max(120).optional(),
  memo: z.string().max(NOTE_MEMO_MAX).optional(),
  style: z.enum(STYLES).optional(),
  volume: z.enum(VOLUMES).optional(),
  refNote: z.string().max(NOTE_REF_MAX).optional(),
  sourceIds: z.array(z.string().min(1)).max(10).optional(),
  outline: outlineSchema.optional(),
  paywallAfter: z.number().int().min(0).max(NOTE_MAX_CHAPTERS).nullable().optional(),
});

const outlineRequestSchema = z.object({
  answer: z.string().trim().max(2_000).optional(),
  assume: z.boolean().optional(),
});

const reviseSchema = z.object({ instruction: z.string().trim().min(1).max(2_000) });
const writeSchema = z.object({ resume: z.boolean().optional() });

type NoteRow = {
  id: string; user_id: string; account_id: string; title: string; title_options_json: string; memo: string;
  style: string; volume: string; ref_note: string; ref_profile_json: string | null; source_ids_json: string;
  outline_json: string | null; paywall_after: number | null; qa_json: string; status: string; engine: string;
  source_digest_json: string; created_at: string; updated_at: string;
};
type SectionRow = {
  id: string; note_id: string; ord: number; heading: string; target_chars: number; body: string; summary: string;
  char_count: number; status: string; error: string | null; updated_at: string;
};

const NOTE_SELECT =
  "id, user_id, account_id, title, title_options_json, memo, style, volume, ref_note, ref_profile_json, source_ids_json, outline_json, paywall_after, qa_json, status, engine, source_digest_json, created_at, updated_at";
const SECTION_SELECT = "id, note_id, ord, heading, target_chars, body, summary, char_count, status, error, updated_at";

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

function toSection(row: SectionRow): NoteSection {
  return {
    id: row.id, ord: row.ord, heading: row.heading, targetChars: row.target_chars, body: row.body, summary: row.summary,
    charCount: row.char_count, status: row.status as NoteSection["status"], error: row.error, updatedAt: row.updated_at,
  };
}

function toDetail(row: NoteRow, sections: SectionRow[]): NoteDetail {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    titleOptions: parseJson<string[]>(row.title_options_json, []),
    memo: row.memo,
    style: row.style as NoteStyle,
    volume: row.volume as NoteVolume,
    refNote: row.ref_note,
    refProfile: parseJson<NoteRefProfile | null>(row.ref_profile_json, null),
    sourceIds: parseJson<string[]>(row.source_ids_json, []),
    outline: parseJson<NoteOutline | null>(row.outline_json, null),
    paywallAfter: row.paywall_after,
    qa: parseJson<NoteQa[]>(row.qa_json, []),
    status: row.status as NoteStatus,
    engine: "gemini",
    sections: sections.map(toSection),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadNote(db: Db, id: string, userId: string): Promise<NoteRow | null> {
  return db.first<NoteRow>(`SELECT ${NOTE_SELECT} FROM notes WHERE id=? AND user_id=?`, id, userId);
}

async function loadSections(db: Db, noteId: string): Promise<SectionRow[]> {
  return db.all<SectionRow>(`SELECT ${SECTION_SELECT} FROM note_sections WHERE note_id=? ORDER BY ord`, noteId);
}

async function detail(db: Db, row: NoteRow): Promise<NoteDetail> {
  return toDetail(row, await loadSections(db, row.id));
}

async function loadSources(db: Db, userId: string, ids: string[]): Promise<NoteSourceRow[]> {
  const unique = [...new Set(ids)].slice(0, 10);
  if (!unique.length) return [];
  return db.all<NoteSourceRow>(
    `SELECT id, type, title, content, url FROM sources WHERE user_id=? AND id IN (${unique.map(() => "?").join(",")})`,
    userId, ...unique,
  );
}

/**
 * 本文の無い YouTube 資料を Gemini に見せて要点を書き出し、note に保存する（目次の前に1回だけ）。
 * 動画は並べて読む。1本失敗しても他は使う。
 */
async function ensureVideoDigests(
  env: Env, db: Db, row: NoteRow, rows: NoteSourceRow[],
  key: { provider: "gemini"; model: string; apiKey: string }, budget: unknown,
): Promise<{ digests: Record<string, string>; notes: string[] }> {
  const digests = parseJson<Record<string, string>>(row.source_digest_json, {});
  const missing = rows.filter((s) => needsVideoDigest(s) && !digests[s.id]);
  if (!missing.length) return { digests, notes: [] };
  const results = await Promise.allSettled(missing.map((s) => generateRaw(
    env,
    { provider: key.provider, model: key.model, apiKey: key.apiKey, system: NOTE_DIGEST_SYSTEM, user: buildDigestPrompt(s.title), youtubeUrls: [s.url!], appOrigin: env.APP_ORIGIN },
    { budget: budget as never, timeoutMs: NOTE_DIGEST_TIMEOUT_MS, retries: 0 },
  ).then(readDigest)));
  const notes: string[] = [];
  results.forEach((r, i) => {
    const s = missing[i]!;
    if (r.status === "fulfilled") digests[s.id] = r.value;
    else notes.push(`「${s.title}」の動画を読めませんでした（${r.reason instanceof Error ? r.reason.message : "失敗"}）。文字起こしを貼ると使えます`);
  });
  await db.run("UPDATE notes SET source_digest_json=? WHERE id=?", JSON.stringify(digests), row.id);
  return { digests, notes };
}

/** 1分10回（`/ai/*` と同じ `ai:<user_id>`）。AI を実際に呼ぶ経路だけ。 */
async function aiRateLimit(c: { get: (k: "db" | "userId") => any }, next: () => Promise<void>): Promise<Response | void> {
  const db = c.get("db");
  const userId = c.get("userId") as string | null;
  if (!userId) return next();
  const key = aiKey(userId);
  const now = new Date();
  const allowed = await rateAllow(db, key, RATE_LIMITS.ai.limit, RATE_LIMITS.ai.windowMin, now);
  await rateRecord(db, key, now);
  if (!allowed) return fail("RATE_LIMITED", "少し早すぎます。1分ほど空けてからもう一度お試しください", 429);
  return next();
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try { return await c.req.json(); } catch { return null; }
}

/**
 * 投入したジョブを動かす。Queue があれば送る。無ければ（ローカル開発）このリクエストの
 * 裏で章を順に書く。本番は Queue 前提なので、ここでの直接実行は DEV だけ。
 */
async function kickNoteJob(c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } }, db: Db, budget: AppEnv["Variables"]["budget"], jobId: string, noteId: string): Promise<void> {
  const ctx = jobContextFrom(c.env, db, budget);
  if (c.env.JOB_QUEUE) { await wakeJob(ctx, jobId); return; }
  if (!__DEV__ || c.env.NOTE_JOBS_INLINE !== "1") return;
  c.executionCtx.waitUntil((async () => {
    let next: string | null = jobId;
    for (let i = 0; next && i < NOTE_MAX_CHAPTERS + 2; i++) {
      await runJobs(createJobContext(c.env), undefined, next);
      const row = await createJobContext(c.env).sys.first<{ id: string }>(
        "SELECT id FROM jobs WHERE type='note_write' AND status='pending' AND json_extract(state_json,'$.noteId')=? ORDER BY next_run_at LIMIT 1",
        noteId,
      );
      next = row?.id ?? null;
    }
  })());
}

export function noteRoutes() {
  const r = new Hono<AppEnv>();
  r.use("/:id/outline", aiRateLimit);
  r.use("/:id/sections/:sid/revise", aiRateLimit);

  r.get("/", async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const accountId = c.req.query("accountId") ?? "";
    const account = await loadOwnedAccount(db, accountId, userId);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const rows = await db.all<NoteRow & { chars: number | null; chapters_done: number | null; chapters_total: number | null }>(
      `SELECT n.${NOTE_SELECT.split(", ").join(", n.")},
              (SELECT SUM(char_count) FROM note_sections s WHERE s.note_id=n.id AND s.status='done') AS chars,
              (SELECT COUNT(*) FROM note_sections s WHERE s.note_id=n.id AND s.status='done') AS chapters_done,
              (SELECT COUNT(*) FROM note_sections s WHERE s.note_id=n.id) AS chapters_total
       FROM notes n WHERE n.user_id=? AND n.account_id=? ORDER BY n.updated_at DESC LIMIT 100`,
      userId, account.id,
    );
    const notes: NoteSummary[] = rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      title: row.title,
      status: row.status as NoteStatus,
      chars: row.chars ?? 0,
      chaptersDone: row.chapters_done ?? 0,
      chaptersTotal: row.chapters_total ?? (parseJson<NoteOutline | null>(row.outline_json, null)?.chapters.length ?? 0),
      updatedAt: row.updated_at,
    }));
    return c.json(ok({ notes }));
  });

  r.post("/", async (c) => {
    const parsed = createSchema.safeParse(await readBody(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const userId = c.get("userId")!;
    const account = await loadOwnedAccount(db, parsed.data.accountId, userId);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.run(
      "INSERT INTO notes (id, user_id, account_id, title, memo, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      id, userId, account.id, parsed.data.title ?? "", parsed.data.memo, now, now,
    );
    const row = (await loadNote(db, id, userId))!;
    return c.json(ok({ note: await detail(db, row) }), 201);
  });

  r.get("/:id", async (c) => {
    const db = c.get("db");
    const row = await loadNote(db, c.req.param("id"), c.get("userId")!);
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    return c.json(ok({ note: await detail(db, row) }));
  });

  r.patch("/:id", async (c) => {
    const parsed = patchSchema.safeParse(await readBody(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const userId = c.get("userId")!;
    const row = await loadNote(db, c.req.param("id"), userId);
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (row.status === "writing") return fail("CONFLICT", "書いている途中は変えられません。先に「やめる」を押してください", 409);
    const p = parsed.data;
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => { sets.push(`${col}=?`); params.push(v); };
    if (p.title !== undefined) set("title", p.title);
    if (p.memo !== undefined) set("memo", p.memo);
    if (p.style !== undefined) set("style", p.style);
    if (p.volume !== undefined) set("volume", p.volume);
    if (p.refNote !== undefined) set("ref_note", p.refNote);
    if (p.sourceIds !== undefined) set("source_ids_json", JSON.stringify([...new Set(p.sourceIds)]));
    let chapterCount = parseJson<NoteOutline | null>(row.outline_json, null)?.chapters.length ?? 0;
    if (p.outline !== undefined) {
      let outline: NoteOutline;
      try { outline = normalizeOutline(p.outline); } catch { return fail("BAD_REQUEST", "章立ての形が違います", 400); }
      chapterCount = outline.chapters.length;
      set("outline_json", JSON.stringify(outline));
    }
    if (p.paywallAfter !== undefined) {
      set("paywall_after", p.paywallAfter === null ? null : Math.min(Math.max(0, chapterCount - 2), p.paywallAfter));
    } else if (p.outline !== undefined && row.paywall_after !== null && row.paywall_after > chapterCount - 2) {
      set("paywall_after", Math.max(0, chapterCount - 2));
    }
    if (sets.length) {
      set("updated_at", new Date().toISOString());
      await db.run(`UPDATE notes SET ${sets.join(", ")} WHERE id=?`, ...params, row.id);
    }
    return c.json(ok({ note: await detail(db, (await loadNote(db, row.id, userId))!) }));
  });

  r.delete("/:id", async (c) => {
    const db = c.get("db");
    const row = await loadNote(db, c.req.param("id"), c.get("userId")!);
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    await db.batch([
      { sql: "DELETE FROM note_sections WHERE note_id=?", params: [row.id] },
      { sql: "DELETE FROM notes WHERE id=?", params: [row.id] },
    ]);
    return c.json(ok({ deleted: true }));
  });

  /* ── 目次（質問は最大3回） ───────────────────────── */

  r.post("/:id/outline", async (c) => {
    const parsed = outlineRequestSchema.safeParse(await readBody(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const userId = c.get("userId")!;
    const row = await loadNote(db, c.req.param("id"), userId);
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (row.status === "writing") return fail("CONFLICT", "書いている途中は目次を作り直せません", 409);
    if (row.memo.trim() === "") return fail("BAD_REQUEST", "書きたいことを入れてください", 400);

    const key = await resolveServerKey(c.env, db, userId);
    const qa = parseJson<NoteQa[]>(row.qa_json, []);
    const pending = qa.length > 0 && qa[qa.length - 1]!.answer === null ? qa[qa.length - 1]! : null;
    if (pending && parsed.data.answer !== undefined && parsed.data.answer !== "") pending.answer = parsed.data.answer;
    // 答えずに進めたときは、その質問はお任せ（答え空）として残す
    if (pending && pending.answer === null) pending.answer = "";
    const assume = Boolean(parsed.data.assume) || qa.length >= NOTE_MAX_QUESTIONS;

    const sourceRows = await loadSources(db, userId, parseJson<string[]>(row.source_ids_json, []));
    const video = await ensureVideoDigests(c.env, db, row, sourceRows, key, c.get("budget"));
    const sources = sourcesForNote(sourceRows, video.digests);
    const raw = await generateRaw(
      c.env,
      {
        provider: key.provider, model: key.model, apiKey: key.apiKey,
        system: NOTE_OUTLINE_SYSTEM,
        user: buildOutlinePrompt({ memo: row.memo, style: row.style as NoteStyle, volume: row.volume as NoteVolume, refNote: row.ref_note, sources, qa, assume }),
        appOrigin: c.env.APP_ORIGIN,
        maxOutputTokens: NOTE_OUTLINE_MAX_TOKENS,
      },
      { budget: c.get("budget"), timeoutMs: OUTLINE_TIMEOUT_MS, retries: 0 },
    );
    const result = readOutline(raw);
    const now = new Date().toISOString();
    if (result.status === "question" && !assume) {
      qa.push({ question: result.question, answer: null });
      await db.run("UPDATE notes SET qa_json=?, updated_at=? WHERE id=?", JSON.stringify(qa), now, row.id);
      const body: NoteOutlineResponse = { status: "question", question: result.question, round: qa.length };
      return c.json(ok(body));
    }
    if (result.status === "question") throw new AiError("AI_BAD_OUTPUT", "AIが目次を返しませんでした。もう一度お試しください");
    const title = result.titles[0] ?? row.title;
    await db.run(
      "UPDATE notes SET title=?, title_options_json=?, outline_json=?, paywall_after=?, ref_profile_json=?, qa_json=?, status='outlined', updated_at=? WHERE id=?",
      title, JSON.stringify(result.titles), JSON.stringify(result.outline), result.paywallAfter,
      result.refProfile ? JSON.stringify(result.refProfile) : null, JSON.stringify(qa), now, row.id,
    );
    const body: NoteOutlineResponse = { status: "ok", note: await detail(db, (await loadNote(db, row.id, userId))!), notes: [...video.notes, ...result.notes] };
    return c.json(ok(body));
  });

  /* ── 書く / やめる ──────────────────────────────── */

  r.post("/:id/write", async (c) => {
    const parsed = writeSchema.safeParse((await readBody(c)) ?? {});
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const userId = c.get("userId")!;
    const row = await loadNote(db, c.req.param("id"), userId);
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (row.status === "writing") return fail("CONFLICT", "すでに書いています", 409);
    const outline = parseJson<NoteOutline | null>(row.outline_json, null);
    if (!outline || outline.chapters.length === 0) return fail("BAD_REQUEST", "先に目次を作ってください", 400);
    await resolveServerKey(c.env, db, userId);
    const now = new Date().toISOString();
    const existing = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM note_sections WHERE note_id=?", row.id);
    if (parsed.data.resume && existing && existing.n > 0) {
      // 「やめる」のあとの続き。書けた章は残し、途中だった章から書く
      await db.batch([
        { sql: "UPDATE note_sections SET status='todo', error=NULL, updated_at=? WHERE note_id=? AND status IN ('writing','failed')", params: [now, row.id] },
        { sql: "UPDATE notes SET status='writing', updated_at=? WHERE id=?", params: [now, row.id] },
      ]);
    } else {
      await db.batch([
        { sql: "DELETE FROM note_sections WHERE note_id=?", params: [row.id] },
        ...outline.chapters.map((ch, ord) => ({
          sql: "INSERT INTO note_sections (id, note_id, ord, heading, target_chars, updated_at) VALUES (?,?,?,?,?,?)",
          params: [crypto.randomUUID(), row.id, ord, ch.heading, ch.targetChars, now],
        })),
        { sql: "UPDATE notes SET status='writing', updated_at=? WHERE id=?", params: [now, row.id] },
      ]);
    }
    const jobCtx = jobContextFrom(c.env, db, c.get("budget"));
    const jobId = await enqueueJob(jobCtx, "note_write", { accountId: row.account_id, state: { noteId: row.id }, force: true });
    await audit(db, userId, "note_write", { noteId: row.id, chapters: outline.chapters.length });
    if (jobId) await kickNoteJob(c, db, c.get("budget"), jobId, row.id);
    return c.json(ok({ note: await detail(db, (await loadNote(db, row.id, userId))!) }), 202);
  });

  r.post("/:id/cancel", async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const row = await loadNote(db, c.req.param("id"), userId);
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (row.status === "writing") {
      const now = new Date().toISOString();
      await db.batch([
        { sql: "UPDATE notes SET status='outlined', updated_at=? WHERE id=?", params: [now, row.id] },
        { sql: "UPDATE note_sections SET status='todo', updated_at=? WHERE note_id=? AND status='writing'", params: [now, row.id] },
        { sql: "DELETE FROM jobs WHERE type='note_write' AND status='pending' AND json_extract(state_json,'$.noteId')=?", params: [row.id] },
      ]);
    }
    return c.json(ok({ note: await detail(db, (await loadNote(db, row.id, userId))!) }));
  });

  /* ── 章を直す / 書き直す ───────────────────────── */

  r.post("/:id/sections/:sid/revise", async (c) => {
    const parsed = reviseSchema.safeParse(await readBody(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const userId = c.get("userId")!;
    const row = await loadNote(db, c.req.param("id"), userId);
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const section = await db.first<SectionRow>(`SELECT ${SECTION_SELECT} FROM note_sections WHERE id=? AND note_id=?`, c.req.param("sid"), row.id);
    if (!section) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (section.status !== "done") return fail("CONFLICT", "まだ書けていない章は直せません", 409);
    const key = await resolveServerKey(c.env, db, userId);
    const raw = await generateRaw(
      c.env,
      {
        provider: key.provider, model: key.model, apiKey: key.apiKey,
        system: NOTE_REVISE_SYSTEM,
        user: buildRevisePrompt({ instruction: parsed.data.instruction, body: section.body, heading: section.heading, style: row.style as NoteStyle }),
        appOrigin: c.env.APP_ORIGIN,
        maxOutputTokens: NOTE_WRITE_MAX_TOKENS,
      },
      { budget: c.get("budget"), timeoutMs: REVISE_TIMEOUT_MS, retries: 0 },
    );
    const chapter = readChapter(raw);
    const now = new Date().toISOString();
    await db.run(
      "UPDATE note_sections SET body=?, summary=?, char_count=?, error=NULL, updated_at=? WHERE id=?",
      chapter.body, chapter.summary || section.summary, noteCharCount(chapter.body), now, section.id,
    );
    await db.run("UPDATE notes SET updated_at=? WHERE id=?", now, row.id);
    const saved = (await db.first<SectionRow>(`SELECT ${SECTION_SELECT} FROM note_sections WHERE id=?`, section.id))!;
    return c.json(ok({ section: toSection(saved) }));
  });

  r.post("/:id/sections/:sid/rewrite", async (c) => {
    const db = c.get("db");
    const userId = c.get("userId")!;
    const row = await loadNote(db, c.req.param("id"), userId);
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (row.status === "writing") return fail("CONFLICT", "書いている途中です。終わってからお試しください", 409);
    const section = await db.first<SectionRow>(`SELECT ${SECTION_SELECT} FROM note_sections WHERE id=? AND note_id=?`, c.req.param("sid"), row.id);
    if (!section) return fail("NOT_FOUND", "見つかりませんでした", 404);
    await resolveServerKey(c.env, db, userId);
    const now = new Date().toISOString();
    await db.batch([
      { sql: "UPDATE note_sections SET status='todo', error=NULL, updated_at=? WHERE id=?", params: [now, section.id] },
      { sql: "UPDATE notes SET status='writing', updated_at=? WHERE id=?", params: [now, row.id] },
    ]);
    const jobCtx = jobContextFrom(c.env, db, c.get("budget"));
    const jobId = await enqueueJob(jobCtx, "note_write", { accountId: row.account_id, state: { noteId: row.id }, force: true });
    if (jobId) await kickNoteJob(c, db, c.get("budget"), jobId, row.id);
    return c.json(ok({ note: await detail(db, (await loadNote(db, row.id, userId))!) }), 202);
  });

  return r;
}
