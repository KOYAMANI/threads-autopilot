import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueueJob, makeJobContext, runJobs } from "../src/lib/jobs";
import { decrypt } from "../src/lib/crypto";
import { resetMock } from "../src/mock/threads";
import { insertAccount, mockToken, registerUser, testDb } from "./helpers";
import { DAY_MS } from "../src/lib/time";

const NOW = new Date("2026-09-06T00:00:00.000Z");

beforeEach(() => {
  resetMock();
});

describe("token_refresh（SPEC §8.6）", () => {
  it("発行24h後かつ前回延長から7日以上なら延長する", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({
      userId: u.userId,
      token: mockToken("tr1"),
      longLived: true,
      tokenObtainedAt: new Date(NOW.getTime() - 30 * DAY_MS).toISOString(),
    });
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "token_refresh", { accountId });
    expect((await runJobs(ctx)).failed).toBe(0);

    const row = await testDb().first<{
      token_obtained_at: string;
      token_last_refresh_at: string | null;
      token_enc: string;
    }>(
      "SELECT token_obtained_at, token_last_refresh_at, token_enc FROM accounts WHERE id=?",
      accountId,
    );
    expect(row?.token_obtained_at).toBe(NOW.toISOString());
    expect(row?.token_last_refresh_at).toBe(NOW.toISOString());
    expect(await decrypt(row!.token_enc, env.ENC_KEY)).toBe(mockToken("tr1"));
  });

  it("発行24時間以内は何もしない", async () => {
    const u = await registerUser();
    const obtained = new Date(NOW.getTime() - 3600_000).toISOString();
    const accountId = await insertAccount({
      userId: u.userId,
      token: mockToken("tr2"),
      longLived: true,
      tokenObtainedAt: obtained,
    });
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "token_refresh", { accountId });
    await runJobs(ctx);
    const row = await testDb().first<{ token_obtained_at: string }>(
      "SELECT token_obtained_at FROM accounts WHERE id=?",
      accountId,
    );
    expect(row?.token_obtained_at).toBe(obtained);
  });

  it("短期トークンには何もしない", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("tr3") });
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "token_refresh", { accountId });
    await runJobs(ctx);
    const row = await testDb().first<{ token_long_lived: number }>(
      "SELECT token_long_lived FROM accounts WHERE id=?",
      accountId,
    );
    expect(row?.token_long_lived).toBe(0);
  });
});

describe("トークン失効（code 190）", () => {
  it("アカウントが needs_reauth になり、ジョブは failed で止まる", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: "THAAdemo_expired" });
    const ctx = makeJobContext(env, { now: NOW });
    const jobId = (await enqueueJob(ctx, "full_sync", { accountId }))!;
    const res = await runJobs(ctx);
    expect(res.failed).toBe(1);

    const db = testDb();
    expect(
      (await db.first<{ status: string }>("SELECT status FROM accounts WHERE id=?", accountId))
        ?.status,
    ).toBe("needs_reauth");
    const job = await db.first<{ status: string; attempts: number; last_error: string }>(
      "SELECT status, attempts, last_error FROM jobs WHERE id=?",
      jobId,
    );
    // 再試行しても直らないので即 failed（バックオフしない）
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(0);
    expect(job?.last_error).toContain("#190");
  });

  it("エラー文言には日本語の理由と原文が両方入る（SPEC §6.2）", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: "THAAdemo_expired" });
    const { api } = await import("./helpers");
    const res = await api("GET", `/api/accounts/${accountId}/diagnose`, { cookie: u.cookie });
    const steps = res.body.data.steps as Array<{ name: string; ok: boolean; detail: string }>;
    const failed = steps.find((s) => s.name === "アカウント情報")!;
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("トークンが期限切れか無効です");
    expect(failed.detail).toContain("#190");
  });
});

describe("cleanup（SPEC §8.7）", () => {
  it("古い ap_log / done ジョブ / 期限切れセッション / rate_events を消す", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("cl1") });
    const db = testDb();
    const old = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();

    await db.run(
      "INSERT INTO ap_log (id, account_id, at, kind, message) VALUES (?,?,?,'plan','old')",
      crypto.randomUUID(),
      accountId,
      old(91),
    );
    await db.run(
      "INSERT INTO ap_log (id, account_id, at, kind, message) VALUES (?,?,?,'plan','new')",
      crypto.randomUUID(),
      accountId,
      old(1),
    );
    await db.run(
      "INSERT INTO jobs (id, type, account_id, state_json, status, priority, next_run_at, attempts, created_at, updated_at) VALUES (?,?,?,'{}','done',5,?,0,?,?)",
      "stale-done-job",
      "followers",
      accountId,
      old(8),
      old(8),
      old(8),
    );
    await db.run(
      "INSERT INTO sessions (id, user_id, expires_at, created_at, ua) VALUES (?,?,?,?,NULL)",
      "expired-session",
      u.userId,
      old(1),
      old(31),
    );
    await db.run("INSERT INTO rate_events (key, at) VALUES ('login:old@example.com', ?)", old(2));
    await db.run("INSERT INTO rate_events (key, at) VALUES ('login:new@example.com', ?)", old(0));

    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "cleanup", { force: true });
    expect((await runJobs(ctx)).failed).toBe(0);

    const apLogs = await db.all<{ message: string }>(
      "SELECT message FROM ap_log WHERE account_id=?",
      accountId,
    );
    expect(apLogs.map((x) => x.message)).toEqual(["new"]);
    expect(await db.first("SELECT id FROM jobs WHERE id='stale-done-job'")).toBeNull();
    expect(await db.first("SELECT id FROM sessions WHERE id='expired-session'")).toBeNull();
    const rates = await db.all<{ key: string }>(
      "SELECT key FROM rate_events WHERE key LIKE 'login:%@example.com'",
    );
    expect(rates.map((r) => r.key)).toEqual(["login:new@example.com"]);
  });

  it("削除された投稿の履歴だけ掃除する（生きている投稿は残す）", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("cl2") });
    const db = testDb();
    const old = new Date(NOW.getTime() - 100 * DAY_MS).toISOString();

    for (const [id, deleted] of [
      ["dead", 1],
      ["alive", 0],
    ] as const) {
      await db.run(
        "INSERT INTO posts (account_id, id, root_id, is_reply, text, posted_at, deleted) VALUES (?,?,?,0,'x',?,?)",
        accountId,
        id,
        id,
        old,
        deleted,
      );
      await db.run(
        "INSERT INTO post_metrics_history (account_id, post_id, checkpoint, at, views) VALUES (?,?,'48h',?,1)",
        accountId,
        id,
        old,
      );
    }

    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "cleanup", { force: true });
    await runJobs(ctx);

    const rows = await db.all<{ post_id: string }>(
      "SELECT post_id FROM post_metrics_history WHERE account_id=?",
      accountId,
    );
    expect(rows.map((r) => r.post_id)).toEqual(["alive"]);
  });
});
