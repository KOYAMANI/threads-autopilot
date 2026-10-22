import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call } from "../src/lib/threads";
import { createBudget } from "../src/lib/budget";
import { sendEmail } from "../src/lib/email";
import { createApp } from "../src/app";
import { registerUser, testDb } from "./helpers";
import type { Env } from "../src/env";

afterEach(() => vi.restoreAllMocks());
const stage = (): Env => ({...env, APP_ENV:"staging"});
describe("Staging: same as production except email (DECISIONS 2026-10-22)", () => {
  it("does not send email even if a mail credential was accidentally configured", async () => {
    const fetch=vi.spyOn(globalThis,"fetch");
    expect((await sendEmail({...stage(),RESEND_API_KEY:"test"},"test@example.com","password_reset",{url:"https://test.local/private"})).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("publishes to Threads like production", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "c1" }));
    await call("real-token-placeholder","POST","/me/threads",{ media_type: "TEXT", text: "x" }, {env:stage(),budget:createBudget()});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("connects any authenticated Threads account like production", async () => {
    const user = await registerUser();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "777001", username: "someone.else" }))
      .mockResolvedValueOnce(Response.json({ access_token: "test-long-lived-token", expires_in: 5184000 }));
    const res = await createApp().fetch(new Request("https://test.local/api/accounts", {
      method: "POST",
      headers: { Cookie: user.cookie, "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ token: "test-token-placeholder" }),
    }), { ...stage(), THREADS_MOCK: "0" });
    expect(res.status).toBe(201);
    expect(await testDb().first("SELECT username FROM accounts WHERE user_id=?", user.userId)).toEqual({ username: "someone.else" });
  });
});
