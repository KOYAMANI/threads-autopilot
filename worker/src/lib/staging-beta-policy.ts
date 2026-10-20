import type { Env } from "../env";
import type { Db } from "./db";
import { canPublishForUser } from "./staging-review-policy";

export function allStagingUsers(env: Env): boolean {
  return env.APP_ENV === "staging" && env.STAGING_ALL_USERS_PUBLISHING === "1";
}

export function betaPublishingActive(env: Env, now = Date.now()): boolean {
  if (allStagingUsers(env)) return true;
  return env.APP_ENV === "staging" && env.STAGING_BETA_PUBLISHING === "1"
    && Number.isFinite(Date.parse(env.STAGING_BETA_UNTIL ?? ""))
    && now < Date.parse(env.STAGING_BETA_UNTIL!);
}
export async function betaUserAllowed(env: Env, db: Db, userId: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (!userId || !betaPublishingActive(env, now)) return false;
  if (allStagingUsers(env)) return Boolean(await db.first(`SELECT u.id FROM users u JOIN licenses l ON l.id=u.license_id WHERE u.id=? AND l.status='active'`, userId));
  return Boolean(await db.first(`SELECT u.id FROM users u JOIN licenses l ON l.id=u.license_id
    JOIN staging_beta_licenses b ON b.license_id=l.id WHERE u.id=? AND l.status='active'`, userId));
}
export async function publishingEnabledForUser(env: Env, db: Db, userId: string | null | undefined, now = Date.now()): Promise<boolean> {
  return canPublishForUser(env, userId, now) || await betaUserAllowed(env, db, userId, now);
}
export async function canPublishForAccount(env: Env, db: Db, userId: string, threadsUserId: string, now = Date.now()): Promise<boolean> {
  if (env.APP_ENV !== "staging") return true;
  if (allStagingUsers(env)) return await betaUserAllowed(env, db, userId, now) && Boolean(await db.first("SELECT id FROM accounts WHERE user_id=? AND threads_user_id=? AND status='ok'", userId, threadsUserId));
  if (canPublishForUser(env, userId, now) && threadsUserId === env.STAGING_THREADS_USER_ID) return true;
  if (!await betaUserAllowed(env, db, userId, now)) return false;
  return Boolean(await db.first(`SELECT username FROM staging_beta_profiles
    WHERE user_id=? AND threads_user_id=? AND enabled=1`, userId, threadsUserId));
}
/** Claim once using only the authenticated /me profile. Renames do not transfer a grant. */
export async function claimBetaProfile(env: Env, db: Db, userId: string, profile: {id:string; username?:string}, now = Date.now()): Promise<boolean> {
  if (!await betaUserAllowed(env, db, userId, now)) return false;
  if (allStagingUsers(env)) return !await db.first("SELECT id FROM accounts WHERE threads_user_id=? AND user_id<>?", profile.id, userId);
  const pinned = await db.first<{user_id:string; enabled:number}>(
    "SELECT user_id,enabled FROM staging_beta_profiles WHERE threads_user_id=?", profile.id);
  if (pinned) return pinned.user_id === userId && pinned.enabled === 1;
  const name = profile.username?.trim().replace(/^@/, "").toLowerCase();
  if (!name || !/^[a-z0-9._]{1,30}$/.test(name)) return false;
  await db.run(`UPDATE staging_beta_profiles SET threads_user_id=?,user_id=?,connected_at=?
    WHERE username=? AND enabled=1 AND threads_user_id IS NULL AND user_id IS NULL`,
    profile.id, userId, new Date(now).toISOString(), name);
  return Boolean(await db.first(`SELECT username FROM staging_beta_profiles
    WHERE username=? AND threads_user_id=? AND user_id=? AND enabled=1`, name, profile.id, userId));
}
