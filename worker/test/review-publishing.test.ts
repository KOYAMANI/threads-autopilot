import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { canPublishForUser, reviewPublishingActive } from "../src/lib/staging-review-policy";
import { call } from "../src/lib/threads";
import { createBudget } from "../src/lib/budget";
import { dispatchReviewPublishing } from "../src/lib/review-scheduler";
import { createJobContext } from "../src/lib/jobs";
import { createApp } from "../src/app";
import { insertAccount, registerUser, testDb } from "./helpers";
const reviewer='11111111-1111-4111-8111-111111111111';
const now=Date.parse('2026-09-08T02:00:00Z');
const stage=(extra:Partial<Env>={}):Env=>({...env,APP_ENV:'staging',THREADS_MOCK:'0',
  STAGING_THREADS_USER_ID:'123456',STAGING_REVIEW_USER_ID:reviewer,STAGING_REVIEW_PUBLISHING:'1',
  STAGING_REVIEW_UNTIL:'2027-10-01T00:00:00Z',...extra});
afterEach(()=>vi.restoreAllMocks());
describe('Scoped reviewer publishing',()=>{
 it.each([{STAGING_REVIEW_PUBLISHING:undefined},{STAGING_REVIEW_USER_ID:undefined},
  {STAGING_THREADS_USER_ID:undefined},{STAGING_REVIEW_UNTIL:'invalid'},
  {STAGING_REVIEW_UNTIL:'2026-09-08T02:00:00Z'}])('fails closed with incomplete/expired config %j',config=>{
  expect(reviewPublishingActive(stage(config),now)).toBe(false);
  expect(canPublishForUser(stage(config),reviewer,now)).toBe(false);
 });
 it('does not grant publishing to another login',()=>{
  expect(canPublishForUser(stage(),'another-user',now)).toBe(false);
  expect(canPublishForUser(stage(),reviewer,now)).toBe(true);
 });
 it('requires the verified token profile before POST',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({id:'different-profile'}));
  await expect(call('placeholder','POST','/me/threads',{}, {env:stage(),budget:createBudget(),now,publishingUserId:reviewer})).rejects.toThrow('一致');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![1]?.method).toBe('GET');
 });
 it.each([['DELETE','/me/threads'],['POST','/123/repost']] as const)('never grants %s %s',async(method,path)=>{
  const fetch=vi.spyOn(globalThis,'fetch');
  await expect(call('placeholder',method,path,{}, {env:stage(),budget:createBudget(),now,publishingUserId:reviewer})).rejects.toThrow('ステージング');
  expect(fetch).not.toHaveBeenCalled();
 });
 it('allows only the reviewer and verified profile to publish',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({id:'123456'})).mockResolvedValueOnce(Response.json({id:'published'}));
  expect(await call('placeholder','POST','/me/threads',{text:'test'}, {env:stage(),budget:createBudget(),now,publishingUserId:reviewer})).toEqual({id:'published'});
  expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('rejects an ordinary staging reservation but still accepts a draft',async()=>{
  const user=await registerUser();const id=await insertAccount({userId:user.userId});
  const send=(status:string)=>createApp().fetch(new Request(`https://test.local/api/accounts/${id}/queue`,{method:'POST',headers:{Cookie:user.cookie,'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify({status,body:'test',scheduledAt:'2027-01-01T00:00:00Z'})}),stage());
  expect((await send('scheduled')).status).toBe(409);
  expect((await send('draft')).status).toBe(201);
  expect(await testDb().first("SELECT COUNT(*) n FROM jobs WHERE type='publish'")).toEqual({n:0});
 });
 it('dispatches only due manual reviewer work, preserving other pending reservations',async()=>{
  const a=await registerUser(), b=await registerUser();
  const aId=await insertAccount({userId:a.userId,threadsUserId:'123456'});
  const bId=await insertAccount({userId:b.userId,threadsUserId:'123456'});
  const db=testDb(); const at=new Date(now-60000).toISOString();
  for(const [id,account,source] of [['own',aId,'manual'],['other',bId,'manual'],['auto',aId,'autopilot']]){
   await db.run("INSERT INTO queue(id,account_id,status,scheduled_at,body,source,created_at,updated_at) VALUES (?,?,'scheduled',?,'test',?,?,?)",id,account,at,source,at,at);
  }
  await db.run("INSERT INTO jobs(id,type,account_id,status,priority,next_run_at,created_at,updated_at) VALUES ('other-job','publish',?,'pending',1,?,?,?)",bId,at,at,at);
  const sendBatch=vi.fn().mockResolvedValue(undefined);
  const config=stage({STAGING_REVIEW_USER_ID:a.userId,JOB_QUEUE:{sendBatch} as unknown as Env['JOB_QUEUE']});
  await dispatchReviewPublishing(createJobContext(config,new Date(now)));
  expect(sendBatch).toHaveBeenCalledTimes(1);
  const sentId=sendBatch.mock.calls[0]![0][0].body.jobId;
  expect(await db.first('SELECT account_id FROM jobs WHERE id=?',sentId)).toEqual({account_id:aId});
  expect(await db.first("SELECT dispatched_until FROM jobs WHERE id='other-job'")).toEqual({dispatched_until:null});
  expect(await db.first("SELECT status FROM queue WHERE id='other'")).toEqual({status:'scheduled'});
  // Once manual work is finished, an Autopilot-only row must not wake publishing.
  await db.run("UPDATE queue SET status='done' WHERE id='own'");sendBatch.mockClear();
  await dispatchReviewPublishing(createJobContext(config,new Date(now+360000)));
  expect(sendBatch).not.toHaveBeenCalled();
 });
});
