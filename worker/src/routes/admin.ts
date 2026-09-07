/**
 * 管理API（SPEC §5.4）。ヘッダ `X-Admin-Secret` で認証する（セッションは使わない）。
 * - POST /api/admin/licenses            {count, note} → {keys:[{id,key}]}
 * - POST /api/admin/licenses/:id/revoke → status='revoked', revoked_at=now
 */
import { Hono } from "hono";
import { rateHit } from "../lib/rate";
import { z } from "zod";
import { ok } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { audit } from "../lib/audit";
import { generateLicenseKey, timingSafeEqual } from "../lib/crypto";

const MAX_BATCH = 200;

/**
 * 1文にまとめる行数。D1（SQLite）の1文あたりのバインド変数は100個までで、
 * licenses の INSERT は1行4個（id, key, note, issued_at）なので 25 行が上限。
 * これを超えると `D1_ERROR: too many SQL variables` になる。
 */
const LICENSE_ROWS_PER_STATEMENT = 25;

const issueSchema = z.object({
  count: z.number().int().min(1).max(MAX_BATCH),
  note: z.string().max(200).optional(),
});

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
    if (!adminOk(c.req.header("X-Admin-Secret"), c.env.ADMIN_SECRET)) {
      return fail("FORBIDDEN", "管理者用の操作です", 403);
    }
    await next();
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
      return fail("BAD_REQUEST", `count は1〜${MAX_BATCH}の整数で指定してください`, 400);
    }
    const { count, note } = parsed.data;
    const db = c.get("db");
    const nowIso = new Date().toISOString();

    const keys: Array<{ id: string; key: string }> = [];
    const seen = new Set<string>();
    while (keys.length < count) {
      const key = generateLicenseKey();
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push({ id: crypto.randomUUID(), key });
    }

    // マルチVALUES でクエリ数を圧縮しつつ（SPEC §8.1）、1文 25 行でバインド上限 100 を守る
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    for (let i = 0; i < keys.length; i += LICENSE_ROWS_PER_STATEMENT) {
      const chunk = keys.slice(i, i + LICENSE_ROWS_PER_STATEMENT);
      statements.push({
        sql:
          "INSERT INTO licenses (id, key, status, note, issued_at, activated_at, user_id, revoked_at) VALUES " +
          chunk.map(() => "(?,?,'unused',?,?,NULL,NULL,NULL)").join(","),
        params: chunk.flatMap((k) => [k.id, k.key, note ?? null, nowIso]),
      });
    }
    await db.batch(statements);
    // 発行を監査に残す（DECISIONS 2026-09-06「ライセンスの発行と失効」）。
    // **キーそのものは書かない** — 監査ログを読める経路がそのまま在庫の流出になるため、
    // 発行した本数とメモだけ残す。個々の ID はレスポンスの `keys` にある
    await audit(db, null, "license_issue", { count: keys.length, note: note ?? null });

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
