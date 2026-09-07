import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, insertAccount, mockToken, registerUser, testDb } from './helpers';
import { createApp } from '../src/app';
import * as jobs from '../src/lib/jobs';
import * as threads from '../src/lib/threads';
import worker from '../src/index';
import type { Env } from '../src/env';

afterEach(()=>vi.restoreAllMocks());
const queue = () => ({sendBatch:vi.fn().mockResolvedValue(undefined),send:vi.fn().mockResolvedValue(undefined)});
describe('initial analytics ingestion',()=>{
  it('immediately dispatches this account’s complete initial data jobs within the free budget',async()=>{
    const u=await registerUser(); const q=queue();
    const configured={...env,WORKERS_PLAN:'free',MAX_DB_QUERIES:'32',MAX_SUBREQUESTS:'20',JOB_QUEUE:q} as unknown as Env;
    const result=await createApp().fetch(new Request('https://test.local/api/accounts',{method:'POST',headers:{Cookie:u.cookie,'X-Requested-With':'fetch','Content-Type':'application/json'},body:JSON.stringify({token:mockToken('bootstrap')})}),configured);
    expect(result.status).toBe(201);
    expect(q.sendBatch).toHaveBeenCalledTimes(1);
    const {data}=await result.json() as any;
    const rows=await testDb().all<{id:string,type:string}>('SELECT id,type FROM jobs WHERE account_id=?',data.account.id);
    expect(rows.map(r=>r.type).sort()).toEqual(['clicks','daily_views','followers','full_sync']);
    expect(q.sendBatch.mock.calls[0]![0].map((m:any)=>m.body.jobId).sort()).toEqual(rows.map(r=>r.id).sort());
  });
  it('keeps a recoverable outbox if the queue send fails',async()=>{
    const u=await registerUser();const accountId=await insertAccount({userId:u.userId});const q=queue();q.sendBatch.mockRejectedValue(new Error('queue down'));
    const configured={...env,WORKERS_PLAN:'free',JOB_QUEUE:q} as unknown as Env;
    const ctx=jobs.createJobContext(configured);
    await jobs.enqueueAccountSync(ctx,accountId);
    expect(ctx.db.queryCount+ctx.sys.queryCount).toBeLessThanOrEqual(48);
    const rows=await testDb().all<{status:string;dispatched_until:null}>('SELECT status,dispatched_until FROM jobs WHERE account_id=?',accountId);
    expect(rows).toHaveLength(4);expect(rows.every(r=>r.status==='pending' && r.dispatched_until===null)).toBe(true);
  });
  it('a failed import cannot report 100 percent or success',async()=>{
    const u=await registerUser();const accountId=await insertAccount({userId:u.userId});
    await jobs.enqueueJob(jobs.makeJobContext(env),'full_sync',{accountId});
    await testDb().run("UPDATE jobs SET status='failed',state_json='{\"pages\":2}' WHERE account_id=?",accountId);
    const status=await api('GET',`/api/accounts/${accountId}/sync`,{cookie:u.cookie});
    expect(status.body.data).toMatchObject({running:false,status:'failed',progress:2,posts:0});expect(status.body.data.message).toBeTruthy();
  });
  it('initial sync populates account analytics and schedules post insights before the next cron',async()=>{
    const u=await registerUser();const accountId=await insertAccount({userId:u.userId});
    const ctx=jobs.makeJobContext(env);
    await jobs.enqueueAccountSync(ctx,accountId);await jobs.runJobs(ctx);
    const status=await api('GET',`/api/accounts/${accountId}/sync`,{cookie:u.cookie});
    expect(status.body.data.status).toBe('done');expect(status.body.data.posts).toBeGreaterThan(0);
    const result=await api('GET',`/api/accounts/${accountId}/dashboard?period=30`,{cookie:u.cookie});
    expect(result.body.data.followers.current).toBeGreaterThan(0);
    expect(result.body.data.views.series.length).toBeGreaterThan(0);
    expect(result.body.data.posts.some((p:any)=>p.views>0)).toBe(true);
    const profile=await testDb().first<{username:string}>('SELECT username FROM accounts WHERE id=?',accountId);
    expect(profile?.username).not.toBe('demo_test');
  });
  it('does not invent a 60-day expiry when refreshing an otherwise valid token is rejected',async()=>{
    const u=await registerUser();vi.spyOn(threads,'refreshLongLivedToken').mockRejectedValue(new Error('not yet refreshable'));
    const response=await api('POST','/api/accounts',{cookie:u.cookie,body:{token:mockToken('short')}});
    expect(response.status).toBe(201);expect(response.body.data.longLived).toBe(false);expect(response.body.data.account.tokenExpiresInDays).toBeNull();
  });
  it('budget continuation uses fresh queue messages instead of exhausting the failure retry limit',async()=>{
    vi.spyOn(jobs,'runJobs').mockResolvedValue({processed:1,done:0,deferred:1,failed:0,exhausted:true});
    const q=queue(),ack=vi.fn(),retry=vi.fn();
    for(let i=0;i<6;i++) await worker.queue({messages:[{body:{jobId:'same-import'},ack,retry}]} as unknown as MessageBatch<{jobId:string}>,{...env,WORKERS_PLAN:'free',JOB_QUEUE:q} as unknown as Env);
    expect(q.send).toHaveBeenCalledTimes(6);expect(ack).toHaveBeenCalledTimes(6);expect(retry).not.toHaveBeenCalled();
  });
});

it('backfills more than 50 initial posts across free-plan invocations without touching older or other-account data',async()=>{
 const u=await registerUser();const accountId=await insertAccount({userId:u.userId});const other=await insertAccount({userId:u.userId});const now=new Date();
 for(let i=0;i<61;i++) await testDb().run("INSERT INTO posts(account_id,id,root_id,text,posted_at) VALUES (?,?,?,?,?)",accountId,`batch-${i}`,`batch-${i}`,'test',new Date(now.getTime()-10*86400000).toISOString());
 for(const [account,id,age] of [[accountId,'old',100],[other,'other',10]] as const) await testDb().run("INSERT INTO posts(account_id,id,root_id,text,posted_at) VALUES (?,?,?,?,?)",account,id,id,'test',new Date(now.getTime()-age*86400000).toISOString());
 vi.spyOn(threads,'getPostInsights').mockImplementation(async (_token,_id,options)=>{options.budget.subrequests.use();return {views:100,likes:3};});
 const configured={...env,WORKERS_PLAN:'free',MAX_DB_QUERIES:'32',MAX_SUBREQUESTS:'20'} as Env;
 const id=(await jobs.enqueueJob(jobs.makeJobContext(env,{now}),'insights_daily',{accountId,state:{initial:true}}))!;
 for(let i=0;i<20;i++) {const ctx=jobs.createJobContext(configured,now);const result=await jobs.runJobs(ctx,undefined,id);expect(result.failed).toBe(0);expect(ctx.db.queryCount+ctx.sys.queryCount).toBeLessThanOrEqual(48);if(result.done)break;}
 expect(await testDb().first('SELECT status FROM jobs WHERE id=?',id)).toEqual({status:'done'});
 expect(await testDb().first('SELECT COUNT(*) n FROM posts WHERE account_id=? AND metrics_fetched_at IS NOT NULL',accountId)).toEqual({n:61});
 expect(await testDb().first("SELECT views FROM posts WHERE account_id=? AND id='old'",accountId)).toEqual({views:0});
 expect(await testDb().first("SELECT views FROM posts WHERE account_id=? AND id='other'",other)).toEqual({views:0});
});
