import { describe, expect, it } from "vitest";
import { hasRequestedWith, readCookie, signToken, verifyToken } from "../src/lib/session";

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
