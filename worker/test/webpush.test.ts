/**
 * Web Push（RFC 8291 aes128gcm / RFC 8292 VAPID）の自前実装のテスト。
 *
 * 実際の Push サービスへは送らない。送信は `globalThis.fetch` を差し替えて確認する。
 * 暗号は「自分で暗号化 → 受信者側の手順で復号」の往復で、導出が RFC どおりかを見る。
 */
import { afterEach, describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "../src/lib/crypto";
import {
  MAX_PAYLOAD_BYTES,
  decryptPayload,
  encryptPayload,
  generateVapidKeys,
  sendPush,
  signVapidJwt,
  vapidAuthHeader,
  type PushSubscription,
  type VapidKeys,
} from "../src/lib/webpush";

/** テストで使う VAPID の連絡先（RFC 8292 の `sub`）。 */
const SUBJECT = "mailto:push@example.com";

const te = new TextEncoder();

/** ブラウザ役の購読を1件作る（受信者の P-256 鍵と 16 バイトの auth）。 */
async function makeSubscriber(endpoint = "https://fcm.example.com/send/abc123?x=1"): Promise<{
  sub: PushSubscription;
  privateJwk: JsonWebKey;
  authSecret: Uint8Array;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    sub: {
      endpoint,
      keys: { p256dh: bytesToBase64Url(raw), auth: bytesToBase64Url(authSecret) },
    },
    privateJwk,
    authSecret,
  };
}

