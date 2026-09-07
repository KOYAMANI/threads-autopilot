import { describe, expect, it } from "vitest";
import { api, registerUser, testDb } from "./helpers";
import { getOutbox } from "../src/lib/email";

describe("signed-in password change", () => {
  const path = "/api/auth/password";
  const body = { current_password: "password1234", new_password: "changed-password9876" };
  it("requires authentication and CSRF protection", async () => {
    expect((await api("POST", path, { body })).status).toBe(401);
    const u = await registerUser();
    expect((await api("POST", path, { cookie: u.cookie, body, xrw: false })).status).toBe(403);
  });
  it("rejects wrong current password, short or unchanged replacement without losing session", async () => {
    const u = await registerUser();
    for (const input of [{ ...body, current_password: "wrong" }, { ...body, new_password: "tiny" }, { ...body, new_password: body.current_password }]) {
      expect((await api("POST", path, { cookie: u.cookie, body: input })).status).toBe(400);
    }
    expect((await api("GET", "/api/auth/me", { cookie: u.cookie })).status).toBe(200);
  });
  it("revokes all owner sessions and reset links, preserves other users, and accepts only the new password", async () => {
    const u = await registerUser();
    const other = await registerUser();
    const second = await api("POST", "/api/auth/login", { body: { email: u.email, password: body.current_password } });
    await api("POST", "/api/auth/forgot", { body: { email: u.email } });
    const mail = getOutbox().filter(m => m.to === u.email).at(-1)!;
    const token = decodeURIComponent(/\/login\?reset=([^\s]+)/.exec(mail.text)![1]!);
    const result = await api("POST", path, { cookie: u.cookie, body: { ...body, user_id: other.userId } });
    expect(result.status).toBe(200);
    expect(result.headers.get("Set-Cookie")).toContain("Max-Age=0");
    for (const cookie of [u.cookie, second.cookie]) expect((await api("GET", "/api/auth/me", { cookie })).status).toBe(401);
    expect((await api("GET", "/api/auth/me", { cookie: other.cookie })).status).toBe(200);
    expect((await api("POST", "/api/auth/reset", { body: { token, password: "another-password" } })).status).toBe(400);
    expect((await api("POST", "/api/auth/login", { body: { email: u.email, password: body.current_password } })).status).toBe(401);
    expect((await api("POST", "/api/auth/login", { body: { email: u.email, password: body.new_password } })).status).toBe(200);
    const audit = await testDb().first<{ detail: string | null }>("SELECT detail FROM audit_log WHERE user_id=? AND action='password_change'", u.userId);
    expect(audit).toBeTruthy(); expect(audit?.detail).toBeNull();
  });
  it("limits repeated guesses without changing the password", async () => {
    const u = await registerUser();
    for (let i = 0; i < 5; i++) expect((await api("POST", path, { cookie: u.cookie, body: { ...body, current_password: "wrong" } })).status).toBe(400);
    expect((await api("POST", path, { cookie: u.cookie, body })).status).toBe(429);
  });
  it("allows only one concurrent change based on the original password", async () => {
    const u = await registerUser();
    const results = await Promise.all([body, { ...body, new_password: "another-password987" }].map(input => api("POST", path, { cookie: u.cookie, body: input })));
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(results.filter(r => r.status !== 200)).toHaveLength(1);
    expect((await api("GET", "/api/auth/me", { cookie: u.cookie })).status).toBe(401);
  });
});
