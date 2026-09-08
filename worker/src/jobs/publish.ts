/**
 * `publish` ジョブ（SPEC §8.3）。キュー1件＝ステップ実行。
 *
 * `queue.status='scheduled' AND scheduled_at<=now AND (next_step_at IS NULL OR next_step_at<=now)`
 * を拾って `publishing` にし、1回の実行で進めるところまで進める。
 *
 * ステップの意味（`REPLY_TWO_STEP` は**毎回 env を読んで**解釈する。SPEC §8.3）:
 *
 *   step 0   本文を投稿（画像ありならコンテナ作成）
 *   step 1   コンテナ状態確認 → FINISHED なら threads_publish
 *   step 2.. コメントを reply_to_id で投稿する
 *            1ステップ方式（既定）: i = step-2
 *            3ステップ方式:        i = floor((step-2)/3), phase = (step-2)%3
 *
 * 二重投稿の防止: Threads への publish が1回成功するたびに、**次に進む前に**
 * `result_ids_json` を保存する。途中で落ちても、再開時は保存済みの step から続く。
 */
import { canPublishForUser } from "../lib/staging-review-policy";
import { buildTags, startOfTzDay, validatePost, type PostTags } from "@tap/shared";
import { accountToken, loadAccount, type AccountRow } from "../lib/accounts";
import { apLog, loadAutopilot } from "../lib/autopilot";
import { sendEmail } from "../lib/email";
import { notifyTargets, pushToUser } from "../lib/notify";
import { buildUpsertChunks, type Db } from "../lib/db";
import { redact } from "../lib/redact";
import { enqueueJob, type JobContext, type RunningJob } from "../lib/jobs";
import {
  findDuplicate,
  parseJsonArray,
  publishSettings,
  QUEUE_SELECT,
  type QueueRow,
} from "../lib/queue";
import {
  createImageContainer,
  createTextPost,
  getContainerStatus,
  isRateLimit,
  publishContainer,
  ThreadsApiError,
  threadsReason,
  type CallOptions,
  type ReplyControl,
} from "../lib/threads";

/** コンテナを IN_PROGRESS で待てる回数（SPEC §8.3）。超えたら failed。 */
export const MAX_CONTAINER_POLLS = 10;
/** step 1（画像コンテナ）の再確認までの間隔（SPEC §8.3）。 */
export const CONTAINER_POLL_SEC = 30;
/** 3ステップ方式 phase 0 → 1 の間隔（SPEC §8.3）。 */
export const REPLY_CONTAINER_WAIT_SEC = 10;
/** 3ステップ方式 phase 1 の再確認間隔（SPEC §8.3）。 */
export const REPLY_POLL_SEC = 15;
/** レート制限で後ろに倒す幅（SPEC §8.3「レート制限は next_step_at を後ろにずらして再試行」）。 */
export const RATE_LIMIT_BACKOFF_SEC = 300;
/** 1回のジョブ実行で進めるステップ数の上限（暴走ガード）。 */
export const MAX_STEPS_PER_RUN = 40;

/* ── ステップの解釈 ────────────────────────────────── */

export function twoStepMode(env: { REPLY_TWO_STEP?: string }): boolean {
  return env.REPLY_TWO_STEP === "1";
}

/** step（2以上）から、何番目のコメントの何フェーズかを出す。 */
export function commentStep(step: number, twoStep: boolean): { index: number; phase: 0 | 1 | 2 } {
  const k = Math.max(0, step - 2);
  if (!twoStep) return { index: k, phase: 0 };
  return { index: Math.floor(k / 3), phase: (k % 3) as 0 | 1 | 2 };
}

/* ── 行の更新（1回の UPDATE にまとめる） ─────────────── */

type QueuePatch = {
  status?: string;
  step?: number;
  nextStepAt?: string | null;
  containerId?: string | null;
  containerPolls?: number;
  resultIds?: string[];
  rootPublishedAt?: string;
  error?: string | null;
  errorRaw?: string | null;
  attempts?: number;
};

