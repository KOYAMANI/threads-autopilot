import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  MAX_DAILY_MEDIA_UPLOADS_PER_USER,
  MAX_TOTAL_MEDIA_BYTES,
  cleanupExpiredMedia,
  mediaObjectKey,
} from "../src/lib/media";
import { api, insertAccount, registerUser, testDb } from "./helpers";

const app = createApp();

async function upload(cookie: string, accountId: string, type = "image/jpeg") {
  const response = await app.fetch(new Request(`https://test.local/api/media?accountId=${accountId}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": type,
      "X-Requested-With": "fetch",
    },
    body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  }), env);
  return { response, body: await response.clone().json() as any };
}

describe("投稿画像の一時保存", () => {
  it("所有者だけがアップロードでき、推測困難な公開URLからは認証なしで取得できる", async () => {
    const user = await registerUser();
    const accountId = await insertAccount({ userId: user.userId });
    const { response, body } = await upload(user.cookie, accountId);

    expect(response.status).toBe(201);
    expect(body.data.url).toMatch(/^http:\/\/localhost:5173\/api\/media\/[0-9a-f-]{36}$/);
    expect(await env.MEDIA_BUCKET.get(mediaObjectKey(body.data.id))).not.toBeNull();

    const publicRead = await app.fetch(new Request(body.data.url), env);
    expect(publicRead.status).toBe(200);
    expect(publicRead.headers.get("Content-Type")).toBe("image/jpeg");
    expect([...new Uint8Array(await publicRead.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it("他ユーザーの保存画像はキューに指定できず、予約した画像は投稿後の猶予まで保持する", async () => {
    const owner = await registerUser();
    const other = await registerUser();
    const ownerAccount = await insertAccount({ userId: owner.userId });
    const otherAccount = await insertAccount({ userId: other.userId });
    const { body } = await upload(owner.cookie, ownerAccount);

    const stolen = await api("POST", `/api/accounts/${otherAccount}/queue`, {
      cookie: other.cookie,
      body: { status: "draft", body: "使えない画像です。", mediaUrls: [body.data.url] },
    });
    expect(stolen.status).toBe(400);

    const scheduledAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    const queued = await api("POST", `/api/accounts/${ownerAccount}/queue`, {
      cookie: owner.cookie,
      body: { status: "scheduled", scheduledAt, body: "画像付きの予約投稿です。", mediaUrls: [body.data.url] },
    });
    expect(queued.status).toBe(201);
    const stored = await testDb().first<{ expires_at: string }>("SELECT expires_at FROM media_objects WHERE id=?", body.data.id);
    expect(Date.parse(stored!.expires_at)).toBeGreaterThanOrEqual(Date.parse(scheduledAt) + 48 * 60 * 60_000);
  });

  it("期限切れ画像をR2とメタデータの両方から掃除する", async () => {
    const user = await registerUser();
    const accountId = await insertAccount({ userId: user.userId });
    const { body } = await upload(user.cookie, accountId);
    const db = testDb();
    await db.run("UPDATE media_objects SET expires_at=? WHERE id=?", "2026-01-01T00:00:00.000Z", body.data.id);

    expect(await cleanupExpiredMedia(env, db, new Date("2026-01-02T00:00:00.000Z"))).toBe(1);
    expect(await env.MEDIA_BUCKET.get(mediaObjectKey(body.data.id))).toBeNull();
    expect(await db.first("SELECT id FROM media_objects WHERE id=?", body.data.id)).toBeNull();
  });

  it("24時間のユーザー別アップロード上限を超えるとR2へ保存しない", async () => {
    const user = await registerUser();
    const accountId = await insertAccount({ userId: user.userId });
    const now = new Date().toISOString();
    const rows = Array.from({ length: MAX_DAILY_MEDIA_UPLOADS_PER_USER }, (_, index) => ({
      sql: "INSERT INTO rate_events (key,at) VALUES (?,?)",
      params: [`media-upload:${user.userId}`, new Date(Date.parse(now) - index).toISOString()],
    }));
    await testDb().batch(rows);

    const { response } = await upload(user.cookie, accountId);
    expect(response.status).toBe(429);
  });

  it("全体容量の安全上限を超えるとR2へ保存しない", async () => {
    const user = await registerUser();
    const accountId = await insertAccount({ userId: user.userId });
    const now = new Date().toISOString();
    await testDb().run(
      `INSERT INTO media_objects (id,user_id,account_id,content_type,byte_size,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?)`,
      crypto.randomUUID(),
      user.userId,
      accountId,
      "image/jpeg",
      MAX_TOTAL_MEDIA_BYTES,
      now,
      new Date(Date.now() + 60_000).toISOString(),
    );

    const { response } = await upload(user.cookie, accountId);
    expect(response.status).toBe(409);
  });
});
