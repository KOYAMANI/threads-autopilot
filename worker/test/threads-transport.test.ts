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
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(["/access_token", "/refresh_access_token"])("retains required OAuth parameters for %s", async path => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"access_token":"test"}'));
    await call("test-private-token", "GET", path, {grant_type:"test"}, {env,budget:createBudget()});
    const [url, options] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get("access_token")).toBe("test-private-token");
    expect(new Headers(options?.headers).has("Authorization")).toBe(false);
  });
});
