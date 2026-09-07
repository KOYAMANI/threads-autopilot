import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  bytesToBase64,
  base64ToBytes,
  decrypt,
  encrypt,
  generateLicenseKey,
  hashPassword,
  PASSWORD_HASH_PREFIX,
  passwordHashNeedsUpgrade,
  upgradeLegacyPasswordHash,
  isLicenseKeyShape,
  sha256Hex,
  timingSafeEqual,
  verifyPassword,
} from "../src/lib/crypto";

const KEY = env.ENC_KEY;

describe("AES-256-GCM（SPEC §13 M1 完了条件2）", () => {
  it("ENC_KEY で暗号化したトークンが復号できる", async () => {
    const token = "THAAdemo_abcdef0123456789";
    const enc = await encrypt(token, KEY);
    expect(enc).not.toContain(token);
    expect(await decrypt(enc, KEY)).toBe(token);
  });

  it("同じ平文でも毎回違う暗号文になる（IV がランダム）", async () => {
    const a = await encrypt("same", KEY);
    const b = await encrypt("same", KEY);
    expect(a).not.toBe(b);
    expect(await decrypt(a, KEY)).toBe(await decrypt(b, KEY));
  });

  it("日本語・絵文字も往復する", async () => {
    const s = "トークン🔑テスト";
    expect(await decrypt(await encrypt(s, KEY), KEY)).toBe(s);
  });

  it("違う鍵では復号できない", async () => {
    const other = bytesToBase64(new Uint8Array(32).fill(7));
    const enc = await encrypt("secret", KEY);
    await expect(decrypt(enc, other)).rejects.toBeTruthy();
  });

  it("改ざんした暗号文は復号に失敗する（GCM の認証）", async () => {
    const enc = await encrypt("secret", KEY);
    const bytes = base64ToBytes(enc);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! ^ 0xff) & 0xff;
    await expect(decrypt(bytesToBase64(bytes), KEY)).rejects.toBeTruthy();
  });

  it("32バイトでない鍵は弾く", async () => {
    await expect(encrypt("x", bytesToBase64(new Uint8Array(16)))).rejects.toThrow(/32 bytes/);
  });
});

describe("PBKDF2-SHA256 + separate post-hash pepper", () => {
  it("正しいパスワードだけ通る", async () => {
    const stored = await hashPassword("password1234", env.PASSWORD_PEPPER);
    expect(await verifyPassword("password1234", stored, env.PASSWORD_PEPPER)).toBe(true);
    expect(await verifyPassword("password1235", stored, env.PASSWORD_PEPPER)).toBe(false);
  });

  it("versions the format and requires the same secret, without accepting the leaked DB digest as a password", async () => {
    const stored = await hashPassword("password1234", env.PASSWORD_PEPPER);
    expect(stored.hash.startsWith(PASSWORD_HASH_PREFIX)).toBe(true);
    expect(passwordHashNeedsUpgrade(stored)).toBe(false);
    expect(await verifyPassword("password1234", stored, "different-pepper-different-pepper-0123")).toBe(false);
    expect(await verifyPassword(stored.hash, stored, env.PASSWORD_PEPPER)).toBe(false);
    await expect(hashPassword("password1234", "")).rejects.toThrow("PASSWORD_PEPPER");
    await expect(verifyPassword("password1234", stored, "")).rejects.toThrow("PASSWORD_PEPPER");
  });

  it("verifies the independent legacy vector and upgrades it without needing a password reset", async () => {
    // Python hashlib.pbkdf2_hmac('sha256', b'password1234', bytes(range(16)), 100000)
    const legacy = { hash: "fmmThy7w6gLovBzttVbAd8jUZZEY4P6uFRoNnvWWvrg=", salt: "AAECAwQFBgcICQoLDA0ODw==" };
    expect(passwordHashNeedsUpgrade(legacy)).toBe(true);
    expect(await verifyPassword("password1234", legacy, env.PASSWORD_PEPPER)).toBe(true);
    expect(await verifyPassword("wrong", legacy, env.PASSWORD_PEPPER)).toBe(false);
    const upgraded = await upgradeLegacyPasswordHash(legacy, env.PASSWORD_PEPPER);
    expect(upgraded.hash).not.toContain(legacy.hash);
    expect(await verifyPassword("password1234", upgraded, env.PASSWORD_PEPPER)).toBe(true);
  });

  it("salt が毎回違うのでハッシュも変わる", async () => {
    const a = await hashPassword("password1234", env.PASSWORD_PEPPER);
    const b = await hashPassword("password1234", env.PASSWORD_PEPPER);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("壊れた保存値では false を返す（例外にしない）", async () => {
    expect(await verifyPassword("x", { hash: "!!!", salt: "!!!" }, env.PASSWORD_PEPPER)).toBe(false);
  });
});

describe("補助", () => {
  it("timingSafeEqual", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("sha256Hex は既知のベクタと一致する", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("ライセンスキーは TAP-XXXX-XXXX-XXXX で I/O/0/1 を含まない", () => {
    for (let i = 0; i < 50; i++) {
      const key = generateLicenseKey();
      expect(isLicenseKeyShape(key)).toBe(true);
      expect(key.slice(4)).not.toMatch(/[IO01]/);
    }
  });
});