async function patchQueue(
  db: Db,
  ctx: JobContext,
  id: string,
  patch: QueuePatch,
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  const put = (sql: string, value: unknown) => {
    sets.push(sql);
    args.push(value);
  };
  if (patch.status !== undefined) put("status=?", patch.status);
  if (patch.step !== undefined) put("step=?", patch.step);
  if (patch.nextStepAt !== undefined) put("next_step_at=?", patch.nextStepAt);
  if (patch.containerId !== undefined) put("container_id=?", patch.containerId);
  if (patch.containerPolls !== undefined) put("container_polls=?", patch.containerPolls);
  if (patch.resultIds !== undefined) put("result_ids_json=?", JSON.stringify(patch.resultIds));
  if (patch.rootPublishedAt !== undefined) put("root_published_at=COALESCE(root_published_at,?)", patch.rootPublishedAt);
  if (patch.error !== undefined) put("error=?", patch.error);
  if (patch.errorRaw !== undefined) put("error_raw=?", patch.errorRaw);
  if (patch.attempts !== undefined) put("attempts=?", patch.attempts);
  put("updated_at=?", ctx.now.toISOString());
  await db.run(`UPDATE queue SET ${sets.join(", ")} WHERE id=?`, ...args, id);
}

/**
 * 失敗として畳む。日本語（`error`）と原文（`error_raw`）の両方を残す（SPEC §2.4 / §8.3）。
 * `extra` はコンテナ待ちの回数など、失敗と同時に確定させたい値を渡すため。
 */
async function failQueue(
  ctx: JobContext,
  row: QueueRow,
  message: string,
  raw: string | null,
  extra: Pick<QueuePatch, "containerPolls"> = {},
): Promise<void> {
  await patchQueue(ctx.db, ctx, row.id, {
    status: "failed",
    nextStepAt: null,
    error: message,
    errorRaw: raw,
    ...extra,
  });

  // 失敗はメールで知らせる（SPEC §10.5 `publish_failed`）。自動投稿なら ap_log にも残し、
  // 3連続で止める数（SPEC §9.6）を進める
  const account = await ctx.db.first<{ username: string }>(
    "SELECT username FROM accounts WHERE id=?",
    row.account_id,
  );
  if (row.source === "autopilot") {
    await ctx.db.run(
      `INSERT INTO autopilot (account_id, consecutive_failures, updated_at) VALUES (?,1,?)
         ON CONFLICT(account_id) DO UPDATE SET
           consecutive_failures = consecutive_failures + 1, updated_at = excluded.updated_at`,
      row.account_id,
      ctx.now.toISOString(),
    );
    await apLog(ctx.db, row.account_id, "error", `投稿に失敗しました: ${message}`, row.id, ctx.now);
    await stopIfTooManyFailures(ctx, row.account_id, account?.username ?? "", message);
  }
  const target = await notifyTargets(ctx.db, row.account_id);
  if (target) {
    await sendEmail(ctx.env, target.email, "publish_failed", {
      username: account?.username ?? "",
      reason: message,
      ...(raw ? { raw } : {}),
      appOrigin: ctx.env.APP_ORIGIN,
    });
    // 失敗は早く知りたいので Push も出す（M7。`push_enabled=1` の購読だけ）
    await pushToUser(ctx.env, ctx.db, target.userId, {
      title: `@${account?.username ?? ""} の投稿に失敗しました`,
      body: message.slice(0, 120),
      url: "/app/queue",
    });
  }
}

/** Threads 失敗3連続でオートパイロットを止める（SPEC §9.6）。 */
async function stopIfTooManyFailures(
  ctx: JobContext,
  accountId: string,
  username: string,
  reason: string,
): Promise<void> {
  const row = await ctx.db.first<{ consecutive_failures: number; enabled: number }>(
    "SELECT consecutive_failures, enabled FROM autopilot WHERE account_id=?",
    accountId,
  );
  if (!row || !row.enabled || row.consecutive_failures < 3) return;
  await ctx.db.run(
    "UPDATE autopilot SET enabled=0, updated_at=? WHERE account_id=?",
    ctx.now.toISOString(),
    accountId,
  );
  await apLog(
    ctx.db,
    accountId,
    "stopped",
    "3回続けて失敗したので、オートパイロットを止めました",
    null,
    ctx.now,
  );
  const target = await notifyTargets(ctx.db, accountId);
  if (target) {
    await sendEmail(ctx.env, target.email, "ap_stopped", {
      username,
      reason,
      appOrigin: ctx.env.APP_ORIGIN,
    });
  }
}

