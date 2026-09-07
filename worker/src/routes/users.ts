/**
 * 退会（SPEC §7.8 `DELETE /users/me`）とライセンス表示（SPEC §1「設定 … ライセンス」）。
 *
 * 退会はパスワードを**もう一度**確かめてから実行する。セッションが盗まれていても
 * 一発でデータを消せないようにするため。消す範囲は SPEC §7.8 の表がすべてで、
 * 消し残しを作らないよう対象を1か所（`lib/accounts.ts` の `ACCOUNT_CHILD_TABLES` と
 * 下の `USER_TABLES`）に列挙してある。
 *
 * `licenses` は行を残し、`user_id` を外して `status='revoked'` にする（再利用させない）。
 * `users` 行は消す。`audit_log` には削除の事実だけ残し、メールは SHA-256 のハッシュで置く
 * （平文を残さない）。完了後にメールで知らせる。
 */
import { Hono } from "hono";
import { z } from "zod";
import { ok, type LicenseSummary } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { ACCOUNT_CHILD_TABLES } from "../lib/accounts";
import { sha256Hex, verifyPassword } from "../lib/crypto";
import type { Db } from "../lib/db";
import { sendEmail } from "../lib/email";
import { forgotKey, loginKey } from "../lib/rate";

/** `user_id` を持つテーブル（SPEC §7.8 の表）。`users` は最後に消すのでここには入れない。 */
export const USER_TABLES = [
  "sessions",
  "google_connections",
  "google_oauth_states",
  "password_resets",
  "sources",
  "ai_settings",
  "notifications",
  "push_subscriptions",
] as const;

const deleteSchema = z.object({ password: z.string().min(1).max(200) });

/** ライセンスは末尾4桁と状態だけ返す（キー全体は画面に出さない）。 */
export async function loadLicense(db: Db, userId: string): Promise<LicenseSummary | null> {
  const row = await db.first<{
    key: string;
    status: string;
    issued_at: string;
    activated_at: string | null;
  }>(
    `SELECT l.key AS key, l.status AS status, l.issued_at AS issued_at, l.activated_at AS activated_at
       FROM users u JOIN licenses l ON l.id = u.license_id WHERE u.id=?`,
    userId,
  );
  if (!row) return null;
  return {
    keyTail: row.key.slice(-4),
    status: (row.status as LicenseSummary["status"]) ?? "active",
    issuedAt: row.issued_at,
    activatedAt: row.activated_at,
  };
}

export function userRoutes() {
  const r = new Hono<AppEnv>();

  /* ── ライセンス（設定画面に出す） ─────────────── */
  r.get("/me/license", async (c) => {
    const license = await loadLicense(c.get("db"), c.get("userId")!);
    if (!license) return fail("NOT_FOUND", "見つかりませんでした", 404);
    return c.json(ok({ license }));
  });

  /* ── 退会（SPEC §7.8） ───────────────────────── */
  r.delete("/me", async (c) => {
    let raw: unknown = null;
    try {
      raw = await c.req.json();
    } catch {
      raw = null;
    }
    const parsed = deleteSchema.safeParse(raw);
    if (!parsed.success) return fail("BAD_REQUEST", "パスワードを入力してください", 400);

    const db = c.get("db");
    const userId = c.get("userId")!;
    const user = await db.first<{
      id: string;
      email: string;
      pass_hash: string;
      pass_salt: string;
      license_id: string;
    }>(
      "SELECT id, email, pass_hash, pass_salt, license_id FROM users WHERE id=?",
      userId,
    );
    if (!user) return fail("UNAUTHORIZED", "ログインしてください", 401);

    const good = await verifyPassword(parsed.data.password, {
      hash: user.pass_hash,
      salt: user.pass_salt,
    });
    if (!good) return fail("LOGIN_FAILED", "パスワードが違います", 401);

    const accounts = await db.all<{ id: string }>(
      "SELECT id FROM accounts WHERE user_id=?",
      userId,
    );
    const nowIso = new Date().toISOString();
    const email = user.email;

    const emailHash = await sha256Hex(email.trim().toLowerCase());
    // All related deletes commit together, with a fixed query count regardless of account count.
    await db.batch([
      ...ACCOUNT_CHILD_TABLES.map(t => ({ sql: `DELETE FROM ${t} WHERE account_id IN (SELECT id FROM accounts WHERE user_id=?)`, params: [userId] })),
      { sql: "DELETE FROM accounts WHERE user_id=?", params: [userId] },
      { sql: "DELETE FROM jobs WHERE type='sheets_sync' AND json_extract(state_json,'$.userId')=?", params: [userId] },
      ...USER_TABLES.map(t => ({ sql: `DELETE FROM ${t} WHERE user_id=?`, params: [userId] })),
      { sql: "DELETE FROM rate_events WHERE key=? OR key=?", params: [loginKey(email), forgotKey(email)] },
      { sql: "UPDATE licenses SET status='revoked', revoked_at=?, user_id=NULL WHERE id=?", params: [nowIso, user.license_id] },
      { sql: "DELETE FROM users WHERE id=?", params: [userId] },
      { sql: "INSERT INTO audit_log(id,user_id,at,action,detail) VALUES (?,NULL,?,'user_delete',?)",
        params: [crypto.randomUUID(), nowIso, JSON.stringify({emailHash, accounts: accounts.length, licenseId: user.license_id})] },
    ]);

    // 8. 完了の通知（`notifications` はもう消えているので直接送る）
    await sendEmail(c.env, email, "account_deleted", { appOrigin: c.env.APP_ORIGIN });

    // Cookie も落とす（行はもう無いが、ブラウザに死んだ sid を残さない）
    return new Response(JSON.stringify(ok({ deleted: true })), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "sid=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
      },
    });
  });

  return r;
}