function decodeJwtPart(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ── 暗号化（RFC 8291） ─────────────────────────────── */

describe("aes128gcm の暗号化（RFC 8291）", () => {
  it("暗号化した本文が受信者側の手順で元に戻る（日本語・絵文字を含む）", async () => {
    const { sub, privateJwk, authSecret } = await makeSubscriber();
    const message = '自動投稿を1件下書きしました🎉 "予約は 8:00" — チェックして';
    const body = await encryptPayload(sub, message);
    expect(await decryptPayload(body, privateJwk, authSecret)).toBe(message);
  });

  it("空文字と 4010 バイトちょうども往復する", async () => {
    const { sub, privateJwk, authSecret } = await makeSubscriber();
    expect(await decryptPayload(await encryptPayload(sub, ""), privateJwk, authSecret)).toBe("");

    const max = "a".repeat(MAX_PAYLOAD_BYTES);
    expect(te.encode(max).length).toBe(4010);
    const body = await encryptPayload(sub, max);
    expect(await decryptPayload(body, privateJwk, authSecret)).toBe(max);
  });

  it("ヘッダは salt(16) + rs=4096 + idlen=65 + 鍵(65) の形で、salt は毎回変わる", async () => {
    const { sub } = await makeSubscriber();
    const a = await encryptPayload(sub, "hello");
    const b = await encryptPayload(sub, "hello");

    const view = new DataView(a.buffer, a.byteOffset, a.byteLength);
    expect(view.getUint32(16, false)).toBe(4096);
    expect(a[20]).toBe(65);
    expect(a[21]).toBe(0x04); // 送信側の使い捨て公開鍵（非圧縮点）
    expect(a.length).toBeGreaterThan(86);

    // salt（先頭16バイト）と使い捨て鍵はメッセージごとに変わる
    expect(bytesToBase64Url(a.slice(0, 16))).not.toBe(bytesToBase64Url(b.slice(0, 16)));
    expect(bytesToBase64Url(a.slice(21, 86))).not.toBe(bytesToBase64Url(b.slice(21, 86)));
    // 同じ平文でも暗号文は一致しない
    expect(bytesToBase64Url(a)).not.toBe(bytesToBase64Url(b));
  });

  it("4010 バイトを超える平文は例外にする（呼び出し側が本文を切る）", async () => {
    const { sub } = await makeSubscriber();
    await expect(encryptPayload(sub, "a".repeat(MAX_PAYLOAD_BYTES + 1))).rejects.toThrow(
      /too large/,
    );
    // マルチバイトは文字数ではなくバイト数で判定する
    await expect(encryptPayload(sub, "あ".repeat(1337))).rejects.toThrow(/too large/);
  });

  it("鍵の形が違う購読は弾く", async () => {
    const { sub } = await makeSubscriber();
    await expect(
      encryptPayload({ ...sub, keys: { ...sub.keys, p256dh: bytesToBase64Url(new Uint8Array(32)) } }, "x"),
    ).rejects.toThrow(/65-byte/);
    await expect(
      encryptPayload({ ...sub, keys: { ...sub.keys, auth: bytesToBase64Url(new Uint8Array(8)) } }, "x"),
    ).rejects.toThrow(/16 bytes/);
  });

  it("別の購読者の鍵では復号できない", async () => {
    const { sub } = await makeSubscriber();
    const other = await makeSubscriber();
    const body = await encryptPayload(sub, "secret");
    await expect(decryptPayload(body, other.privateJwk, other.authSecret)).rejects.toBeTruthy();
  });
});

/* ── VAPID（RFC 8292） ──────────────────────────────── */

describe("VAPID JWT（RFC 8292）", () => {
  it("3パートで、header/payload が仕様どおり", async () => {
    const keys = await generateVapidKeys();
    const now = 1_800_000_000;
    const jwt = await signVapidJwt(
      keys,
      "https://fcm.example.com/send/abc123?x=1",
      "mailto:push@example.com",
      now,
    );

    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    expect(new TextDecoder().decode(base64UrlToBytes(parts[0]!))).toBe(
      '{"typ":"JWT","alg":"ES256"}',
    );

    const payload = decodeJwtPart(parts[1]!) as { aud: string; exp: number; sub: string };
    // aud は origin だけ（パス・クエリを含まない）
    expect(payload.aud).toBe("https://fcm.example.com");
    expect(payload.exp).toBe(now + 12 * 3600);
    expect(payload.sub).toBe("mailto:push@example.com");
  });

  it("署名は raw r||s の 64 バイトで、公開鍵で検証が通る", async () => {
    const keys = await generateVapidKeys();
    const jwt = await signVapidJwt(keys, "https://push.example.org/x", "https://example.com/me");
    const parts = jwt.split(".");
    const sig = base64UrlToBytes(parts[2]!);
    expect(sig.length).toBe(64);

    const pub = base64UrlToBytes(keys.publicKey);
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(0x04);
    const verifyKey = await crypto.subtle.importKey(
      "raw",
      pub as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const okSig = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      sig as BufferSource,
      te.encode(`${parts[0]}.${parts[1]}`) as BufferSource,
    );
    expect(okSig).toBe(true);

    // 1バイト変えたら通らない
    const tampered = new Uint8Array(sig);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifyKey,
        tampered as BufferSource,
        te.encode(`${parts[0]}.${parts[1]}`) as BufferSource,
      ),
    ).toBe(false);
  });

  it("subject は mailto: か https: しか受けない", async () => {
    const keys = await generateVapidKeys();
    await expect(signVapidJwt(keys, "https://a.example/x", "yama@example.com")).rejects.toThrow(
      /mailto:/,
    );
  });

  it("vapidAuthHeader は `vapid t=<jwt>, k=<pub>`", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthHeader(keys, "https://fcm.example.com/send/x", "mailto:a@b.co");
    const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(keys.publicKey);
    // t= の中身は signVapidJwt と同じ構造
    expect(m![1]!.split(".")).toHaveLength(3);
  });

  it("generateVapidKeys の鍵は base64url で 65 / 32 バイト", async () => {
    const keys = await generateVapidKeys();
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64UrlToBytes(keys.publicKey).length).toBe(65);
    expect(base64UrlToBytes(keys.privateKey).length).toBe(32);
    // 毎回違う鍵が出る
    expect((await generateVapidKeys()).privateKey).not.toBe(keys.privateKey);
  });
});

/* ── 送信 ───────────────────────────────────────────── */

type Captured = { url: string; init: RequestInit };

