import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  enqueueForCron,
  enqueueJob,
  makeJobContext,
  runJobs,
  STALE_RUNNING_MIN,
  type JobHandler,
} from "../src/lib/jobs";
import { BudgetExceeded, createBudget } from "../src/lib/budget";
import { createDb } from "../src/lib/db";
import { insertAccount, registerUser, testDb } from "./helpers";
import { resetMock } from "../src/mock/threads";

const NOW = new Date("2026-09-06T00:00:00.000Z");

beforeEach(async () => {
  await testDb().run("DELETE FROM jobs");
  await testDb().run("DELETE FROM cron_sweeps");
  resetMock();
});

async function countAllJobs(): Promise<number> {
  const row = await testDb().first<{ n: number }>("SELECT COUNT(*) AS n FROM jobs");
  return row?.n ?? 0;
}

async function jobRow(id: string) {
  return testDb().first<{
    status: string;
    attempts: number;
    state_json: string;
    next_run_at: string;
    last_error: string | null;
  }>("SELECT status, attempts, state_json, next_run_at, last_error FROM jobs WHERE id=?", id);
}

describe("ジョブ基盤（SPEC §8.1）", () => {
  it("同じ type+account_id の pending は重複投入しない", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId });
    const ctx = makeJobContext(env, { now: NOW });

    const first = await enqueueJob(ctx, "full_sync", { accountId });
    const second = await enqueueJob(ctx, "full_sync", { accountId });
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    // force を付ければ入る
    expect(await enqueueJob(ctx, "full_sync", { accountId, force: true })).not.toBeNull();
  });

  it("優先度の小さいものから処理する", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId });
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "cleanup", { accountId, force: true }); // priority 9
    await enqueueJob(ctx, "insights_recent", { accountId, force: true }); // priority 3

    const order: string[] = [];
    const spy: JobHandler = async (_c, job) => {
      order.push(job.type);
    };
    await runJobs(ctx, { cleanup: spy, insights_recent: spy });
    expect(order).toEqual(["insights_recent", "cleanup"]);
  });

  it("予算切れ（BudgetExceeded）は state_json を保存して pending に戻す", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId });
    const ctx = makeJobContext(env, { now: NOW });
    const id = (await enqueueJob(ctx, "full_sync", { accountId }))!;

    const handler: JobHandler = async (_c, job) => {
      job.state.progress = 3;
      throw new BudgetExceeded("subrequests", 301, 300);
    };
    const res = await runJobs(ctx, { full_sync: handler });
    expect(res.deferred).toBe(1);
    expect(res.exhausted).toBe(true);

    const row = await jobRow(id);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0); // 予算切れは失敗ではない
    expect(JSON.parse(row!.state_json)).toEqual({ progress: 3 });
    expect(row?.next_run_at).toBe(NOW.toISOString());
  });

  it("失敗は指数バックオフで5回まで、以後 failed", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId });
    const id = (await enqueueJob(makeJobContext(env, { now: NOW }), "clicks", { accountId }))!;

    const boom: JobHandler = async () => {
      throw new Error("boom");
    };

    let now = NOW;
    for (let i = 1; i <= 5; i++) {
      const ctx = makeJobContext(env, { now });
      await runJobs(ctx, { clicks: boom });
      const row = await jobRow(id);
      if (i < 5) {
        expect(row?.status).toBe("pending");
        expect(row?.attempts).toBe(i);
        now = new Date(Date.parse(row!.next_run_at));
      } else {
        expect(row?.status).toBe("failed");
        expect(row?.last_error).toContain("boom");
      }
    }
  });

  it("running のまま10分以上経ったジョブは pending に戻る", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId });
    const db = testDb();
    const id = crypto.randomUUID();
    const stale = new Date(NOW.getTime() - (STALE_RUNNING_MIN + 1) * 60_000).toISOString();
    await db.run(
      "INSERT INTO jobs (id, type, account_id, state_json, status, priority, next_run_at, attempts, created_at, updated_at) VALUES (?,?,?,'{}','running',5,?,0,?,?)",
      id,
      "followers",
      accountId,
      NOW.toISOString(),
      stale,
      stale,
    );

    let ran = false;
    await runJobs(makeJobContext(env, { now: NOW }), {
      followers: async () => {
        ran = true;
      },
    });
    expect(ran).toBe(true);
    expect((await jobRow(id))?.status).toBe("done");
  });

  it("未実装のジョブ（publish は M4）はキューを詰まらせない", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId });
    const ctx = makeJobContext(env, { now: NOW });
    const id = (await enqueueJob(ctx, "publish", { accountId }))!;
    await runJobs(ctx, {});
    expect((await jobRow(id))?.status).toBe("done");
  });
});

/* ── 台帳（jobs テーブル）側の予算切れ（M6 で踏んだ回帰） ── */