/* ── 直前チェック（SPEC §8.3） ─────────────────────── */

export type PreflightResult = { ok: true } | { ok: false; message: string };

/** その日の tz 00:00 を ISO で返す。 */
function startOfDayIso(nowMs: number, tz: string): string {
  return new Date(startOfTzDay(nowMs, tz)).toISOString();
}

/**
 * 1日の投稿上限・投稿間隔・重複（SPEC §8.3）。各root公開の直前に通す。
 * `validatePost()` は呼び出し側（`runStep`）で別に見る。
 */
export async function preflight(
  ctx: JobContext,
  account: AccountRow,
  row: QueueRow,
): Promise<PreflightResult> {
  const settings = publishSettings(account);
  const nowMs = ctx.now.getTime();

  // 1日の投稿上限
  const dayStart = startOfDayIso(nowMs, account.timezone);
  // Midnight + 36h lands on the next local date even across a DST change.
  const dayEnd = startOfDayIso(Date.parse(dayStart) + 36 * 3600_000, account.timezone);
  const today = await ctx.db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM queue WHERE account_id=? AND id<>? AND root_published_at>=? AND root_published_at<?",
    account.id,
    row.id,
    dayStart,
    dayEnd,
  );
  if ((today?.n ?? 0) >= settings.dailyPostLimit) {
    return {
      ok: false,
      message: `1日の投稿上限（${settings.dailyPostLimit}件）に達しています`,
    };
  }

  if (row.source === "autopilot") {
    const ap = await loadAutopilot(ctx.db, account.id);
    const autoToday = await ctx.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM queue WHERE account_id=? AND id<>? AND source='autopilot' AND root_published_at>=? AND root_published_at<?",
      account.id, row.id, dayStart, dayEnd,
    );
    const limit = Math.min(3, Math.max(1, ap.daily_limit));
    if ((autoToday?.n ?? 0) >= limit) return { ok: false, message: `オートパイロットの1日上限（${limit}件）に達しています` };
  }

  // Root publication remains counted after reply failure, cancellation, or retry.
  // updated_at is intentionally ignored: editing a row must not move its publication day.
  if (settings.minGapMin > 0) {
    const last = await ctx.db.first<{ at: string | null }>(
      "SELECT MAX(posted_at) AS at FROM posts WHERE account_id=? AND is_reply=0 AND source<>'external'",
      account.id,
    );
    const inflight = await ctx.db.first<{ at: string | null }>(
      "SELECT MAX(root_published_at) AS at FROM queue WHERE account_id=? AND id<>?",
      account.id,
      row.id,
    );
    const lastAt = [last?.at, inflight?.at].filter((v): v is string => Boolean(v)).sort().pop();
    if (lastAt) {
      const gapMin = (nowMs - Date.parse(lastAt)) / 60_000;
      if (gapMin < settings.minGapMin) {
        return {
          ok: false,
          message: `前の投稿から${settings.minGapMin}分あける設定です（いまは${Math.max(0, Math.floor(gapMin))}分）`,
        };
      }
    }
  }

  // 重複（3-gram Jaccard >= 0.8）。source='recycle' は判定対象から外す
  if (row.source !== "recycle") {
    const dup = await findDuplicate(ctx.db, account.id, row.body, {
      nowMs,
      excludeQueueId: row.id,
    });
    if (dup) return { ok: false, message: "直近30日に似た内容の投稿があります" };
  }

  return { ok: true };
}

/* ── done 時の posts 挿入（SPEC §8.3） ───────────────── */

const PUBLISHED_COLUMNS = [
  "account_id",
  "id",
  "root_id",
  "is_reply",
  "text",
  "permalink",
  "media_type",
  "media_url",
  "link_attachment_url",
  "posted_at",
  "tags_json",
  "source",
  "queue_id",
  "deleted",
];

/**
 * `done` にして `posts` へ root と comments を入れる（SPEC §8.3）。
 * `queue.tags_json` は root の `tags_json` にコピーする。空のときだけ §9.1 の
 * タグを組み立てて入れる（`full_sync` が同じ規則で埋めるので、値は一致する）。
 */
