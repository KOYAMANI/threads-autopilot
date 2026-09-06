/**
 * 回数制限（SPEC §5.1）。`rate_events(key, at)` の窓の件数で数える。
 *
 * | 用途                       | キー                  | 数える対象               | 制限        |
 * |---------------------------|----------------------|-------------------------|-------------|
 * | ログイン                   | login:<email 小文字>  | 失敗だけ（成功で消す）    | 10分に10回  |
 * | パスワード再設定の要求      | forgot:<email 小文字> | 全リクエスト             | 10分に3回   |
 * | メールからの承認/取消(§7.9) | action:<ip>          | 全リクエスト（GET/POST） | 1分に20回   |
 * | AI 呼び出し（M7）          | ai:<user_id>         | 全リクエスト             | 1分に10回   |
 *
 * 窓の外の行は cleanup ジョブ（SPEC §8.7、1日）が消す。
 */
import type { Db } from "./db";

export const RATE_LIMITS = {
  login: { limit: 10, windowMin: 10 },
  forgot: { limit: 3, windowMin: 10 },
  action: { limit: 20, windowMin: 1 },
  /**
   * AI 呼び出し（`/ai/generate` `/ai/revise` `/ai/test`、M7 で追加）。1分に10回。
   *
   * SPEC には窓が書かれていないが、ここだけ無制限だと 1 リクエスト = 買い手の
   * AI キーの課金 1 回になる。画面から出せるのは「3案」ボタンの連打くらいなので、
   * 手が滑った程度では当たらず、スクリプトで回されたら止まる値にする。
   * キーは `ai:<user_id>`（IP ではなく本人。認証済みの経路なので）。
   */
  ai: { limit: 10, windowMin: 1 },
} as const;

export function loginKey(email: string): string {
  return `login:${email.trim().toLowerCase()}`;
}
export function forgotKey(email: string): string {
  return `forgot:${email.trim().toLowerCase()}`;
}
export function actionKey(ip: string): string {
  return `action:${ip}`;
}
export function aiKey(userId: string): string {
  return `ai:${userId}`;
}

/** 窓の中の件数。 */
export async function rateCount(db: Db, key: string, windowMin: number, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - windowMin * 60_000).toISOString();
  const row = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM rate_events WHERE key=? AND at>?",
    key,
    since,
  );
  return row?.n ?? 0;
}

/** 1件記録する。 */
export async function rateRecord(db: Db, key: string, now = new Date()): Promise<void> {
  await db.run("INSERT INTO rate_events (key, at) VALUES (?,?)", key, now.toISOString());
}

/** そのキーの記録を消す（ログイン成功時）。 */
export async function rateClear(db: Db, key: string): Promise<void> {
  await db.run("DELETE FROM rate_events WHERE key=?", key);
}

/**
 * 窓の件数が limit 以上なら false（＝弾く）。件数は数えるだけで、ここでは記録しない。
 * 記録するタイミング（失敗時のみ／毎回）が用途で違うため、呼び出し側で rateRecord を呼ぶ。
 */
export async function rateAllow(
  db: Db,
  key: string,
  limit: number,
  windowMin: number,
  now = new Date(),
): Promise<boolean> {
  return (await rateCount(db, key, windowMin, now)) < limit;
}

/**
 * 「1件記録してから、窓の件数が limit を超えていないか」を見る版。
 * 全リクエストを数える用途（forgot / action）向け。通れば true。
 */
export async function rateHit(
  db: Db,
  key: string,
  limit: number,
  windowMin: number,
  now = new Date(),
): Promise<boolean> {
  await rateRecord(db, key, now);
  return (await rateCount(db, key, windowMin, now)) <= limit;
}
