import { describe, expect, it } from "vitest";
import { createSession, deleteSession, getSession, hasRequestedWith, readCookie, signToken, verifyToken } from "../src/lib/session";

import { api, registerUser, testDb } from "./helpers";
import { sha256Hex } from "../src/lib/crypto";

const SECRET = "unit-test-secret-unit-test-secret-0123456789";
const nowSec = 1_800_000_000;

describe("signToken / verifyToken（SPEC §5.3）", () => {
  it("署名した内容がそのまま戻る", async () => {
    const token = await signToken(SECRET, {
      purpose: "pwreset",
      sub: "reset-1",
      extra: "",
      expires: nowSec + 1800,
    });
    const payload = await verifyToken(SECRET, token, "pwreset", nowSec);
    expect(payload).toEqual({ purpose: "pwreset", sub: "reset-1", extra: "", expires: nowSec + 1800 });
  });

  it("qaction は extra に approve/cancel を載せる", async () => {
    const token = await signToken(SECRET, {
      purpose: "qaction",
      sub: "queue-1",
      extra: "approve",
      expires: nowSec + 3600,
    });
    expect((await verifyToken(SECRET, token, "qaction", nowSec))?.extra).toBe("approve");
  });

  it("期限切れは null", async () => {
    const token = await signToken(SECRET, {
      purpose: "pwreset",
      sub: "reset-1",
      extra: "",
      expires: nowSec,
    });
    expect(await verifyToken(SECRET, token, "pwreset", nowSec)).toBeNull();
    expect(await verifyToken(SECRET, token, "pwreset", nowSec - 1)).not.toBeNull();
  });

  it("purpose が違えば null（pwreset のトークンを qaction として使えない）", async () => {
    const token = await signToken(SECRET, {
      purpose: "pwreset",
      sub: "x",
      extra: "",
      expires: nowSec + 60,
    });
    expect(await verifyToken(SECRET, token, "qaction", nowSec)).toBeNull();
  });

  it("鍵が違えば null", async () => {
    const token = await signToken(SECRET, {
      purpose: "pwreset",
      sub: "x",
      extra: "",
      expires: nowSec + 60,
    });
    expect(await verifyToken(SECRET + "!", token, "pwreset", nowSec)).toBeNull();
  });

  it("payload を書き換えると署名が合わなくなる", async () => {
    const token = await signToken(SECRET, {
      purpose: "qaction",
      sub: "queue-1",
      extra: "cancel",
      expires: nowSec + 60,
    });
    const [body, sig] = token.split(".") as [string, string];
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(body.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)),
    );
    const tampered = decoded.replace("cancel", "approve");
    const reencoded = btoa(tampered).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyToken(SECRET, `${reencoded}.${sig}`, "qaction", nowSec)).toBeNull();
  });

  it("壊れた形式は null（例外にしない）", async () => {
    for (const bad of ["", ".", "abc", "abc.", ".abc", "a.b.c", "!!!.???"]) {
      expect(await verifyToken(SECRET, bad, "pwreset", nowSec)).toBeNull();
    }
  });
});

describe("Cookie / CSRF", () => {
  it("readCookie", () => {
    const req = new Request("https://x.test", { headers: { Cookie: "a=1; sid=abc%20def; b=2" } });
    expect(readCookie(req, "sid")).toBe("abc def");
    expect(readCookie(req, "nope")).toBeNull();
    expect(readCookie(new Request("https://x.test"), "sid")).toBeNull();
  });

  it("hasRequestedWith は安全メソッドを素通しし、変更系はヘッダを要求する", () => {
    expect(hasRequestedWith(new Request("https://x.test"))).toBe(true);
    expect(hasRequestedWith(new Request("https://x.test", { method: "POST" }))).toBe(false);
    expect(
      hasRequestedWith(
        new Request("https://x.test", { method: "POST", headers: { "X-Requested-With": "fetch" } }),
      ),
    ).toBe(true);
  });
});


describe("opaque session credentials", () => {
  it("stores only the digest, rejects a leaked digest, and preserves OAuth FK ownership", async () => {
    const u = await registerUser(), db = testDb();
    const token = u.cookie.slice(4);
    const row = await db.first<{ id: string }>("SELECT id FROM sessions WHERE user_id=?", u.userId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row?.id).toBe(await sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect((await api("GET", "/api/auth/me", { cookie: `sid=${row!.id}` })).status).toBe(401);
    const session = await getSession(db, token);
    expect(session?.user_id).toBe(u.userId);
    await db.run("INSERT INTO threads_oauth_states(id,user_id,session_id,browser_hash,expires_at) VALUES (?,?,?,?,?)",
      "test-state", u.userId, session!.id, "browser-hash", session!.expires_at);
    const second = await createSession(db, u.userId, null);
    await deleteSession(db, session!.id);
    expect(await getSession(db, token)).toBeNull();
    expect(await db.first("SELECT id FROM threads_oauth_states WHERE id='test-state'")).toBeNull();
    expect((await getSession(db, second.token))?.id).toBe(second.id);
  });

  it("does not accept old bearer IDs or malformed cookies and does not delete the retained records", async () => {
    const u = await registerUser(), db = testDb();
    const legacyToken = crypto.randomUUID();
    await db.run("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES (?,?,?,?)", legacyToken, u.userId,
      new Date(Date.now()+86400000).toISOString(), new Date().toISOString());
    expect((await api("GET", "/api/auth/me", { cookie: `sid=${legacyToken}` })).status).toBe(401);
    expect((await api("GET", "/api/auth/me", { cookie: "sid=%broken" })).status).toBe(401);
    expect(await db.first("SELECT id FROM sessions WHERE id=?", legacyToken)).toBeTruthy();
  });

  it("enforces expiry even for a correctly hashed token", async () => {
    const u = await registerUser(), db = testDb();
    const expired = await createSession(db, u.userId, null, new Date("2000-01-01T00:00:00Z"));
    expect(await getSession(db, expired.token)).toBeNull();
  });
});
