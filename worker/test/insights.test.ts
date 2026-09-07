import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueueJob, makeJobContext, runJobs } from "../src/lib/jobs";
import { crossedCheckpoints } from "../src/jobs/insights";
import { resetMock } from "../src/mock/threads";
import { insertAccount, mockToken, registerUser, testDb } from "./helpers";

const DAY = 86_400_000;
const NOW = new Date("2026-09-06T00:00:00.000Z");

beforeEach(() => {
  resetMock();
});

describe("チェックポイント判定（SPEC §8.4）", () => {
  const posted = Date.parse("2026-08-01T00:00:00.000Z");

  it("48h 未満では何も入らない", () => {
    expect(crossedCheckpoints(posted, posted + 47 * 3600_000, posted + 3600_000)).toEqual([]);
  });

  it("初めて 48h を超えた取得で 48h だけ入る", () => {
    expect(crossedCheckpoints(posted, posted + 49 * 3600_000, posted + 3600_000)).toEqual(["48h"]);
  });

  it("同じ帯で2回目の取得では何も入らない（1回だけ）", () => {
    expect(crossedCheckpoints(posted, posted + 60 * 3600_000, posted + 49 * 3600_000)).toEqual([]);
  });

  it("48h と 7d をまたいで一度に取得したら両方入る", () => {
    expect(crossedCheckpoints(posted, posted + 8 * DAY, posted + 3600_000)).toEqual(["48h", "7d"]);
  });

  it("30日を超えてから初めて取得した投稿は 30d だけ（48h と 7d は後から作らない）", () => {
    expect(crossedCheckpoints(posted, posted + 60 * DAY, null)).toEqual(["30d"]);
  });

  it("初回取得が 48h 直後なら 48h だけ", () => {
    expect(crossedCheckpoints(posted, posted + 50 * 3600_000, null)).toEqual(["48h"]);
  });
});

describe("insights ジョブ（SPEC §8.4）", () => {
  async function seedAccount(suffix: string, postedAt: string) {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "full_sync", { accountId });
    await runJobs(ctx);
    const db = testDb();
    // Initial sync now fetches analytics too. Reset those checkpoints for this isolated time-travel fixture.
    await db.run("DELETE FROM post_metrics_history WHERE account_id=?", accountId);
    // 経過時間を制御するため、投稿日時をそろえて取得済み印を消す
    await db.run(
      "UPDATE posts SET posted_at=?, metrics_fetched_at=NULL, views=0, likes=0 WHERE account_id=?",
      postedAt,
      accountId,
    );
    return accountId;
  }

  it("48h / 7d / 30d の行が、初めて超えた取得時に1行ずつ入る", async () => {
    const postedAt = "2026-09-01T00:00:00.000Z";
    const posted = Date.parse(postedAt);
    const accountId = await seedAccount("ins1", postedAt);
    const db = testDb();

    const run = async (nowMs: number, type: "insights_recent" | "insights_daily") => {
      const ctx = makeJobContext(env, { now: new Date(nowMs) });
      await enqueueJob(ctx, type, { accountId, force: true });
      await runJobs(ctx);
    };
    const historyCount = async (checkpoint?: string) => {
      const row = await db.first<{ n: number }>(
        checkpoint
          ? "SELECT COUNT(*) AS n FROM post_metrics_history WHERE account_id=? AND checkpoint=?"
          : "SELECT COUNT(*) AS n FROM post_metrics_history WHERE account_id=?",
        ...(checkpoint ? [accountId, checkpoint] : [accountId]),
      );
      return row?.n ?? 0;
    };

    // 1時間後: 履歴なし。posts の現在値は更新される
    await run(posted + 3600_000, "insights_recent");
    expect(await historyCount()).toBe(0);
    const first = await db.first<{ views: number; metrics_fetched_at: string | null }>(
      "SELECT views, metrics_fetched_at FROM posts WHERE account_id=? LIMIT 1",
      accountId,
    );
    expect(first?.metrics_fetched_at).toBe(new Date(posted + 3600_000).toISOString());

    // 49時間後: 48h が全投稿ぶん入る
    await run(posted + 49 * 3600_000, "insights_recent");
    expect(await historyCount("48h")).toBe(14);
    expect(await historyCount()).toBe(14);

    // 8日後: 7d が入る（48h は増えない）
    await run(posted + 8 * DAY, "insights_daily");
    expect(await historyCount("48h")).toBe(14);
    expect(await historyCount("7d")).toBe(14);

    // 31日後: 30d が入る
    await run(posted + 31 * DAY, "insights_daily");
    expect(await historyCount("30d")).toBe(14);
    expect(await historyCount()).toBe(14 * 3);

    // もう一度回しても増えない（同じチェックポイントを二度書かない）
    await run(posted + 32 * DAY, "insights_daily");
    expect(await historyCount()).toBe(14 * 3);

    // 1投稿あたり最大3行
    const max = await db.first<{ m: number }>(
      "SELECT MAX(c) AS m FROM (SELECT COUNT(*) AS c FROM post_metrics_history WHERE account_id=? GROUP BY post_id)",
      accountId,
    );
    expect(max?.m).toBe(3);
  });

  it("30日を超えてから初めて取得した投稿は 30d の1行だけ", async () => {
    const postedAt = "2026-07-01T00:00:00.000Z";
    const accountId = await seedAccount("ins2", postedAt);
    const now = Date.parse(postedAt) + 61 * DAY; // insights_old の対象は 60日超
    const ctx = makeJobContext(env, { now: new Date(now) });
    await enqueueJob(ctx, "insights_old", { accountId, force: true });
    await runJobs(ctx);

    const rows = await testDb().all<{ checkpoint: string }>(
      "SELECT DISTINCT checkpoint FROM post_metrics_history WHERE account_id=?",
      accountId,
    );
    expect(rows.map((r) => r.checkpoint)).toEqual(["30d"]);
  });

  it("外部fetch予算が尽きても、次回続きから全投稿を処理する", async () => {
    const postedAt = "2026-09-01T00:00:00.000Z";
    const accountId = await seedAccount("ins3", postedAt);
    const now = new Date(Date.parse(postedAt) + 49 * 3600_000);

    const tight = makeJobContext(env, { now, subrequests: 3 });
    const jobId = (await enqueueJob(tight, "insights_recent", { accountId, force: true }))!;
    const res1 = await runJobs(tight);
    expect(res1.deferred).toBe(1);

    const db = testDb();
    const partial = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM posts WHERE account_id=? AND metrics_fetched_at IS NOT NULL",
      accountId,
    );
    expect(partial?.n).toBe(3);
    const state = await db.first<{ state_json: string }>(
      "SELECT state_json FROM jobs WHERE id=?",
      jobId,
    );
    expect((JSON.parse(state!.state_json).pending as unknown[]).length).toBe(11);

    // 次の実行で残りが片付く
    await runJobs(makeJobContext(env, { now }));
    const all = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM posts WHERE account_id=? AND metrics_fetched_at IS NOT NULL",
      accountId,
    );
    expect(all?.n).toBe(14);
    expect(
      (await db.first<{ status: string }>("SELECT status FROM jobs WHERE id=?", jobId))?.status,
    ).toBe("done");
  });
});
