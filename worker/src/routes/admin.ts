/**
 * 管理API（SPEC §5.4）。CLI は `X-Admin-Secret`、画面は指定ユーザーのセッションで認証する。
 * - GET  /api/admin/licenses            → 新しい順のアクセスキー一覧
 * - POST /api/admin/licenses            {count, note} → {keys:[{id,key}]}
 * - POST /api/admin/licenses/:id/revoke → status='revoked', revoked_at=now
 */
import { Hono } from "hono";
import { rateHit } from "../lib/rate";
import { z } from "zod";
import { ok } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { readSchedulerStatus } from "../lib/scheduler-health";
import { audit } from "../lib/audit";
import { effectiveAccountLimit } from "../lib/accounts";
import { generateLicenseKey, timingSafeEqual } from "../lib/crypto";

const MAX_BATCH = 200;

/**
 * 1文にまとめる行数。D1（SQLite）の1文あたりのバインド変数は100個までで、
 * licenses の INSERT は1行4個（id, key, note, issued_at）なので 25 行が上限。
 * これを超えると `D1_ERROR: too many SQL variables` になる。
 */
const LICENSE_ROWS_PER_STATEMENT = 25;

const issueSchema = z.union([
  z.object({ count: z.number().int().min(1).max(MAX_BATCH), note: z.string().max(200).optional() }),
  z.object({
    recipients: z.array(z.string().trim().min(1).max(80)).min(1).max(20)
      .refine((items) => new Set(items).size === items.length, "宛名が重複しています"),
  }),
]);
const planSchema = z.object({ plan: z.enum(["free", "academy", "pro"]) });
const planByEmailSchema = planSchema.extend({ email: z.string().trim().email().max(320) });

function adminOk(given: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  if (!given) return false;
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(given), enc.encode(expected));
}

