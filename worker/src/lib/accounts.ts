/**
 * accounts テーブルまわりの共通処理（SPEC §7.1 / §6.1）。
 * ルート（routes/accounts.ts）とジョブ（jobs/*.ts）の両方から使う。
 */
import type { AccountSummary } from "@tap/shared";
import type { Db } from "./db";
import { sendEmail } from "./email";
import { notifyTargets } from "./notify";
import type { Env } from "../env";
import { decrypt } from "./crypto";
import { isTokenInvalid, ThreadsApiError } from "./threads-error";

export type AccountRow = {
  id: string;
  user_id: string;
  threads_user_id: string;
  username: string;
  name: string | null;
  avatar_url: string | null;
  color: string;
  token_enc: string;
  token_obtained_at: string;
  token_long_lived: number;
  token_last_refresh_at: string | null;
  status: string;
  timezone: string;
  settings_json: string;
  last_full_sync_at: string | null;
  created_at: string;
};

export const ACCOUNT_COLUMNS =
  "id, user_id, threads_user_id, username, name, avatar_url, color, token_enc, token_obtained_at, token_long_lived, token_last_refresh_at, status, timezone, settings_json, last_full_sync_at, created_at";

/** SPEC §7.1: 同一ユーザーで3件まで。 */
export const ACCOUNT_LIMIT = 3;

/** アカウントの色。接続順に割り当てる（プロトタイプ到着後に差し替える可能性あり）。 */
export const ACCOUNT_COLORS = ["#4f7cff", "#12b886", "#e8590c"];

export async function loadAccount(db: Db, accountId: string): Promise<AccountRow | null> {
  return db.first<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id=?`, accountId);
}

/** 本人のアカウントであることを確かめてから返す（SPEC §7 冒頭）。 */
export async function loadOwnedAccount(
  db: Db,
  accountId: string,
  userId: string,
): Promise<AccountRow | null> {
  return db.first<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id=? AND user_id=?`,
    accountId,
    userId,
  );
}

/** 復号したトークン。呼び出し元の関数スコープで使い切る（SPEC §5.2）。 */
export async function accountToken(env: Env, account: AccountRow): Promise<string> {
  return decrypt(account.token_enc, env.ENC_KEY);
}

export function parseSettings(account: AccountRow): Record<string, unknown> {
  try {
    const v = JSON.parse(account.settings_json) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * code 190 を受けたらアカウントを `needs_reauth` にする（SPEC §6.1 / §8.6）。
 * あわせてオートパイロットを一時停止し、`env` があればメールで知らせる（SPEC §8.6 / §10.5）。
 * 状態が変わった回だけ送る（毎時のジョブが同じメールを繰り返さないように）。
 */
export async function markNeedsReauth(db: Db, accountId: string, env?: Env): Promise<void> {
  const res = await db.run(
    "UPDATE accounts SET status='needs_reauth' WHERE id=? AND status='ok'",
    accountId,
  );
  if (res.changes === 0) return; // すでに needs_reauth か disabled。二度目は送らない

  // needs_reauth のアカウントは計画しない（SPEC §9.6）。設定ごと止めて、
  // つなぎ直したときに買い手が自分でオンに戻す
  await db.run(
    "UPDATE autopilot SET enabled=0, updated_at=? WHERE account_id=? AND enabled=1",
    new Date().toISOString(),
    accountId,
  );
  if (!env) return;
  const account = await db.first<{ username: string }>(
    "SELECT username FROM accounts WHERE id=?",
    accountId,
  );
  const target = await notifyTargets(db, accountId);
  if (target) {
    await sendEmail(env, target.email, "needs_reauth", {
      username: account?.username ?? "",
      appOrigin: env.APP_ORIGIN,
    });
  }
}

export function isReauthError(e: unknown): boolean {
  return e instanceof ThreadsApiError && isTokenInvalid(e.toThreadsError());
}

/**
 * SPEC §7.1 `DELETE /accounts/:id` の削除対象。§7.8（退会）からも同じ順で使う。
 * 列挙を1か所に置いて、消し残しが出ないようにする。
 */
export const ACCOUNT_CHILD_TABLES = [
  "posts",
  "post_metrics_history",
  "queue",
  "learning",
  "links",
  "autopilot",
  "jobs",
  "daily_views",
  "follower_snapshots",
  "click_weeks",
  "click_weeks_done",
  "demographics",
  "ap_log",
] as const;

/** 関連データを全部消す。accounts 行そのものは最後に消す。 */
export async function deleteAccountData(db: Db, accountId: string): Promise<void> {
  await db.batch(
    ACCOUNT_CHILD_TABLES.map((t) => ({
      sql: `DELETE FROM ${t} WHERE account_id=?`,
      params: [accountId],
    })),
  );
  await db.run("DELETE FROM accounts WHERE id=?", accountId);
}

/* ── API 応答への変換（SPEC §7.1） ─────────────────── */

/** 長期トークンの有効期間（SPEC §6.3）。60日。 */
export const LONG_LIVED_DAYS = 60;

export function tokenExpiresInDays(account: AccountRow, nowMs: number): number | null {
  if (!account.token_long_lived) return null;
  const expires = Date.parse(account.token_obtained_at) + LONG_LIVED_DAYS * 86_400_000;
  return Math.max(0, Math.ceil((expires - nowMs) / 86_400_000));
}

export function toAccountSummary(
  account: AccountRow,
  options: { autopilotEnabled?: boolean; nowMs?: number } = {},
): AccountSummary {
  const nowMs = options.nowMs ?? Date.now();
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    avatarUrl: account.avatar_url,
    color: account.color,
    status: (account.status as AccountSummary["status"]) ?? "ok",
    timezone: account.timezone,
    tokenExpiresInDays: tokenExpiresInDays(account, nowMs),
    longLived: Boolean(account.token_long_lived),
    lastFullSyncAt: account.last_full_sync_at,
    autopilotEnabled: Boolean(options.autopilotEnabled),
  };
}
