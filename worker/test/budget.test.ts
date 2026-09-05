import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BudgetExceeded, budgetFromEnv, createBudget, isBudgetExceeded } from "../src/lib/budget";
import { buildUpsertChunks, createDb } from "../src/lib/db";

describe("budget（SPEC §13 M1 完了条件5 / §6.1）", () => {
  it("D1 クエリ 800 を超えると BudgetExceeded", () => {
    const b = createBudget({ dbQueries: 800 });
    for (let i = 0; i < 800; i++) b.dbQueries.use();
    expect(b.dbQueries.used).toBe(800);
    expect(() => b.dbQueries.use()).toThrow(BudgetExceeded);
  });

  it("env の MAX_DB_QUERIES=800 がそのまま上限になる", async () => {
    const b = budgetFromEnv(env);
    expect(b.dbQueries.limit).toBe(800);
    expect(b.subrequests.limit).toBe(300);
    expect(b.timeMs.limit).toBe(20000);

    const db = createDb(env.DB, b);
    // db.ts が全クエリで dbQueries.use() を呼んでいることの確認
    await db.first("SELECT 1 AS one");
    expect(b.dbQueries.used).toBe(1);
    expect(db.queryCount).toBe(1);
  });

  it("実際の D1 呼び出しでも 800 を超えたところで投げる", async () => {
    const b = createBudget({ dbQueries: 3 });
    const db = createDb(env.DB, b);
    await db.first("SELECT 1 AS one");
    await db.first("SELECT 1 AS one");
    await db.first("SELECT 1 AS one");
    await expect(db.first("SELECT 1 AS one")).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it("外部fetch回数も同じ BudgetExceeded になる", () => {
    const b = createBudget({ subrequests: 2 });
    b.subrequests.use();
    b.subrequests.use();
    try {
      b.subrequests.use();
      expect.unreachable();
    } catch (e) {
      expect(isBudgetExceeded(e)).toBe(true);
      expect((e as BudgetExceeded).kind).toBe("subrequests");
    }
  });

  it("時間予算も同じ BudgetExceeded になる", () => {
    let t = 1000;
    const b = createBudget({ timeMs: 20000, now: () => t });
    b.timeMs.check();
    t += 19999;
    b.timeMs.check();
    t += 2;
    expect(() => b.timeMs.check()).toThrow(BudgetExceeded);
    try {
      b.timeMs.check();
    } catch (e) {
      expect((e as BudgetExceeded).kind).toBe("timeMs");
    }
  });

  it("まとめて使う（use(n)）でも上限で投げる", () => {
    const b = createBudget({ dbQueries: 10 });
    b.dbQueries.use(10);
    expect(b.dbQueries.remaining).toBe(0);
    expect(() => b.dbQueries.use(1)).toThrow(BudgetExceeded);
  });

  it("batch は文の本数ぶんクエリを数える", async () => {
    const b = createBudget({ dbQueries: 100 });
    const db = createDb(env.DB, b);
    await db.batch([
      { sql: "SELECT 1" },
      { sql: "SELECT 2" },
      { sql: "SELECT 3" },
    ]);
    expect(b.dbQueries.used).toBe(3);
  });
});

describe("buildUpsertChunks（SPEC §8.1 のクエリ圧縮）", () => {
  it("50行ごとに1クエリにまとめる", () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`a${i}`, i]);
    const chunks = buildUpsertChunks("daily_views", ["date", "views"], rows, ["date"], ["views"]);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.params).toHaveLength(100);
    expect(chunks[2]!.params).toHaveLength(40);
    expect(chunks[0]!.sql).toContain("ON CONFLICT(date) DO UPDATE SET views=excluded.views");
  });

  it("更新列が無ければ DO NOTHING", () => {
    const chunks = buildUpsertChunks("t", ["a"], [["x"]], ["a"], []);
    expect(chunks[0]!.sql).toContain("DO NOTHING");
  });
});
