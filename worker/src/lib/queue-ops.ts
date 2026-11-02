/**
 * キューの書き込み（SPEC §7.4）。アプリのルート（routes/queue.ts）と Claude 連携の MCP ツール
 * （mcp/server.ts）が同じ処理を通るように、ここに1つだけ置く（DECISIONS 2026-11-01）。
 *
 * どの関数も「本人のアカウント」を受け取る（所有の確認は呼び出し側）。
 * 失敗は例外ではなく `{ ok: false, code, message, status }` で返し、ルートはそのまま `fail()` に渡す。
 * 予約が入った・早まったときは `enqueuePublish` で publish ジョブを前倒しで積む。
 */
import { alignSegments, localDateKey, validatePost, type CreateQueueRequest, type MediaItem, type PatchQueueRequest, type QueueSource } from "@tap/shared";
import type { Env } from "../env";
import { enqueuePublish } from "../jobs/publish";
import { canPublishAccount, type AccountRow } from "./accounts";
import { audit } from "./audit";
import type { Budget } from "./budget";
import type { Db } from "./db";
import { jobContextFrom } from "./jobs";
import { canReservePostingSlot, isSlotConflict, nextPostingSlot } from "./posting-schedule";
import { parseJsonArray, QUEUE_SELECT, rowMedia, type QueueRow } from "./queue";

export type QueueOpsContext = { env: Env; db: Db; budget: Budget };
export type QueueOpError = { ok: false; code: string; message: string; status: 400 | 404 | 409 };
export type QueueOpResult<T> = { ok: true; value: T } | QueueOpError;

function err(code: string, message: string, status: 400 | 404 | 409 = 400): QueueOpError {
  return { ok: false, code, message, status };
}

const NOT_FOUND = () => err("NOT_FOUND", "見つかりませんでした", 404);

