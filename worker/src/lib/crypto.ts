/**
 * 暗号（SPEC §5.2）。WebCrypto のみ。
 * - encrypt/decrypt: AES-256-GCM、鍵は ENC_KEY（32バイトの base64）
 * - パスワード: PBKDF2-SHA256 100,000回 + 専用 Secret による HMAC、salt 16バイト
 * 復号した値は関数スコープ内で使い切り、レスポンスやログに入れない。
 */

// Keep within the deployed Workers PBKDF2 budget. The pepper adds DB-only breach
// protection; it does not claim the 600k work factor recommended by OWASP.
const PBKDF2_ITERATIONS = 100_000;
export const PASSWORD_HASH_PREFIX = "pbkdf2-sha256$100000$hmac-sha256$v1$";
const SALT_BYTES = 16;
const IV_BYTES = 12;

/* ── base64 / base64url ─────────────────────────────── */

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const te = new TextEncoder();
const td = new TextDecoder();

/* ── AES-256-GCM ────────────────────────────────────── */

async function aesKey(encKey: string): Promise<CryptoKey> {
  const raw = base64ToBytes(encKey.trim());
  if (raw.length !== 32) {
    throw new Error("ENC_KEY must be 32 bytes encoded as base64");
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** base64(iv(12) + ciphertext) を返す。 */
export async function encrypt(plain: string, encKey: string): Promise<string> {
  const key = await aesKey(encKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, te.encode(plain) as BufferSource),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToBase64(out);
}

export async function decrypt(payload: string, encKey: string): Promise<string> {
  const key = await aesKey(encKey);
  const all = base64ToBytes(payload);
  if (all.length <= IV_BYTES) throw new Error("ciphertext too short");
  const iv = all.slice(0, IV_BYTES);
  const ct = all.slice(IV_BYTES);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return td.decode(plain);
}

/* ── パスワード（PBKDF2-SHA256 100,000回） ───────────── */

export type PasswordHash = { hash: string; salt: string };

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    te.encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** This dedicated secret must never be stored in D1 or derived from an encryption/session key. */
function requirePasswordPepper(pepper: string): void {
  if (typeof pepper !== "string" || pepper.length < 32) throw new Error("PASSWORD_PEPPER is not configured");
}

async function pepperDigest(derived: Uint8Array, salt: string, pepper: string): Promise<Uint8Array> {
  requirePasswordPepper(pepper);
  return hmacSha256(pepper, `${PASSWORD_HASH_PREFIX}${salt}$${bytesToBase64(derived)}`);
}

export async function hashPassword(password: string, pepper: string): Promise<PasswordHash> {
  requirePasswordPepper(pepper);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const saltBase64 = bytesToBase64(salt);
  const digest = await pepperDigest(await pbkdf2(password, salt), saltBase64, pepper);
  return { hash: PASSWORD_HASH_PREFIX + bytesToBase64(digest), salt: saltBase64 };
}

export function passwordHashNeedsUpgrade(stored: PasswordHash): boolean {
  return !stored.hash.startsWith(PASSWORD_HASH_PREFIX);
}

/** Called only after successful legacy verification. Reuse its existing KDF output
 * so upgrading the post-hash HMAC does not require a second expensive KDF call. */
export async function upgradeLegacyPasswordHash(stored: PasswordHash, pepper: string): Promise<PasswordHash> {
  requirePasswordPepper(pepper);
  const derived = base64ToBytes(stored.hash);
  if (derived.length !== 32 || base64ToBytes(stored.salt).length !== SALT_BYTES) throw new Error("Invalid legacy password hash");
  return { hash: PASSWORD_HASH_PREFIX + bytesToBase64(await pepperDigest(derived, stored.salt, pepper)), salt: stored.salt };
}

export async function verifyPassword(
  password: string,
  stored: PasswordHash,
  pepper: string,
): Promise<boolean> {
  requirePasswordPepper(pepper);
  const current = stored.hash.startsWith(PASSWORD_HASH_PREFIX);
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64ToBytes(stored.salt);
    expected = base64ToBytes(current ? stored.hash.slice(PASSWORD_HASH_PREFIX.length) : stored.hash);
    if (salt.length !== SALT_BYTES || expected.length !== 32) return false;
  } catch {
    return false;
  }
  const derived = await pbkdf2(password, salt);
  // Do the same KDF + HMAC for legacy, current and dummy credentials.
  const protectedDigest = await pepperDigest(derived, stored.salt, pepper);
  return timingSafeEqual(current ? protectedDigest : derived, expected);
}

/* ── 補助 ───────────────────────────────────────────── */

/** 長さが違っても早期 return しない定数時間比較。 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(input) as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(message) as BufferSource);
  return new Uint8Array(sig);
}

/** I/O/0/1 を除いた英大文字＋数字（ライセンスキー用、SPEC §5.4）。 */
export const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** TAP-XXXX-XXXX-XXXX 形式のライセンスキーを作る。 */
export function generateLicenseKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = Array.from(bytes, (b) => LICENSE_ALPHABET[b % LICENSE_ALPHABET.length]!);
  return `TAP-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

const LICENSE_KEY_RE = /^TAP-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

export function isLicenseKeyShape(key: string): boolean {
  return LICENSE_KEY_RE.test(key.trim().toUpperCase());
}
