/**
 * 通知の宛先と、メールに貼るワンタイムURL（SPEC §7.8 / §7.9 / §9.5 / §10.5）。
 *
 * 承認・取消のリンクは **Cookie に依存しない** `{APP_ORIGIN}/a/<token>` を使う。
 * セッション Cookie は `SameSite=Strict` なので、メールクライアントからの遷移には付かず、
 * アプリ内URLを貼ると必ずログイン画面に飛ぶため（SPEC §7.9）。
 */
import type { Env } from "../env";
import { decrypt } from "./crypto";
import type { Db } from "./db";
import { signToken } from "./session";
import { sendPush, type PushSubscription } from "./webpush";

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

/* ── Web Push の実送信（M7。SPEC §7.8 / §12.4） ─────── */

/**
 * その買い手の端末に Push を送る。**メールと並行**で、承認・取消・失敗など
 * すぐ知りたい通知にだけ使う（日次ダイジェストには使わない。急がないため）。
 *
 * - `notifications.push_enabled=1` の買い手にだけ送る（既定は 0）
 * - 購読は `push_subscriptions.json` に暗号化して入っている（SPEC §5.2）ので復号して使う
 * - 404/410 が返った購読は**その場で行を消す**（RFC 8030 §7.3。端末が消えている合図）
 * - それ以外の失敗は `fail_count` を数え、続くようなら送信の対象から外す
 * - 鍵（`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`）が無ければ何もしない。メールは別経路で届く
 *
 * **例外を投げない**。Push が失敗しても、メールが届いていれば運用は回る。
 */
export type PushPayload = { title: string; body: string; url?: string };

/** これ以上失敗が続いた購読には送らない（端末が長く落ちている等）。 */
export const PUSH_MAX_FAILURES = 5;

export async function pushToUser(
  env: Env,
  db: Db,
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; removed: number }> {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (env.VAPID_PRIVATE_KEY ?? "").trim();
  if (publicKey === "" || privateKey === "") return { sent: 0, removed: 0 };

  const settings = await db.first<{ push_enabled: number }>(
    "SELECT push_enabled FROM notifications WHERE user_id=?",
    userId,
  );
  if (!settings || settings.push_enabled !== 1) return { sent: 0, removed: 0 };

  const rows = await db.all<{ id: string; json: string; fail_count: number }>(
    "SELECT id, json, fail_count FROM push_subscriptions WHERE user_id=? AND fail_count<? LIMIT 10",
    userId,
    PUSH_MAX_FAILURES,
  );
  if (rows.length === 0) return { sent: 0, removed: 0 };

  // RFC 8292 の `sub` は `mailto:` か `https:` でなければならない。`VAPID_SUBJECT` が
  // 空なら APP_ORIGIN で代用するが、開発の `http://localhost:5173` はどちらでもないので
  // 使えない。有効な連絡先が無いときは**送らない**（メールは別経路で届く）。
  const candidate =
    (env.VAPID_SUBJECT ?? "").trim() !== ""
      ? env.VAPID_SUBJECT!.trim()
      : env.APP_ORIGIN.replace(/\/+$/, "");
  if (!candidate.startsWith("mailto:") && !candidate.startsWith("https:")) {
    return { sent: 0, removed: 0 };
  }
  const subject = candidate;

  let sent = 0;
  let removed = 0;
  const nowIso = new Date().toISOString();
  for (const row of rows) {
    let sub: PushSubscription;
    try {
      sub = JSON.parse(await decrypt(row.json, env.ENC_KEY)) as PushSubscription;
    } catch {
      // 復号できない行は ENC_KEY を替えたときの残骸。消しておく
      await db.run("DELETE FROM push_subscriptions WHERE id=?", row.id);
      removed++;
      continue;
    }
    const res = await sendPush({ publicKey, privateKey }, sub, payload, subject);
    if (res.ok) {
      sent++;
      if (row.fail_count > 0) {
        await db.run("UPDATE push_subscriptions SET fail_count=0 WHERE id=?", row.id);
      }
      continue;
    }
    if (res.gone) {
      await db.run("DELETE FROM push_subscriptions WHERE id=?", row.id);
      removed++;
      continue;
    }
    await db.run(
      "UPDATE push_subscriptions SET fail_count=fail_count+1, last_error_at=? WHERE id=?",
      nowIso,
      row.id,
    );
  }
  return { sent, removed };
}