export async function finishQueue(
  ctx: JobContext,
  account: AccountRow,
  row: QueueRow,
  resultIds: string[],
): Promise<void> {
  const nowIso = ctx.now.toISOString();
  const comments = parseJsonArray(row.comments_json);
  const rootId = resultIds[0];

  if (rootId) {
    let tags: string = row.tags_json;
    if (!tags || tags === "{}") {
      const built: PostTags = buildTags(row.body, ctx.now, account.timezone);
      tags = JSON.stringify(built);
    }
    const source = row.source === "manual" ? "manual" : row.source;
    const rows: unknown[][] = resultIds.map((id, i) => [
      account.id,
      id,
      rootId,
      i === 0 ? 0 : 1,
      i === 0 ? row.body : (comments[i - 1] ?? ""),
      null, // permalink は応答に無い。次の full_sync で入る
      i === 0 && row.image_url ? "IMAGE" : "TEXT_POST",
      i === 0 ? row.image_url : null,
      null,
      i === 0 ? (row.root_published_at ?? nowIso) : nowIso,
      i === 0 ? tags : "{}",
      source,
      row.id,
      0,
    ]);
    await ctx.db.batch(
      buildUpsertChunks("posts", PUBLISHED_COLUMNS, rows, ["account_id", "id"], [
        "root_id",
        "is_reply",
        "text",
        "media_type",
        "media_url",
        "posted_at",
        "source",
        "queue_id",
        "deleted",
        {
          column: "tags_json",
          expr: "CASE WHEN posts.tags_json='{}' THEN excluded.tags_json ELSE posts.tags_json END",
        },
      ]),
    );
  }

  await patchQueue(ctx.db, ctx, row.id, {
    status: "done",
    nextStepAt: null,
    containerId: null,
    containerPolls: 0,
    resultIds,
    error: null,
    errorRaw: null,
  });
}

/* ── 1ステップ進める ───────────────────────────────── */

type StepOutcome = "continue" | "stop";

