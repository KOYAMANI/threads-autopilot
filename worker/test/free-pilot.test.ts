import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createApp } from "../src/app";
import { createJobContext, createSchedulerContext, dispatchJobs, enqueueForCron, enqueueJob, makeJobContext, runJobs } from "../src/lib/jobs";
import { allocateToPosts } from "../src/jobs/clicks";
import { insertAccount, registerUser, testDb } from "./helpers";
import * as threads from "../src/lib/threads";

const NOW = new Date("2026-09-06T00:00:00Z");
const free = (): Env => ({...env, WORKERS_PLAN: "free", MAX_DB_QUERIES: "32", MAX_SUBREQUESTS: "20"});
afterEach(() => vi.restoreAllMocks());

describe("Free pilot: durable progress within D1 invocation limits", () => {
  it("checkpoints a work-budget exhaustion using the bookkeeping reserve", async () => {
    const id = (await enqueueJob(makeJobContext(env, {now: NOW}), "cleanup", {force:true}))!;
    const ctx = createJobContext(free(), NOW);
    const result = await runJobs(ctx, {cleanup: async c => {
      for (let i=0; i<40; i++) await c.db.first("SELECT 1");
    }}, id);
    expect(result.deferred).toBe(1);
    expect(ctx.sys.queryCount + ctx.db.queryCount).toBeLessThanOrEqual(48);
    expect(await testDb().first("SELECT status,attempts FROM jobs WHERE id=?", id)).toEqual({status:"pending",attempts:0});
  });

  it("daily + hourly sweeps for ten users and dispatch fit one cron allowance", async () => {
    await testDb().run("DELETE FROM jobs");
    await testDb().run("DELETE FROM cron_sweeps");
    for (let i=0;i<10;i++) {
      const user = await registerUser();
      await insertAccount({userId:user.userId});
    }
    for (const kind of ["daily","hourly"]) await testDb().run("INSERT INTO cron_sweeps(id,kind,period) VALUES (?,?,?)",kind,kind,NOW.toISOString());
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const ctx = createSchedulerContext({...free(), JOB_QUEUE: {sendBatch} as unknown as Queue<{jobId:string}>}, NOW);
    await enqueueForCron(ctx, "* * * * *");
    await dispatchJobs(ctx);
    expect(ctx.db.queryCount + ctx.sys.queryCount).toBeLessThanOrEqual(48);
    expect(await testDb().first("SELECT COUNT(*) n FROM cron_sweeps WHERE done=0")).toEqual({n:0});
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0]![0]).toHaveLength(2);
    expect(await testDb().first("SELECT COUNT(*) n FROM jobs WHERE type IN ('ap_plan','ap_notify')")).toEqual({n:0});
  });

  it("resumes all pages and preserves metrics and link labels", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({userId:u.userId});
    vi.spyOn(threads, "listThreads").mockImplementation(async (_token, params) => {
      expect(params.limit).toBe(25);
      const offset = Number(params.after ?? 0);
      return {data:Array.from({length:25}, (_,i)=>({id:`free-${i+offset}`, text:`post ${i+offset} https://example.com/free`, timestamp:NOW.toISOString(), media_type:"TEXT_POST" as const})),
        ...(offset===0 ? {paging:{cursors:{after:"25"}}} : {})};
    });
    vi.spyOn(threads, "listReplies").mockResolvedValue({data:[]});
    const id = (await enqueueJob(makeJobContext(env,{now:NOW}), "full_sync", {accountId}))!;
    for (let i=0;i<3;i++) {
      const ctx = createJobContext(free(), NOW);
      const result = await runJobs(ctx, undefined, id);
      expect(result.failed).toBe(0);
      expect(ctx.db.queryCount + ctx.sys.queryCount).toBeLessThanOrEqual(48);
      if (i===0) {
        await testDb().run("UPDATE posts SET views=123 WHERE account_id=? AND id='free-0'",accountId);
        await testDb().run("UPDATE links SET label='My link',enabled_for_ap=0 WHERE account_id=?",accountId);
      }
    }
    expect(await testDb().first("SELECT status FROM jobs WHERE id=?",id)).toEqual({status:"done"});
    expect(await testDb().first("SELECT COUNT(*) n FROM posts WHERE account_id=?",accountId)).toEqual({n:50});
    expect(await testDb().first("SELECT views FROM posts WHERE account_id=? AND id='free-0'",accountId)).toEqual({views:123});
    expect(await testDb().first("SELECT label,enabled_for_ap FROM links WHERE account_id=?",accountId)).toEqual({label:"My link",enabled_for_ap:0});
    expect(await testDb().first("SELECT last_full_sync_at FROM accounts WHERE id=?",accountId)).toEqual({last_full_sync_at:NOW.toISOString()});
  });

  it("allocates clicks to over 40 roots with four queries and keeps other tenants intact", async () => {
    const u = await registerUser();
    const a = await insertAccount({userId:u.userId});
    const b = await insertAccount({userId:u.userId});
    for (let i=0;i<60;i++) for (const accountId of [a,b]) await testDb().run(
      "INSERT INTO posts(account_id,id,root_id,text,posted_at,views,clicks) VALUES (?,?,?,?,?,100,7)",accountId,`click-${i}`,`click-${i}`,"https://example.com/free",NOW.toISOString());
    await testDb().run("INSERT INTO click_weeks(account_id,week_end,url,clicks,fetched_at) VALUES (?,?,?,600,?)",a,"2026-09-06","https://example.com/free",NOW.toISOString());
    const ctx = createJobContext(free(),NOW);
    await allocateToPosts(ctx,a);
    expect(ctx.db.queryCount).toBe(4);
    expect(await testDb().first("SELECT SUM(clicks) c FROM posts WHERE account_id=?",a)).toEqual({c:600});
    expect(await testDb().first("SELECT SUM(clicks) c FROM posts WHERE account_id=?",b)).toEqual({c:420});
  });

  it("deletes three accounts atomically under the free HTTP budget", async () => {
    const u = await registerUser();
    const other = await registerUser();
    for (let i=0;i<3;i++) await insertAccount({userId:u.userId});
    const retained = await insertAccount({userId:other.userId});
    const res = await createApp().fetch(new Request("https://test.local/api/users/me", {
      method:"DELETE",headers:{Cookie:u.cookie,"Content-Type":"application/json","X-Requested-With":"fetch"},body:JSON.stringify({password:"password1234"}),
    }),free());
    expect(res.status, await res.text()).toBe(200);
    expect(await testDb().first("SELECT COUNT(*) n FROM users WHERE id=?",u.userId)).toEqual({n:0});
    expect(await testDb().first("SELECT COUNT(*) n FROM accounts WHERE user_id=?",u.userId)).toEqual({n:0});
    expect(await testDb().first("SELECT id FROM accounts WHERE id=?",retained)).toEqual({id:retained});
  });
});
