/**
 * 投稿に付ける画像（DECISIONS 2026-10-30）。
 * - `POST /api/accounts/:id/media` 本文が画像そのもの（JPEG / PNG、8MB まで）。R2 に置いて公開 URL を返す
 * - `GET /m/:key` は認証なしで配る（Threads がこの URL を取りに来る）。`index.ts` が受け持つ
 *
 * 縮小や JPEG への変換はブラウザ側で済ませてから送る（画像変換の依存を足さない。DECISIONS の方針）。
 */
import { Hono } from "hono";
import { MAX_MEDIA_BYTES, ok } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import type { Env } from "../env";
import { loadOwnedAccount } from "../lib/accounts";

const KEY_RE = /^[0-9a-f-]{36}\.(jpg|png)$/;

/** 先頭のバイトで中身を確かめる（Content-Type だけを信じない）。 */
function sniff(bytes: Uint8Array): "jpg" | "png" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return null;
}

export function mediaUrl(env: Pick<Env, "APP_ORIGIN">, key: string): string {
  return `${env.APP_ORIGIN.replace(/\/$/, "")}/m/${key}`;
}

export function mediaRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/:id/media", async (c) => {
    if (!c.env.MEDIA) return fail("UNAVAILABLE", "画像を置く場所が設定されていません", 503);
    const account = await loadOwnedAccount(c.get("db"), c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) return fail("BAD_REQUEST", "画像が空です", 400);
    if (bytes.byteLength > MAX_MEDIA_BYTES) return fail("BAD_REQUEST", "画像は8MBまでです", 413);
    const ext = sniff(bytes);
    if (!ext) return fail("BAD_REQUEST", "JPEG か PNG の画像を送ってください", 415);

    const key = `${crypto.randomUUID()}.${ext}`;
    await c.env.MEDIA.put(key, bytes, {
      httpMetadata: { contentType: ext === "jpg" ? "image/jpeg" : "image/png" },
      customMetadata: { userId: c.get("userId")!, accountId: account.id },
    });
    return c.json(ok({ url: mediaUrl(c.env, key) }), 201);
  });

  return r;
}

/** `GET|HEAD /m/:key`。鍵は推測できない UUID なので認証は付けない（Threads が取りに来るため）。 */
export async function serveMedia(request: Request, env: Env, key: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  if (!env.MEDIA || !KEY_RE.test(key)) return new Response("Not Found", { status: 404 });
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not Found", { status: 404 });
  const headers = new Headers({
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(object.size),
    ETag: object.httpEtag,
  });
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