async function runStep(
  ctx: JobContext,
  account: AccountRow,
  row: QueueRow,
  token: string,
  call: CallOptions,
  clock: () => Date,
): Promise<StepOutcome> {
  const nowMs = ctx.now.getTime();
  const comments = parseJsonArray(row.comments_json);
  const resultIds = parseJsonArray(row.result_ids_json);
  const settings = publishSettings(account);
  const delayMs = settings.commentDelaySec * 1000;
  const replyControl = (row.reply_control as ReplyControl) || "everyone";
  const twoStep = twoStepMode(ctx.env);
  const later = (sec: number) => new Date(nowMs + sec * 1000).toISOString();

  // Published root IDs are authoritative even if a recovery accidentally resets
  // either root step. Never issue a second root while finishing the old thread.
  if (row.step <= 1 && resultIds.length > 0) {
    const doneComments = resultIds.length - 1;
    if (doneComments >= comments.length) {
      await finishQueue(ctx, account, row, resultIds);
      return "continue";
    }
    await patchQueue(ctx.db, ctx, row.id, {
      step: 2 + doneComments * (twoStep ? 3 : 1),
      containerId: null,
      containerPolls: 0,
      nextStepAt: ctx.now.toISOString(),
    });
    return "continue";
  }
  if (row.root_published_at && resultIds.length === 0) {
    await failQueue(ctx, row, "公開済みの投稿IDを確認できないため、再投稿を停止しました", null);
    return "continue";
  }

  /* step 0: 本文 */
  if (row.step === 0) {
    // 手で書いた投稿（`manual`）は本文にリンクを置いてよい。見るのは空・500文字・
    // リンク5本・NGワードだけ。オートパイロット経由（`autopilot`）は設定の
    // `link_placement` と `ng_words` を効かせる（SPEC §9.6）
    const ap = row.source === "autopilot" ? await loadAutopilot(ctx.db, account.id) : null;
    const check = validatePost(row.body, {
      comments,
      linkPlacement: ap ? (ap.link_placement as "comment" | "body" | "none") : "body",
      ...(ap ? { ngWords: ap.ng_words } : {}),
    });
    if (!check.ok) {
      await failQueue(ctx, row, check.issues[0]!.message, null);
      return "continue";
    }

    const pre = await preflight({ ...ctx, now: clock() }, account, row);
    if (!pre.ok) {
      await failQueue(ctx, row, pre.message, null);
      return "continue";
    }

    if (row.image_url) {
      const container = await createImageContainer(
        token,
        row.image_url,
        row.body,
        { replyControl },
        call,
      );
      await patchQueue(ctx.db, ctx, row.id, {
        containerId: container.id,
        containerPolls: 0,
        step: 1,
        nextStepAt: later(CONTAINER_POLL_SEC),
      });
      return "stop";
    }

    const created = await createTextPost(
      token,
      row.body,
      { autoPublish: true, replyControl },
      call,
    );
    // 成功した result_ids は「次へ進む前に」保存する（二重投稿防止。SPEC §8.3）
    const ids = [created.id];
    const rootPublishedAt = clock().toISOString();
    if (comments.length > 0) {
      await patchQueue(ctx.db, ctx, row.id, {
        resultIds: ids,
        rootPublishedAt,
        step: 2,
        nextStepAt: new Date(nowMs + delayMs).toISOString(),
      });
      return "stop";
    }
    await patchQueue(ctx.db, ctx, row.id, { resultIds: ids, rootPublishedAt });
    await finishQueue(ctx, account, { ...row, result_ids_json: JSON.stringify(ids), root_published_at: rootPublishedAt }, ids);
    return "continue";
  }

  /* step 1: 画像コンテナの状態確認 */
  if (row.step === 1) {
    if (!row.container_id) {
      await failQueue(ctx, row, "画像の下ごしらえが見つかりませんでした", null);
      return "continue";
    }
    const status = await getContainerStatus(token, row.container_id, call);
    if (status.status === "FINISHED") {
      // Containers can resume hours/days after creation; recheck the current
      // publication day and gap immediately before the irreversible root publish.
      const pre = await preflight({ ...ctx, now: clock() }, account, row);
      if (!pre.ok) {
        await failQueue(ctx, row, pre.message, null);
        return "continue";
      }
      const published = await publishContainer(token, row.container_id, call);
      const ids = [...resultIds, published.id];
      const rootPublishedAt = clock().toISOString();
      if (comments.length > 0) {
        await patchQueue(ctx.db, ctx, row.id, {
          resultIds: ids,
          rootPublishedAt,
          containerId: null,
          containerPolls: 0,
          step: 2,
          nextStepAt: new Date(nowMs + delayMs).toISOString(),
        });
        return "stop";
      }
      await patchQueue(ctx.db, ctx, row.id, {
        resultIds: ids,
        rootPublishedAt,
        containerId: null,
        containerPolls: 0,
      });
      await finishQueue(ctx, account, { ...row, result_ids_json: JSON.stringify(ids), root_published_at: rootPublishedAt }, ids);
      return "continue";
    }
    if (status.status === "ERROR" || status.status === "EXPIRED") {
      await failQueue(
        ctx,
        row,
        "画像の下ごしらえに失敗しました",
        redact(status.error_message ?? String(status.status)),
      );
      return "continue";
    }
    // IN_PROGRESS
    const polls = row.container_polls + 1;
    if (polls >= MAX_CONTAINER_POLLS) {
      await failQueue(
        ctx,
        row,
        "画像の下ごしらえが終わりませんでした。時間をおいてもう一度お試しください",
        `container ${row.container_id} still IN_PROGRESS after ${polls} polls`,
        { containerPolls: polls },
      );
      return "continue";
    }
    await patchQueue(ctx.db, ctx, row.id, {
      containerPolls: polls,
      nextStepAt: later(CONTAINER_POLL_SEC),
    });
    return "stop";
  }

  /* step 2..: コメント */
  const { index, phase } = commentStep(row.step, twoStep);
  const text = comments[index];
  if (text === undefined) {
    // コメントを削って編集したときなど。そこまでで完了とみなす
    await finishQueue(ctx, account, row, resultIds);
    return "continue";
  }
  const parent = resultIds[resultIds.length - 1];
  if (!parent) {
    await failQueue(ctx, row, "1投稿目が見つかりませんでした", null);
    return "continue";
  }

  const hasNext = index + 1 < comments.length;

  if (!twoStep) {
    const created = await createTextPost(
      token,
      text,
      { autoPublish: true, replyToId: parent },
      call,
    );
    const ids = [...resultIds, created.id];
    if (hasNext) {
      await patchQueue(ctx.db, ctx, row.id, {
        resultIds: ids,
        step: row.step + 1,
        nextStepAt: new Date(nowMs + delayMs).toISOString(),
      });
      return "stop";
    }
    await patchQueue(ctx.db, ctx, row.id, { resultIds: ids });
    await finishQueue(ctx, account, { ...row, result_ids_json: JSON.stringify(ids) }, ids);
    return "continue";
  }

  /* 3ステップ方式 */
  if (phase === 0) {
    const container = await createTextPost(
      token,
      text,
      { autoPublish: false, replyToId: parent },
      call,
    );
    await patchQueue(ctx.db, ctx, row.id, {
      containerId: container.id,
      containerPolls: 0,
      step: row.step + 1,
      nextStepAt: later(REPLY_CONTAINER_WAIT_SEC),
    });
    return "stop";
  }

  if (phase === 1) {
    if (!row.container_id) {
      await failQueue(ctx, row, "コメントの下ごしらえが見つかりませんでした", null);
      return "continue";
    }
    const status = await getContainerStatus(token, row.container_id, call);
    if (status.status === "FINISHED") {
      await patchQueue(ctx.db, ctx, row.id, {
        step: row.step + 1,
        nextStepAt: ctx.now.toISOString(),
      });
      return "continue";
    }
    if (status.status === "ERROR" || status.status === "EXPIRED") {
      await failQueue(
        ctx,
        row,
        "コメントの下ごしらえに失敗しました",
        redact(status.error_message ?? String(status.status)),
      );
      return "continue";
    }
    const polls = row.container_polls + 1;
    if (polls >= MAX_CONTAINER_POLLS) {
      await failQueue(
        ctx,
        row,
        "コメントの下ごしらえが終わりませんでした。時間をおいてもう一度お試しください",
        `container ${row.container_id} still IN_PROGRESS after ${polls} polls`,
        { containerPolls: polls },
      );
      return "continue";
    }
    await patchQueue(ctx.db, ctx, row.id, {
      containerPolls: polls,
      nextStepAt: later(REPLY_POLL_SEC),
    });
    return "stop";
  }

  // phase 2
  if (!row.container_id) {
    await failQueue(ctx, row, "コメントの下ごしらえが見つかりませんでした", null);
    return "continue";
  }
  const published = await publishContainer(token, row.container_id, call);
  const ids = [...resultIds, published.id];
  if (hasNext) {
    await patchQueue(ctx.db, ctx, row.id, {
      resultIds: ids,
      containerId: null,
      containerPolls: 0,
      step: row.step + 1,
      nextStepAt: new Date(nowMs + delayMs).toISOString(),
    });
    return "stop";
  }
  await patchQueue(ctx.db, ctx, row.id, {
    resultIds: ids,
    containerId: null,
    containerPolls: 0,
  });
  await finishQueue(ctx, account, { ...row, result_ids_json: JSON.stringify(ids) }, ids);
  return "continue";
}