/** ISO8601 として読めるか。読めたら UTC の ISO に揃えて返す。 */
export function parseAt(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * 本文とコメントの検査（SPEC §9.6）。
 * `link_placement` は M6 のオートパイロット設定なので、手動のキューでは本文にリンクを
 * 置くこと自体は許す（`body`）。見るのは空・500文字・リンク5本・NGワード。
 */
export function checkManualPost(body: string, comments: string[], media: MediaItem[][] = []): { message: string } | null {
  const res = validatePost(body, { comments, media, linkPlacement: "body" });
  return res.ok ? null : { message: res.issues[0]!.message };
}

/** 入力の画像。`media` が無ければ旧形式の `imageUrl` を1投稿目の1枚として読む。どちらも無ければ undefined。 */
function inputMedia(input: { media?: MediaItem[][]; imageUrl?: string | null }): MediaItem[][] | undefined {
  if (input.media) return input.media.map((seg) => seg.map((m) => ({ url: m.url, ...(m.alt?.trim() ? { alt: m.alt.trim() } : {}) })));
  if (input.imageUrl !== undefined) return input.imageUrl ? [[{ url: input.imageUrl }]] : [];
  return undefined;
}

export async function loadQueueRow(db: Db, accountId: string, qid: string): Promise<QueueRow | null> {
  return db.first<QueueRow>(
    `SELECT ${QUEUE_SELECT} FROM queue WHERE id=? AND account_id=?`,
    qid,
    accountId,
  );
}

/**
 * 予約が入った・早まったときに `publish` ジョブを積む（SPEC §8.3）。
 * 5分ごとの cron も同じジョブを積むので、これは「待たせない」ためだけの前倒し。
 */
export async function schedulePublish(ctx: QueueOpsContext, accountId: string, atIso: string): Promise<void> {
  const jobCtx = jobContextFrom(ctx.env, ctx.db, ctx.budget);
  const at = new Date(Math.max(Date.parse(atIso), jobCtx.now.getTime()));
  await enqueuePublish(jobCtx, accountId, at);
}

/* ── 作成（POST /accounts/:id/queue） ────────────────── */

export type CreateQueueInput = CreateQueueRequest & {
  /** 行の出どころ。アプリは `manual`、Claude 連携は `claude` */
  source?: QueueSource;
};

/** `existing` は冪等キーで前回の行を返したとき（ルートは 200、新規は 201） */
export async function createQueueItem(
  ctx: QueueOpsContext,
  account: AccountRow,
  input: CreateQueueInput,
): Promise<QueueOpResult<{ row: QueueRow; existing: boolean }>> {
  const { db } = ctx;
  if (input.idempotencyKey) {
    const previous = await db.first<QueueRow>(`SELECT ${QUEUE_SELECT} FROM queue WHERE account_id=? AND request_id=?`, account.id, input.idempotencyKey);
    if (previous) return { ok: true, value: { row: previous, existing: true } };
  }
  if (input.status !== "draft" && !canPublishAccount(account)) return err("CONFLICT", "Threads APIを設定で連携してから予約してください", 409);
  const { comments, media } = alignSegments(input.comments ?? [], inputMedia(input) ?? []);
  const bad = checkManualPost(input.body, comments, media);
  if (bad) return err("VALIDATION", bad.message, 400);

  const nowIso = new Date().toISOString();
  let status: string = input.status === "now" ? "scheduled" : input.status;
  let scheduledAt: string | null = null;
  if (input.status === "next_slot") {
    const slot = await nextPostingSlot(db, account);
    if (!slot) return err("CONFLICT", "7日先まで空いている投稿枠がありません", 409);
    scheduledAt = slot.at;
    status = "scheduled";
  } else if (input.status === "now") {
    scheduledAt = nowIso;
  } else if (input.status === "scheduled") {
    const at = parseAt(input.scheduledAt);
    if (!at) return err("BAD_REQUEST", "投稿する日時を指定してください", 400);
    scheduledAt = at;
  } else {
    // draft でも日時だけ先に持っておける
    const at = parseAt(input.scheduledAt ?? null);
    scheduledAt = at ?? null;
    status = "draft";
  }

  if (input.reserveSlot && (status !== "scheduled" || !(await canReservePostingSlot(db, account, scheduledAt)))) {
    return err("CONFLICT", "この投稿枠は利用できません。スケジュールを更新して別の枠を選んでください", 409);
  }
  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.run(
        `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, media_json, reply_control,
            source, approval_mode, approve_deadline, notified_at, action_token_used_at, step, next_step_at,
            container_id, container_polls, result_ids_json, error, error_raw, attempts, tags_json,
            origin_post_id, source_ids_json, created_at, updated_at, slot_managed, slot_day, request_id)
          VALUES (?,?,?,?,?,?,?,?, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, '[]', NULL, NULL, 0, '{}', ?,?,?,?,?,?,?)`,
        id,
        account.id,
        status,
        scheduledAt,
        input.body,
        JSON.stringify(comments),
        JSON.stringify(media),
        input.replyControl ?? "everyone",
        input.source ?? "manual",
        input.originPostId ?? null,
        JSON.stringify(input.sourceIds ?? []),
        nowIso,
        nowIso,
        input.status === "next_slot" || input.reserveSlot ? 1 : 0,
        scheduledAt ? localDateKey(Date.parse(scheduledAt), account.timezone) : null,
        input.idempotencyKey ?? null,
      );

      break;
    } catch (error) {
      if (input.idempotencyKey) {
        const previous = await db.first<QueueRow>(`SELECT ${QUEUE_SELECT} FROM queue WHERE account_id=? AND request_id=?`, account.id, input.idempotencyKey);
        if (previous) return { ok: true, value: { row: previous, existing: true } };
      }
      if (!isSlotConflict(error)) throw error;
      if (input.status !== "next_slot" || attempt === 2) return err("CONFLICT", "この投稿枠は埋まっています。別の枠を選んでください", 409);
      const next = await nextPostingSlot(db, account);
      if (!next) return err("CONFLICT", "7日先まで空いている投稿枠がありません", 409);
      scheduledAt = next.at;
    }
  }

  if (status === "scheduled" && scheduledAt) {
    await schedulePublish(ctx, account.id, scheduledAt);
  }
  return { ok: true, value: { row: (await loadQueueRow(db, account.id, id))!, existing: false } };
}

/* ── 編集・日時変更（PATCH /accounts/:id/queue/:qid） ── */