export function adminRoutes() {
  const r = new Hono<AppEnv>();

  r.use("*", async (c, next) => {
    const ip = c.req.header("CF-Connecting-IP");
    if (ip && !(await rateHit(c.get("db"), `admin-ip:${ip}`, 20, 10))) return fail("RATE_LIMITED", "しばらく待ってください", 429);
    const sessionAdmin = Boolean(c.env.ADMIN_USER_ID && c.get("userId") === c.env.ADMIN_USER_ID);
    if (!sessionAdmin && !adminOk(c.req.header("X-Admin-Secret"), c.env.ADMIN_SECRET)) {
      return fail("FORBIDDEN", "管理者用の操作です", 403);
    }
    await next();
  });

  r.get("/scheduler-status", async (c) => c.json(ok(await readSchedulerStatus(c.get("db"), c.env))));

  r.get("/status", (c) => c.json(ok({ isAdmin: true as const })));

  r.get("/licenses", async (c) => {
    const rows = await c.get("db").all<{
      id: string;
      key: string;
      status: "unused" | "active" | "revoked";
      note: string | null;
      email: string | null;
      issued_at: string;
      activated_at: string | null;
      revoked_at: string | null;
    }>(
      `SELECT l.id,l.key,l.status,l.note,l.issued_at,l.activated_at,l.revoked_at,u.email
         FROM licenses l LEFT JOIN users u ON u.id=l.user_id
        ORDER BY l.issued_at DESC, l.rowid DESC LIMIT 200`,
    );
    return c.json(ok({ licenses: rows.map((row) => ({
      id: row.id,
      key: row.key,
      status: row.status,
      note: row.note,
      email: row.email,
      issuedAt: row.issued_at,
      activatedAt: row.activated_at,
      revokedAt: row.revoked_at,
    })) }));
  });

  r.put("/users/:id/plan", async (c) => {
    let raw: unknown = null;
    try { raw = await c.req.json(); } catch { raw = null; }
    const parsed = planSchema.safeParse(raw);
    if (!parsed.success) return fail("BAD_REQUEST", "適用するプランを選んでください", 400);
    const userId = c.req.param("id");
    const user = await c.get("db").first<{ id: string; email: string }>("SELECT id,email FROM users WHERE id=?", userId);
    if (!user) return fail("NOT_FOUND", "対象のアカウントが見つかりません", 404);
    const full = parsed.data.plan !== "free";
    const nowIso = new Date().toISOString();
    await c.get("db").run(
      `INSERT INTO user_entitlements (user_id, plan_code, account_limit, ai_advice_enabled, platform_ai_enabled, updated_at)
       VALUES (?,?,?,?,0,?)
       ON CONFLICT(user_id) DO UPDATE SET plan_code=excluded.plan_code, account_limit=excluded.account_limit,
         ai_advice_enabled=excluded.ai_advice_enabled, platform_ai_enabled=0, updated_at=excluded.updated_at`,
      userId, parsed.data.plan, full ? 3 : 1, full ? 1 : 0, nowIso,
    );
    await audit(c.get("db"), userId, "plan_change", { plan: parsed.data.plan, by: c.get("userId") });
    return c.json(ok({ userId, email: user.email, plan: parsed.data.plan, accountLimit: effectiveAccountLimit(userId, c.env.ADMIN_USER_ID, full ? 3 : 1), aiAdviceEnabled: full, platformAiEnabled: false }));
  });

  r.put("/plans", async (c) => {
    let raw: unknown = null;
    try { raw = await c.req.json(); } catch { raw = null; }
    const parsed = planByEmailSchema.safeParse(raw);
    if (!parsed.success) return fail("BAD_REQUEST", "メールアドレスとプランを確認してください", 400);
    const email = parsed.data.email.toLowerCase();
    const user = await c.get("db").first<{ id: string; email: string }>(
      "SELECT id,email FROM users WHERE lower(email)=?",
      email,
    );
    if (!user) return fail("NOT_FOUND", "このメールアドレスのアカウントが見つかりません", 404);
    const full = parsed.data.plan !== "free";
    const nowIso = new Date().toISOString();
    await c.get("db").run(
      `INSERT INTO user_entitlements (user_id, plan_code, account_limit, ai_advice_enabled, platform_ai_enabled, updated_at)
       VALUES (?,?,?,?,0,?)
       ON CONFLICT(user_id) DO UPDATE SET plan_code=excluded.plan_code, account_limit=excluded.account_limit,
         ai_advice_enabled=excluded.ai_advice_enabled, platform_ai_enabled=0, updated_at=excluded.updated_at`,
      user.id, parsed.data.plan, full ? 3 : 1, full ? 1 : 0, nowIso,
    );
    await audit(c.get("db"), user.id, "plan_change", { plan: parsed.data.plan, by: c.get("userId") });
    return c.json(ok({ userId: user.id, email: user.email, plan: parsed.data.plan, accountLimit: effectiveAccountLimit(user.id, c.env.ADMIN_USER_ID, full ? 3 : 1), aiAdviceEnabled: full, platformAiEnabled: false as const }));
  });

  r.post("/licenses", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = issueSchema.safeParse(body);
    if (!parsed.success) {
      return fail("BAD_REQUEST", `件数は1〜${MAX_BATCH}、宛名は1〜20人で指定してください`, 400);
    }
    const recipients = "recipients" in parsed.data ? parsed.data.recipients : null;
    const count = recipients?.length ?? ("count" in parsed.data ? parsed.data.count : 0);
    const commonNote = "note" in parsed.data ? parsed.data.note : undefined;
    const db = c.get("db");
    const nowIso = new Date().toISOString();

    const keys: Array<{ id: string; key: string; note?: string }> = [];
    const seen = new Set<string>();
    while (keys.length < count) {
      const key = generateLicenseKey();
      if (seen.has(key)) continue;
      seen.add(key);
      const note = recipients?.[keys.length] ?? commonNote;
      keys.push({ id: crypto.randomUUID(), key, ...(note ? { note } : {}) });
    }

    // マルチVALUES でクエリ数を圧縮しつつ（SPEC §8.1）、1文 25 行でバインド上限 100 を守る
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    for (let i = 0; i < keys.length; i += LICENSE_ROWS_PER_STATEMENT) {
      const chunk = keys.slice(i, i + LICENSE_ROWS_PER_STATEMENT);
      statements.push({
        sql:
          "INSERT INTO licenses (id, key, status, note, issued_at, activated_at, user_id, revoked_at) VALUES " +
          chunk.map(() => "(?,?,'unused',?,?,NULL,NULL,NULL)").join(","),
        params: chunk.flatMap((k) => [k.id, k.key, k.note ?? null, nowIso]),
      });
    }
    await db.batch(statements);
    // 発行を監査に残す（DECISIONS 2026-09-06「ライセンスの発行と失効」）。
    // **キーそのものは書かない** — 監査ログを読める経路がそのまま在庫の流出になるため、
    // 発行した本数とメモだけ残す。個々の ID はレスポンスの `keys` にある
    await audit(db, c.get("userId"), "license_issue", {
      count: keys.length,
      note: commonNote ?? null,
      recipients: recipients ?? null,
    });

    return c.json(ok({ keys }), 201);
  });

  r.post("/licenses/:id/revoke", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");
    const nowIso = new Date().toISOString();

    const row = await db.first<{ id: string; user_id: string | null }>(
      "SELECT id, user_id FROM licenses WHERE id=?",
      id,
    );
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);

    await db.run("UPDATE licenses SET status='revoked', revoked_at=? WHERE id=?", nowIso, id);
    // ログイン中のセッションも切る（自動投稿が続かないように。SPEC §5.4）
    if (row.user_id) await db.run("DELETE FROM sessions WHERE user_id=?", row.user_id);
    await audit(db, row.user_id, "license_revoke", { licenseId: id });

    return c.json(ok({ id, status: "revoked" as const, revokedAt: nowIso }));
  });

  return r;
}
