/**
 * 認証（SPEC §5.1 / §5.3 / §5.4 / §7）。
 * register / login / logout / me / forgot / reset。
 */
import { Hono } from "hono";
import { z } from "zod";
import type {
  AiSettingsSummary,
  MeResponse,
  NotificationSettings,
  UserSummary,
} from "@tap/shared";
import { ok } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { ACCOUNT_COLUMNS, toAccountSummary, type AccountRow } from "../lib/accounts";
import { audit } from "../lib/audit";
import type { Db } from "../lib/db";
import { hashPassword, sha256Hex, verifyPassword } from "../lib/crypto";
import { sendEmail } from "../lib/email";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  deleteUserSessions,
  sessionCookie,
  signToken,
  verifyToken,
} from "../lib/session";
import {
  forgotKey,
  loginKey,
  rateAllow,
  rateClear,
  rateHit,
  rateRecord,
  RATE_LIMITS,
} from "../lib/rate";
import { redactEmail } from "../lib/redact";

const PASSWORD_MIN = 8;
const RESET_TTL_MIN = 30;

/**
 * ユーザーが存在しないときにも同じだけ PBKDF2 を回すためのダミー。
 * これが無いと、応答時間（1回 100,000 ラウンドぶん）でメールアドレスの有無が分かる。
 * どのパスワードにも一致しない固定値（32バイトのゼロ）。
 */
const DUMMY_PASSWORD = {
  hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  salt: "AAECAwQFBgcICQoLDA0ODw==",
} as const;

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(PASSWORD_MIN).max(200);

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  license_key: z.string().trim().min(1).max(64),
});
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) });
const forgotSchema = z.object({ email: emailSchema });
const resetSchema = z.object({ token: z.string().min(1).max(2048), password: passwordSchema });

type UserRow = {
  id: string;
  email: string;
  pass_hash: string;
  pass_salt: string;
  license_id: string;
  created_at: string;
  last_login_at: string | null;
};

type LicenseRow = {
  id: string;
  key: string;
  status: string;
  user_id: string | null;
};

