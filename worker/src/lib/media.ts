import type { Env } from "../env";
import type { Db } from "./db";

export const MAX_POST_MEDIA_BYTES = 8_000_000;
/** R2 の無料枠 10 GB-month に対して 3 GB の余白を残す。 */
export const MAX_TOTAL_MEDIA_BYTES = 7_000_000_000;
/** 誤操作や自動化の暴走で Class A 無料枠を消費しないための24時間上限。 */
export const MAX_DAILY_MEDIA_UPLOADS_PER_USER = 100;
export const TEMP_MEDIA_RETENTION_MS = 24 * 60 * 60_000;
export const DRAFT_MEDIA_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const PUBLISHED_MEDIA_GRACE_MS = 48 * 60 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MediaObjectRow = {
  id: string;
  user_id: string;
  account_id: string;
  content_type: string;
  byte_size: number;
  created_at: string;
  expires_at: string;
};

export function mediaObjectKey(id: string): string {
  return `post-media/${id}`;
}

export function mediaPublicUrl(env: Pick<Env, "APP_ORIGIN">, id: string): string {
  return `${env.APP_ORIGIN.replace(/\/$/, "")}/api/media/${id}`;
}

function managedId(env: Pick<Env, "APP_ORIGIN">, value: string): { managed: boolean; id: string | null } {
  try {
    const url = new URL(value);
    const app = new URL(env.APP_ORIGIN);
    if (url.origin !== app.origin || !url.pathname.startsWith("/api/media/")) return { managed: false, id: null };
    const id = decodeURIComponent(url.pathname.slice("/api/media/".length));
    return { managed: true, id: UUID_RE.test(id) ? id : null };
  } catch {
    return { managed: false, id: null };
  }
}

export function managedMediaIds(env: Pick<Env, "APP_ORIGIN">, urls: string[]): { ids: string[]; valid: boolean } {
  const ids = new Set<string>();
  for (const url of urls) {
    const parsed = managedId(env, url);
    if (parsed.managed && !parsed.id) return { ids: [], valid: false };
    if (parsed.id) ids.add(parsed.id);
  }
  return { ids: [...ids], valid: true };
}

export async function validateOwnedMedia(
  db: Db,
  env: Pick<Env, "APP_ORIGIN">,
  userId: string,
  accountId: string,
  urls: string[],
  now = new Date(),
): Promise<{ ok: true; ids: string[] } | { ok: false }> {
  const parsed = managedMediaIds(env, urls);
  if (!parsed.valid) return { ok: false };
  if (parsed.ids.length === 0) return { ok: true, ids: [] };
  const placeholders = parsed.ids.map(() => "?").join(",");
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM media_objects
      WHERE user_id=? AND account_id=? AND expires_at>? AND id IN (${placeholders})`,
    userId,
    accountId,
    now.toISOString(),
    ...parsed.ids,
  );
  return rows.length === parsed.ids.length ? { ok: true, ids: parsed.ids } : { ok: false };
}

export async function extendMediaRetention(
  db: Db,
  ids: string[],
  expiresAt: Date,
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await db.run(
    `UPDATE media_objects SET expires_at=MAX(expires_at,?) WHERE id IN (${placeholders})`,
    expiresAt.toISOString(),
    ...ids,
  );
}

export function queueMediaExpiry(status: string, scheduledAt: string | null, now = new Date()): Date {
  if (status === "draft") return new Date(now.getTime() + DRAFT_MEDIA_RETENTION_MS);
  const publishAt = scheduledAt ? Date.parse(scheduledAt) : now.getTime();
  return new Date(Math.max(now.getTime(), Number.isFinite(publishAt) ? publishAt : now.getTime()) + PUBLISHED_MEDIA_GRACE_MS);
}

export async function cleanupExpiredMedia(env: Pick<Env, "MEDIA_BUCKET">, db: Db, now = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const rows = await db.all<{ id: string }>(
    "SELECT id FROM media_objects WHERE expires_at<=? ORDER BY expires_at LIMIT 250",
    nowIso,
  );
  if (rows.length === 0) return 0;
  await env.MEDIA_BUCKET.delete(rows.map(row => mediaObjectKey(row.id)));
  const placeholders = rows.map(() => "?").join(",");
  await db.run(
    `DELETE FROM media_objects WHERE expires_at<=? AND id IN (${placeholders})`,
    nowIso,
    ...rows.map(row => row.id),
  );
  return rows.length;
}
