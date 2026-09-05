/**
 * セッション Cookie と署名トークン（SPEC §5.1 / §5.3）。
 * - Cookie `sid`: HttpOnly, Secure, SameSite=Strict, 30日
 * - signToken / verifyToken: pwreset と qaction の共用（HMAC-SHA256）
 */
import type { Db } from "./db";
import { base64UrlToBytes, bytesToBase64Url, hmacSha256, timingSafeEqual } from "./crypto";

export const SESSION_COOKIE = "sid";
export const SESSION_DAYS = 30;

export type SessionRow = { id: string; user_id: string; expires_at: string; created_at: string };

/* ── Cookie ─────────────────────────────────────────── */

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function sessionCookie(id: string, maxAgeSec = SESSION_DAYS * 86400): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/* ── sessions テーブル ──────────────────────────────── */

export async function createSession(
  db: Db,
  userId: string,
  ua: string | null,
  now = new Date(),
): Promise<SessionRow> {
  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86400_000).toISOString();
  await db.run(
    "INSERT INTO sessions (id, user_id, expires_at, created_at, ua) VALUES (?,?,?,?,?)",
    id,
    userId,
    expiresAt,
    createdAt,
    ua,
  );
  return { id, user_id: userId, expires_at: expiresAt, created_at: createdAt };
}

export async function getSession(db: Db, id: string, now = new Date()): Promise<SessionRow | null> {
  return db.first<SessionRow>(
    "SELECT id, user_id, expires_at, created_at FROM sessions WHERE id=? AND expires_at>?",
    id,
    now.toISOString(),
  );
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.run("DELETE FROM sessions WHERE id=?", id);
}

/** パスワード再設定・ライセンス失効で全端末ログアウトさせる（SPEC §5.1 / §5.4）。 */
export async function deleteUserSessions(db: Db, userId: string): Promise<number> {
  const res = await db.run("DELETE FROM sessions WHERE user_id=?", userId);
  return res.changes;
}

/* ── 署名トークン（SPEC §5.3） ──────────────────────── */

export type TokenPurpose = "pwreset" | "qaction";

export type TokenPayload = {
  purpose: TokenPurpose;
  sub: string;
  extra: string;
  /** UNIX 秒 */
  expires: number;
};

/**
 * payload = `${purpose}|${sub}|${extra}|${expires}`
 * token   = base64url(payload) + "." + base64url(HMAC-SHA256(SESSION_SECRET, payload))
 */
export async function signToken(secret: string, payload: TokenPayload): Promise<string> {
  const body = `${payload.purpose}|${payload.sub}|${payload.extra}|${payload.expires}`;
  const sig = await hmacSha256(secret, body);
  return `${bytesToBase64Url(new TextEncoder().encode(body))}.${bytesToBase64Url(sig)}`;
}

/**
 * 検証は base64url デコード → 署名再計算 → 定数時間比較 → expires → purpose の順。
 * どこで落ちても同じ null を返す（失敗理由を漏らさない）。
 * 1回性は DB 側で見る（password_resets.used_at / queue.action_token_used_at）。
 */
export async function verifyToken(
  secret: string,
  token: string,
  purpose: TokenPurpose,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<TokenPayload | null> {
  try {
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;
    const bodyPart = token.slice(0, dot);
    const sigPart = token.slice(dot + 1);
    const body = new TextDecoder().decode(base64UrlToBytes(bodyPart));
    const expected = await hmacSha256(secret, body);
    const given = base64UrlToBytes(sigPart);
    if (!timingSafeEqual(expected, given)) return null;

    const fields = body.split("|");
    if (fields.length !== 4) return null;
    const [p, sub, extra, expStr] = fields as [string, string, string, string];
    const expires = Number.parseInt(expStr, 10);
    if (!Number.isFinite(expires)) return null;
    if (expires <= nowSec) return null;
    if (p !== purpose) return null;
    return { purpose: p, sub, extra, expires };
  } catch {
    return null;
  }
}

/* ── CSRF（SPEC §5.1） ──────────────────────────────── */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** /api/* の変更系は `X-Requested-With: fetch` を必須にする。 */
export function hasRequestedWith(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  return (req.headers.get("X-Requested-With") ?? "").toLowerCase() === "fetch";
}
