import { env } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { registerUser, insertAccount, testDb } from './helpers';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { betaUserAllowed, canPublishForAccount, claimBetaProfile } from '../src/lib/staging-beta-policy';
import { call } from '../src/lib/threads';
import { createBudget } from '../src/lib/budget';
import { createJobContext } from '../src/lib/jobs';
import { dispatchReviewPublishing } from '../src/lib/review-scheduler';
const names=['yonashi_kahannshinyase','lions.study','hikkoshi_makasete','shiga_lunch_bakery','noricha.pht'];
const now=Date.parse('2026-09-08T12:00:00Z');
const stage=(extra:Partial<Env>={}):Env=>({...env,APP_ENV:'staging',THREADS_MOCK:'0',
 STAGING_BETA_PUBLISHING:'1',STAGING_BETA_UNTIL:'2026-12-31T23:59:59Z',...extra});
afterEach(()=>vi.restoreAllMocks());
async function setup(){
 const owner=await registerUser(),other=await registerUser(),db=testDb();
 await db.run('DELETE FROM staging_beta_profiles');
 await db.run('DELETE FROM staging_beta_licenses');
 await db.run('INSERT INTO staging_beta_licenses SELECT license_id FROM users WHERE id=?',owner.userId);
 for(const name of names) await db.run('INSERT INTO staging_beta_profiles(username) VALUES (?)',name);
 return {owner,other,db};
}
it('requires a specifically granted active license, and an active beta window',async()=>{
 const {owner,other,db}=await setup();
 expect(await betaUserAllowed(stage(),db,owner.userId,now)).toBe(true);
 expect(await betaUserAllowed(stage(),db,other.userId,now)).toBe(false);
 expect(await betaUserAllowed(stage({STAGING_BETA_PUBLISHING:'0'}),db,owner.userId,now)).toBe(false);
 expect(await betaUserAllowed(stage({STAGING_BETA_UNTIL:'invalid'}),db,owner.userId,now)).toBe(false);
 expect(await betaUserAllowed(stage(),db,owner.userId,Date.parse('2027-01-01'))).toBe(false);
 await db.run("UPDATE licenses SET status='revoked' WHERE user_id=?",owner.userId);
 expect(await betaUserAllowed(stage(),db,owner.userId,now)).toBe(false);
});
it('allows all five named profiles only after /me verifies and pins the ID to the owner',async()=>{
 const {owner,other,db}=await setup();
 await db.run('INSERT INTO staging_beta_licenses SELECT license_id FROM users WHERE id=?',other.userId);
 for(const [index,name] of names.entries()){
  const id=String(8000+index);
  expect(await claimBetaProfile(stage(),db,owner.userId,{id,username:name},now)).toBe(true);
  expect(await canPublishForAccount(stage(),db,owner.userId,id,now)).toBe(true);
  expect(await claimBetaProfile(stage(),db,other.userId,{id,username:name},now)).toBe(false);
  expect(await claimBetaProfile(stage(),db,owner.userId,{id:'new'+id,username:name},now)).toBe(false);
  expect(await claimBetaProfile(stage(),db,owner.userId,{id,username:'renamed'},now)).toBe(true);
 }
 expect(await claimBetaProfile(stage(),db,owner.userId,{id:'999',username:'unapproved'},now)).toBe(false);
 expect(await canPublishForAccount(stage(),db,owner.userId,'999',now)).toBe(false);
 expect(await canPublishForAccount(stage(),db,other.userId,'8000',now)).toBe(false);
 await db.run("UPDATE staging_beta_profiles SET enabled=0 WHERE username=?",names[0]);
 expect(await canPublishForAccount(stage(),db,owner.userId,'8000',now)).toBe(false);
});
it('ignores client supplied username and rejects an unauthorized /me profile before storing tokens',async()=>{
 const {owner,db}=await setup();
 vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:'123',username:'not_allowed'}));
 const response=await createApp().fetch(new Request('https://test.local/api/accounts',{method:'POST',headers:{Cookie:owner.cookie,'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify({token:'placeholder',username:names[0]})}),stage());
 expect(response.status).toBe(403);
 expect(await db.first('SELECT COUNT(*) n FROM accounts')).toEqual({n:0});
 expect(await db.first('SELECT COUNT(*) n FROM staging_beta_profiles WHERE user_id IS NOT NULL')).toEqual({n:0});
});
it('checks the actual token owner and expected account immediately before every irreversible POST',async()=>{
 const {owner,other,db}=await setup();await claimBetaProfile(stage(),db,owner.userId,{id:'8000',username:names[0]},now);
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({id:'wrong'}));
 const options={env:stage(),budget:createBudget(),now,publishingUserId:owner.userId,publishingThreadsUserId:'8000'};
 await expect(call('placeholder','POST','/me/threads',{},options)).rejects.toThrow('一致');
 expect(fetch).toHaveBeenCalledTimes(1);
 fetch.mockReset().mockResolvedValueOnce(Response.json({id:'8000'})).mockResolvedValueOnce(Response.json({id:'container'}));
 expect(await call('placeholder','POST','/me/threads',{},options)).toEqual({id:'container'});
 expect(fetch).toHaveBeenCalledTimes(2);
 fetch.mockClear();
 await expect(call('placeholder','POST','/me/threads',{}, {...options,publishingUserId:other.userId})).rejects.toThrow('ステージング');
 expect(fetch).not.toHaveBeenCalled();
 await expect(call('placeholder','DELETE','/123',{},options)).rejects.toThrow('ステージング');
 expect(fetch).not.toHaveBeenCalled();
});
it('accepts a granted manual reservation and dispatches it, while rejecting other profiles and excluding Autopilot',async()=>{
 const {owner,other,db}=await setup();await claimBetaProfile(stage(),db,owner.userId,{id:'8000',username:names[0]},now);
 const allowed=await insertAccount({userId:owner.userId,threadsUserId:'8000'});
 const wrong=await insertAccount({userId:owner.userId,threadsUserId:'9999'});
 const unrelated=await insertAccount({userId:other.userId,threadsUserId:'8000'});
 const headers={Cookie:owner.cookie,'Content-Type':'application/json','X-Requested-With':'fetch'};
 const create=(account:string)=>createApp().fetch(new Request(`https://test.local/api/accounts/${account}/queue`,{method:'POST',headers,body:JSON.stringify({status:'scheduled',body:'test',scheduledAt:'2026-12-01T00:00:00Z'})}),stage());
 expect((await create(allowed)).status).toBe(201);
 expect((await create(wrong)).status).toBe(409);
 const at=new Date(now-60000).toISOString();
 await db.run('UPDATE queue SET scheduled_at=?',at);
 for(const [id,account,source] of [['auto',allowed,'autopilot'],['other',unrelated,'manual']]) await db.run("INSERT INTO queue(id,account_id,status,scheduled_at,body,source,created_at,updated_at) VALUES (?,?,'scheduled',?,'test',?,?,?)",id,account,at,source,at,at);
 const sendBatch=vi.fn().mockResolvedValue(undefined);
 await dispatchReviewPublishing(createJobContext(stage({JOB_QUEUE:{sendBatch} as unknown as Env['JOB_QUEUE']}),new Date(now)));
 expect(sendBatch).toHaveBeenCalledTimes(1);
 const jobId=sendBatch.mock.calls[0]![0][0].body.jobId;
 expect(await db.first('SELECT account_id FROM jobs WHERE id=?',jobId)).toEqual({account_id:allowed});
 await db.run("UPDATE queue SET status='done' WHERE source='manual' AND account_id=?",allowed);sendBatch.mockClear();
 await dispatchReviewPublishing(createJobContext(stage({JOB_QUEUE:{sendBatch} as unknown as Env['JOB_QUEUE']}),new Date(now+600000)));
 expect(sendBatch).not.toHaveBeenCalled();
});

it('allows every active staging login but only its own connected account, without beta grants',async()=>{
 const {owner,other,db}=await setup();
 const open=stage({STAGING_ALL_USERS_PUBLISHING:'1',STAGING_BETA_PUBLISHING:'0',STAGING_BETA_UNTIL:'expired'});
 const account=await insertAccount({userId:other.userId,threadsUserId:'new-profile'});
 expect(await betaUserAllowed(open,db,other.userId)).toBe(true);
 expect(await claimBetaProfile(open,db,other.userId,{id:'another-profile',username:'not_preapproved'})).toBe(true);
 expect(await canPublishForAccount(open,db,other.userId,'new-profile')).toBe(true);
 expect(await canPublishForAccount(open,db,owner.userId,'new-profile')).toBe(false);
 expect(await claimBetaProfile(open,db,owner.userId,{id:'new-profile'})).toBe(false);
 const sendBatch=vi.fn().mockResolvedValue(undefined);
 await db.run("UPDATE queue SET status='done' WHERE status IN ('scheduled','publishing')");
 const at=new Date(now).toISOString();
 await db.run("INSERT INTO queue(id,account_id,status,scheduled_at,body,source,created_at,updated_at) VALUES ('all-users-test',?,'scheduled',?,'test','manual',?,?)",account,at,at,at);
 await dispatchReviewPublishing(createJobContext({...open,JOB_QUEUE:{sendBatch} as unknown as Env['JOB_QUEUE']},new Date(now)));
 expect(sendBatch).toHaveBeenCalledTimes(1);
 const jobId=sendBatch.mock.calls[0]![0][0].body.jobId;
 expect(await db.first('SELECT account_id FROM jobs WHERE id=?',jobId)).toEqual({account_id:account});
 await db.run("UPDATE licenses SET status='revoked' WHERE user_id=?",other.userId);
 expect(await betaUserAllowed(open,db,other.userId)).toBe(false);
 expect(await canPublishForAccount(open,db,other.userId,'new-profile')).toBe(false);
});
