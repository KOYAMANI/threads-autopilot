/**
 * 通知の宛先と、メールに貼るワンタイムURL（SPEC §7.8 / §7.9 / §9.5 / §10.5）。
 *
 * 承認・取消のリンクは **Cookie に依存しない** `{APP_ORIGIN}/a/<token>` を使う。
 * セッション Cookie は `SameSite=Strict` なので、メールクライアントからの遷移には付かず、
 * アプリ内URLを貼ると必ずログイン画面に飛ぶため（SPEC §7.9）。
 */
import type { Env } from "../env";
import type { Db } from "./db";
import { signToken } from "./session";

export type NotifyTarget = { userId: string; email: string; emailEnabled: boolean };

/**
 * アカウントの持ち主のメール宛先。`notifications.email_enabled=0` なら null（送らない）。
 * `notifications` の行が無いときは既定（有効）として扱う（SPEC §4 の DEFAULT 1）。
 */
export async function notifyTargets(db: Db, accountId: string): Promise<NotifyTarget | null> {
  const row = await db.first<{ user_id: string; email: string; email_enabled: number | null }>(
    `SELECT u.id AS user_id, u.email AS email, n.email_enabled AS email_enabled
       FROM accounts a JOIN users u ON u.id=a.user_id
       LEFT JOIN notifications n ON n.user_id=u.id
      WHERE a.id=?`,
    accountId,
  );
  if (!row) return null;
  const enabled = row.email_enabled === null ? true : row.email_enabled === 1;
  if (!enabled) return null;
  return { userId: row.user_id, email: row.email, emailEnabled: enabled };
}

/** ユーザーIDから直接引く版（アカウントに紐づかない通知用）。 */
export async function notifyTargetForUser(db: Db, userId: string): Promise<NotifyTarget | null> {
  const row = await db.first<{ email: string; email_enabled: number | null }>(
    `SELECT u.email AS email, n.email_enabled AS email_enabled
       FROM users u LEFT JOIN notifications n ON n.user_id=u.id WHERE u.id=?`,
    userId,
  );
  if (!row) return null;
  const enabled = row.email_enabled === null ? true : row.email_enabled === 1;
  if (!enabled) return null;
  return { userId, email: row.email, emailEnabled: enabled };
}

/* ── ワンタイムURL（SPEC §7.9） ─────────────────────── */

export type QueueAction = "approve" | "cancel";

/** 発行時刻からの上限（SPEC §7.9「発行時刻 + 72時間」）。 */
export const ACTION_TOKEN_MAX_MS = 72 * 3_600_000;
/** 予定時刻からの上限（SPEC §7.9「scheduled_at + 1時間」）。 */
export const ACTION_TOKEN_AFTER_SCHEDULED_MS = 3_600_000;

/**
 * `expires = min(scheduled_at + 1時間, 発行時刻 + 72時間)` を UNIX 秒で返す（SPEC §7.9）。
 * `scheduled_at` が無い（下書き）ときは発行時刻 + 72時間。
 */
export function actionTokenExpires(scheduledAt: string | null, nowMs: number): number {
  const cap = nowMs + ACTION_TOKEN_MAX_MS;
  const fromSchedule = scheduledAt
    ? Date.parse(scheduledAt) + ACTION_TOKEN_AFTER_SCHEDULED_MS
    : cap;
  return Math.floor(Math.min(Number.isFinite(fromSchedule) ? fromSchedule : cap, cap) / 1000);
}

/** `{APP_ORIGIN}/a/<token>` を作る。`purpose='qaction'`（SPEC §5.3 / §7.9）。 */
export async function actionUrl(
  env: Env,
  options: { queueId: string; action: QueueAction; scheduledAt: string | null; nowMs: number },
): Promise<string> {
  const token = await signToken(env.SESSION_SECRET, {
    purpose: "qaction",
    sub: options.queueId,
    extra: options.action,
    expires: actionTokenExpires(options.scheduledAt, options.nowMs),
  });
  return `${env.APP_ORIGIN.replace(/\/+$/, "")}/a/${token}`;
}