/* ── ジョブ本体 ────────────────────────────────────── */

/** publish ジョブを積む。既に pending があれば、より早い時刻へ前倒しする。 */
export async function enqueuePublish(
  ctx: JobContext,
  accountId: string,
  at: Date,
): Promise<void> {
  const id = await enqueueJob(ctx, "publish", { accountId, nextRunAt: at });
  if (id) return;
  // 同じアカウントの pending が既にある。予定が早まったなら前倒しする
  await ctx.sys.run(
    "UPDATE jobs SET next_run_at=?, updated_at=? WHERE type='publish' AND account_id=? AND status='pending' AND next_run_at>?",
    at.toISOString(),
    ctx.now.toISOString(),
    accountId,
    at.toISOString(),
  );
}

/** ライセンスが `revoked` なら自動投稿を止める（SPEC §5.4）。 */
async function licenseRevoked(ctx: JobContext, account: AccountRow): Promise<boolean> {
  const row = await ctx.db.first<{ status: string }>(
    "SELECT l.status AS status FROM licenses l JOIN users u ON u.license_id=l.id WHERE u.id=?",
    account.user_id,
  );
  return row?.status === "revoked";
}

export async function publishJob(ctx: JobContext, job: RunningJob): Promise<void> {
  const startedAt = Date.now();
  // Follow elapsed API/I/O time while preserving the injected logical clock in tests.
  const clock = () => new Date(ctx.now.getTime() + Math.max(0, Date.now() - startedAt));
  if (!job.accountId) return;
  const account = await loadAccount(ctx.db, job.accountId);
  if (!account) return;
  if (!canPublishForUser(ctx.env, account.user_id, ctx.now.getTime())) return;
  if (ctx.env.APP_ENV === "staging" && account.threads_user_id !== ctx.env.STAGING_THREADS_USER_ID) return;

  if (await licenseRevoked(ctx, account)) {
    await ctx.db.run("UPDATE autopilot SET enabled=0, updated_at=? WHERE account_id=?", ctx.now.toISOString(), account.id);
    await ctx.db.run(
      "INSERT INTO ap_log (id, account_id, at, kind, message, ref_id) VALUES (?,?,?,?,?,NULL)",
      crypto.randomUUID(),
      account.id,
      ctx.now.toISOString(),
      "license",
      "ライセンスが無効化されているため、自動投稿を停止しました",
    );
    return;
  }
  if (account.status !== "ok") return;

  const token = await accountToken(ctx.env, account);
  const call: CallOptions = { budget: ctx.budget, env: ctx.env, now: ctx.now.getTime(), publishingUserId: account.user_id };
  const nowIso = ctx.now.toISOString();

  for (let i = 0; i < (ctx.env.WORKERS_PLAN === "free" ? 1 : MAX_STEPS_PER_RUN); i++) {
    ctx.budget.timeMs.check();

    const row = await ctx.db.first<QueueRow>(
      `SELECT ${QUEUE_SELECT} FROM queue
         WHERE account_id=? AND status IN ('scheduled','publishing')
           AND (?=0 OR source<>'autopilot')
           AND (status='publishing' OR source<>'autopilot' OR EXISTS (
             SELECT 1 FROM autopilot ap WHERE ap.account_id=queue.account_id AND ap.enabled=1))
           AND scheduled_at<=? AND (next_step_at IS NULL OR next_step_at<=?)
         ORDER BY scheduled_at ASC LIMIT 1`,
      account.id,
      ctx.env.APP_ENV === "staging" ? 1 : 0,
      nowIso,
      nowIso,
    );
    if (!row) break;

    if (row.status === "scheduled") {
      const claim = await ctx.db.run(
        `UPDATE queue SET status='publishing', updated_at=? WHERE id=? AND status='scheduled'
           AND updated_at=? AND scheduled_at=? AND body=? AND comments_json=? AND image_url IS ?
           AND reply_control=? AND next_step_at IS ? AND step=?
           AND (source<>'autopilot' OR EXISTS (
             SELECT 1 FROM autopilot ap WHERE ap.account_id=queue.account_id AND ap.enabled=1))`,
        nowIso, row.id, row.updated_at, row.scheduled_at, row.body, row.comments_json, row.image_url,
        row.reply_control, row.next_step_at, row.step,
      );
      if (claim.changes === 0) continue;
      row.status = "publishing";
    }

    let outcome: StepOutcome;
    try {
      outcome = await runStep(ctx, account, row, token, call, clock);
    } catch (e) {
      if (e instanceof ThreadsApiError) {
        const err = e.toThreadsError();
        if (isRateLimit(err)) {
          // 後ろに倒して再試行する（SPEC §8.3）。失敗としては数えない
          await patchQueue(ctx.db, ctx, row.id, {
            nextStepAt: new Date(ctx.now.getTime() + RATE_LIMIT_BACKOFF_SEC * 1000).toISOString(),
            attempts: row.attempts + 1,
            error: threadsReason(err),
            errorRaw: err.raw || `#${err.code} ${err.message}`,
          });
          return;
        }
        // step と result_ids はそのまま残す。再開したら続きから進む（二重投稿防止）
        await failQueue(ctx, row, threadsReason(err), err.raw || `#${err.code} ${err.message}`);
        continue;
      }
      throw e;
    }
    if (outcome === "stop") break;
  }

  // 続きは次の5分の cron が拾う（`enqueueForCron` が publish を積み直す）。
  // ここで積み直さないのは、同じアカウントの publish を常に1本に保つため
  // （2本が並走すると、`publishing` の行を両方が拾ってコメントを二重投稿しうる）。
}