function toUserSummary(u: UserRow): UserSummary {
  return {
    id: u.id,
    email: u.email,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

/**
 * 署名トークンを使う経路の前提。`.dev.vars` / `wrangler secret put` の入れ忘れを
 * 「なぜか 500」ではなく、原因の分かるログにする。
 */
function sessionSecretMissing(secret: string | undefined): boolean {
  if (secret && secret.length > 0) return false;
  console.error(
    "[auth] SESSION_SECRET が設定されていません。.dev.vars（開発）か wrangler secret put（本番）で入れてください",
  );
  return true;
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

/** GET /me が返す全体（SPEC §7）。M1 時点で accounts は常に空になりうる。 */
async function buildMe(db: Db, userId: string): Promise<MeResponse | null> {
  const user = await db.first<UserRow>(
    "SELECT id, email, pass_hash, pass_salt, license_id, created_at, last_login_at FROM users WHERE id=?",
    userId,
  );
  if (!user) return null;

  const accountRows = await db.all<AccountRow & { ap_enabled: number | null }>(
    `SELECT ${ACCOUNT_COLUMNS.split(", ").map(column => `a.${column}`).join(", ")}, ap.enabled AS ap_enabled
       FROM accounts a LEFT JOIN autopilot ap ON ap.account_id = a.id
      WHERE a.user_id=? ORDER BY a.created_at ASC`,
    userId,
  );
  const accounts = accountRows.map(account => toAccountSummary(account, { autopilotEnabled: Boolean(account.ap_enabled) }));

  const aiRow = await db.first<{
    provider: string;
    model: string | null;
    key_enc: string | null;
    store_on_server: number;
  }>("SELECT provider, model, key_enc, store_on_server FROM ai_settings WHERE user_id=?", userId);

  const ai: AiSettingsSummary = aiRow
    ? {
        provider: aiRow.provider as AiSettingsSummary["provider"],
        model: aiRow.model,
        hasKey: Boolean(aiRow.key_enc),
        storeOnServer: Boolean(aiRow.store_on_server),
      }
    : { provider: null, model: null, hasKey: false, storeOnServer: true };

  const nRow = await db.first<{
    email_enabled: number;
    push_enabled: number;
    digest_hour: number;
  }>("SELECT email_enabled, push_enabled, digest_hour FROM notifications WHERE user_id=?", userId);

  const notifications: NotificationSettings = nRow
    ? {
        emailEnabled: Boolean(nRow.email_enabled),
        pushEnabled: Boolean(nRow.push_enabled),
        digestHour: nRow.digest_hour,
      }
    : { emailEnabled: true, pushEnabled: false, digestHour: 8 };

  return { user: toUserSummary(user), accounts, ai, notifications };
}

export function authRoutes() {
  const r = new Hono<AppEnv>();

  /* ── 登録（SPEC §5.1） ─────────────────────────── */
  r.post("/register", async (c) => {
    const raw = await readJson(c);
    const parsed = registerSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const isPassword = issue?.path?.[0] === "password";
      return fail(
        isPassword ? "WEAK_PASSWORD" : "BAD_REQUEST",
        isPassword
          ? `パスワードは${PASSWORD_MIN}文字以上にしてください`
          : "入力に誤りがあります。メールアドレスとライセンスキーをご確認ください",
        400,
      );
    }
    const { email, password } = parsed.data;
    const licenseKey = parsed.data.license_key.toUpperCase();
    const db = c.get("db");
    const now = new Date();

    const license = await db.first<LicenseRow>(
      "SELECT id, key, status, user_id FROM licenses WHERE key=?",
      licenseKey,
    );
    // 存在しない・使用済み・revoked は同じ扱い（どれかを漏らさない）
    if (!license || license.status !== "unused") {
      return fail("LICENSE_INVALID", "このライセンスキーは使えません", 400);
    }

    const existing = await db.first<{ id: string }>("SELECT id FROM users WHERE email=?", email);
    if (existing) {
      return fail("EMAIL_TAKEN", "このメールアドレスは登録済みです", 409);
    }

    const { hash, salt } = await hashPassword(password);
    const userId = crypto.randomUUID();
    const nowIso = now.toISOString();

    try {
      await db.run(
        "INSERT INTO users (id, email, pass_hash, pass_salt, license_id, created_at, last_login_at) VALUES (?,?,?,?,?,?,?)",
        userId,
        email,
        hash,
        salt,
        license.id,
        nowIso,
        nowIso,
      );
    } catch (e) {
      // 上の SELECT と INSERT の間に同じメールで登録が入った場合（users.email の UNIQUE）
      if (/UNIQUE/i.test(String(e))) {
        return fail("EMAIL_TAKEN", "このメールアドレスは登録済みです", 409);
      }
      throw e;
    }
    // ライセンスを押さえる。他の登録と競合したら 0 行になるので、その場合は取り消す
    const claim = await db.run(
      "UPDATE licenses SET status='active', activated_at=?, user_id=? WHERE id=? AND status='unused'",
      nowIso,
      userId,
      license.id,
    );
    if (claim.changes === 0) {
      await db.run("DELETE FROM users WHERE id=?", userId);
      return fail("LICENSE_INVALID", "このライセンスキーは使えません", 400);
    }

    await db.run(
      "INSERT INTO notifications (user_id, email_enabled, push_enabled, digest_hour, updated_at) VALUES (?,1,0,8,?)",
      userId,
      nowIso,
    );
    await db.run(
      "INSERT INTO audit_log (id, user_id, at, action, detail) VALUES (?,?,?,?,?)",
      crypto.randomUUID(),
      userId,
      nowIso,
      "register",
      null,
    );

    const session = await createSession(db, userId, c.req.header("User-Agent") ?? null, now);
    const me = await buildMe(db, userId);
    return new Response(JSON.stringify(ok({ user: me!.user })), {
      status: 201,
      headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie(session.id) },
    });
  });

  /* ── ログイン（SPEC §5.1 / §5.4） ──────────────── */
  r.post("/login", async (c) => {
    const parsed = loginSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return fail("BAD_REQUEST", "メールアドレスとパスワードを入力してください", 400);
    }
    const { email, password } = parsed.data;
    const db = c.get("db");
    const now = new Date();
    const key = loginKey(email);

    if (!(await rateAllow(db, key, RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMin, now))) {
      return fail(
        "RATE_LIMITED",
        "ログインの試行が多すぎます。10分ほど待ってからもう一度お試しください",
        429,
      );
    }

    const user = await db.first<UserRow>(
      "SELECT id, email, pass_hash, pass_salt, license_id, created_at, last_login_at FROM users WHERE email=?",
      email,
    );
    // ユーザーが居なくても同じだけ PBKDF2 を回す（応答時間で存在を漏らさない）
    const good = await verifyPassword(
      password,
      user ? { hash: user.pass_hash, salt: user.pass_salt } : DUMMY_PASSWORD,
    );

    if (!user || !good) {
      await rateRecord(db, key, now);
      return fail("LOGIN_FAILED", "メールアドレスかパスワードが違います", 401);
    }

    // ライセンス失効の確認（返金対応。SPEC §5.4）
    const license = await db.first<{ status: string }>(
      "SELECT status FROM licenses WHERE id=?",
      user.license_id,
    );
    if (license?.status === "revoked") {
      await deleteUserSessions(db, user.id);
      return fail("LICENSE_REVOKED", "ライセンスが無効化されています", 403);
    }

    await rateClear(db, key);
    const nowIso = now.toISOString();
    await db.run("UPDATE users SET last_login_at=? WHERE id=?", nowIso, user.id);
    const session = await createSession(db, user.id, c.req.header("User-Agent") ?? null, now);
    // SPEC §13 M7「ログイン」を監査に残す。UA は端末の見分けがつく程度に切る
    await audit(db, user.id, "login", {
      ua: (c.req.header("User-Agent") ?? "").slice(0, 120),
    }, now);

    return new Response(
      JSON.stringify(ok({ user: toUserSummary({ ...user, last_login_at: nowIso }) })),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie(session.id) },
      },
    );
  });

  /* ── ログアウト ───────────────────────────────── */
  r.post("/logout", async (c) => {
    const sid = c.get("sessionId");
    if (sid) await deleteSession(c.get("db"), sid);
    return new Response(JSON.stringify(ok({ loggedOut: true })), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie() },
    });
  });

  // Password verification, update and revocation all belong to the signed-in user.
  r.post("/password", async (c) => {
    const userId = c.get("userId")!;
    const db = c.get("db");
    if (!(await rateHit(db, `password-change:${userId}`, 5, 15))) {
      return fail("RATE_LIMITED", "試行回数が多いため、15分ほど待ってからお試しください", 429);
    }
    const parsed = z.object({
      current_password: z.string().min(1).max(200),
      new_password: passwordSchema,
    }).safeParse(await readJson(c));
    if (!parsed.success) return fail("BAD_REQUEST", "現在のパスワードと、8〜200文字の新しいパスワードを入力してください", 400);
    const { current_password, new_password } = parsed.data;
    const user = await db.first<{ pass_hash: string; pass_salt: string }>(
      "SELECT pass_hash, pass_salt FROM users WHERE id=?", userId,
    );
    if (!user || !(await verifyPassword(current_password, { hash: user.pass_hash, salt: user.pass_salt }))) {
      return fail("PASSWORD_INCORRECT", "現在のパスワードが違います", 400);
    }
    if (current_password === new_password) return fail("PASSWORD_UNCHANGED", "現在とは異なるパスワードを設定してください", 400);
    const { hash, salt } = await hashPassword(new_password);
    const now = new Date().toISOString();
    // CAS prevents concurrent changes from overwriting a password verified earlier.
    // Every revocation is guarded by this request's unique salted hash, in one D1 transaction.
    const changed = "EXISTS (SELECT 1 FROM users WHERE id=? AND pass_hash=? AND pass_salt=?)";
    const guard = [userId, hash, salt];
    await db.batch([
      { sql: "UPDATE users SET pass_hash=?,pass_salt=? WHERE id=? AND pass_hash=? AND pass_salt=?", params: [hash,salt,userId,user.pass_hash,user.pass_salt] },
      { sql: `UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL AND ${changed}`, params: [now,userId,...guard] },
      { sql: `DELETE FROM sessions WHERE user_id=? AND ${changed}`, params: [userId,...guard] },
      { sql: `DELETE FROM push_subscriptions WHERE user_id=? AND ${changed}`, params: [userId,...guard] },
      { sql: `INSERT INTO audit_log (id,user_id,at,action,detail) SELECT ?,?,?,'password_change',NULL WHERE ${changed}`, params: [crypto.randomUUID(),userId,now,...guard] },
    ]);
    const accepted = await db.first<{ pass_hash: string }>("SELECT pass_hash FROM users WHERE id=?", userId);
    if (accepted?.pass_hash !== hash) return fail("PASSWORD_CHANGED", "パスワードが更新されています。もう一度ログインしてください", 409);
    return new Response(JSON.stringify(ok({ changed: true })), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": clearSessionCookie() },
    });
  });

  /* ── me ──────────────────────────────────────── */
  r.get("/me", async (c) => {
    const userId = c.get("userId")!;
    const me = await buildMe(c.get("db"), userId);
    if (!me) return fail("UNAUTHORIZED", "ログインしてください", 401);
    return c.json(ok(me));
  });

  /* ── パスワード再設定の要求（SPEC §5.1） ────────── */
  r.post("/forgot", async (c) => {
    const parsed = forgotSchema.safeParse(await readJson(c));
    // メールの存在も、形式の誤りも漏らさない。常に ok:true
    if (!parsed.success) return c.json(ok({ requested: true }));
    if (sessionSecretMissing(c.env.SESSION_SECRET)) {
      return fail("INTERNAL", "サーバーの設定が終わっていません。管理者にお問い合わせください", 500);
    }

    const { email } = parsed.data;
    const db = c.get("db");
    const now = new Date();

    const allowed = await rateHit(
      db,
      forgotKey(email),
      RATE_LIMITS.forgot.limit,
      RATE_LIMITS.forgot.windowMin,
      now,
    );
    if (!allowed) return c.json(ok({ requested: true }));

    const user = await db.first<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE email=?",
      email,
    );
    if (!user) {
      // 存在しないメールでも、トークン生成と同じだけの計算を空回しして時間を揃える
      // （応答時間で登録済みかどうかを漏らさない）
      const dummy = await signToken(c.env.SESSION_SECRET, {
        purpose: "pwreset",
        sub: crypto.randomUUID(),
        extra: "",
        expires: Math.floor(now.getTime() / 1000) + RESET_TTL_MIN * 60,
      });
      await sha256Hex(dummy);
      return c.json(ok({ requested: true }));
    }

    const id = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + RESET_TTL_MIN * 60_000);
    const token = await signToken(c.env.SESSION_SECRET, {
      purpose: "pwreset",
      sub: id,
      extra: "",
      expires: Math.floor(expiresAt.getTime() / 1000),
    });
    await db.run(
      "INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at) VALUES (?,?,?,?,NULL,?)",
      id,
      user.id,
      await sha256Hex(token),
      expiresAt.toISOString(),
      now.toISOString(),
    );

    const url = `${c.env.APP_ORIGIN}/login?reset=${encodeURIComponent(token)}`;
    await sendEmail(c.env, user.email, "password_reset", { url, appOrigin: c.env.APP_ORIGIN });
    console.log(`[auth] password reset requested for ${redactEmail(user.email)}`);

    return c.json(ok({ requested: true }));
  });

  /* ── パスワード再設定の実行（SPEC §5.1） ────────── */
  r.post("/reset", async (c) => {
    const parsed = resetSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      const isPassword = parsed.error.issues[0]?.path?.[0] === "password";
      return isPassword
        ? fail("WEAK_PASSWORD", `パスワードは${PASSWORD_MIN}文字以上にしてください`, 400)
        : fail("RESET_INVALID", "リンクの有効期限が切れています。もう一度お試しください", 400);
    }
    if (sessionSecretMissing(c.env.SESSION_SECRET)) {
      return fail("INTERNAL", "サーバーの設定が終わっていません。管理者にお問い合わせください", 500);
    }
    const { token, password } = parsed.data;
    const db = c.get("db");
    const now = new Date();
    const invalid = () =>
      fail("RESET_INVALID", "リンクの有効期限が切れています。もう一度お試しください", 400);

    const payload = await verifyToken(
      c.env.SESSION_SECRET,
      token,
      "pwreset",
      Math.floor(now.getTime() / 1000),
    );
    if (!payload) return invalid();

    const row = await db.first<{
      id: string;
      user_id: string;
      token_hash: string;
      expires_at: string;
      used_at: string | null;
    }>(
      "SELECT id, user_id, token_hash, expires_at, used_at FROM password_resets WHERE id=?",
      payload.sub,
    );
    if (!row) return invalid();
    if (row.used_at !== null) return invalid();
    if (Date.parse(row.expires_at) <= now.getTime()) return invalid();
    if (row.token_hash !== (await sha256Hex(token))) return invalid();

    const { hash, salt } = await hashPassword(password);
    const nowIso = now.toISOString();

    const claimId = crypto.randomUUID();
    const claimed = "EXISTS (SELECT 1 FROM password_resets WHERE id=? AND claim_id=?)";
    await db.batch([
      { sql: "UPDATE password_resets SET used_at=?, claim_id=? WHERE id=? AND used_at IS NULL AND expires_at>? AND token_hash=?",
        params: [nowIso, claimId, row.id, nowIso, await sha256Hex(token)] },
      { sql: `UPDATE users SET pass_hash=?, pass_salt=? WHERE id=? AND ${claimed}`,
        params: [hash, salt, row.user_id, row.id, claimId] },
      { sql: `UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL AND ${claimed}`,
        params: [nowIso, row.user_id, row.id, claimId] },
      { sql: `DELETE FROM sessions WHERE user_id=? AND ${claimed}`, params: [row.user_id, row.id, claimId] },
      { sql: `DELETE FROM push_subscriptions WHERE user_id=? AND ${claimed}`, params: [row.user_id, row.id, claimId] },
      { sql: `INSERT INTO audit_log (id,user_id,at,action,detail) SELECT ?,?,?,'password_reset',NULL WHERE ${claimed}`,
        params: [crypto.randomUUID(), row.user_id, nowIso, row.id, claimId] },
    ]);
    const accepted = await db.first<{ claim_id: string }>("SELECT claim_id FROM password_resets WHERE id=?", row.id);
    if (accepted?.claim_id !== claimId) return invalid();

    // 自動ログインはしない。Cookie も消してログイン画面へ戻す
    return new Response(JSON.stringify(ok({ reset: true })), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie() },
    });
  });

  return r;
}
