import { describe, expect, it } from "vitest";
import { api, insertAccount, registerUser, testDb } from "./helpers";

describe("アカウント別の承認待ち件数", () => {
  it("GET /auth/me と GET /accounts が投稿先ごとの件数を返す", async () => {
    const user = await registerUser();
    const first = await insertAccount({ userId: user.userId, threadsUserId: "178100000000001" });
    const second = await insertAccount({ userId: user.userId, threadsUserId: "178100000000002" });
    const now = new Date().toISOString();
    await testDb().batch([
      { sql: "INSERT INTO queue(id,account_id,status,body,created_at,updated_at) VALUES (?,?,'pending_approval','a',?,?)", params: [crypto.randomUUID(), first, now, now] },
      { sql: "INSERT INTO queue(id,account_id,status,body,created_at,updated_at) VALUES (?,?,'pending_approval','b',?,?)", params: [crypto.randomUUID(), second, now, now] },
      { sql: "INSERT INTO queue(id,account_id,status,body,created_at,updated_at) VALUES (?,?,'pending_approval','c',?,?)", params: [crypto.randomUUID(), second, now, now] },
      { sql: "INSERT INTO queue(id,account_id,status,body,created_at,updated_at) VALUES (?,?,'draft','d',?,?)", params: [crypto.randomUUID(), second, now, now] },
    ]);

    for (const path of ["/api/auth/me", "/api/accounts"]) {
      const response = await api("GET", path, { cookie: user.cookie });
      const accounts = response.body.data.accounts as Array<{ id: string; pendingApprovalCount: number }>;
      expect(accounts.find(account => account.id === first)?.pendingApprovalCount).toBe(1);
      expect(accounts.find(account => account.id === second)?.pendingApprovalCount).toBe(2);
    }
  });
});
