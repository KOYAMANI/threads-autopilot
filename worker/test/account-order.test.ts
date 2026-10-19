import { describe, expect, it } from "vitest";
import { api, insertAccount, registerUser } from "./helpers";

const ids = (body: { data: { accounts: Array<{ id: string }> } }) => body.data.accounts.map((a) => a.id);

describe("PUT /api/accounts/order（ドロワーの並べ替え）", () => {
  it("並べた順が GET /accounts と /auth/me の両方に出る", async () => {
    const u = await registerUser();
    const a = await insertAccount({ userId: u.userId, createdAt: "2026-09-01T00:00:00.000Z" });
    const b = await insertAccount({ userId: u.userId, createdAt: "2026-09-02T00:00:00.000Z" });
    const c = await insertAccount({ userId: u.userId, createdAt: "2026-09-03T00:00:00.000Z" });

    // 並べ替える前は接続した順
    expect(ids((await api("GET", "/api/accounts", { cookie: u.cookie })).body)).toEqual([a, b, c]);

    const res = await api("PUT", "/api/accounts/order", { cookie: u.cookie, body: { ids: [c, a, b] } });
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([c, a, b]);
    expect(ids((await api("GET", "/api/accounts", { cookie: u.cookie })).body)).toEqual([c, a, b]);
    expect(ids((await api("GET", "/api/auth/me", { cookie: u.cookie })).body)).toEqual([c, a, b]);
  });

  it("接続の上限（3件）より多くつないでいても並べ替えられる", async () => {
    const u = await registerUser();
    const six: string[] = [];
    for (let i = 0; i < 6; i++) {
      six.push(await insertAccount({ userId: u.userId, createdAt: `2026-09-0${i + 1}T00:00:00.000Z` }));
    }
    const reversed = [...six].reverse();
    const res = await api("PUT", "/api/accounts/order", { cookie: u.cookie, body: { ids: reversed } });
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(reversed);
  });

  it("並べ替えたあとに増えたアカウントは最後に付く", async () => {
    const u = await registerUser();
    const a = await insertAccount({ userId: u.userId, createdAt: "2026-09-01T00:00:00.000Z" });
    const b = await insertAccount({ userId: u.userId, createdAt: "2026-09-02T00:00:00.000Z" });
    await api("PUT", "/api/accounts/order", { cookie: u.cookie, body: { ids: [b, a] } });
    const c = await insertAccount({ userId: u.userId, createdAt: "2026-09-03T00:00:00.000Z" });
    expect(ids((await api("GET", "/api/accounts", { cookie: u.cookie })).body)).toEqual([b, a, c]);
  });

  it("足りない・重複・他人の ID を含む並びは 409 で、順番は変わらない", async () => {
    const u = await registerUser();
    const other = await registerUser();
    const a = await insertAccount({ userId: u.userId, createdAt: "2026-09-01T00:00:00.000Z" });
    const b = await insertAccount({ userId: u.userId, createdAt: "2026-09-02T00:00:00.000Z" });
    const foreign = await insertAccount({ userId: other.userId });

    for (const bad of [[b], [b, b], [b, foreign], [b, a, foreign]]) {
      const res = await api("PUT", "/api/accounts/order", { cookie: u.cookie, body: { ids: bad } });
      expect(res.status).toBe(409);
    }
    expect(ids((await api("GET", "/api/accounts", { cookie: u.cookie })).body)).toEqual([a, b]);
    // 他人の並びも動いていない
    expect(ids((await api("GET", "/api/accounts", { cookie: other.cookie })).body)).toEqual([foreign]);
  });

  it("形が違う入力は 400、ログインしていなければ 401", async () => {
    const u = await registerUser();
    expect((await api("PUT", "/api/accounts/order", { cookie: u.cookie, body: { ids: [] } })).status).toBe(400);
    expect((await api("PUT", "/api/accounts/order", { cookie: u.cookie, body: {} })).status).toBe(400);
    expect((await api("PUT", "/api/accounts/order", { body: { ids: ["x"] } })).status).toBe(401);
  });
});
