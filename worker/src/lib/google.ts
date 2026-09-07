/** Google credentials never leave this module's server callers. Use drive.file, not full Drive access. */
import type { Env } from "../env";
import type { Db } from "./db";
import type { Budget } from "./budget";
import { bytesToBase64Url, decrypt } from "./crypto";

export const GOOGLE_SCOPE = "openid https://www.googleapis.com/auth/drive.file";
export const GOOGLE_COOKIE = "tap_google_oauth";
export function googleConfigured(env: Env): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim(),
  );
}
export function googleRedirect(env: Env): string {
  return new URL("/api/google/callback", env.APP_ORIGIN).href;
}
export function randomToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
export class GoogleError extends Error {
  constructor(readonly kind: "reauth" | "missing" | "rate" | "temporary") {
    super(
      {
        reauth: "Googleとの再連携が必要です",
        missing: "スプレッドシートが削除されたか、アクセスできません",
        rate: "Google同期が混み合っています。自動で再試行します",
        temporary: "Google同期に失敗しました。自動で再試行します",
      }[kind],
    );
  }
}

/** Fixed allowlist: never attach credentials to a caller-supplied URL or follow redirects. */
export async function googleRequest<T>(
  db: Db,
  budget: Budget,
  url: string,
  init: RequestInit,
): Promise<T> {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    ![
      "oauth2.googleapis.com",
      "sheets.googleapis.com",
      "www.googleapis.com",
      "openidconnect.googleapis.com",
    ].includes(target.hostname)
  )
    throw new Error("Google host not allowed");
  budget.timeMs.check();
  budget.subrequests.use();
  if (
    target.hostname === "sheets.googleapis.com" ||
    target.hostname === "www.googleapis.com"
  ) {
    const bucket = `${new Date().toISOString().slice(0, 16)}:${init.method === "GET" ? "read" : "write"}`;
    const hit = await db.run(
      `INSERT INTO google_api_budget(bucket,n) VALUES (?,1) ON CONFLICT(bucket) DO UPDATE SET n=n+1 WHERE n<150`,
      bucket,
    );
    if (!hit.changes) throw new GoogleError("rate");
  }
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10_000);
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "error",
      signal: abort.signal,
    });
    if (res.status === 429) throw new GoogleError("rate");
    if (res.status === 401) throw new GoogleError("reauth");
    // Read errors only to classify; never propagate Google bodies (may contain credentials).
    if (!res.ok) {
      const error = (await res.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      if (
        target.hostname === "oauth2.googleapis.com" &&
        error?.error === "invalid_grant"
      )
        throw new GoogleError("reauth");
      if (res.status === 404 || res.status === 403)
        throw new GoogleError("missing");
      throw new GoogleError("temporary");
    }
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof GoogleError) throw e;
    throw new GoogleError("temporary");
  } finally {
    clearTimeout(timeout);
  }
}
export async function googleAccess(
  env: Env,
  db: Db,
  budget: Budget,
  refreshEnc: string,
): Promise<string> {
  if (!googleConfigured(env)) throw new GoogleError("reauth");
  const token = await googleRequest<{ access_token?: string }>(
    db,
    budget,
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        grant_type: "refresh_token",
        refresh_token: await decrypt(refreshEnc, env.ENC_KEY),
      }),
    },
  );
  if (!token.access_token) throw new GoogleError("reauth");
  return token.access_token;
}
export function googleHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}
