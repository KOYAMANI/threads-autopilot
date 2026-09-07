import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { registerUser, testDb } from './helpers';
import type { Env } from '../src/env';
import { createSession } from '../src/lib/session';
import * as threads from '../src/lib/threads';
import * as accounts from '../src/routes/accounts';

const app=createApp();
const configured={...env,APP_ORIGIN:'https://test.local',THREADS_APP_ID:'test-app-id',THREADS_APP_SECRET:'test-app-secret'} as Env;
async function req(path:string,method='GET',cookie='',body?:unknown,bindings=configured,xrw=true) {
 const res=await app.fetch(new Request('https://test.local/api/threads/oauth'+path,{method,headers:{Cookie:cookie,...(xrw?{'X-Requested-With':'fetch'}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),bindings);
 const text=await res.text();let data:any;try{data=JSON.parse(text)}catch{data=text}
 return {status:res.status,data,headers:res.headers};
}
async function start(cookie:string){const r=await req('/start','POST',cookie,{});expect(r.status).toBe(200);return{state:new URL(r.data.data.url).searchParams.get('state')!,cookie:cookie+'; '+r.headers.get('set-cookie')!.split(';')[0]};}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});
describe('Threads OAuth',()=>{
 it('requires a session, CSRF header and operator configuration',async()=>{
  expect((await req('/start','POST','',{})).status).toBe(401);
  const u=await registerUser();expect((await req('/start','POST',u.cookie,{},configured,false)).status).toBe(403);
  expect((await req('/start','POST',u.cookie,{},env)).status).toBe(503);
  expect((await req('/status','GET',u.cookie,undefined,env)).data.data.configured).toBe(false);
 });
 it('authorizes the real callback and scopes without leaking app secret',async()=>{
  const u=await registerUser();const r=await req('/start','POST',u.cookie,{});const url=new URL(r.data.data.url);
  expect(url.origin).toBe('https://threads.net');expect(url.searchParams.get('redirect_uri')).toBe('https://test.local/api/threads/oauth/callback');
  expect(url.searchParams.get('scope')).toContain('threads_read_replies');expect(JSON.stringify(r.data)).not.toContain('test-app-secret');
  const rows=await testDb().all<{id:string}>('SELECT id FROM threads_oauth_states WHERE user_id=?',u.userId);
  expect(rows).toHaveLength(1);expect(rows[0]?.id).not.toBe(url.searchParams.get('state'));
 });
 it('rejects another user, another session, and the wrong browser before any Meta call',async()=>{
  const u=await registerUser(),other=await registerUser();const s=await start(u.cookie);const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const body={state:s.state,code:'test-code'};const browser=s.cookie.slice(s.cookie.indexOf(';')+1);
  expect((await req('/complete','POST',other.cookie+';'+browser,body)).status).toBe(400);
  const session=await createSession(testDb(),u.userId,null);
  expect((await req('/complete','POST',`sid=${session.token};${browser}`,body)).status).toBe(400);
  expect((await req('/complete','POST',u.cookie+'; __Secure-tap_threads_oauth=wrong-browser',body)).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('rejects expired state and consumes valid state only once',async()=>{
  const u=await registerUser();const s=await start(u.cookie);await testDb().run("UPDATE threads_oauth_states SET expires_at='2000-01-01T00:00:00Z' WHERE user_id=?",u.userId);
  expect((await req('/complete','POST',s.cookie,{state:s.state,code:'code'})).status).toBe(400);
  const fresh=await start(u.cookie);const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({access_token:'THAAdemo_oauth'}),{status:200}));vi.stubGlobal('fetch',fetcher);
  const result=await req('/complete','POST',fresh.cookie,{state:fresh.state,code:'test-code'});
  expect(result.status).toBe(201);expect(result.data.data.longLived).toBe(true);
  expect(JSON.stringify(result.data)).not.toContain('THAAdemo');expect(JSON.stringify(result.data)).not.toContain('test-app-secret');
  expect((await req('/complete','POST',fresh.cookie,{state:fresh.state,code:'test-code'})).status).toBe(400);expect(fetcher).toHaveBeenCalledTimes(1);
  const init=fetcher.mock.calls[0]![1] as RequestInit;
  expect(init.method).toBe('POST');expect(String(init.body)).toContain('redirect_uri=https%3A%2F%2Ftest.local%2Fapi%2Fthreads%2Foauth%2Fcallback');
 });
 it('callback bridge works without relaxing the Strict application cookie and escapes injected HTML',async()=>{
  const r=await req('/callback?state=xxx&code='+encodeURIComponent('</script><img src=x>'),'GET','',undefined,configured,false);
  expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(r.headers.get('referrer-policy')).toBe('no-referrer');expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(r.data).not.toContain('</script><img');expect(r.data).toContain('history.replaceState');expect(r.data).toContain('\\u003c');
 });
 it('provider failure never returns secret-bearing provider errors',async()=>{
  const u=await registerUser();const s=await start(u.cookie);vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{message:'test-app-secret test-code'}}),{status:400})));
  const r=await req('/complete','POST',s.cookie,{state:s.state,code:'test-code'});expect(r.status).toBe(400);expect(JSON.stringify(r.data)).not.toContain('test-app-secret');
 });
 it.each([
  {stage:'short_exchange',failureCode:'OAUTH_SHORT_EXCHANGE',before:0},
  {stage:'long_exchange',failureCode:'OAUTH_LONG_EXCHANGE',before:1},
  {stage:'profile_save',failureCode:'OAUTH_PROFILE_SAVE',before:2},
 ])('reports $stage failure using only fixed labels and numeric provider metadata',async({stage,failureCode,before})=>{
  const u=await registerUser(),s=await start(u.cookie);
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  const fetcher=vi.fn();
  if(before>=1) fetcher.mockResolvedValueOnce(new Response(JSON.stringify({access_token:'synthetic-short-secret'})));
  if(before>=2) fetcher.mockResolvedValueOnce(new Response(JSON.stringify({access_token:'synthetic-long-secret'})));
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({error:{code:190,error_subcode:463,message:'test-app-secret synthetic-short-secret synthetic-long-secret test-code '+s.state,fbtrace_id:'private-trace'}}),{status:400}));
  vi.stubGlobal('fetch',fetcher);
  const result=await req('/complete','POST',s.cookie,{state:s.state,code:'test-code'});
  expect(result.status).toBe(before===0?400:502);
  expect(result.data.error.code).toBe(failureCode);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]).toEqual(['[threads-oauth]',{stage,errorClass:'ThreadsApiError',providerCode:190,providerSubcode:463,...(before===0?{httpStatus:400}:{})}]);
  const exposed=JSON.stringify([result.data,log.mock.calls]);
  for(const secret of ['test-app-secret','synthetic-short-secret','synthetic-long-secret','test-code',s.state,'private-trace']) expect(exposed).not.toContain(secret);
  expect(fetcher).toHaveBeenCalledTimes(before+1);
 });
 it('does not log message/stack/name even when thrown errors contain token-bearing URLs',async()=>{
  const u=await registerUser(),s=await start(u.cookie),log=vi.spyOn(console,'error').mockImplementation(()=>{});
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({access_token:'synthetic-short-secret'}))));
  const failure=new Error('https://graph.threads.net?access_token=private-token&client_secret=test-app-secret');
  failure.name='private-name';failure.stack='private-stack';
  vi.spyOn(threads,'exchangeToken').mockRejectedValue(failure);
  const result=await req('/complete','POST',s.cookie,{state:s.state,code:'private-code'});
  expect(result.data.error.code).toBe('OAUTH_LONG_EXCHANGE');
  expect(log.mock.calls).toEqual([['[threads-oauth]',{stage:'long_exchange',errorClass:'Error'}]]);
  expect(JSON.stringify([result.data,log.mock.calls])).not.toContain('private');
 });
 it('distinguishes malformed short responses and database/profile-save exceptions without logging them',async()=>{
  const u=await registerUser(),log=vi.spyOn(console,'error').mockImplementation(()=>{});
  let s=await start(u.cookie);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('private-response test-app-secret')));
  let result=await req('/complete','POST',s.cookie,{state:s.state,code:'test-code'});
  expect(result.data.error.code).toBe('OAUTH_SHORT_EXCHANGE');
  expect(log.mock.calls).toEqual([['[threads-oauth]',{stage:'short_exchange',errorClass:'SyntaxError',httpStatus:200}]]);
  log.mockClear();s=await start(u.cookie);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({access_token:'synthetic-short-secret'}))));
  vi.spyOn(threads,'exchangeToken').mockResolvedValue({access_token:'synthetic-long-secret'});
  vi.spyOn(accounts,'connectThreadsAccount').mockRejectedValue(new Error('D1 details private-token private-user-id'));
  result=await req('/complete','POST',s.cookie,{state:s.state,code:'test-code'});
  expect(result.data.error.code).toBe('OAUTH_PROFILE_SAVE');
  expect(log.mock.calls).toEqual([['[threads-oauth]',{stage:'profile_save',errorClass:'Error'}]]);
 });
 it('omits nonnumeric provider codes and rejects empty token responses at the correct stage',async()=>{
  const u=await registerUser(),log=vi.spyOn(console,'error').mockImplementation(()=>{});
  let s=await start(u.cookie);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'private-code',error_subcode:'private-subcode',message:'private-message'}}),{status:400})));
  let result=await req('/complete','POST',s.cookie,{state:s.state,code:'test-code'});
  expect(result.data.error.code).toBe('OAUTH_SHORT_EXCHANGE');
  expect(log.mock.calls).toEqual([['[threads-oauth]',{stage:'short_exchange',errorClass:'OAuthResponseError',httpStatus:400}]]);
  log.mockClear();s=await start(u.cookie);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({access_token:'synthetic-short-secret'}))));
  vi.spyOn(threads,'exchangeToken').mockResolvedValue({access_token:''});
  result=await req('/complete','POST',s.cookie,{state:s.state,code:'test-code'});
  expect(result.status).toBe(400);expect(result.data.error.code).toBe('OAUTH_LONG_EXCHANGE');
  expect(log.mock.calls).toEqual([['[threads-oauth]',{stage:'long_exchange',errorClass:'OAuthResponseError'}]]);
 });

});