export async function updateQueueItem(
  ctx: QueueOpsContext,
  account: AccountRow,
  qid: string,
  input: PatchQueueRequest,
): Promise<QueueOpResult<QueueRow>> {
  const { db } = ctx;
  const row = await loadQueueRow(db, account.id, qid);
  if (!row) return NOT_FOUND();
  if (row.status === "publishing" || row.status === "done") {
    return err("CONFLICT", "この投稿はもう編集できません", 409);
  }

  const body = input.body ?? row.body;
  const { comments, media } = alignSegments(
    input.comments ?? parseJsonArray(row.comments_json),
    inputMedia(input) ?? rowMedia(row),
  );
  const bad = checkManualPost(body, comments, media);
  if (bad) return err("VALIDATION", bad.message, 400);

  const at = parseAt(input.scheduledAt);
  if (input.scheduledAt !== undefined && at === undefined) {
    return err("BAD_REQUEST", "日時の形式が正しくありません", 400);
  }
  let scheduledAt = at === undefined ? row.scheduled_at : at;
  let status = input.status === "next_slot" ? "scheduled" : input.status ?? (row.status === "failed" ? "draft" : row.status);
  if (status === "scheduled" && row.source === "autopilot" && row.approval_mode === "manual" && ["pending_approval", "draft"].includes(row.status)) {
    status = "pending_approval"; // 日時の変更は承認の代わりにはならない。
  }
  if (input.status === "next_slot") {
    const next = await nextPostingSlot(db, account, new Date(), row.id);
    if (!next) return err("CONFLICT", "7日先まで空いている投稿枠がありません", 409);
    scheduledAt = next.at;
  }
  if ((status === "scheduled" || status === "pending_approval") && !canPublishAccount(account)) return err("CONFLICT", "Threads APIを設定で連携し直してから予約してください", 409);
  if (status === "scheduled" && !scheduledAt) {
    return err("BAD_REQUEST", "投稿する日時を指定してください", 400);
  }

  if (input.reserveSlot && (!["scheduled", "pending_approval"].includes(status) || !(await canReservePostingSlot(db, account, scheduledAt, row.id)))) {
    return err("CONFLICT", "この投稿枠は利用できません。スケジュールを更新して別の枠を選んでください", 409);
  }
  const nowIso = new Date().toISOString();
  // 本文を直したら、途中まで進んだ状態はリセットする（失敗からの作り直し）。
  // ただし **既に Threads へ出た投稿がある行（result_ids が空でない）は step を戻さない**。
  // 戻すと step 0 が root をもう1本作ってしまう（SPEC §8.3 の二重投稿防止）。
  // その場合は続きの step から再開する（publish-now と同じ扱い）。
  const published = parseJsonArray(row.result_ids_json).length > 0;
  const resetSteps = (row.status === "failed" || row.status === "draft") && !published;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const updated = await db.run(
        `UPDATE queue SET body=?, comments_json=?, media_json=?, image_url=NULL, reply_control=?, scheduled_at=?, status=?,
           slot_managed=CASE WHEN ? THEN 1 ELSE slot_managed END, slot_day=?,
           error=NULL, error_raw=NULL,
           step=CASE WHEN ? THEN 0 ELSE step END,
           next_step_at=NULL, container_id=NULL, container_polls=0, media_state_json=NULL,
           updated_at=? WHERE id=? AND account_id=? AND status=? AND updated_at=? AND status NOT IN ('publishing','done')`,
        body,
        JSON.stringify(comments),
        JSON.stringify(media),
        input.replyControl ?? row.reply_control,
        scheduledAt,
        status,
        input.status === "next_slot" || input.reserveSlot ? 1 : 0,
        scheduledAt ? localDateKey(Date.parse(scheduledAt), account.timezone) : null,
        resetSteps ? 1 : 0,
        nowIso,
        row.id,
        account.id,
        row.status,
        row.updated_at,
      );

      if (updated.changes === 0) return err("CONFLICT", "別の操作で状態が変わりました。最新の状態を確認してください", 409);
      break;
    } catch (error) {
      if (!isSlotConflict(error)) throw error;
      if (input.status !== "next_slot" || attempt === 2) return err("CONFLICT", "この投稿枠は埋まっています。別の枠を選んでください", 409);
      const next = await nextPostingSlot(db, account, new Date(), row.id);
      if (!next) return err("CONFLICT", "7日先まで空いている投稿枠がありません", 409);
      scheduledAt = next.at;
    }
  }

  if (status === "scheduled" && scheduledAt) {
    await schedulePublish(ctx, account.id, scheduledAt);
  }
  return { ok: true, value: (await loadQueueRow(db, account.id, row.id))! };
}

