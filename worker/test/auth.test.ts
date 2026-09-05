import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { api, issueLicense, registerUser, testDb, uniqueEmail } from "./helpers";
import { clearOutbox, getOutbox } from "../src/lib/email";

beforeEach(() => clearOutbox());

describe("register → login → me（SPEC §13 M1 完了条件1）", () => {
  it("登録できてセッションが張られ、me が自分を返す", async () => {
    const license = await issueLicense();
    const email = uniqueEmail();

    const reg = await api("POST", "/api/auth/register", {
      body: { email, password: "password1234", license_key: license.key },
    });
    expect(reg.status).toBe(201);
    expect(reg.body.ok).toBe(true);
    expect(reg.body.data.user.email).toBe(email);
    expect(reg.cookie).toMatch(/^sid=/);

    const me = await api("GET", "/api/auth/me", { cookie: reg.cookie });
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email);
    expect(me.body.data.accounts).toEqual([]);
    expect(me.body.data.ai).toEqual({ provider: null, model: null, hasKey: false, storeOnServer: true });
    expect(me.body.data.notifications).toEqual({ emailEnabled: true, pushEnabled: false, digestHour: 8 });

    const login = await api("POST", "/api/auth/login", { body: { email, password: "password1234" } });
    expect(login.status).toBe(200);
    const me2 = await api("GET", "/api/auth/me", { cookie: login.cookie });
    expect(me2.body.data.user.id).toBe(reg.body.data.user.id);
  });

  it("Cookie 無しの me は 401", async () => {
    const res = await api("GET", "/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("ログアウトするとセッションが消える", async () => {
    const u = await registerUser();
    const out = await api("POST", "/api/auth/logout", { cookie: u.cookie });
    expect(out.status).toBe(200);
    const me = await api("GET", "/api/auth/me", { cookie: u.cookie });
    expect(me.status).toBe(401);
  });

  it("パスワードは8文字以上", async () => {
    const license = await issueLicense();
    const res = await api("POST", "/api/auth/register", {
      body: { email: uniqueEmail(), password: "short", license_key: license.key },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("WEAK_PASSWORD");
  });

  it("同じメールでは二重登録できない", async () => {
    const u = await registerUser();
    const license = await issueLicense();
    const res = await api("POST", "/api/auth/register", {
      body: { email: u.email, password: "password1234", license_key: license.key },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("パスワードが違えば LOGIN_FAILED", async () => {
    const u = await registerUser();
    const res = await api("POST", "/api/auth/login", { body: { email: u.email, password: "wrongpassword" } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("LOGIN_FAILED");
  });

  it("変更系は X-Requested-With が無いと 403（CSRF）", async () => {
    const res = await api("POST", "/api/auth/login", {
      body: { email: "a@example.com", password: "password1234" },
      xrw: false,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF");
  });
});

describe("ライセンス（SPEC §13 M1 完了条件3 / §5.4）", () => {
  it("使い回しは LICENSE_INVALID", async () => {
    const license = await issueLicense();
    const first = await api("POST", "/api/auth/register", {
      body: { email: uniqueEmail(), password: "password1234", license_key: license.key },
    });
    expect(first.status).toBe(201);

    const second = await api("POST", "/api/auth/register", {
      body: { email: uniqueEmail(), password: "password1234", license_key: license.key },
    });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("LICENSE_INVALID");
  });

  it("存在しないキーも LICENSE_INVALID", async () => {
    const res = await api("POST", "/api/auth/register", {
      body: { email: uniqueEmail(), password: "password1234", license_key: "TAP-ZZZZ-ZZZZ-ZZZZ" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("LICENSE_INVALID");
  });

  it("revoked のライセンスでは登録もログインもできない", async () => {
    const u = await registerUser();
    const db = testDb();
    await db.run(
      "UPDATE licenses SET status='revoked', revoked_at=? WHERE id=?",
      new Date().toISOString(),
      u.licenseId,
    );

    const res = await api("POST", "/api/auth/login", { body: { email: u.email, password: "password1234" } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("LICENSE_REVOKED");

    // 既存セッションも切れている
    const me = await api("GET", "/api/auth/me", { cookie: u.cookie });
    expect(me.status).toBe(401);
  });

  it("revoked のキーは新規登録にも使えない", async () => {
    const license = await issueLicense();
    const db = testDb();
    await db.run("UPDATE licenses SET status='revoked' WHERE id=?", license.id);
    const res = await api("POST", "/api/auth/register", {
      body: { email: uniqueEmail(), password: "password1234", license_key: license.key },
    });
    expect(res.body.error.code).toBe("LICENSE_INVALID");
  });
});

describe("forgot → reset（SPEC §13 M1 完了条件4）", () => {
  it("forgot でメールが届き、reset でパスワードが変わり、旧セッションが全部失効する", async () => {
    const u = await registerUser();

    // 2つ目のセッションを作っておく（全端末ログアウトの確認用）
    const second = await api("POST", "/api/auth/login", {
      body: { email: u.email, password: "password1234" },
    });
    expect(second.status).toBe(200);

    const forgot = await api("POST", "/api/auth/forgot", { body: { email: u.email } });
    expect(forgot.status).toBe(200);
    expect(forgot.body).toEqual({ ok: true, data: { requested: true } });

    const mails = getOutbox().filter((m) => m.to === u.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.template).toBe("password_reset");

    const token = /\/login\?reset=([^\s]+)/.exec(mails[0]!.text)?.[1];
    expect(token).toBeTruthy();

    const reset = await api("POST", "/api/auth/reset", {
      body: { token: decodeURIComponent(token!), password: "newpassword5678" },
    });
    expect(reset.status).toBe(200);
    expect(reset.body.data.reset).toBe(true);

    // 旧セッションは両方とも無効
    expect((await api("GET", "/api/auth/me", { cookie: u.cookie })).status).toBe(401);
    expect((await api("GET", "/api/auth/me", { cookie: second.cookie })).status).toBe(401);

    // 旧パスワードでは入れない
    const old = await api("POST", "/api/auth/login", { body: { email: u.email, password: "password1234" } });
    expect(old.status).toBe(401);

    // 新パスワードで入れる
    const fresh = await api("POST", "/api/auth/login", {
      body: { email: u.email, password: "newpassword5678" },
    });
    expect(fresh.status).toBe(200);
  });

  it("同じトークンは2回使えない", async () => {
    const u = await registerUser();
    await api("POST", "/api/auth/forgot", { body: { email: u.email } });
    const token = decodeURIComponent(
      /\/login\?reset=([^\s]+)/.exec(getOutbox().at(-1)!.text)![1]!,
    );

    expect((await api("POST", "/api/auth/reset", { body: { token, password: "newpassword5678" } })).status).toBe(200);
    const again = await api("POST", "/api/auth/reset", { body: { token, password: "another12345" } });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("RESET_INVALID");
  });

  it("改ざんしたトークンは RESET_INVALID", async () => {
    const u = await registerUser();
    await api("POST", "/api/auth/forgot", { body: { email: u.email } });
    const token = decodeURIComponent(/\/login\?reset=([^\s]+)/.exec(getOutbox().at(-1)!.text)![1]!);
    const broken = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");

    const res = await api("POST", "/api/auth/reset", { body: { token: broken, password: "newpassword5678" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("RESET_INVALID");
  });

  it("期限切れの行は RESET_INVALID（DB 側の期限も見る）", async () => {
    const u = await registerUser();
    await api("POST", "/api/auth/forgot", { body: { email: u.email } });
    const token = decodeURIComponent(/\/login\?reset=([^\s]+)/.exec(getOutbox().at(-1)!.text)![1]!);

    const db = testDb();
    await db.run(
      "UPDATE password_resets SET expires_at=? WHERE user_id=?",
      new Date(Date.now() - 60_000).toISOString(),
      u.userId,
    );
    const res = await api("POST", "/api/auth/reset", { body: { token, password: "newpassword5678" } });
    expect(res.body.error.code).toBe("RESET_INVALID");
  });

  it("存在しないメールでも ok:true を返し、メールは送らない", async () => {
    const res = await api("POST", "/api/auth/forgot", { body: { email: "nobody@example.com" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { requested: true } });
    expect(getOutbox().filter((m) => m.to === "nobody@example.com")).toHaveLength(0);
  });

  it("未使用の他のリセット行も、成功時にまとめて無効化される", async () => {
    const u = await registerUser();
    await api("POST", "/api/auth/forgot", { body: { email: u.email } });
    await api("POST", "/api/auth/forgot", { body: { email: u.email } });
    const mails = getOutbox().filter((m) => m.to === u.email);
    expect(mails).toHaveLength(2);

    const first = decodeURIComponent(/\/login\?reset=([^\s]+)/.exec(mails[0]!.text)![1]!);
    const secondToken = decodeURIComponent(/\/login\?reset=([^\s]+)/.exec(mails[1]!.text)![1]!);

    expect((await api("POST", "/api/auth/reset", { body: { token: secondToken, password: "newpassword5678" } })).status).toBe(200);
    const stale = await api("POST", "/api/auth/reset", { body: { token: first, password: "yetanother123" } });
    expect(stale.body.error.code).toBe("RESET_INVALID");
  });
});

describe("環境", () => {
  it("テスト用の D1 が使える", async () => {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(typeof row?.n).toBe("number");
  });
});
