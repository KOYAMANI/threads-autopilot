import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, registerUser, testDb, uniqueEmail } from "./helpers";
import { isLicenseKeyShape } from "../src/lib/crypto";

const admin = { "X-Admin-Secret": env.ADMIN_SECRET! };

describe("管理API（SPEC §5.4）", () => {
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

  it("バインド上限の境界（25 / 26 件）", async () => {
    for (const count of [25, 26]) {
      const res = await api("POST", "/api/admin/licenses", { body: { count }, headers: admin });
      expect(res.status).toBe(201);
      expect(res.body.data.keys).toHaveLength(count);
    }
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