describe("台帳の予算が尽きたとき（SPEC §8.1）", () => {
  it("すでに終えたジョブの結果を巻き添えにせず、打ち切って次回に回す", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId });
    const ctx = makeJobContext(env, { now: NOW });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await enqueueJob(ctx, "cleanup", { accountId, force: true });
      ids.push(id!);
    }

    // 台帳の予算を絞る。runJobs は1本あたり3クエリ（拾う・押さえる・畳む）使うので、
    // 8クエリ = stale の巻き戻し1 + 2本ぶん(6) + 3本目の SELECT で尽きる
    const tight = makeJobContext(env, { now: NOW });
    tight.sys = createDb(env.DB, createBudget({ dbQueries: 8, subrequests: 0, timeMs: 1e9 }));

    const noop: JobHandler = async () => {};
    const res = await runJobs(tight, { cleanup: noop });

    expect(res.exhausted).toBe(true);
    expect(res.done).toBeGreaterThan(0); // 終えたぶんは done のまま残る
    const done = await testDb().first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE account_id=? AND status='done'",
      accountId,
    );
    expect(done!.n).toBe(res.done);
    // 残りは pending のまま。次の5分で続きから
    const pending = await testDb().first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE account_id=? AND status IN ('pending','running')",
      accountId,
    );
    expect(pending!.n).toBe(ids.length - res.done);
  });

  it("cron の投入が予算切れになっても投げず、積めたぶんは残る", async () => {
    const u = await registerUser();
    await insertAccount({ userId: u.userId });
    const before = await countAllJobs();

    // 毎時は1アカウントあたり3本（insights_recent / ap_plan / ap_notify）。1本の投入に
    // 2クエリ（重複確認＋INSERT）使うので、アカウント一覧の1クエリと合わせて途中で尽きる。
    // どのアカウントに当たるかはテストの実行順で変わるので、件数は全体で見る
    const ctx = makeJobContext(env, { now: NOW });
    ctx.sys = createDb(env.DB, createBudget({ dbQueries: 3, subrequests: 0, timeMs: 1e9 }));

    await expect(enqueueForCron(ctx, "0 * * * *")).resolves.toBeUndefined(); // 投げない
    const after = await countAllJobs();
    expect(after).toBe(before); // ページとカーソルは同一バッチなので部分登録しない
    await enqueueForCron(makeJobContext(env, { now: NOW }), "* * * * *");
    expect(await countAllJobs()).toBeGreaterThan(before); // 次回は未完了の周期から再開
  });
});

describe("cron の投入（SPEC §8.2）", () => {
  it("5分の cron は何も投入しない", async () => {
    const u = await registerUser();
    await insertAccount({ userId: u.userId });
    const ctx = makeJobContext(env, { now: NOW });
    const before = await countJobs();
    await enqueueForCron(ctx, "*/5 * * * *");
    expect(await countJobs()).toBe(before);
  });

  it("毎時は insights_recent と ap_plan / ap_notify（SPEC §8.2）", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId });
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueForCron(ctx, "0 * * * *");
    const types = await jobTypes(accountId);
    expect(types).toEqual(["ap_notify", "ap_plan", "insights_recent"]);
  });

  it("日次（平日）は週1ジョブを含まない", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId });
    // 2026-09-09 は水曜（UTC）
    const ctx = makeJobContext(env, { now: new Date("2026-09-09T18:00:00.000Z") });
    await enqueueForCron(ctx, "0 18 * * *");
    const types = await jobTypes(accountId);
    expect(types).toEqual([
      "ap_score",
      "clicks",
      "daily_views",
      "followers",
      "full_sync",
      "insights_daily",
    ]);
    // cleanup はアカウントに紐づかない1本（他のテストが入れた account 付きのものは数えない）
    expect(await countJobs("type='cleanup' AND account_id IS NULL")).toBe(1);
  });

  it("日次（UTC日曜）は insights_old / demographics / token_refresh も入る", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId });
    // 2026-09-06 は日曜（UTC）
    const ctx = makeJobContext(env, { now: new Date("2026-09-06T18:00:00.000Z") });
    await enqueueForCron(ctx, "0 18 * * *");
    const types = await jobTypes(accountId);
    expect(types).toContain("insights_old");
    expect(types).toContain("demographics");
    expect(types).toContain("token_refresh");
  });

  it("needs_reauth のアカウントには投入しない", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, status: "needs_reauth" });
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueForCron(ctx, "0 * * * *");
    expect(await jobTypes(accountId)).toEqual([]);
  });
});

async function countJobs(where = "1=1"): Promise<number> {
  const row = await testDb().first<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE ${where}`);
  return row?.n ?? 0;
}

async function jobTypes(accountId: string): Promise<string[]> {
  const rows = await testDb().all<{ type: string }>(
    "SELECT DISTINCT type FROM jobs WHERE account_id=? ORDER BY type",
    accountId,
  );
  return rows.map((r) => r.type);
}
