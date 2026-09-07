import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call } from "../src/lib/threads";
import { createBudget } from "../src/lib/budget";
import { sendEmail } from "../src/lib/email";
import { createApp } from "../src/app";
import { registerUser, testDb } from "./helpers";
import type { Env } from "../src/env";

afterEach(() => vi.restoreAllMocks());
const stage = (): Env => ({...env, APP_ENV:"staging", STAGING_THREADS_USER_ID:undefined, STAGING_THREADS_USERNAME:undefined});
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

describe("Staging test account bootstrap", () => {
  async function connect(config: Partial<Env>, profile: { id: string; username?: string }) {
    const user = await registerUser();
    const jobsBefore = await testDb().first("SELECT COUNT(*) n FROM jobs");
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(profile))
      .mockResolvedValueOnce(Response.json({ access_token: "test-long-lived-token", expires_in: 5184000 }));
    const res = await createApp().fetch(new Request("https://test.local/api/accounts", {
      method: "POST",
      headers: { Cookie: user.cookie, "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ token: "test-token-placeholder", username: "yama_threads.sub" }),
    }), { ...stage(), THREADS_MOCK: "0", ...config });
    return { res, fetch, userId: user.userId, jobsBefore };
  }

  it("accepts only the authenticated profile username, normalizing @ and case", async () => {
    const { res, fetch, userId } = await connect({ STAGING_THREADS_USERNAME: " @YAMA_THREADS.SUB " }, { id: "123456", username: "yama_threads.sub" });
    expect(res.status).toBe(201);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await testDb().first("SELECT threads_user_id, username FROM accounts WHERE user_id=?", userId)).toEqual({ threads_user_id: "123456", username: "yama_threads.sub" });
  });

  it.each(["yama_threads", "yama_threads.sub.other", undefined])("rejects authenticated username %s before writing account data", async username => {
    const { res, fetch, userId, jobsBefore } = await connect({ STAGING_THREADS_USERNAME: "yama_threads.sub" }, { id: "123456", username });
    expect(res.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await testDb().first("SELECT COUNT(*) n FROM accounts WHERE user_id=?", userId)).toEqual({ n: 0 });
    expect(await testDb().first("SELECT COUNT(*) n FROM jobs")).toEqual(jobsBefore);
  });

  it.each([" @ ", "https://threads.net/@yama_threads.sub", "yama threads.sub", "@@yama_threads.sub"])("fails closed before fetching with invalid bootstrap setting %s", async configuredUsername => {
    const { res, fetch, userId, jobsBefore } = await connect({ STAGING_THREADS_USER_ID: " ", STAGING_THREADS_USERNAME: configuredUsername }, { id: "123456", username: "yama_threads.sub" });
    expect(res.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    expect(await testDb().first("SELECT COUNT(*) n FROM accounts WHERE user_id=?", userId)).toEqual({ n: 0 });
    expect(await testDb().first("SELECT COUNT(*) n FROM jobs")).toEqual(jobsBefore);
  });

  it("rejects a matching username when the configured ID differs", async () => {
    const { res, fetch, userId, jobsBefore } = await connect({ STAGING_THREADS_USER_ID: "999999", STAGING_THREADS_USERNAME: "yama_threads.sub" }, { id: "123456", username: "yama_threads.sub" });
    expect(res.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await testDb().first("SELECT COUNT(*) n FROM accounts WHERE user_id=?", userId)).toEqual({ n: 0 });
    expect(await testDb().first("SELECT COUNT(*) n FROM jobs")).toEqual(jobsBefore);
  });

  it("accepts a pinned ID after the test account changes its username", async () => {
    const { res, userId } = await connect({ STAGING_THREADS_USER_ID: "123456", STAGING_THREADS_USERNAME: "yama_threads.sub" }, { id: "123456", username: "renamed.test.account" });
    expect(res.status).toBe(201);
    expect(await testDb().first("SELECT threads_user_id FROM accounts WHERE user_id=?", userId)).toEqual({ threads_user_id: "123456" });
  });
});
