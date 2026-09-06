/**
 * Web Push の実送信（RFC 8291 aes128gcm / RFC 8292 VAPID）。
 *
 * 外部ライブラリを使わず WebCrypto だけで書く。Workers は npm の web-push が依存する
 * node の crypto をそのままは使えず、バンドルサイズも増えるため（SPEC の依存最小方針）。
 *
 * base64 / base64url は `lib/crypto.ts` のヘルパを再利用する（実装を二重に持たない）。
 *
 * ログについて: endpoint と `p256dh` / `auth` は購読者を特定できる秘密として扱い、
 * このモジュールからは一切ログに出さない（`lib/redact.ts` の方針。出す必要が生じたら
 * 呼び出し側で `redact()` を通すこと）。エラーも文字列化して外に投げず、結果型で返す。
 *
 * 鍵導出は `crypto.subtle` の HKDF（deriveBits）で行う。RFC 5869 の Extract と Expand は
 * このモジュールでは常にセットで使う（Extract 単体の PRK を取り出す場面が無い）ので、
 * HMAC で手書きせずに済む。Workers 上で HKDF-SHA256 が使えることは事前に実機確認した。
 */
import { base64UrlToBytes, bytesToBase64Url } from "./crypto";

const te = new TextEncoder();
const td = new TextDecoder();

/* ── 型 ─────────────────────────────────────────────── */

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/** どちらも base64url。publicKey は非圧縮 65 バイト、privateKey は生の 32 バイト d。 */
export type VapidKeys = { publicKey: string; privateKey: string };

export type PushResult = {
  ok: boolean;
  status: number;
  /** 404/410 = 購読が死んでいる。呼び出し側が行を消す */
  gone: boolean;
};

/* ── 定数 ───────────────────────────────────────────── */

/** RFC 8292 §2「the `exp` claim … MUST NOT be more than 24 hours from the time of the request」。余裕を見て12時間。 */
const JWT_TTL_SEC = 12 * 3600;

/** RFC 8188 §2.1 の rs（record size）。単一レコードで送るので固定。 */
const RECORD_SIZE = 4096;

/** aes128gcm ヘッダ = salt(16) + rs(4) + idlen(1) + keyid(65)。RFC 8188 §2.1 / RFC 8291 §4。 */
const HEADER_BYTES = 16 + 4 + 1 + 65;

/**
 * 平文の上限。rs(4096) からヘッダ 86 バイトを引いた 4010 バイトを上限として扱う。
 * GCM タグ 16 とパディング区切り 1 の分だけ実際にはもう少し入るが、押し込むより
 * 呼び出し側に本文を切らせたほうが安全なので保守側に倒す。
 */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_BYTES;

/** RFC 8291 §3.3 の "WebPush: info" ラベル（末尾に 0x00）。 */
const KEY_INFO_PREFIX = te.encode("WebPush: info\0");
/** RFC 8188 §2.2。 */
const CEK_INFO = te.encode("Content-Encoding: aes128gcm\0");
const NONCE_INFO = te.encode("Content-Encoding: nonce\0");

/* ── バイト操作 ─────────────────────────────────────── */

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** ECDH の共有秘密から HKDF で任意長を導出する。salt / info / L は RFC の指定どおりに渡す。 */
async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  // SHA-256 の1ラウンド（32バイト）で足りる長さしか使わない。将来ここを超える用途が出たら
  // ラウンドを回す実装が要るので、気づけるように assert しておく。
  if (lengthBytes > 32) throw new Error("hkdf: length must be <= 32");
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: info as BufferSource,
    },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/** 非圧縮公開鍵（0x04||X||Y）から JWK の x / y（base64url）を切り出す。 */
function splitUncompressed(pub: Uint8Array): { x: string; y: string } {
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("public key must be a 65-byte uncompressed P-256 point");
  }
  return { x: bytesToBase64Url(pub.slice(1, 33)), y: bytesToBase64Url(pub.slice(33, 65)) };
}

/* ── VAPID（RFC 8292） ──────────────────────────────── */

/**
 * ES256 の JWT を1本作る。RFC 8292 §2。
 *
 * `crypto.subtle.sign` が返すのは raw の r||s（64バイト）で、JWT の ES256 が要求する形と同じ。
 * DER への変換は要らない（node の web-push が DER を剥がしているのは node crypto の都合）。
 */
