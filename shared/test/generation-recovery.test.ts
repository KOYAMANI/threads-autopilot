import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { api } from "../../web/src/api/client";
import { clearPrivateState } from "../../web/src/lib/session-boundary";
import { generateInBackground, getGenerationTask, clearGenerationTask, resumeGenerationTask } from "../../web/src/lib/generation-task";

const input = { accountId: "a", instruction: "keep this theme", pickMode: "information" as const, n: 3 };
const started = { taskId: "task-1", startedAt: "2026-09-30T00:00:00Z" };
const done = { ...started, accountId: "a", status: "done", result: { candidates: [{ key: "A", body: "result", comments: [] }], notes: [] }, context: { instruction: input.instruction } };
const ok = (data: unknown) => Response.json({ ok: true, data });
beforeEach(() => {
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("window", new EventTarget());
  clearGenerationTask();
});
afterEach(() => { clearGenerationTask(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("recovers from network and 503 polling failures without starting another generation", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(ok(started)).mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(Response.json({ ok: false }, { status: 503 })).mockResolvedValueOnce(ok(done));
  vi.stubGlobal("fetch", fetcher);
  const result = generateInBackground(input);
  await vi.advanceTimersByTimeAsync(0);
  expect(getGenerationTask()).toMatchObject({ status: "running", reconnecting: true });
  await vi.advanceTimersByTimeAsync(4000);
  expect(await result).toEqual(done.result);
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  expect(getGenerationTask()).toMatchObject({ status: "done" });
});
it("a terminal model quota failure retains input and requires explicit retry", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(ok(started)).mockResolvedValueOnce(ok({ ...done, status: "failed", result: null, error: { code: "AI_FAILED", message: "quota", status: 429 } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(generateInBackground(input)).rejects.toMatchObject({ status: 429 });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(getGenerationTask()).toMatchObject({ status: "failed", context: { instruction: input.instruction } });
});
it("a late poll after logout cannot restore private task results", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>(r => { resolve = r; });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok(started)).mockReturnValueOnce(pending));
  const result = generateInBackground(input).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  clearPrivateState();
  resolve(ok(done));
  expect(await result).toMatchObject({ code: "CANCELLED" });
  expect(getGenerationTask()).toEqual({ status: "idle" });
});
it("restores a saved task by polling its ID without a new POST", async () => {
  localStorage.setItem("tap:ai-generation-task", JSON.stringify({ ...started, accountId: "a" }));
  const fetcher = vi.fn().mockResolvedValue(ok(done));
  vi.stubGlobal("fetch", fetcher);
  await resumeGenerationTask();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![1].method).toBe("GET");
  expect(getGenerationTask()).toMatchObject({ status: "done", accountId: "a" });
});
it.each([503, 401])("only confirmed auth rejection logs out (recheck status %s)", async (status) => {
  const unauthorized = vi.fn();
  window.addEventListener("tap:unauthorized", unauthorized);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ ok: false, error: { code: "AI_FAILED" } }, { status: 401 }))
    .mockResolvedValueOnce(new Response(null, { status })));
  await expect(api.get("/ai/settings")).rejects.toBeTruthy();
  expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
});
