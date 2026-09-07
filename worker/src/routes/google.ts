import { Hono } from "hono";
import { z } from "zod";
import { ok } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { bytesToBase64Url, decrypt, encrypt, sha256Hex } from "../lib/crypto";
import { readCookie } from "../lib/session";
import {
  GOOGLE_COOKIE,
  GOOGLE_SCOPE,
  googleConfigured,
  googleRedirect,
  googleRequest,
  googleHeaders,
  randomToken,
} from "../lib/google";
import { audit } from "../lib/audit";

export function googleRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/status", async (c) => {
    const row = await c
      .get("db")
      .first<{
        spreadsheet_id: string | null;
        status: string;
        last_sync_at: string | null;
        last_error: string | null;
      }>(
        "SELECT spreadsheet_id,status,last_sync_at,last_error FROM google_connections WHERE user_id=?",
        c.get("userId")!,
      );
    return c.json(
      ok({
        configured: googleConfigured(c.env),
        connected: Boolean(row),
        status: row?.status ?? "disconnected",
        spreadsheetUrl: row?.spreadsheet_id
          ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(row.spreadsheet_id)}/edit`
          : null,
        lastSyncAt: row?.last_sync_at ?? null,
        lastError: row?.last_error ?? null,
      }),
    );
  });
  r.post("/start", async (c) => {
    if (!googleConfigured(c.env))
      return fail(
        "NOT_CONFIGURED",
        "Google連携は管理者による設定待ちです",
        503,
      );
    const state = randomToken(),
      browser = randomToken(),
      verifier = randomToken();
    const challenge = bytesToBase64Url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    );
    const db = c.get("db"),
      userId = c.get("userId")!;
    await db.batch([
      {
        sql: "DELETE FROM google_oauth_states WHERE user_id=? OR expires_at<?",
        params: [userId, new Date().toISOString()],
      },
      {
        sql: "INSERT INTO google_oauth_states(id,user_id,session_id,browser_hash,verifier_enc,expires_at) VALUES (?,?,?,?,?,?)",
        params: [
          await sha256Hex(state),
          userId,
          c.get("sessionId"),
          await sha256Hex(browser),
          await encrypt(verifier, c.env.ENC_KEY),
          new Date(Date.now() + 600_000).toISOString(),
        ],
      },
    ]);
    c.header(
      "Set-Cookie",
      `${GOOGLE_COOKIE}=${browser}; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID!,
      redirect_uri: googleRedirect(c.env),
      response_type: "code",
      scope: GOOGLE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return c.json(ok({ url: url.href }));
  });
  // OAuth arrives cross-site. Load a same-origin document before the authenticated completion POST,
  // so the normal Strict session cookie works without weakening every application session to Lax.
  r.get("/callback", (c) => {
    const nonce = randomToken();
    const payload = JSON.stringify({
      state: c.req.query("state") ?? "",
      code: c.req.query("code") ?? "",
    }).replace(/</g, "\\u003c");
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Google連携</title><p id="message">Googleとの連携を確認しています…</p><script nonce="${nonce}">
      const payload=${payload}; history.replaceState(null,'','/api/google/callback');
      fetch('/api/google/complete',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify(payload)})
      .then(r=>{location.replace('/app/settings?google='+(r.ok?'connected':'failed'));})
      .catch(()=>{document.getElementById('message').textContent='連携できませんでした。設定画面からもう一度お試しください。';});
      </script><noscript>JavaScriptを有効にし、設定画面から再度連携してください。</noscript></html>`);
  });
  r.post("/complete", async (c) => {
    if (!googleConfigured(c.env))
      return fail("NOT_CONFIGURED", "Google連携は未設定です", 503);
    const input = z
      .object({
        state: z.string().min(20).max(200),
        code: z.string().min(1).max(4096),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return fail("OAUTH_INVALID", "連携を開始し直してください", 400);
    const db = c.get("db"),
      userId = c.get("userId")!,
      id = await sha256Hex(input.data.state);
    const browser = readCookie(c.req.raw, GOOGLE_COOKIE);
    if (!browser)
      return fail(
        "OAUTH_INVALID",
        "連携を開始したブラウザでお試しください",
        400,
      );
    const state = await db.first<{ verifier_enc: string }>(
      `DELETE FROM google_oauth_states WHERE id=? AND user_id=? AND session_id=? AND browser_hash=? AND expires_at>? RETURNING verifier_enc`,
      id,
      userId,
      c.get("sessionId"),
      await sha256Hex(browser),
      new Date().toISOString(),
    );
    if (!state) return fail("OAUTH_INVALID", "連携を開始し直してください", 400);
    c.header(
      "Set-Cookie",
      `${GOOGLE_COOKIE}=; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );
    try {
      const token = await googleRequest<{
        access_token?: string;
        refresh_token?: string;
        scope?: string;
      }>(db, c.get("budget"), "https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: c.env.GOOGLE_CLIENT_ID!,
          client_secret: c.env.GOOGLE_CLIENT_SECRET!,
          code: input.data.code,
          code_verifier: await decrypt(state.verifier_enc, c.env.ENC_KEY),
          redirect_uri: googleRedirect(c.env),
          grant_type: "authorization_code",
        }),
      });
      if (
        !token.access_token ||
        !token.refresh_token ||
        !token.scope
          ?.split(" ")
          .includes("https://www.googleapis.com/auth/drive.file")
      )
        return fail(
          "OAUTH_SCOPE",
          "スプレッドシートへのアクセスを許可して再連携してください",
          400,
        );
      const identity = await googleRequest<{ sub?: string }>(
        db,
        c.get("budget"),
        "https://openidconnect.googleapis.com/v1/userinfo",
        { method: "GET", headers: googleHeaders(token.access_token) },
      );
      if (!identity.sub)
        return fail(
          "OAUTH_INVALID",
          "Googleアカウントを確認できませんでした",
          400,
        );
      const now = new Date().toISOString();
      const stored = await db.run(
        `INSERT INTO google_connections(user_id,google_sub,refresh_enc,next_sync_at,updated_at) SELECT ?,?,?,?,?
        WHERE EXISTS (SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?)
        ON CONFLICT(user_id) DO UPDATE SET refresh_enc=excluded.refresh_enc,
        spreadsheet_id=CASE WHEN google_sub=excluded.google_sub THEN spreadsheet_id ELSE NULL END,
        last_sync_at=CASE WHEN google_sub=excluded.google_sub THEN last_sync_at ELSE NULL END,
        google_sub=excluded.google_sub,status='connected',last_error=NULL,next_sync_at=excluded.next_sync_at,updated_at=excluded.updated_at,
        lease_id=NULL,lease_until=NULL`,
        userId,
        identity.sub,
        await encrypt(token.refresh_token, c.env.ENC_KEY),
        now,
        now,
        c.get("sessionId"),
        userId,
        now,
      );
      if (!stored.changes)
        return fail("UNAUTHORIZED", "ログインし直して再連携してください", 401);
      await audit(db, userId, "google_connect", {});
      return c.json(ok({ connected: true }));
    } catch {
      return fail(
        "GOOGLE_ERROR",
        "Google連携に失敗しました。設定画面から再度お試しください",
        502,
      );
    }
  });
  r.post("/sync", async (c) => {
    const db = c.get("db"),
      userId = c.get("userId")!;
    const change = await db.run(
      "UPDATE google_connections SET next_sync_at=? WHERE user_id=? AND status='connected' AND (last_sync_at IS NULL OR last_sync_at<?)",
      new Date().toISOString(),
      userId,
      new Date(Date.now() - 60_000).toISOString(),
    );
    if (!change.changes)
      return fail(
        "SYNC_UNAVAILABLE",
        "連携状態を確認するか、1分ほど待ってお試しください",
        409,
      );
    return c.json(ok({ queued: true }), 202);
  });
  r.post("/repair", async (c) => {
    const result = await c
      .get("db")
      .run(
        "UPDATE google_connections SET spreadsheet_id=NULL,status='connected',last_error=NULL,next_sync_at=?,lease_id=NULL,lease_until=NULL WHERE user_id=? AND status='needs_attention'",
        new Date().toISOString(),
        c.get("userId")!,
      );
    if (!result.changes)
      return fail("BAD_REQUEST", "修復が必要な管理表がありません", 409);
    return c.json(ok({ queued: true }), 202);
  });
  r.delete("/connection", async (c) => {
    const db = c.get("db"),
      userId = c.get("userId")!;
    await db.batch([
      {
        sql: "DELETE FROM google_oauth_states WHERE user_id=?",
        params: [userId],
      },
      {
        sql: "DELETE FROM google_connections WHERE user_id=?",
        params: [userId],
      },
      {
        sql: "DELETE FROM jobs WHERE type='sheets_sync' AND json_extract(state_json,'$.userId')=?",
        params: [userId],
      },
    ]);
    await audit(db, userId, "google_disconnect", {});
    return c.json(ok({ disconnected: true }));
  });
  return r;
}
