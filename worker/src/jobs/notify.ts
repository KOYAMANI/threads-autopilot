/**
 * `ap_notify`（毎時。SPEC §9.5）。
 *
 * | 承認方式 | いつ通知するか |
 * |---|---|
 * | `manual` | 作成直後（「承認してください」） |
 * | `cancel` | `now >= approve_deadline` かつ未通知（「◯時間後に出ます。取り消すならこちら」） |
 * | `auto`   | 投稿後（`done` になったあと） |
 *
 * 承認・取消のリンクは §7.9 の `{APP_ORIGIN}/a/<token>`。ログイン状態に関係なく踏める
 * URL であることが要件（`SameSite=Strict` の Cookie はメールからの遷移に付かない）。
 * Web Push は M7（DECISIONS に理由）。
 */
import { apLog } from "../lib/autopilot";
import { sendEmail } from "../lib/email";
import type { JobContext, RunningJob } from "../lib/jobs";
import { actionUrl, notifyTargets } from "../lib/notify";
import { formatSlot } from "./plan";

/** 1回の実行で送る上限（暴走ガード）。 */
export const MAX_NOTIFY_PER_RUN = 20;

type Pending = {
  id: string;
  status: string;
  scheduled_at: string | null;
  approval_mode: string | null;
  approve_deadline: string | null;
  body: string;
  tags_json: string;
};

function hookOf(tagsJson: string): string {
  try {
    const t = JSON.parse(tagsJson) as { hook?: unknown };
    return typeof t.hook === "string" ? t.hook : "";
  } catch {
    return "";
  }
}

/**
 * 通知すべきキューを拾う（SPEC §9.5）。`notified_at` が入っている行は二度送らない。
 * - `manual`: `pending_approval` の行を作成直後に
 * - `cancel`: `scheduled` で `approve_deadline` を過ぎた行を
 * - `auto`:   `done` になった行を
 */
export async function pendingNotifications(
  ctx: JobContext,
  accountId: string,
): Promise<Pending[]> {
  const nowIso = ctx.now.toISOString();
  return ctx.db.all<Pending>(
    `SELECT id, status, scheduled_at, approval_mode, approve_deadline, body, tags_json
       FROM queue
      WHERE account_id=? AND source='autopilot' AND notified_at IS NULL
        AND (
          (approval_mode='manual' AND status='pending_approval')
          OR (approval_mode='cancel' AND status='scheduled'
              AND approve_deadline IS NOT NULL AND approve_deadline<=?)
          OR (approval_mode='auto' AND status='done')
        )
      ORDER BY scheduled_at ASC
      LIMIT ?`,
    accountId,
    nowIso,
    MAX_NOTIFY_PER_RUN,
  );
}

export type NotifySummary = { sent: number; skipped: string | null };

export async function notifyAccount(ctx: JobContext, accountId: string): Promise<NotifySummary> {
  const account = await ctx.db.first<{ username: string; timezone: string }>(
    "SELECT username, timezone FROM accounts WHERE id=?",
    accountId,
  );
  if (!account) return { sent: 0, skipped: "アカウントがありません" };

  const rows = await pendingNotifications(ctx, accountId);
  if (rows.length === 0) return { sent: 0, skipped: null };

  const target = await notifyTargets(ctx.db, accountId);
  if (!target) {
    // 通知オフ。送らないが、同じ行を毎時見に行かないよう印だけ付ける
    for (const row of rows) await markNotified(ctx, accountId, row.id);
    return { sent: 0, skipped: "メール通知がオフです" };
  }

  let sent = 0;
  for (const row of rows) {
    ctx.budget.timeMs.check();
    const when = row.scheduled_at ? formatSlot(row.scheduled_at, account.timezone) : "";

    if (row.approval_mode === "auto") {
      await sendEmail(ctx.env, target.email, "ap_published", {
        username: account.username,
        when,
        body: row.body,
        appOrigin: ctx.env.APP_ORIGIN,
      });
    } else {
      const nowMs = ctx.now.getTime();
      const cancelUrl = await actionUrl(ctx.env, {
        queueId: row.id,
        action: "cancel",
        scheduledAt: row.scheduled_at,
        nowMs,
      });
      const approveUrl =
        row.approval_mode === "manual"
          ? await actionUrl(ctx.env, {
              queueId: row.id,
              action: "approve",
              scheduledAt: row.scheduled_at,
              nowMs,
            })
          : undefined;
      await sendEmail(ctx.env, target.email, "ap_draft", {
        username: account.username,
        when,
        hook: hookOf(row.tags_json),
        body: row.body,
        mode: row.approval_mode ?? "cancel",
        ...(approveUrl ? { approveUrl } : {}),
        cancelUrl,
        appOrigin: ctx.env.APP_ORIGIN,
      });
    }

    await markNotified(ctx, accountId, row.id);
    await apLog(
      ctx.db,
      accountId,
      "notify",
      row.approval_mode === "manual"
        ? `${when}の下書きの承認をお願いするメールを送りました`
        : row.approval_mode === "auto"
          ? `${when}に自動投稿したことをメールで知らせました`
          : `${when}に投稿することをメールで知らせました（取消のリンク付き）`,
      row.id,
      ctx.now,
    );
    sent++;
  }
  return { sent, skipped: null };
}

/** 二度送らないための印。`notified_at` が入っている行は `pendingNotifications` が拾わない。 */
async function markNotified(ctx: JobContext, accountId: string, queueId: string): Promise<void> {
  await ctx.db.run(
    "UPDATE queue SET notified_at=?, updated_at=? WHERE id=? AND account_id=? AND notified_at IS NULL",
    ctx.now.toISOString(),
    ctx.now.toISOString(),
    queueId,
    accountId,
  );
}

export async function apNotifyJob(ctx: JobContext, job: RunningJob): Promise<void> {
  if (!job.accountId) return;
  const summary = await notifyAccount(ctx, job.accountId);
  job.state.sent = summary.sent;
  if (summary.skipped) job.state.skipped = summary.skipped;
}
