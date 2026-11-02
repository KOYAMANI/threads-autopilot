/**
 * `note_write`: note の章を1つ書く（SPEC §7.10 / §8.2）。
 *
 * 1回の実行で章1つ。本番の free プランは1実行＝ジョブ1件・外部呼び出し20回なので、
 * 章ごとに自分の続きを投入して進む（`publish` の続行と同じ形）。
 *
 * - note が `writing` でなければ何もしない（画面の「やめる」）
 * - `todo` の章を ord 順に1つ取り、書けたら `done`、検査に2回落ちたら `failed` にして次へ
 * - 全章が終わったら note を `done` にして Web Push
 */
import type { NoteOutline, NoteQa, NoteRefProfile, NoteStyle } from "@tap/shared";
import { noteCharCount } from "@tap/shared";
import { AiError, generateRaw } from "../lib/ai";
import { resolveServerKey } from "../lib/ai-key";
import { enqueueJob, type JobContext, type RunningJob } from "../lib/jobs";
import { pushToUser } from "../lib/notify";
import {
  NOTE_WRITE_MAX_TOKENS,
  NOTE_WRITE_SYSTEM,
  buildWritePrompt,
  chapterIssue,
  readChapter,
  type NoteSourceInput,
  type NoteSourceRow,
  sourcesForNote,
} from "../lib/note-writing";
import { redact } from "../lib/redact";

/** 1章の AI 呼び出しの上限。60秒だと 5,000 字の章で切れることがある。 */
export const NOTE_WRITE_TIMEOUT_MS = 120_000;
/** 検査に落ちたときの書き直しは1回（free プランでは呼び出し2回＝外部20回に収まる）。 */
const MAX_ATTEMPTS = 2;

type NoteRow = {
  id: string; user_id: string; account_id: string; title: string; style: string; status: string;
  memo: string; qa_json: string; source_digest_json: string; ref_note: string; ref_profile_json: string | null; source_ids_json: string; outline_json: string | null;
};
type SectionRow = { id: string; ord: number; heading: string; target_chars: number; summary: string; status: string };

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

/** 次の章のために自分の続きを投入し、Queue があればすぐ届くようにする。 */
export async function scheduleNoteContinuation(ctx: JobContext, note: { id: string; account_id: string }, currentJobId: string): Promise<string | null> {
  const jobId = await enqueueJob(ctx, "note_write", { accountId: note.account_id, state: { noteId: note.id }, force: true });
  if (!jobId || jobId === currentJobId) return jobId;
  await wakeJob(ctx, jobId);
  return jobId;
}

/** `pending` のジョブを Queue に送る（lease 付き）。Queue が無ければ cron の dispatch を待つ。 */
export async function wakeJob(ctx: JobContext, jobId: string): Promise<void> {
  if (!ctx.env.JOB_QUEUE) return;
  const nowIso = ctx.now.toISOString();
  const lease = new Date(ctx.now.getTime() + 300_000).toISOString();
  const leased = await ctx.sys.run(
    "UPDATE jobs SET dispatched_until=? WHERE id=? AND status='pending' AND (dispatched_until IS NULL OR dispatched_until<=?)",
    lease, jobId, nowIso,
  );
  if (!leased.changes) return;
  try { await ctx.env.JOB_QUEUE.send({ jobId }, { delaySeconds: 1 }); }
  catch { await ctx.sys.run("UPDATE jobs SET dispatched_until=NULL WHERE id=? AND status='pending'", jobId); }
}

