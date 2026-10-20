import {it,expect,vi,afterEach} from "vitest";
import {thinkingCapabilities,thinkingConfig} from "../src/lib/ai-capabilities";
import {callAi,AI_TIMEOUT_MS} from "../src/lib/ai";
afterEach(()=>vi.useRealTimers());
const input={provider:"gemini" as const,model:"gemini-3.5-flash-lite",apiKey:"test-only-key",system:"test",user:"test",appOrigin:"https://example.com"};
it("exposes audited options per model and hides unknown capabilities",()=>{
 expect(thinkingCapabilities("gemini",input.model).options.map(o=>o.id)).toEqual(["minimal","low","medium","high"]);
 expect(thinkingCapabilities("gemini","gemini-3.8-flash").options.map(o=>o.id)).toEqual(["low","medium","high"]);
 expect(thinkingConfig("gemini","gemini-3.8-flash","high")).toEqual({thinkingConfig:{thinkingLevel:"high"}});
 expect(thinkingConfig("gemini","gemini-2.5-flash","auto")).toEqual({thinkingConfig:{thinkingBudget:-1}});
 expect(thinkingCapabilities("unknown","future-model")).toMatchObject({supported:false,options:[],defaultId:"default"});
 expect(thinkingConfig("unknown","future-model")).toEqual({});
 expect(()=>thinkingConfig("unknown","future-model","high")).toThrow();
});
it.each(["minimal","low","medium","high"])("sends %s through the real request builder",async thinking=>{
 const fetchImpl=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body));
  expect(body.generationConfig.thinkingConfig).toEqual({thinkingLevel:thinking});
  expect(body.generationConfig.maxOutputTokens).toBeGreaterThan(8192);
  expect(body.generationConfig.temperature).toBeUndefined();
  return Response.json({candidates:[{content:{parts:[{thought:true,text:"private reasoning"},{text:"visible"}]}}]});
 });
 expect(await callAi({...input,thinking},{fetchImpl:fetchImpl as typeof fetch})).toBe("visible");
});
it("rejects invalid effort before calling provider",async()=>{
 const fetchImpl=vi.fn();await expect(callAi({...input,thinking:"impossible"},{fetchImpl})).rejects.toMatchObject({category:"input"});expect(fetchImpl).not.toHaveBeenCalled();
});
it("continues after 60 seconds and aborts at the total 300 second limit",async()=>{
 vi.useFakeTimers();expect(AI_TIMEOUT_MS).toBe(300000);
 const fetchImpl=vi.fn((_u:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener("abort",()=>reject(new DOMException("stop","AbortError")))));
 let settled=false;
 const result=callAi(input,{fetchImpl:fetchImpl as typeof fetch}).catch(e=>{settled=true;return e;});
 await vi.advanceTimersByTimeAsync(60001);expect(settled).toBe(false);
 await vi.advanceTimersByTimeAsync(239999);expect(await result).toMatchObject({category:"timeout",retryable:false});expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it("all retries share a single deadline",async()=>{
 vi.useFakeTimers();let calls=0;
 const fetchImpl=vi.fn(async()=>{calls++;await new Promise(r=>setTimeout(r,200000));return new Response("",{status:503});});
 // Expired deadlines prevent another attempt, even when a fetch implementation ignores abort.
 const result=callAi(input,{fetchImpl:fetchImpl as typeof fetch,deadlineMs:Date.now()+100000}).catch(e=>e);
 await vi.advanceTimersByTimeAsync(200000);expect(await result).toMatchObject({category:"timeout"});expect(calls).toBe(1);
});
it("user cancellation stops an in-flight provider call without retry",async()=>{
 const controller=new AbortController();
 const fetchImpl=vi.fn((_u:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_r,reject)=>init!.signal!.addEventListener("abort",()=>reject(new DOMException("stop","AbortError")))));
 const result=callAi(input,{signal:controller.signal,fetchImpl:fetchImpl as typeof fetch}).catch(e=>e);
 controller.abort();expect(await result).toMatchObject({category:"cancelled",retryable:false});expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it("detects token exhaustion instead of treating reasoning as a post",async()=>{
 await expect(callAi(input,{retries:0,fetchImpl:async()=>Response.json({candidates:[{finishReason:"MAX_TOKENS",content:{parts:[{thought:true,text:"thinking"}]}}]})})).rejects.toMatchObject({category:"output_limit"});
});
