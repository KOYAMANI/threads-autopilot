import {it,expect,vi} from 'vitest';
import {callAi} from '../src/lib/ai';
const base={model:'gemini-3.5-flash-lite',provider:'gemini' as const,apiKey:'test-only-key',system:'test',user:'test',appOrigin:'https://example.com'};
it.each([302,307])('never follows or retries HTTP %s with credentials',async status=>{
 const fetchImpl=vi.fn(async (url:RequestInfo|URL,init?:RequestInit)=>{
  expect(new Request(url,init).redirect).toBe('manual');
  return new Response(null,{status,headers:{Location:'https://untrusted.example/collect'}});
 });
 await expect(callAi(base,{fetchImpl:fetchImpl as typeof fetch})).rejects.toMatchObject({code:'AI_FAILED',retryable:false});
 expect(fetchImpl).toHaveBeenCalledTimes(1);
 expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
});

it('reports the actual Gemini free daily quota without retrying',async()=>{
 const fetchImpl=vi.fn(async()=>Response.json({error:{details:[{violations:[{quotaId:'GenerateRequestsPerDayPerProjectPerModel-FreeTier',quotaValue:'20'}]}]}},{status:429}));
 await expect(callAi(base,{fetchImpl:fetchImpl as typeof fetch})).rejects.toThrow('1日の上限（20回）');
 expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each([[401,"authentication"],[403,"authentication"],[404,"model"],[400,"unknown"],[429,"rate_limit"]])("classifies HTTP %s without retrying or exposing response",async(status,category)=>{
 const fetchImpl=vi.fn(async()=>new Response("private prompt and secret",{status:Number(status)}));
 await expect(callAi(base,{fetchImpl:fetchImpl as typeof fetch})).rejects.toMatchObject({category,upstreamStatus:status,raw:null,retryable:false});
 expect(fetchImpl).toHaveBeenCalledTimes(1);
});
