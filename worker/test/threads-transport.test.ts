import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call } from "../src/lib/threads";
import { createBudget } from "../src/lib/budget";

afterEach(() => vi.restoreAllMocks());
describe("Threads credential transport", () => {
  it.each(["GET", "POST", "DELETE"] as const)("keeps %s credentials out of normal API URLs", async method => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"id":"test"}'));
    await call("test-private-token", method, "/me/threads", {fields:"id",access_token:"untrusted-param"}, {env,budget:createBudget()});
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).not.toContain("token");
    expect(new URL(String(url)).searchParams.get("fields")).toBe("id");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer test-private-token");
    // Workers rejects redirect:"error"; "manual" plus the 3xx check below keeps credentials from following.
    expect(options?.redirect).toBe("manual");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
  it("fails a redirect instead of following it with the bearer token", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } }),
    );
    await expect(
      call("test-private-token", "GET", "/me", { fields: "id" }, { env, budget: createBudget() }),
    ).rejects.toMatchObject({ code: 302 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["/access_token", "/refresh_access_token"])("retains required OAuth parameters for %s", async path => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"access_token":"test"}'));
    await call("test-private-token", "GET", path, {grant_type:"test"}, {env,budget:createBudget()});
    const [url, options] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get("access_token")).toBe("test-private-token");
    expect(new Headers(options?.headers).has("Authorization")).toBe(false);
  });
});

describe("時間予算と timeout（2026-10-21）", () => {
  it("予算の残りが 3 秒未満なら呼ばずに BudgetExceeded（失敗回数を増やさない）", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"id":"test"}'));
    let t = 0;
    const budget = createBudget({ timeMs: 20000, now: () => t });
    t = 18000; // 残り 2 秒
    await expect(
      call("test-private-token", "GET", "/me", { fields: "id" }, { env, budget }),
    ).rejects.toMatchObject({ name: "BudgetExceeded", kind: "timeMs" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("予算の残りで短く切った timeout は BudgetExceeded、API 側の 15 秒 timeout はそのまま投げる", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    let t = 0;
    const short = createBudget({ timeMs: 20000, now: () => t });
    t = 12000; // 残り 8 秒 → 8 秒で切った timeout
    await expect(
      call("test-private-token", "GET", "/me", { fields: "id" }, { env, budget: short }),
    ).rejects.toMatchObject({ name: "BudgetExceeded" });
    const full = createBudget({ timeMs: 60000, now: () => 0 });
    await expect(
      call("test-private-token", "GET", "/me", { fields: "id" }, { env, budget: full }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
