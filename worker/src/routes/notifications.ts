/**
 * 通知と Web Push の購読（SPEC §7.8）。
 *
 * - `GET /notifications` / `PUT /notifications`
 * - `POST /push/subscribe` / `DELETE /push/subscribe`
 *
 * 購読の中身（`endpoint` と鍵）は `push_subscriptions.json` に**暗号化して**入れる
 * （SPEC §5.2「Threadsトークン、AIキー、Push購読の3種にだけ使う」）。
 * 実際の送信は M7（DECISIONS.md 参照）。ここは登録と解除だけ。
 */
import { Hono } from "hono";
import { z } from "zod";
import { ok, type NotificationSettings } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { encrypt } from "../lib/crypto";
import type { Db } from "../lib/db";
import type { Env } from "../env";

/** 空文字（wrangler.toml の [vars] の既定）は「未設定」として null に寄せる。 */
function vapidPublicKey(env: Env): string | null {
  const v = (env.VAPID_PUBLIC_KEY ?? "").trim();
  return v === "" ? null : v;
}

const putSchema = z.object({
  emailEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  digestHour: z.number().int().min(0).max(23).optional(),
});

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
});

type NotificationRow = {
  user_id: string;
  email_enabled: number;
  push_enabled: number;
  digest_hour: number;
};

/** 行が無ければ既定値（SPEC §4 の DEFAULT）。 */
export async function loadNotifications(db: Db, userId: string): Promise<NotificationSettings> {
  const row = await db.first<NotificationRow>(
    "SELECT user_id, email_enabled, push_enabled, digest_hour FROM notifications WHERE user_id=?",
    userId,
  );
  return {
    emailEnabled: row ? row.email_enabled === 1 : true,
    pushEnabled: row ? row.push_enabled === 1 : false,
    digestHour: row?.digest_hour ?? 8,
  };
}

export function notificationRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    const settings = await loadNotifications(c.get("db"), c.get("userId")!);
    return c.json(
      ok({
        notifications: settings,
        // [vars] は空文字で入ることがある。画面は「未設定」と同じに見せたいので null に寄せる
        vapidPublicKey: vapidPublicKey(c.env),
      }),
    );
  });

  r.put("/", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);

    const db = c.get("db");
    const userId = c.get("userId")!;
    const prev = await loadNotifications(db, userId);
    const next: NotificationSettings = {
      emailEnabled: parsed.data.emailEnabled ?? prev.emailEnabled,
      pushEnabled: parsed.data.pushEnabled ?? prev.pushEnabled,
      digestHour: parsed.data.digestHour ?? prev.digestHour,
    };
    await db.run(
      `INSERT INTO notifications (user_id, email_enabled, push_enabled, digest_hour, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           email_enabled=excluded.email_enabled, push_enabled=excluded.push_enabled,
           digest_hour=excluded.digest_hour, updated_at=excluded.updated_at`,
      userId,
      next.emailEnabled ? 1 : 0,
      next.pushEnabled ? 1 : 0,
      next.digestHour,
      new Date().toISOString(),
    );
    return c.json(
      ok({ notifications: next, vapidPublicKey: vapidPublicKey(c.env) }),
    );
  });

  return r;
}

export function pushRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/subscribe", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);

    const db = c.get("db");
    const userId = c.get("userId")!;
    // 同じ endpoint を二重に持たない。判定できるよう endpoint のハッシュを id にする
    const id = await endpointId(userId, parsed.data.endpoint);
    await db.run(
      `INSERT INTO push_subscriptions (id, user_id, json, created_at) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET json=excluded.json`,
      id,
      userId,
      await encrypt(JSON.stringify(parsed.data), c.env.ENC_KEY),
      new Date().toISOString(),
    );
    return c.json(ok({ id }), 201);
  });

  r.delete("/subscribe", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const db = c.get("db");
    const userId = c.get("userId")!;
    const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
    if (typeof endpoint === "string" && endpoint !== "") {
      await db.run(
        "DELETE FROM push_subscriptions WHERE id=? AND user_id=?",
        await endpointId(userId, endpoint),
        userId,
      );
    } else {
      // endpoint 無しは「この端末が分からないので全部消す」（設定の Push オフから呼ぶ）
      await db.run("DELETE FROM push_subscriptions WHERE user_id=?", userId);
    }
    return c.json(ok({ deleted: true }));
  });

  return r;
}

/** `user_id` と endpoint から決まる id。同じ端末の再購読で行が増えないようにする。 */
async function endpointId(userId: string, endpoint: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${userId}\n${endpoint}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