export async function noteWriteJob(ctx: JobContext, job: RunningJob): Promise<void> {
  const noteId = typeof job.state.noteId === "string" ? job.state.noteId : null;
  if (!noteId) return;
  const note = await ctx.db.first<NoteRow>(
    "SELECT id, user_id, account_id, title, style, status, memo, qa_json, source_digest_json, ref_note, ref_profile_json, source_ids_json, outline_json FROM notes WHERE id=?",
    noteId,
  );
  if (!note || note.status !== "writing") return;

  const sections = await ctx.db.all<SectionRow>(
    "SELECT id, ord, heading, target_chars, summary, status FROM note_sections WHERE note_id=? ORDER BY ord",
    noteId,
  );
  const nowIso = ctx.now.toISOString();
  const next = sections.find((s) => s.status === "todo" || s.status === "writing");
  if (!next) {
    await ctx.db.run("UPDATE notes SET status='done', updated_at=? WHERE id=? AND status='writing'", nowIso, noteId);
    try {
      await pushToUser(ctx.env, ctx.db, note.user_id, { title: "note が書き上がりました", body: note.title || "原稿を確認してください", url: `/app/note/${noteId}` });
    } catch { /* Push は補助。失敗しても原稿は残る */ }
    return;
  }

  const outline = parseJson<NoteOutline | null>(note.outline_json, null);
  const chapterOutline = outline?.chapters[next.ord];
  if (!outline || !chapterOutline) {
    await ctx.db.run("UPDATE note_sections SET status='failed', error=?, updated_at=? WHERE id=?", "章立てが見つかりません", nowIso, next.id);
    await scheduleNoteContinuation(ctx, note, job.id);
    return;
  }

  await ctx.db.run("UPDATE note_sections SET status='writing', error=NULL, updated_at=? WHERE id=?", nowIso, next.id);

  const sourceIds = parseJson<string[]>(note.source_ids_json, []).filter((id) => typeof id === "string").slice(0, 10);
  let sources: NoteSourceInput[] = [];
  if (sourceIds.length) {
    // 本文の無い動画は、目次のときに書き出した要点を使う（章ごとに動画を読ませない）
    const rows = await ctx.db.all<NoteSourceRow>(
      `SELECT id, type, title, content, url FROM sources WHERE user_id=? AND id IN (${sourceIds.map(() => "?").join(",")})`,
      note.user_id, ...sourceIds,
    );
    sources = sourcesForNote(rows, parseJson<Record<string, string>>(note.source_digest_json, {}));
  }
  const previousSummaries = sections
    .filter((s) => s.ord < next.ord && s.status === "done" && s.summary.trim() !== "")
    .map((s) => ({ heading: s.heading, summary: s.summary }));

  const key = await resolveServerKey(ctx.env, ctx.db, note.user_id);
  const chapter = { ord: next.ord, heading: next.heading, targetChars: next.target_chars, sections: chapterOutline.sections };
  let feedback: string | undefined;
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // 予算の確認は呼び出しの前だけ。呼び出しの後で投げると書けた章を捨てることになる
    ctx.budget.timeMs.check();
    try {
      const raw = await generateRaw(
        ctx.env,
        {
          provider: key.provider,
          model: key.model,
          apiKey: key.apiKey,
          system: NOTE_WRITE_SYSTEM,
          user: buildWritePrompt({
            title: note.title,
            memo: note.memo,
            qa: parseJson<NoteQa[]>(note.qa_json, []),
            style: note.style as NoteStyle,
            chapter,
            outline,
            previousSummaries,
            sources,
            refNote: note.ref_note,
            refProfile: parseJson<NoteRefProfile | null>(note.ref_profile_json, null),
            feedback,
          }),
          appOrigin: ctx.env.APP_ORIGIN,
          maxOutputTokens: NOTE_WRITE_MAX_TOKENS,
        },
        { budget: ctx.budget, timeoutMs: NOTE_WRITE_TIMEOUT_MS, retries: 0 },
      );
      const parsed = readChapter(raw);
      const issue = chapterIssue(parsed.body, chapter);
      if (issue && attempt < MAX_ATTEMPTS - 1) { feedback = issue; lastError = issue; continue; }
      await ctx.db.run(
        "UPDATE note_sections SET body=?, summary=?, char_count=?, status='done', error=?, updated_at=? WHERE id=?",
        parsed.body, parsed.summary, noteCharCount(parsed.body), issue, new Date().toISOString(), next.id,
      );
      lastError = "";
      break;
    } catch (e) {
      if (e instanceof AiError) {
        if (e.code === "AI_KEY_REQUIRED" || !e.retryable) { lastError = e.message; break; }
        lastError = e.message;
        feedback = "前回の応答は読めませんでした。JSON だけを返してください";
        continue;
      }
      throw e;
    }
  }
  if (lastError !== "") {
    await ctx.db.run("UPDATE note_sections SET status='failed', error=?, updated_at=? WHERE id=?", redact(lastError).slice(0, 300), new Date().toISOString(), next.id);
  }
  await scheduleNoteContinuation(ctx, note, job.id);
}
