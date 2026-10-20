import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import * as jobs from "../src/lib/jobs";
import * as health from "../src/lib/scheduler-health";
import { api, insertAccount, registerUser, testDb } from "./helpers";

const MINUTELY = "* * * * *";
const admin = { "X-Admin-Secret": env.ADMIN_SECRET! };
const stage = (): Env => ({ ...env, APP_ENV: "staging", WORKERS_PLAN: "free" });
async function scheduled(bindings: Env, cron = MINUTELY) {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled({ cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
    bindings, { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } as ExecutionContext);
  return Promise.all(pending);
}
beforeEach(async () => {
  // Test storage is shared within this file; isolate only this suite's fixtures.
  await testDb().batch([
    { sql: "DELETE FROM scheduler_health" },
    { sql: "DELETE FROM jobs" },
    { sql: "DELETE FROM cron_sweeps" },
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("Cron arrival and dispatch evidence", () => {
  it("requires the admin secret, including for a signed-in user, and distinguishes never observed", async () => {
    expect((await api("GET", "/api/admin/scheduler-status")).status).toBe(403);
    const u = await registerUser();
    expect((await api("GET", "/api/admin/scheduler-status", { cookie: u.cookie })).status).toBe(403);
    const result = await api("GET", "/api/admin/scheduler-status", { headers: admin });
    expect(result.status).toBe(200);
    expect(result.body.data.triggers).toHaveLength(3);
    expect(result.body.data.triggers.every((t: any) => t.status === "not_observed" && t.stale && !t.lastStartedAt)).toBe(true);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
  });

  it("records staging delivery without enqueuing or dispatching even when account data exists", async () => {
    const u = await registerUser();
    await insertAccount({ userId: u.userId });
    const enqueue = vi.spyOn(jobs, "enqueueForCron");
    const dispatch = vi.spyOn(jobs, "dispatchJobs");
    const run = vi.spyOn(jobs, "runJobs");
    const fetch = vi.spyOn(globalThis, "fetch");
    await scheduled(stage());
    for (const spy of [enqueue, dispatch, run, fetch]) expect(spy).not.toHaveBeenCalled();
    expect(await testDb().first("SELECT COUNT(*) n FROM jobs")).toEqual({ n: 0 });
    expect(await testDb().first("SELECT COUNT(*) n FROM cron_sweeps")).toEqual({ n: 0 });
    const result = await health.readSchedulerStatus(testDb(), stage());
    expect(result.mode).toBe("trigger_monitor_only");
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0]).toMatchObject({ cron: MINUTELY, status: "success", stale: false, lastFailedAt: null });
    expect(result.triggers[0]!.lastStartedAt).toBeTruthy();
    expect(result.triggers[0]!.lastSucceededAt).toBeTruthy();
  });

  it("records actual production dispatch separately from monitor-only delivery", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const bindings = { ...env, APP_ENV: "production", WORKERS_PLAN: "free", JOB_QUEUE: { sendBatch } } as unknown as Env;
    await scheduled(bindings, "0 * * * *");
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(await testDb().first("SELECT COUNT(*) n FROM cron_sweeps")).toEqual({ n: 1 });
    const result = await health.readSchedulerStatus(testDb(), bindings);
    expect(result.mode).toBe("job_dispatch");
    expect(result.triggers.find(t => t.cron === "0 * * * *")?.status).toBe("success");
    expect(result.triggers.find(t => t.cron === MINUTELY)?.status).toBe("not_observed");
  });

  it("rejects the waitUntil promise for platform failure reporting and stores no error body", async () => {
    const sensitive = "provider response includes a token and private post";
    vi.spyOn(jobs, "enqueueForCron").mockRejectedValue(new Error(sensitive));
    await expect(scheduled({ ...env, APP_ENV: "production", WORKERS_PLAN: "free" })).rejects.toThrow("Scheduled task failed");
    const rows = await testDb().all("SELECT * FROM scheduler_health");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ last_status: "error", last_succeeded_at: null });
    expect(rows[0]!.last_failed_at).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain(sensitive);
    const result = await api("GET", "/api/admin/scheduler-status", { headers: admin });
    expect(result.body.data.triggers[0].lastFailedAt).toBeTruthy();
    expect(JSON.stringify(result.body)).not.toContain("latest_run_id");
  });

  it("still rejects when failure telemetry itself cannot be stored", async () => {
    vi.spyOn(jobs, "enqueueForCron").mockRejectedValue(new Error("original failure"));
    vi.spyOn(health, "recordSchedulerFinish").mockRejectedValue(new Error("D1 offline"));
    await expect(scheduled({ ...env, APP_ENV: "production", WORKERS_PLAN: "free" })).rejects.toThrow("Scheduled task failed");
    expect(await testDb().first("SELECT last_status FROM scheduler_health")).toEqual({ last_status: "started" });
  });

  it("records maintenance as paused rather than falsely saying jobs ran", async () => {
    const enqueue = vi.spyOn(jobs, "enqueueForCron");
    await scheduled({ ...env, APP_ENV: "production", MAINTENANCE_MODE: "1" });
    expect(enqueue).not.toHaveBeenCalled();
    expect(await testDb().first("SELECT last_status,last_succeeded_at FROM scheduler_health")).toEqual({ last_status: "paused", last_succeeded_at: null });
  });

  it("preserves last success and failure while preventing an older run from clobbering a newer one", async () => {
    const db = testDb(), now = new Date("2026-09-07T12:00:00Z"), later = new Date(now.getTime()+60_000);
    await health.recordSchedulerStart(db, MINUTELY, "old", now, now);
    await health.recordSchedulerStart(db, MINUTELY, "new", later, later);
    await health.recordSchedulerFinish(db, MINUTELY, "old", "success", new Date(later.getTime()+1_000));
    expect(await db.first("SELECT last_status,last_finished_at FROM scheduler_health")).toEqual({ last_status: "started", last_finished_at: null });
    await health.recordSchedulerFinish(db, MINUTELY, "new", "error", new Date(later.getTime()+2_000));
    const result = await health.readSchedulerStatus(db, stage(), later);
    expect(result.triggers[0]).toMatchObject({ status: "error", lastScheduledAt: later.toISOString() });
    expect(result.triggers[0]!.lastSucceededAt).toBeTruthy();
    expect(result.triggers[0]!.lastFailedAt).toBeTruthy();
    expect((await health.readSchedulerStatus(db, stage(), new Date(later.getTime()+6*60_000))).triggers[0]!.stale).toBe(true);
  });

  it("caps monitor bookkeeping at three DB operations even if a completion write fails", async () => {
    const db = health.createSchedulerHealthDb(stage());
    const now = new Date();
    await health.recordSchedulerStart(db, MINUTELY, "run", now, now);
    await expect(db.run("SELECT missing_monitor_column FROM scheduler_health")).rejects.toThrow();
    await health.recordSchedulerFinish(db, MINUTELY, "run", "error", now);
    expect(db.queryCount).toBe(3);
    await expect(db.run("SELECT 1")).rejects.toThrow("budget exceeded");
  });
});
