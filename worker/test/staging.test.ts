import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call } from "../src/lib/threads";
import { createBudget } from "../src/lib/budget";
import { sendEmail } from "../src/lib/email";
import { createApp } from "../src/app";
import { registerUser, testDb } from "./helpers";
import type { Env } from "../src/env";

afterEach(() => vi.restoreAllMocks());
const stage = (): Env => ({...env, APP_ENV:"staging", STAGING_THREADS_USER_ID:undefined});
describe("Staging isolation", () => {
  it.each(["POST","DELETE"] as const)("blocks %s before any Threads request", async method => {
    const fetch = vi.spyOn(globalThis,"fetch");
    await expect(call("real-token-placeholder",method,"/me/threads",{}, {env:stage(),budget:createBudget()})).rejects.toThrow("ステージング");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not send email even if a mail credential was accidentally configured", async () => {
    const fetch=vi.spyOn(globalThis,"fetch");
    expect((await sendEmail({...stage(),RESEND_API_KEY:"test"},"test@example.com","password_reset",{url:"https://test.local/private"})).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects token connection without a dedicated test account and stores nothing", async () => {
    const user=await registerUser();
    const fetch=vi.spyOn(globalThis,"fetch");
    const res=await createApp().fetch(new Request("https://test.local/api/accounts",{method:"POST",headers:{Cookie:user.cookie!,"Content-Type":"application/json","X-Requested-With":"fetch"},body:JSON.stringify({token:"real-token-placeholder"})}),stage());
    expect(res.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    expect(await testDb().first("SELECT COUNT(*) n FROM accounts")).toEqual({n:0});
  });
});