function stubFetch(reply: () => Promise<Response> | Response): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return calls;
}

describe("sendPush", () => {
  const payload = { title: "下書きができました", body: "8:00 の投稿", url: "/queue" };
  let keys: VapidKeys;
  let sub: PushSubscription;

  async function setup(): Promise<void> {
    keys = await generateVapidKeys();
    sub = (await makeSubscriber("https://fcm.example.com/send/abc123")).sub;
  }

  it("201 は ok、ヘッダとボディが RFC の形で載る", async () => {
    await setup();
    const calls = stubFetch(() => new Response(null, { status: 201 }));
    const res = await sendPush(keys, sub, payload, SUBJECT);
    expect(res).toEqual({ ok: true, status: 201, gone: false });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(sub.endpoint);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["TTL"]).toBe("86400");
    expect(headers["Urgency"]).toBe("normal");
    expect(headers["Authorization"]).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

    const body = call.init.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16, false)).toBe(
      4096,
    );
    expect(body[20]).toBe(65);
    expect(headers["Content-Length"]).toBe(String(body.length));
  });

  it("200 / 202 も ok", async () => {
    await setup();
    for (const status of [200, 202]) {
      stubFetch(() => new Response(null, { status }));
      expect(await sendPush(keys, sub, payload, SUBJECT)).toEqual({ ok: true, status, gone: false });
    }
  });

  it("410 と 404 は gone（購読の行を消す合図）", async () => {
    await setup();
    for (const status of [404, 410]) {
      stubFetch(() => new Response(null, { status }));
      expect(await sendPush(keys, sub, payload, SUBJECT)).toEqual({ ok: false, status, gone: true });
    }
  });

  it("500 は ok:false だが gone にはしない", async () => {
    await setup();
    stubFetch(() => new Response("boom", { status: 500 }));
    expect(await sendPush(keys, sub, payload, SUBJECT)).toEqual({ ok: false, status: 500, gone: false });
  });

  it("fetch が throw しても例外を投げない（ジョブが止まらない）", async () => {
    await setup();
    stubFetch(() => {
      throw new TypeError("network error");
    });
    expect(await sendPush(keys, sub, payload, SUBJECT)).toEqual({ ok: false, status: 0, gone: false });
  });

  it("平文が大きすぎる・鍵が壊れている場合も例外にせず結果で返す", async () => {
    await setup();
    let called = 0;
    stubFetch(() => {
      called++;
      return new Response(null, { status: 201 });
    });
    const big = { title: "x", body: "あ".repeat(4000) };
    expect(await sendPush(keys, sub, big, SUBJECT)).toEqual({ ok: false, status: 0, gone: false });

    const broken: PushSubscription = { ...sub, keys: { ...sub.keys, auth: "AAAA" } };
    expect(await sendPush(keys, broken, payload, SUBJECT)).toEqual({ ok: false, status: 0, gone: false });
    expect(called).toBe(0); // 送信に至らない
  });

  it("送ったボディは購読者の鍵で復号できる（VAPID 鍵も自前生成で完結）", async () => {
    const vapid = await generateVapidKeys();
    const subscriber = await makeSubscriber("https://updates.push.services.mozilla.com/wpush/v2/xyz");
    const calls = stubFetch(() => new Response(null, { status: 201 }));
    const res = await sendPush(vapid, subscriber.sub, payload, SUBJECT);
    expect(res.ok).toBe(true);

    const body = calls[0]!.init.body as Uint8Array;
    const plain = await decryptPayload(body, subscriber.privateJwk, subscriber.authSecret);
    expect(JSON.parse(plain)).toEqual(payload);

    // Authorization の aud は endpoint の origin（パスを含まない）
    const header = (calls[0]!.init.headers as Record<string, string>)["Authorization"]!;
    const token = header.slice("vapid t=".length, header.indexOf(", k="));
    const claims = decodeJwtPart(token.split(".")[1]!) as { aud: string };
    expect(claims.aud).toBe("https://updates.push.services.mozilla.com");
  });
});
