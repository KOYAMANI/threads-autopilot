import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, registerUser, testDb } from "./helpers";
import { PASSWORD_HASH_PREFIX, hashPassword } from "../src/lib/crypto";
import { createSession } from "../src/lib/session";
import { getOutbox } from "../src/lib/email";

const legacy = { hash: "fmmThy7w6gLovBzttVbAd8jUZZEY4P6uFRoNnvWWvrg=", salt: "AAECAwQFBgcICQoLDA0ODw==" };
async function legacyUser() {
  const u = await registerUser();
  await testDb().run("UPDATE users SET pass_hash=?,pass_salt=? WHERE id=?", legacy.hash, legacy.salt, u.userId);
  return u;
}
async function stored(userId: string) {
  return testDb().first<{ pass_hash: string; pass_salt: string }>("SELECT pass_hash,pass_salt FROM users WHERE id=?", userId);
}

describe("password storage migration", () => {
  it("leaves a failed legacy attempt untouched and transparently upgrades a successful login once", async () => {
    const u = await legacyUser();
    expect((await api("POST", "/api/auth/login", { body: { email: u.email, password: "wrong" } })).status).toBe(401);
    expect((await stored(u.userId))?.pass_hash).toBe(legacy.hash);
    const first = await api("POST", "/api/auth/login", { body: { email: u.email, password: "password1234" } });
    expect(first.status).toBe(200);
    const upgraded = await stored(u.userId);
    expect(upgraded?.pass_hash.startsWith(PASSWORD_HASH_PREFIX)).toBe(true);
    expect(upgraded?.pass_hash).not.toContain(legacy.hash);
    expect(JSON.stringify(first.body)).not.toContain(upgraded!.pass_hash);
    expect((await api("GET", "/api/auth/me", { cookie: first.cookie })).status).toBe(200);
    expect((await api("POST", "/api/auth/login", { body: { email: u.email, password: "password1234" } })).status).toBe(200);
    expect(await stored(u.userId)).toEqual(upgraded);
  });

  it("accepts a legacy current password for password change and stores only the protected format", async () => {
    const u = await legacyUser();
    expect((await api("POST", "/api/auth/password", { cookie: u.cookie, body: { current_password: "password1234", new_password: "changed-password-1234" } })).status).toBe(200);
    expect((await stored(u.userId))?.pass_hash.startsWith(PASSWORD_HASH_PREFIX)).toBe(true);
    expect((await api("POST", "/api/auth/login", { body: { email: u.email, password: "password1234" } })).status).toBe(401);
    expect((await api("POST", "/api/auth/login", { body: { email: u.email, password: "changed-password-1234" } })).status).toBe(200);
  });

  it("resets a legacy password through the existing single-use email link", async () => {
    const u = await legacyUser();
    await api("POST", "/api/auth/forgot", { body: { email: u.email } });
    const mail = getOutbox().filter(m => m.to === u.email).at(-1)!;
    const token = decodeURIComponent(/\/login\?reset=([^\s]+)/.exec(mail.text)![1]!);
    expect((await api("POST", "/api/auth/reset", { body: { token, password: "reset-password-1234" } })).status).toBe(200);
    expect((await stored(u.userId))?.pass_hash.startsWith(PASSWORD_HASH_PREFIX)).toBe(true);
    expect((await api("GET", "/api/auth/me", { cookie: u.cookie })).status).toBe(401);
    expect((await api("POST", "/api/auth/login", { body: { email: u.email, password: "reset-password-1234" } })).status).toBe(200);
  });

  it("cannot create a session from a password verification invalidated by a concurrent password change", async () => {
    const u = await legacyUser(), db = testDb();
    const updated = await hashPassword("new-password-1234", env.PASSWORD_PEPPER);
    await db.run("UPDATE users SET pass_hash=?,pass_salt=? WHERE id=?", updated.hash, updated.salt, u.userId);
    expect(await createSession(db, u.userId, null, new Date(), legacy)).toBeNull();
    expect(await createSession(db, u.userId, null, new Date(), updated)).toBeTruthy();
  });
});
