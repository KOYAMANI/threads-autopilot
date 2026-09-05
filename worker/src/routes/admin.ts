/**
 * 管理API（SPEC §5.4）。ヘッダ `X-Admin-Secret` で認証する（セッションは使わない）。
 * - POST /api/admin/licenses            {count, note} → {keys:[{id,key}]}
 * - POST /api/admin/licenses/:id/revoke → status='revoked', revoked_at=now
 */
import { Hono } from "hono";
import { z } from "zod";
import { ok } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { generateLicenseKey, timingSafeEqual } from "../lib/crypto";

const MAX_BATCH = 200;

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

    // マルチVALUES で1クエリにまとめる（SPEC §8.1）
    await db.run(
      "INSERT INTO licenses (id, key, status, note, issued_at, activated_at, user_id, revoked_at) VALUES " +
        keys.map(() => "(?,?,'unused',?,?,NULL,NULL,NULL)").join(","),
      ...keys.flatMap((k) => [k.id, k.key, note ?? null, nowIso]),
    );

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
    await db.run(
      "INSERT INTO audit_log (id, user_id, at, action, detail) VALUES (?,?,?,?,?)",
      crypto.randomUUID(),
      row.user_id,
      nowIso,
      "license_revoke",
      id,
    );

    return c.json(ok({ id, status: "revoked" as const, revokedAt: nowIso }));
  });

  return r;
}