export async function signVapidJwt(
  keys: VapidKeys,
  audience: string,
  subject: string,
  nowSec?: number,
): Promise<string> {
  if (!subject.startsWith("mailto:") && !subject.startsWith("https:")) {
    throw new Error("VAPID subject must be a mailto: or https: URL");
  }
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const aud = new URL(audience).origin;

  // ヘッダはキー順まで含めて固定したいので JSON.stringify ではなくリテラルで書く
  const header = bytesToBase64Url(te.encode('{"typ":"JWT","alg":"ES256"}'));
  const payload = bytesToBase64Url(
    te.encode(JSON.stringify({ aud, exp: now + JWT_TTL_SEC, sub: subject })),
  );
  const signingInput = `${header}.${payload}`;

  const key = await importVapidPrivateKey(keys);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    te.encode(signingInput) as BufferSource,
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

/** `Authorization` ヘッダの値。RFC 8292 §3.1 の `vapid` スキーム。 */
export async function vapidAuthHeader(
  keys: VapidKeys,
  audience: string,
  subject: string,
  nowSec?: number,
): Promise<string> {
  const jwt = await signVapidJwt(keys, audience, subject, nowSec);
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

/**
 * base64url の生の d（32バイト）と公開鍵から署名用の CryptoKey を作る。
 * WebCrypto は P-256 の秘密鍵を "raw" で受け付けないので JWK 経由で入れる。
 */
async function importVapidPrivateKey(keys: VapidKeys): Promise<CryptoKey> {
  const d = base64UrlToBytes(keys.privateKey);
  if (d.length !== 32) throw new Error("VAPID private key must be 32 bytes");
  const { x, y } = splitUncompressed(base64UrlToBytes(keys.publicKey));
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: bytesToBase64Url(d), x, y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** セットアップ用の鍵ペア生成（README / scripts から呼ぶ）。 */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (!jwk.d) throw new Error("failed to export VAPID private key");
  return { publicKey: bytesToBase64Url(pub), privateKey: jwk.d };
}

/* ── ペイロード暗号化（RFC 8291） ───────────────────── */

/**
 * aes128gcm の単一レコードを作る。戻り値がそのまま HTTP のボディ。
 *
 * 導出の流れは RFC 8291 §3.3 と §3.4:
 *   IKM   = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0"||ua||as, L=32)
 *   PRK   = HKDF-Extract(salt, IKM)  ← 以下2本は Extract を共有するが deriveBits が
 *   CEK   = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)     まとめて処理する
 *   NONCE = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)
 */
export async function encryptPayload(
  sub: PushSubscription,
  plaintext: string,
): Promise<Uint8Array> {
  const plainBytes = te.encode(plaintext);
  if (plainBytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `push payload too large: ${plainBytes.length} bytes (max ${MAX_PAYLOAD_BYTES})`,
    );
  }

  const uaPublic = base64UrlToBytes(sub.keys.p256dh);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error("subscription p256dh must be a 65-byte uncompressed point");
  }
  const authSecret = base64UrlToBytes(sub.keys.auth);
  if (authSecret.length !== 16) throw new Error("subscription auth must be 16 bytes");

  // 1. 使い捨ての ECDH 鍵ペア（RFC 8291 §3.1「a new key pair for every message」）
  const asPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", asPair.publicKey)) as ArrayBuffer,
  );

  // 2. 受信者の公開鍵と ECDH
  const uaKey = await importEcdhPublic(uaPublic);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhAlgorithm(uaKey), asPair.privateKey, 256),
  );

  // 3-4. 共有秘密 + auth から IKM
  const keyInfo = concat(KEY_INFO_PREFIX, uaPublic, asPublic);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  // 5. レコードごとの salt から CEK と NONCE
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekBytes = await hkdf(ikm, salt, CEK_INFO, 16);
  const nonce = await hkdf(ikm, salt, NONCE_INFO, 12);

  // 6. 平文 + 0x02（RFC 8188 §2 の delimiter。最後のレコードは 0x02）
  const padded = concat(plainBytes, new Uint8Array([0x02]));

  // 7. AES-128-GCM
  const cek = await crypto.subtle.importKey("raw", cekBytes as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      cek,
      padded as BufferSource,
    ),
  );

  // 8. ヘッダ + 本体（RFC 8188 §2.1）
  const header = new Uint8Array(HEADER_BYTES);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false); // rs は big-endian
  header[20] = asPublic.length; // idlen = 65
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/**
 * 往復確認用の復号（テスト専用。本番経路からは呼ばない）。
 * 受信者（ブラウザ）側の処理を再現して、こちらの導出が RFC どおりかを検証する。
 */
