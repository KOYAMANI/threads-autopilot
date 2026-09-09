import {it,expect,vi} from 'vitest';
import {callAi} from '../src/lib/ai';
const base={model:'gemini-2.5-flash',provider:'gemini' as const,apiKey:'test-only-key',system:'test',user:'test',appOrigin:'https://example.com'};
it.each(['gemini','openrouter'] as const)('constructs actual workerd Requests for %s', async provider=>{
 const fetchImpl=vi.fn(async (url:RequestInfo|URL,init?:RequestInit)=>{
  const request=new Request(url,init);
  expect(request.redirect).toBe('manual');
  return Response.json(provider==='gemini'?{candidates:[{content:{parts:[{text:'ok'}]}}]}:{choices:[{message:{content:'ok'}}]});
 });
 expect(await callAi({...base,provider,model:provider==='gemini'?base.model:'anthropic/claude-sonnet-4.6'},{fetchImpl:fetchImpl as typeof fetch})).toBe('ok');
 expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it.each([301,302,303,307,308])('never follows or retries HTTP %s with credentials',async status=>{
 const fetchImpl=vi.fn(async (url:RequestInfo|URL,init?:RequestInit)=>{
  expect(new Request(url,init).redirect).toBe('manual');
  return new Response(null,{status,headers:{Location:'https://untrusted.example/collect'}});
 });
 await expect(callAi(base,{fetchImpl:fetchImpl as typeof fetch})).rejects.toMatchObject({code:'AI_FAILED',retryable:false});
 expect(fetchImpl).toHaveBeenCalledTimes(1);
 expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
});

it('reports the actual Gemini free daily quota without retrying',async()=>{
 const fetchImpl=vi.fn(async()=>Response.json({error:{details:[{violations:[{quotaId:'GenerateRequestsPerDayPerProjectPerModel-FreeTier',quotaValue:'20'}]}]}},{status:429}));
 await expect(callAi(base,{fetchImpl:fetchImpl as typeof fetch})).rejects.toThrow('1日の上限（20回）');
 expect(fetchImpl).toHaveBeenCalledTimes(1);
});
