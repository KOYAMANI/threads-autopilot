import { describe, it, expect, vi } from "vitest";
import { AI_DATA_POLICY_VERSION, hasAiDataConsent } from "@tap/shared";
import { buildRequest, callAi } from "../src/lib/ai";
import { api, insertAccount, mockToken, registerUser, testDb } from "./helpers";

const input = { provider: "openrouter" as const, model: "anthropic/claude-sonnet-4.6", apiKey: "test-key", system: "test", user: "test", appOrigin: "https://example.com" };
describe("AI routing and data consent", () => {
  it("pins the provider and forbids fallbacks and non-ZDR endpoints", () => {
    const body = JSON.parse(String(buildRequest(input).init.body));
    expect(body.provider).toEqual({only:["amazon-bedrock/us"],order:["amazon-bedrock/us"],allow_fallbacks:false,require_parameters:true,data_collection:"deny",zdr:true});
    expect(body.models).toBeUndefined();
  });
  it.each(["openrouter/auto", "anthropic/claude-sonnet-4.6:free", "google/gemini-2.5-flash", "anthropic/claude-sonnet-4.6:nitro"])("rejects unapproved model %s before any network call", async model => {
    const fetchImpl = vi.fn();
    await expect(callAi({...input,model},{fetchImpl})).rejects.toMatchObject({code:"AI_KEY_REQUIRED"});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("does not redirect secrets or retry with a looser provider policy", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(JSON.parse(String(init?.body)).provider.only).toEqual(["amazon-bedrock/us"]);
      return new Response("No eligible endpoints", {status:404});
    });
    await expect(callAi(input,{fetchImpl:fetchImpl as typeof fetch})).rejects.toMatchObject({code:"AI_FAILED"});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("does not infer consent for legacy or unapproved settings", () => {
    expect(hasAiDataConsent({provider:"gemini"})).toBe(false);
    expect(hasAiDataConsent({provider:"gemini",data_policy_version:"2026-09-08-v1"})).toBe(false);
    expect(hasAiDataConsent({provider:"gemini",data_policy_version:AI_DATA_POLICY_VERSION})).toBe(true);
    expect(hasAiDataConsent({provider:"other",data_policy_version:AI_DATA_POLICY_VERSION})).toBe(false);
  });
  it("allows a free-tier key with explicit consent without replacing it on invalid updates", async () => {
    const u=await registerUser();
    const body={provider:"gemini",key:"test-only-secret",storeOnServer:true};
    expect((await api("PUT","/api/ai/settings",{cookie:u.cookie,body})).status).toBe(400);
    expect((await api("PUT","/api/ai/settings",{cookie:u.cookie,body:{...body,acceptDataPolicy:true}})).status).toBe(200);
    expect((await api("PUT","/api/ai/settings",{cookie:u.cookie,body:{...body,acceptDataPolicy:true,geminiBillingConfirmed:true}})).status).toBe(200);
    const before=await testDb().first<{key_enc:string}>("SELECT key_enc FROM ai_settings WHERE user_id=?",u.userId);
    expect((await api("PUT","/api/ai/settings",{cookie:u.cookie,body:{...body,key:"replacement",model:"other",acceptDataPolicy:true,geminiBillingConfirmed:true}})).status).toBe(400);
    expect((await testDb().first<{key_enc:string}>("SELECT key_enc FROM ai_settings WHERE user_id=?",u.userId))?.key_enc).toBe(before?.key_enc);
  });
  it("rejects malformed keys without calling a provider or overwriting stored settings", async () => {
    const fetchImpl = vi.fn();
    await expect(callAi({...input, apiKey:"key\nsecret"},{fetchImpl})).rejects.toMatchObject({code:"AI_KEY_REQUIRED", retryable:false});
    expect(fetchImpl).not.toHaveBeenCalled();
    const u=await registerUser();
    const res=await api("PUT","/api/ai/settings",{cookie:u.cookie,body:{provider:"gemini",key:"キーをここに入力",acceptDataPolicy:true,storeOnServer:true}});
    expect(res.status).toBe(400);
    expect(await testDb().first("SELECT user_id FROM ai_settings WHERE user_id=?",u.userId)).toBeNull();
  });
  it("blocks test, generation and rewriting when existing consent is absent", async () => {
    const u=await registerUser();const accountId=await insertAccount({userId:u.userId,token:mockToken("policy")});
    await api("PUT","/api/ai/settings",{cookie:u.cookie,body:{provider:"openrouter",key:"test-key",acceptDataPolicy:true,storeOnServer:true}});
    await testDb().run("UPDATE ai_settings SET data_policy_version=NULL WHERE user_id=?",u.userId);
    const settings=await api("GET","/api/ai/settings",{cookie:u.cookie});
    expect(settings.body.data).toMatchObject({hasKey:true,dataPolicyAccepted:false,autopilotAvailable:false});
    for(const [path,body] of [["test",{}],["generate",{accountId}],["revise",{accountId,candidate:{key:"A",hook:"断定型",body:"test",comments:[],basis:"test"},instruction:"shorten"}]] as const){
      const res=await api("POST",`/api/ai/${path}`,{cookie:u.cookie,body});
      expect(res.body.error.code).toBe("AI_KEY_REQUIRED");
    }
  });
});