export async function decryptPayload(
  body: Uint8Array,
  receiverPrivateJwk: JsonWebKey,
  authSecret: Uint8Array,
): Promise<string> {
  if (body.length < HEADER_BYTES) throw new Error("body too short");
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16, false);
  const idlen = body[20];
  if (idlen !== 65) throw new Error(`unexpected keyid length: ${String(idlen)}`);
  if (rs !== RECORD_SIZE) throw new Error(`unexpected record size: ${rs}`);
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  if (!receiverPrivateJwk.x || !receiverPrivateJwk.y) throw new Error("receiver jwk needs x/y");
  const uaPublic = concat(
    new Uint8Array([0x04]),
    base64UrlToBytes(receiverPrivateJwk.x),
    base64UrlToBytes(receiverPrivateJwk.y),
  );

  const uaPrivate = await crypto.subtle.importKey(
    "jwk",
    receiverPrivateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const asKey = await importEcdhPublic(asPublic);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhAlgorithm(asKey), uaPrivate, 256),
  );

  const ikm = await hkdf(ecdhSecret, authSecret, concat(KEY_INFO_PREFIX, uaPublic, asPublic), 32);
  const cekBytes = await hkdf(ikm, salt, CEK_INFO, 16);
  const nonce = await hkdf(ikm, salt, NONCE_INFO, 12);
  const cek = await crypto.subtle.importKey("raw", cekBytes as BufferSource, { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      cek,
      ciphertext as BufferSource,
    ),
  );

  // 末尾の 0x00 パディングを飛ばし、delimiter（0x02 = 最終レコード）を落とす
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0x00) end--;
  if (end === 0 || padded[end - 1] !== 0x02) throw new Error("bad padding delimiter");
  return td.decode(padded.slice(0, end - 1));
}

/**
 * ECDH の deriveBits に渡すアルゴリズム指定。
 *
 * ランタイムのプロパティ名は WebCrypto 標準どおり `public` だが、`@cloudflare/workers-types`
 * の生成型は `$public` と綴っている（型側だけの都合）。素直に書くと型エラーになるので、
 * ここで一度だけキャストして閉じ込める。
 */
function ecdhAlgorithm(publicKey: CryptoKey): Parameters<SubtleCrypto["deriveBits"]>[0] {
  return { name: "ECDH", public: publicKey } as unknown as Parameters<
    SubtleCrypto["deriveBits"]
  >[0];
}

/** 生の非圧縮点を ECDH 公開鍵として読み込む。公開鍵に usage は付けられない仕様。 */
function importEcdhPublic(pub: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    pub as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

/* ── 送信 ───────────────────────────────────────────── */

/**
 * 1件送る。**例外を投げない**（通知ジョブが1件の失敗で止まらないように、結果で返す）。
 *
 * TTL は 24 時間。端末がオフラインでも翌日のダイジェストまでには届く一方、
 * それより古い通知は届いても意味がないため。
 */
export async function sendPush(
  keys: VapidKeys,
  sub: PushSubscription,
  payload: { title: string; body: string; url?: string },
  /**
   * RFC 8292 の `sub`。Push サービスが配信を止めるときの連絡先で、`mailto:` か `https:`。
   * 呼び出し側（`lib/notify.ts`）が `VAPID_SUBJECT`、無ければ `APP_ORIGIN` を渡す。
   */
  subject: string,
): Promise<PushResult> {
  try {
    const body = await encryptPayload(sub, JSON.stringify(payload));
    const auth = await vapidAuthHeader(keys, sub.endpoint, subject);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        TTL: "86400",
        Urgency: "normal",
      },
      body: body as BodyInit,
    });
    const status = res.status;
    // 404 = そんな購読は無い / 410 = 期限切れ（RFC 8030 §7.3）。どちらも行を消す合図
    const gone = status === 404 || status === 410;
    return { ok: status === 200 || status === 201 || status === 202, status, gone };
  } catch {
    // ネットワーク断・平文超過・鍵の形不正。詳細は秘密を含みうるので握りつぶす
    return { ok: false, status: 0, gone: false };
  }
}
