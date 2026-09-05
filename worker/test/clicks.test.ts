import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueueJob, makeJobContext, runJobs } from "../src/lib/jobs";
import { HOT_WEEKS, loadUrlTotals } from "../src/jobs/clicks";
import {
  CLICK_FLOOR_MS,
  clickWeeks,
  DAY_MS,
  weekAt,
  weekIndexOf,
  WEEK_MS,
} from "../src/lib/time";
import { resetMock } from "../src/mock/threads";
import { insertAccount, mockToken, registerUser, testDb } from "./helpers";

const NOW = new Date("2026-09-06T00:00:00.000Z");

beforeEach(() => {
  resetMock();
});

describe("クリックの週グリッド（SPEC §8.5）", () => {
  it("起点が固定なので、いつ計算しても同じ週になる", () => {
    const w = weekAt(100);
    expect(w.sinceSec * 1000).toBe(CLICK_FLOOR_MS + 100 * WEEK_MS);
    expect(weekAt(100)).toEqual(w);
    // 週の名前は week_end の UTC 日付
    expect(w.weekEnd).toBe(new Date(CLICK_FLOOR_MS + 101 * WEEK_MS - 1000).toISOString().slice(0, 10));
  });

  it("週は重ならず、隣り合う週の境界が1秒でつながる", () => {
    const a = weekAt(50);
    const b = weekAt(51);
    expect(b.sinceSec - a.untilSec).toBe(1);
  });

  it("同じ時刻はいつも同じ週に入る（二重計上しない）", () => {
    const t = Date.parse("2026-09-03T12:00:00.000Z");
    expect(weekIndexOf(t)).toBe(weekIndexOf(t));
    // 週の中のどの時刻でも同じ index
    const w = weekAt(weekIndexOf(t));
    expect(weekIndexOf(w.sinceSec * 1000)).toBe(w.index);
    expect(weekIndexOf(w.untilSec * 1000)).toBe(w.index);
  });

  it("下限は「いちばん古い投稿の1週間前」", () => {
    const now = Date.parse("2026-09-06T00:00:00.000Z");
    const oldest = Date.parse("2026-08-05T00:00:00.000Z");
    const weeks = clickWeeks(now, oldest);
    expect(weeks[0]!.index).toBe(weekIndexOf(now));
    expect(weeks.at(-1)!.index).toBe(weekIndexOf(oldest - WEEK_MS));
    // 新しい順に1つずつ下がる
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i - 1]!.index - weeks[i]!.index).toBe(1);
    }
  });

  it("投稿が無ければ今週だけ", () => {
    const weeks = clickWeeks(Date.parse("2026-09-06T00:00:00.000Z"), null);
    expect(weeks).toHaveLength(1);
  });
});

