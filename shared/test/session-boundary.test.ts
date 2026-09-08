import { afterEach, expect, it, vi } from "vitest";
import {
  beginRequest,
  clearPrivateState,
} from "../../web/src/lib/session-boundary";
import { withClientKey } from "../../web/src/api/ai";
afterEach(() => vi.unstubAllGlobals());
it("session reset aborts outstanding requests, removes legacy secrets, and rejects stale results", () => {
  const local = new Map([
    ["aiKey", "old-user-secret"],
    ["activeAccountId", "old-account"],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => local.get(key),
    removeItem: (key: string) => local.delete(key),
  });
  const request = beginRequest();
  clearPrivateState();
  expect(request.controller.signal.aborted).toBe(true);
  expect(request.current()).toBe(false);
  expect(local.has("aiKey")).toBe(false);
  expect(local.has("activeAccountId")).toBe(false);
});
it("legacy local credentials are never added to an AI request", () => {
  vi.stubGlobal("localStorage", { getItem: () => "another-user-secret" });
  expect(
    withClientKey(
      {
        storeOnServer: false,
        hasKey: false,
        provider: "gemini",
        model: null,
        dataPolicyAccepted: false, autopilotAvailable: false,
      },
      { instruction: "hello" },
    ),
  ).toEqual({ instruction: "hello" });
});
