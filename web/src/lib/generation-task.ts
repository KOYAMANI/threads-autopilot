import { useSyncExternalStore } from "react";
import type { AiGenerateRequest, AiGenerateResponse, AiGenerationContext, AiGenerationTaskResponse, AiGenerationTaskStartResponse } from "@tap/shared";
import { api, ApiError } from "../api/client";
import { onPrivateStateClear } from "./session-boundary";

const STORAGE_KEY = "tap:ai-generation-task";
const POLL_MS = 1200;
const TRACKING_LIMIT_MS = 11 * 60_000;
export type GenerationTask =
  | { status: "idle" }
  | { status: "running"; taskId?: string; accountId: string; startedAt: number; context: AiGenerationContext; reconnecting?: boolean }
  | { status: "done"; taskId?: string; accountId: string; startedAt: number; finishedAt: number; context: AiGenerationContext; result: AiGenerateResponse }
  | { status: "failed"; taskId?: string; accountId: string; startedAt: number; finishedAt: number; context: AiGenerationContext; error: unknown };
let task: GenerationTask = { status: "idle" };
let tracking: AbortController | null = null;
let resumePromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function setGenerationTask(next: GenerationTask) {
  task = next;
  try {
    if (next.status === "idle" || !next.taskId) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ taskId: next.taskId, accountId: next.accountId, startedAt: next.startedAt }));
  } catch { /* The server still owns the job if browser storage is unavailable. */ }
  for (const listener of listeners) listener();
}
export function getGenerationTask() { return task; }
export function clearGenerationTask() {
  tracking?.abort();
  tracking = null;
  setGenerationTask({ status: "idle" });
}
onPrivateStateClear(clearGenerationTask);

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}
function cancelled() { return new ApiError("CANCELLED", "処理を中止しました。入力は保持しています。", 0); }
function transient(error: unknown) {
  return error instanceof ApiError && error.code !== "CANCELLED" &&
    (error.code === "NETWORK" || error.status >= 500 || error.status === 429);
}
function recordFailure(error: unknown, controller: AbortController) {
  if (controller.signal.aborted || tracking !== controller || task.status === "idle") return;
  setGenerationTask({ ...task, status: "failed", finishedAt: Date.now(), error });
}

async function pollTask(taskId: string, controller: AbortController): Promise<AiGenerateResponse> {
  const deadline = Date.now() + TRACKING_LIMIT_MS;
  let failures = 0;
  while (!controller.signal.aborted && tracking === controller) {
    let snapshot: AiGenerationTaskResponse;
    try {
      snapshot = await api.get<AiGenerationTaskResponse>(`/ai/generation-tasks/${taskId}`, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || tracking !== controller) throw cancelled();
      if (!transient(error) || Date.now() >= deadline) throw error;
      if (task.status === "running") setGenerationTask({ ...task, reconnecting: true });
      await wait(Math.min(POLL_MS * 2 ** Math.min(failures++, 3), 10_000), controller.signal);
      continue; // Retry GET only: never start another billable generation.
    }
    if (controller.signal.aborted || tracking !== controller) throw cancelled();
    failures = 0;
    const context = snapshot.context ?? (task.status !== "idle" ? task.context : {});
    const startedAt = Date.parse(snapshot.startedAt) || Date.now();
    const common = { taskId, accountId: snapshot.accountId, startedAt, context };
    if (snapshot.status === "done" && snapshot.result) {
      setGenerationTask({ ...common, status: "done", finishedAt: Date.parse(snapshot.finishedAt ?? "") || Date.now(), result: snapshot.result });
      return snapshot.result;
    }
    if (snapshot.status === "failed" || snapshot.status === "cancelled") {
      const e = snapshot.error;
      throw new ApiError(e?.code ?? "AI_FAILED", e?.message ?? "生成できませんでした。入力は保持しています。", e?.status ?? 502, e?.detail);
    }
    if (Date.now() >= deadline) throw new ApiError("TRACKING_TIMEOUT", "生成状況の確認がタイムアウトしました。入力は保持しています。", 504);
    setGenerationTask({ ...common, status: "running", reconnecting: false });
    await wait(POLL_MS, controller.signal);
  }
  throw cancelled();
}

export async function generateInBackground(body: AiGenerateRequest & { signal?: AbortSignal }): Promise<AiGenerateResponse> {
  if (tracking && task.status === "running") throw new ApiError("GENERATION_RUNNING", "生成中です。完了までお待ちください。", 409);
  const { signal, ...request } = body;
  const controller = new AbortController();
  tracking = controller;
  const cancel = () => { if (tracking === controller) cancelGenerationTask(); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) { tracking = null; throw cancelled(); }
  const { accountId, n: _n, ...context } = request;
  setGenerationTask({ status: "running", accountId, startedAt: Date.now(), context });
  try {
    const started = await api.post<AiGenerationTaskStartResponse>("/ai/generation-tasks", request, controller.signal);
    if (controller.signal.aborted || tracking !== controller) throw cancelled();
    setGenerationTask({ status: "running", taskId: started.taskId, accountId, startedAt: Date.parse(started.startedAt), context });
    return await pollTask(started.taskId, controller);
  } catch (error) {
    recordFailure(error, controller);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (tracking === controller) tracking = null;
  }
}

export function resumeGenerationTask(): Promise<void> {
  if (resumePromise || tracking || task.status !== "idle") return resumePromise ?? Promise.resolve();
  let stored: { taskId?: string; accountId?: string; startedAt?: number } | null = null;
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"); } catch { /* no saved task */ }
  if (!stored?.taskId || !stored.accountId) return Promise.resolve();
  const controller = new AbortController();
  tracking = controller;
  setGenerationTask({ status: "running", taskId: stored.taskId, accountId: stored.accountId, startedAt: stored.startedAt ?? Date.now(), context: {} });
  resumePromise = pollTask(stored.taskId, controller).then(() => undefined).catch(error => {
    if (error instanceof ApiError && error.code === "NOT_FOUND" && tracking === controller) clearGenerationTask();
    else recordFailure(error, controller);
  }).finally(() => {
    if (tracking === controller) tracking = null;
    resumePromise = null;
  });
  return resumePromise;
}
export function cancelGenerationTask() {
  const id = task.status === "running" ? task.taskId : undefined;
  clearGenerationTask();
  if (id) void api.del(`/ai/generation-tasks/${id}`).catch(() => {});
}
export function useGenerationTask() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getGenerationTask, getGenerationTask);
}