describe("clicks ジョブ（SPEC §8.5）", () => {
  async function setup(suffix: string) {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "full_sync", { accountId });
    await enqueueJob(ctx, "insights_recent", { accountId });
    await enqueueJob(ctx, "insights_daily", { accountId });
    await runJobs(ctx);
    return accountId;
  }

  const runClicks = async (accountId: string, now = NOW) => {
    const ctx = makeJobContext(env, { now });
    await enqueueJob(ctx, "clicks", { accountId, force: true });
    const res = await runJobs(ctx);
    expect(res.failed).toBe(0);
  };

  it("2回流しても click_weeks が二重にならず、値も増えない", async () => {
    const accountId = await setup("clk1");
    const db = testDb();

    await runClicks(accountId);
    const first = await db.all<{ week_end: string; url: string; clicks: number }>(
      "SELECT week_end, url, clicks FROM click_weeks WHERE account_id=? ORDER BY week_end, url",
      accountId,
    );
    expect(first.length).toBeGreaterThan(0);

    await runClicks(accountId);
    const second = await db.all<{ week_end: string; url: string; clicks: number }>(
      "SELECT week_end, url, clicks FROM click_weeks WHERE account_id=? ORDER BY week_end, url",
      accountId,
    );
    expect(second).toEqual(first);

    // 主キーが (account_id, week_end, url) なので同じ週×URLの行は1本だけ
    const dup = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM (SELECT week_end, url, COUNT(*) c FROM click_weeks WHERE account_id=? GROUP BY week_end, url HAVING c > 1)",
      accountId,
    );
    expect(dup?.n).toBe(0);
  });

  it("直近2週以外は click_weeks_done に入り、次回は取りに行かない", async () => {
    const accountId = await setup("clk2");
    await runClicks(accountId);
    const db = testDb();
    const doneRows = await db.all<{ week_end: string }>(
      "SELECT week_end FROM click_weeks_done WHERE account_id=? ORDER BY week_end DESC",
      accountId,
    );
    const all = clickWeeks(
      NOW.getTime(),
      Date.parse(
        (await db.first<{ p: string }>("SELECT MIN(posted_at) AS p FROM posts WHERE account_id=?", accountId))!.p,
      ),
    );
    expect(doneRows.length).toBe(Math.max(0, all.length - HOT_WEEKS));
    // 直近2週は確定させない
    for (const hot of all.slice(0, HOT_WEEKS)) {
      expect(doneRows.some((d) => d.week_end === hot.weekEnd)).toBe(false);
    }
  });

  it("前回より小さい値が来ても前回を残す", async () => {
    const accountId = await setup("clk3");
    await runClicks(accountId);
    const db = testDb();
    const target = (await db.first<{ week_end: string; url: string; clicks: number }>(
      "SELECT week_end, url, clicks FROM click_weeks WHERE account_id=? ORDER BY clicks DESC LIMIT 1",
      accountId,
    ))!;
    await db.run(
      "UPDATE click_weeks SET clicks=? WHERE account_id=? AND week_end=? AND url=?",
      target.clicks + 10_000,
      accountId,
      target.week_end,
      target.url,
    );
    await runClicks(accountId);
    const after = await db.first<{ clicks: number }>(
      "SELECT clicks FROM click_weeks WHERE account_id=? AND week_end=? AND url=?",
      accountId,
      target.week_end,
      target.url,
    );
    expect(after?.clicks).toBe(target.clicks + 10_000);
  });

  it("按分は §8.5 のとおり（正規化URLで突合し、root に集約する）", async () => {
    const accountId = await setup("clk4");
    await runClicks(accountId);
    const db = testDb();

    // クリックが付くのは root だけ
    const replyWithClicks = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM posts WHERE account_id=? AND is_reply=1 AND clicks<>0",
      accountId,
    );
    expect(replyWithClicks?.n).toBe(0);

    const assigned = await db.first<{ s: number }>(
      "SELECT SUM(clicks) AS s FROM posts WHERE account_id=?",
      accountId,
    );
    const totals = await loadUrlTotals({ db }, accountId);
    const grand = [...totals.values()].reduce((a, b) => a + b, 0);
    expect(grand).toBeGreaterThan(0);
    // 割り当て＋未割り当て＝総クリック
    expect((assigned?.s ?? 0)).toBeLessThanOrEqual(grand + 1e-6);

    // モックのURLは投稿本文にあるので、全部が未割り当てにはならない
    expect(assigned?.s ?? 0).toBeGreaterThan(0);

    // 正規化前の utm 付きURLでも突合できている
    expect([...totals.keys()]).toContain("https://example.com/sheet");
  });

  it("クリックの取得が予算切れでも、次回続きから終わる", async () => {
    const accountId = await setup("clk5");
    const tight = makeJobContext(env, { now: NOW, subrequests: 2 });
    const jobId = (await enqueueJob(tight, "clicks", { accountId, force: true }))!;
    const res = await runJobs(tight);
    expect(res.deferred).toBe(1);

    await runJobs(makeJobContext(env, { now: NOW }));
    const after = await testDb().first<{ status: string }>(
      "SELECT status FROM jobs WHERE id=?",
      jobId,
    );
    expect(after?.status).toBe("done");
  });
});

describe("daily_views / followers / demographics（SPEC §8.4）", () => {
  it("日別表示回数・フォロワー・属性が入る", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("acc1") });
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "daily_views", { accountId });
    await enqueueJob(ctx, "followers", { accountId });
    await enqueueJob(ctx, "demographics", { accountId });
    const res = await runJobs(ctx);
    expect(res.failed).toBe(0);

    const db = testDb();
    const daily = await db.first<{ n: number; mn: string; mx: string }>(
      "SELECT COUNT(*) AS n, MIN(date) AS mn, MAX(date) AS mx FROM daily_views WHERE account_id=?",
      accountId,
    );
    expect(daily!.n).toBeGreaterThanOrEqual(60);
    expect(Date.parse(daily!.mx)).toBeLessThanOrEqual(NOW.getTime());
    expect(NOW.getTime() - Date.parse(daily!.mn)).toBeLessThanOrEqual(64 * DAY_MS);

    const follower = await db.first<{ date: string; followers: number }>(
      "SELECT date, followers FROM follower_snapshots WHERE account_id=?",
      accountId,
    );
    // アカウントの timezone（Asia/Tokyo）の当日で記録する
    expect(follower?.date).toBe("2026-09-06");
    expect(follower!.followers).toBeGreaterThan(0);

    const demo = await db.first<{ breakdown: string; json: string }>(
      "SELECT breakdown, json FROM demographics WHERE account_id=?",
      accountId,
    );
    expect(demo?.breakdown).toBe("age");
    expect(demo!.json.length).toBeGreaterThan(2);
  });

  it("同じ日に2回流してもフォロワーの行は1本のまま", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("acc2") });
    for (const t of [NOW, new Date(NOW.getTime() + 3600_000)]) {
      const ctx = makeJobContext(env, { now: t });
      await enqueueJob(ctx, "followers", { accountId, force: true });
      await runJobs(ctx);
    }
    const n = await testDb().first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM follower_snapshots WHERE account_id=?",
      accountId,
    );
    expect(n?.n).toBe(1);
  });
});
