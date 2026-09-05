import { describe, expect, it } from "vitest";
import { api, registerUser, testDb, uniqueEmail } from "./helpers";
import {
  actionKey,
  forgotKey,
  loginKey,
  rateAllow,
  rateClear,
  rateCount,
  rateHit,
  rateRecord,
  RATE_LIMITS,
} from "../src/lib/rate";

describe("rate_events（SPEC §13 M1 完了条件7 / §5.1）", () => {
  it("login:<email> は10分に10回まで。11回目で弾き、窓を過ぎれば通る", async () => {
    const db = testDb();
    const key = loginKey(uniqueEmail("rate"));
    const t0 = new Date("2026-09-04T10:00:00.000Z");

    for (let i = 0; i < 10; i++) {
      expect(await rateAllow(db, key, RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMin, t0)).toBe(true);
      await rateRecord(db, key, t0);
    }
    // 11回目は弾かれる
    expect(await rateAllow(db, key, RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMin, t0)).toBe(false);

    // 窓（10分）ちょうどではまだ記録が残っている（at > now-10min の境界）
    const at10 = new Date(t0.getTime() + 10 * 60_000);
    expect(await rateCount(db, key, RATE_LIMITS.login.windowMin, at10)).toBe(0);
    expect(await rateAllow(db, key, RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMin, at10)).toBe(true);

    // 窓の内側（9分後）ではまだ弾かれる
    const at9 = new Date(t0.getTime() + 9 * 60_000);
    expect(await rateAllow(db, key, RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMin, at9)).toBe(false);
  });

  it("キーごとに独立して数える", async () => {
    const db = testDb();
    const a = loginKey("a@example.com");
    const b = loginKey("b@example.com");
    const now = new Date();
    for (let i = 0; i < 10; i++) await rateRecord(db, a, now);
    expect(await rateAllow(db, a, 10, 10, now)).toBe(false);
    expect(await rateAllow(db, b, 10, 10, now)).toBe(true);
  });

  it("メールは小文字化して同じキーになる", () => {
    expect(loginKey("  A@Example.COM ")).toBe("login:a@example.com");
    expect(forgotKey("A@Example.COM")).toBe("forgot:a@example.com");
    expect(actionKey("203.0.113.9")).toBe("action:203.0.113.9");
  });

  it("rateClear で記録が消える", async () => {
    const db = testDb();
    const key = loginKey(uniqueEmail("clear"));
    const now = new Date();
    await rateRecord(db, key, now);
    await rateRecord(db, key, now);
    expect(await rateCount(db, key, 10, now)).toBe(2);
    await rateClear(db, key);
    expect(await rateCount(db, key, 10, now)).toBe(0);
  });

  it("rateHit（全件を数える用途）: forgot は10分に3回まで", async () => {
    const db = testDb();
    const key = forgotKey(uniqueEmail("forgot"));
    const now = new Date();
    expect(await rateHit(db, key, RATE_LIMITS.forgot.limit, RATE_LIMITS.forgot.windowMin, now)).toBe(true);
    expect(await rateHit(db, key, RATE_LIMITS.forgot.limit, RATE_LIMITS.forgot.windowMin, now)).toBe(true);
    expect(await rateHit(db, key, RATE_LIMITS.forgot.limit, RATE_LIMITS.forgot.windowMin, now)).toBe(true);
    expect(await rateHit(db, key, RATE_LIMITS.forgot.limit, RATE_LIMITS.forgot.windowMin, now)).toBe(false);
  });

  it("/a/* 用の制限値は1分に20回", () => {
    expect(RATE_LIMITS.action).toEqual({ limit: 20, windowMin: 1 });
  });
});

describe("ログインAPIの回数制限", () => {
  it("失敗を11回続けると RATE_LIMITED になる", async () => {
    const u = await registerUser();
    for (let i = 0; i < 10; i++) {
      const res = await api("POST", "/api/auth/login", { body: { email: u.email, password: "wrongpassword" } });
      expect(res.body.error.code).toBe("LOGIN_FAILED");
    }
    const blocked = await api("POST", "/api/auth/login", { body: { email: u.email, password: "wrongpassword" } });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");

    // 正しいパスワードでも窓の間は弾かれる
    const stillBlocked = await api("POST", "/api/auth/login", { body: { email: u.email, password: "password1234" } });
    expect(stillBlocked.status).toBe(429);
  });

  it("成功すると失敗の記録が消える", async () => {
    const u = await registerUser();
    const db = testDb();
    for (let i = 0; i < 3; i++) {
      await api("POST", "/api/auth/login", { body: { email: u.email, password: "wrongpassword" } });
    }
    expect(await rateCount(db, loginKey(u.email), 10)).toBe(3);
    await api("POST", "/api/auth/login", { body: { email: u.email, password: "password1234" } });
    expect(await rateCount(db, loginKey(u.email), 10)).toBe(0);
  });

  it("forgot は4回目からメールを送らない（応答は常に ok:true）", async () => {
    const u = await registerUser();
    for (let i = 0; i < 5; i++) {
      const res = await api("POST", "/api/auth/forgot", { body: { email: u.email } });
      expect(res.body).toEqual({ ok: true, data: { requested: true } });
    }
    const db = testDb();
    const rows = await db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM password_resets WHERE user_id=?",
      u.userId,
    );
    expect(rows[0]!.n).toBe(3);
  });
});
