import type { Env } from "../env";

/** Explicit, expiring exception for a dedicated reviewer login and one pinned profile. */
export function reviewPublishingActive(env: Env, now = Date.now()): boolean {
  return env.APP_ENV === "staging" && env.STAGING_REVIEW_PUBLISHING === "1"
    && /^[a-f0-9-]{36}$/.test(env.STAGING_REVIEW_USER_ID ?? "")
    && /^\d+$/.test(env.STAGING_THREADS_USER_ID ?? "")
    && Number.isFinite(Date.parse(env.STAGING_REVIEW_UNTIL ?? ""))
    && now < Date.parse(env.STAGING_REVIEW_UNTIL!);
}
export function canPublishForUser(env: Env, userId: string | null | undefined, now = Date.now()): boolean {
  return env.APP_ENV !== "staging" || (reviewPublishingActive(env, now) && userId === env.STAGING_REVIEW_USER_ID);
}
export const STAGING_PUBLISHING_MESSAGE = "この検証用ログインでは実投稿・予約実行を停止しています。下書きとして保存してください。";