/* ── 取消（POST /accounts/:id/queue/:qid/cancel） ────── */

export async function cancelQueueItem(
  ctx: QueueOpsContext,
  account: AccountRow,
  qid: string,
  userId: string,
): Promise<QueueOpResult<QueueRow>> {
  const { db } = ctx;
  const row = await loadQueueRow(db, account.id, qid);
  if (!row) return NOT_FOUND();
  if (row.status === "done" || row.status === "publishing") {
    return err("CONFLICT", "この投稿はもう取り消せません", 409);
  }

  const nowIso = new Date().toISOString();
  const cancelled = await db.run(
    "UPDATE queue SET status='cancelled', next_step_at=NULL, updated_at=? WHERE id=? AND account_id=? AND status=? AND updated_at=? AND status NOT IN ('publishing','done')",
    nowIso, row.id, account.id, row.status, row.updated_at,
  );
  if (cancelled.changes === 0) return err("CONFLICT", "投稿処理または別の操作が始まったため、取り消せませんでした", 409);
  await db.run(
    "INSERT INTO ap_log (id, account_id, at, kind, message, ref_id) VALUES (?,?,?,?,?,?)",
    crypto.randomUUID(),
    account.id,
    nowIso,
    "cancel",
    "予約を取り消しました",
    row.id,
  );
  await audit(db, userId, "queue.cancel", { accountId: account.id, queueId: row.id });
  return { ok: true, value: (await loadQueueRow(db, account.id, row.id))! };
}

/* ── 今すぐ投稿（POST /accounts/:id/queue/:qid/publish-now） ── */

export async function publishQueueItemNow(
  ctx: QueueOpsContext,
  account: AccountRow,
  qid: string,
): Promise<QueueOpResult<QueueRow>> {
  const { db } = ctx;
  const row = await loadQueueRow(db, account.id, qid);
  if (!row) return NOT_FOUND();
  if (!canPublishAccount(account)) return err("CONFLICT", "Threads APIを設定で連携し直してから予約してください", 409);
  if (row.status === "publishing" || row.status === "done") return err("CONFLICT", "すでに投稿中または投稿済みです", 409);

  const bad = checkManualPost(row.body, parseJsonArray(row.comments_json), rowMedia(row));
  if (bad) return err("VALIDATION", bad.message, 400);

  const nowIso = new Date().toISOString();
  // step と result_ids は残す。失敗からの再開で1投稿目を出し直さないため（SPEC §8.3）
  const scheduled = await db.run(
    `UPDATE queue SET status='scheduled', scheduled_at=?, next_step_at=?, slot_managed=0, error=NULL, error_raw=NULL,
       updated_at=? WHERE id=? AND account_id=? AND status=? AND updated_at=? AND status NOT IN ('publishing','done')`,
    nowIso, nowIso, nowIso, row.id, account.id, row.status, row.updated_at,
  );
  if (scheduled.changes === 0) return err("CONFLICT", "別の操作で状態が変わりました。最新の状態を確認してください", 409);
  await schedulePublish(ctx, account.id, nowIso);
  return { ok: true, value: (await loadQueueRow(db, account.id, row.id))! };
}

/* ── 削除（DELETE /accounts/:id/queue/:qid。`done` 以外） ── */

export async function deleteQueueItem(
  db: Db,
  account: AccountRow,
  qid: string,
): Promise<QueueOpResult<{ deleted: true }>> {
  const res = await db.run(
    "DELETE FROM queue WHERE id=? AND account_id=? AND status NOT IN ('done','publishing') AND result_ids_json='[]'",
    qid,
    account.id,
  );
  if (res.changes === 0) {
    const row = await loadQueueRow(db, account.id, qid);
    if (row) return err("CONFLICT", "投稿中・一部でも公開済みのものは消せません", 409);
    return NOT_FOUND();
  }
  return { ok: true, value: { deleted: true } };
}
