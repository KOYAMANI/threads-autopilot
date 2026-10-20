import { Hono } from "hono";
import { ok } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { loadOwnedAccount } from "../lib/accounts";
import {
  MAX_DAILY_MEDIA_UPLOADS_PER_USER,
  MAX_POST_MEDIA_BYTES,
  MAX_TOTAL_MEDIA_BYTES,
  TEMP_MEDIA_RETENTION_MS,
  mediaObjectKey,
  mediaPublicUrl,
  type MediaObjectRow,
} from "../lib/media";
import { rateHit } from "../lib/rate";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasExpectedSignature(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= png.length && png.every((value, index) => bytes[index] === value);
}

export function mediaRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/:mediaId", async (c) => {
    const id = c.req.param("mediaId");
    if (!UUID_RE.test(id)) return fail("NOT_FOUND", "画像が見つかりませんでした", 404);
    const row = await c.get("db").first<MediaObjectRow>(
      "SELECT id,user_id,account_id,content_type,byte_size,created_at,expires_at FROM media_objects WHERE id=? AND expires_at>?",
      id,
      new Date().toISOString(),
    );
    if (!row) return fail("NOT_FOUND", "画像が見つかりませんでした", 404);
    const object = await c.env.MEDIA_BUCKET.get(mediaObjectKey(id));
    if (!object?.body) return fail("NOT_FOUND", "画像が見つかりませんでした", 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", row.content_type);
    headers.set("Content-Length", String(row.byte_size));
    headers.set("ETag", object.httpEtag);
    headers.set("Cache-Control", "public, max-age=300");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    return new Response(object.body, { headers });
  });

  r.post("/", async (c) => {
    const accountId = (c.req.query("accountId") ?? "").trim();
    const account = await loadOwnedAccount(c.get("db"), accountId, c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "投稿先のアカウントが見つかりません", 404);

    const contentType = (c.req.header("Content-Type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      return fail("BAD_REQUEST", "JPEGまたはPNGの画像を選んでください", 400);
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) return fail("BAD_REQUEST", "画像が空です", 400);
    if (bytes.byteLength > MAX_POST_MEDIA_BYTES) {
      return fail("BAD_REQUEST", "画像は1枚8MBまでです", 413);
    }
    if (!hasExpectedSignature(contentType, new Uint8Array(bytes))) {
      return fail("BAD_REQUEST", "画像ファイルを読み取れませんでした。JPEGまたはPNGを選び直してください", 400);
    }

    const db = c.get("db");
    const userId = c.get("userId")!;
    if (!await rateHit(db, `media-upload:${userId}`, MAX_DAILY_MEDIA_UPLOADS_PER_USER, 24 * 60)) {
      return fail("RATE_LIMITED", "画像は24時間に100枚までです。時間をおいてから試してください", 429);
    }
    const usage = await db.first<{ total_bytes: number }>(
      "SELECT COALESCE(SUM(byte_size),0) AS total_bytes FROM media_objects",
    );
    if (Number(usage?.total_bytes ?? 0) + bytes.byteLength > MAX_TOTAL_MEDIA_BYTES) {
      return fail("LIMIT_REACHED", "画像ストレージの安全上限に達したため、現在はアップロードできません", 409);
    }

    const id = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TEMP_MEDIA_RETENTION_MS);
    const key = mediaObjectKey(id);
    await c.env.MEDIA_BUCKET.put(key, bytes, {
      httpMetadata: {
        contentType,
        contentDisposition: "inline",
        cacheControl: "public, max-age=300",
      },
      customMetadata: {
        userId: c.get("userId")!,
        accountId: account.id,
        expiresAt: expiresAt.toISOString(),
      },
    });
    try {
      await c.get("db").run(
        `INSERT INTO media_objects (id,user_id,account_id,content_type,byte_size,created_at,expires_at)
         VALUES (?,?,?,?,?,?,?)`,
        id,
        userId,
        account.id,
        contentType,
        bytes.byteLength,
        now.toISOString(),
        expiresAt.toISOString(),
      );
    } catch (error) {
      await c.env.MEDIA_BUCKET.delete(key);
      throw error;
    }
    return c.json(ok({
      id,
      url: mediaPublicUrl(c.env, id),
      contentType,
      byteSize: bytes.byteLength,
      expiresAt: expiresAt.toISOString(),
    }), 201);
  });

  return r;
}
