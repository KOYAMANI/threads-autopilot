import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, registerUser, testDb, uniqueEmail } from "./helpers";
import { isLicenseKeyShape } from "../src/lib/crypto";

const admin = { "X-Admin-Secret": env.ADMIN_SECRET! };

describe("管理API（SPEC §5.4）", () => {
  it("管理者のプラン変更後も両管理APIとmeは10件の上限を返す", async () => {
    const user = await registerUser();
    const previous = env.ADMIN_USER_ID;
    env.ADMIN_USER_ID = user.userId;
    try {
      for (const plan of ["academy", "free"] as const) {
        for (const path of ["/api/admin/plans", `/api/admin/users/${user.userId}/plan`]) {
          const result = await api("PUT", path, { headers: admin, body: { email: user.email, plan } });
          expect(result.status).toBe(200);
          expect(result.body.data.accountLimit).toBe(10);
          const me = await api("GET", "/api/auth/me", { cookie: user.cookie });
          expect(me.body.data.entitlement.accountLimit).toBe(10);
        }
      }
    } finally { env.ADMIN_USER_ID = previous; }
  });

  it("登録メールアドレスを指定して講座生プランを付与できる", async () => {
    const user = await registerUser();
    const res = await api("PUT", "/api/admin/plans", {
      body: { email: user.email, plan: "academy" },
      headers: admin,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      email: user.email,
      plan: "academy",
      accountLimit: 3,
      aiAdviceEnabled: true,
      platformAiEnabled: false,
    });
    const me = await api("GET", "/api/auth/me", { cookie: user.cookie });
    expect(me.body.data.entitlement.plan).toBe("academy");
  });

  it("ライセンスを発行して、そのキーで登録できる", async () => {
    const res = await api("POST", "/api/admin/licenses", {
      body: { count: 3, note: "2026-09 販売分" },
      headers: admin,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.keys).toHaveLength(3);
    for (const k of res.body.data.keys) expect(isLicenseKeyShape(k.key)).toBe(true);

    const reg = await api("POST", "/api/auth/register", {
      body: { email: uniqueEmail(), password: "password1234", license_key: res.body.data.keys[0].key },
    });
    expect(reg.status).toBe(201);

    const list = await api("GET", "/api/admin/licenses", { headers: admin });
    expect(list.status).toBe(200);
    expect(list.body.data.licenses).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: res.body.data.keys[0].key, status: "active", note: "2026-09 販売分" }),
      expect.objectContaining({ key: res.body.data.keys[1].key, status: "unused", note: "2026-09 販売分" }),
    ]));
  });

  it("ログイン中の指定管理者が宛名ごとのキーを一括発行できる", async () => {
    const user = await registerUser();
    const previous = env.ADMIN_USER_ID;
    env.ADMIN_USER_ID = user.userId;
    try {
      const res = await api("POST", "/api/admin/licenses", {
        cookie: user.cookie,
        body: { recipients: ["@ゆー", "@じゅん", "@ウエダ"] },
      });
      expect(res.status).toBe(201);
      expect(res.body.data.keys.map((item: { note: string }) => item.note)).toEqual(["@ゆー", "@じゅん", "@ウエダ"]);
      const rows = await testDb().all<{ note: string }>("SELECT note FROM licenses WHERE note LIKE '@%' ORDER BY issued_at, rowid");
      expect(rows.slice(-3).map((row) => row.note)).toEqual(["@ゆー", "@じゅん", "@ウエダ"]);
    } finally {
      env.ADMIN_USER_ID = previous;
    }
  });

  it("一般ユーザーのセッションでは管理APIを使えない", async () => {
    const user = await registerUser();
    const previous = env.ADMIN_USER_ID;
    env.ADMIN_USER_ID = crypto.randomUUID();
    try {
      const res = await api("POST", "/api/admin/licenses", { cookie: user.cookie, body: { recipients: ["@test"] } });
      expect(res.status).toBe(403);
    } finally {
      env.ADMIN_USER_ID = previous;
    }
  });

  it("小文字で入力されたキーでも登録できる", async () => {
    const res = await api("POST", "/api/admin/licenses", { body: { count: 1 }, headers: admin });
    const key = res.body.data.keys[0].key as string;
    const reg = await api("POST", "/api/auth/register", {
      body: { email: uniqueEmail(), password: "password1234", license_key: key.toLowerCase() },
    });
    expect(reg.status).toBe(201);
  });

  it("X-Admin-Secret が無い・違うと 403", async () => {
    expect((await api("POST", "/api/admin/licenses", { body: { count: 1 } })).status).toBe(403);
    expect(
      (await api("POST", "/api/admin/licenses", { body: { count: 1 }, headers: { "X-Admin-Secret": "nope" } }))
        .status,
    ).toBe(403);
  });

  it("count=200 でも 500 にならない（D1 のバインド上限100を跨ぐ）", async () => {
    const res = await api("POST", "/api/admin/licenses", {
      body: { count: 200, note: "bulk" },
      headers: admin,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.keys).toHaveLength(200);

    // 発行されたキーがすべて DB に入っている（1文25行 × 8文の batch）
    const db = testDb();
    const row = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM licenses WHERE note='bulk'",
    );
    expect(row?.n).toBe(200);

    // すべて一意で、最後の1本でも登録できる
    const keys = (res.body.data.keys as Array<{ key: string }>).map((k) => k.key);
    expect(new Set(keys).size).toBe(200);
    const reg = await api("POST", "/api/auth/register", {
      body: { email: uniqueEmail(), password: "password1234", license_key: keys[199] },
    });
    expect(reg.status).toBe(201);
  });

  it("count のバリデーション", async () => {
    expect((await api("POST", "/api/admin/licenses", { body: { count: 0 }, headers: admin })).status).toBe(400);
    expect((await api("POST", "/api/admin/licenses", { body: { count: 999 }, headers: admin })).status).toBe(400);
  });

  it("revoke するとユーザーはログインできなくなり、セッションも切れる", async () => {
    const u = await registerUser();
    const res = await api("POST", `/api/admin/licenses/${u.licenseId}/revoke`, { headers: admin });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("revoked");

    expect((await api("GET", "/api/auth/me", { cookie: u.cookie })).status).toBe(401);
    const login = await api("POST", "/api/auth/login", { body: { email: u.email, password: "password1234" } });
    expect(login.body.error.code).toBe("LICENSE_REVOKED");

    const db = testDb();
    const row = await db.first<{ status: string; revoked_at: string | null }>(
      "SELECT status, revoked_at FROM licenses WHERE id=?",
      u.licenseId,
    );
    expect(row?.status).toBe("revoked");
    expect(row?.revoked_at).toBeTruthy();
  });

  it("存在しないライセンスの revoke は 404", async () => {
    const res = await api("POST", "/api/admin/licenses/nope/revoke", { headers: admin });
    expect(res.status).toBe(404);
  });
});
