import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BudgetExceeded, budgetFromEnv, createBudget, isBudgetExceeded } from "../src/lib/budget";
import { buildUpsertChunks, createDb, maxRowsPerStatement } from "../src/lib/db";

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
  it("2列なら50行ごと（バインド100の内側）", () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`a${i}`, i]);
    const chunks = buildUpsertChunks("daily_views", ["date", "views"], rows, ["date"], ["views"]);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.params).toHaveLength(100);
    expect(chunks[2]!.params).toHaveLength(40);
    expect(chunks[0]!.sql).toContain("ON CONFLICT(date) DO UPDATE SET views=excluded.views");
  });

  it("列数からバインド上限100に収まる行数を決める", () => {
    expect(maxRowsPerStatement(2)).toBe(50);
    expect(maxRowsPerStatement(3)).toBe(33);
    expect(maxRowsPerStatement(5)).toBe(20);
    expect(maxRowsPerStatement(21)).toBe(4);
    expect(maxRowsPerStatement(200)).toBe(1);

    // どのチャンクもバインド変数が100を超えない
    for (const cols of [2, 3, 5, 9, 21]) {
      const columns = Array.from({ length: cols }, (_, i) => `c${i}`);
      const rows = Array.from({ length: 137 }, () => columns.map(() => 1));
      const chunks = buildUpsertChunks("t", columns, rows, ["c0"], ["c1"]);
      for (const chunk of chunks) expect(chunk.params.length).toBeLessThanOrEqual(100);
      expect(chunks.reduce((n, c) => n + c.params.length, 0)).toBe(137 * cols);
    }
  });

  it("大きすぎる chunkSize を渡しても上限で切り詰める", () => {
    const columns = ["a", "b", "c", "d", "e"];
    const rows = Array.from({ length: 60 }, () => [1, 2, 3, 4, 5]);
    const chunks = buildUpsertChunks("t", columns, rows, ["a"], ["b"], 50);
    for (const chunk of chunks) expect(chunk.params.length).toBeLessThanOrEqual(100);
  });

  it("更新列が無ければ DO NOTHING", () => {
    const chunks = buildUpsertChunks("t", ["a"], [["x"]], ["a"], []);
    expect(chunks[0]!.sql).toContain("DO NOTHING");
  });

  it("組み立てた SQL が実際の D1 で通る（3列 = 33行/文）", async () => {
    const b = createBudget({ dbQueries: 100 });
    const db = createDb(env.DB, b);
    const accountId = `chunk-${crypto.randomUUID()}`;

    // post_metrics_history は5列 → 20行/文
    const columns = ["account_id", "post_id", "checkpoint", "at", "views"];
    const rows = Array.from({ length: 45 }, (_, i) => [
      accountId,
      `p${i}`,
      "48h",
      "2026-09-04T00:00:00.000Z",
      i,
    ]);
    const chunks = buildUpsertChunks(
      "post_metrics_history",
      columns,
      rows,
      ["account_id", "post_id", "checkpoint"],
      ["views"],
    );
    expect(chunks).toHaveLength(3); // 20 + 20 + 5
    await db.batch(chunks);

    const count = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM post_metrics_history WHERE account_id=?",
      accountId,
    );
    expect(count?.n).toBe(45);

    // 同じ主キーで再実行すると UPDATE 側に入る（行は増えない）
    const again = buildUpsertChunks(
      "post_metrics_history",
      columns,
      rows.map((r) => [...r.slice(0, 4), 999]),
      ["account_id", "post_id", "checkpoint"],
      ["views"],
    );
    await db.batch(again);
    const after = await db.first<{ n: number; v: number }>(
      "SELECT COUNT(*) AS n, MAX(views) AS v FROM post_metrics_history WHERE account_id=?",
      accountId,
    );
    expect(after?.n).toBe(45);
    expect(after?.v).toBe(999);
  });

  it("3列でも daily_views に実際に流せる", async () => {
    const b = createBudget({ dbQueries: 100 });
    const db = createDb(env.DB, b);
    const accountId = `chunk3-${crypto.randomUUID()}`;
    const rows = Array.from({ length: 70 }, (_, i) => [
      accountId,
      `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      i,
    ]);
    // 日付が重複するので upsert される。列数3 → 33行/文
    const chunks = buildUpsertChunks(
      "daily_views",
      ["account_id", "date", "views"],
      rows,
      ["account_id", "date"],
      ["views"],
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.params).toHaveLength(99);
    await db.batch(chunks);
    const count = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM daily_views WHERE account_id=?",
      accountId,
    );
    expect(count?.n).toBe(28);
  });
});
