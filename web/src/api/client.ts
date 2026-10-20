/**
 * API クライアント（SPEC §12.2）。
 * - Cookie を送る（credentials: include）
 * - 変更系は `X-Requested-With: fetch` を付ける（SPEC §5.1 の CSRF 対策）
 * - 失敗は ApiError（error.message をそのまま画面に出す）
 */
import { beginRequest } from "../lib/session-boundary";
import type { ApiResponse } from "@tap/shared";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, readonly detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

let responseOwner: string | null = null;

async function sessionIsStillValid(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/me", {
      headers: { "X-Requested-With": "fetch" },
      credentials: "include",
      cache: "no-store",
    });
    // Only an explicit authentication rejection proves that the session ended.
    return response.status !== 401;
  } catch {
    // A network problem is not evidence that the session ended.
    return true;
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?:AbortSignal, rawBody = false): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "fetch" };
  if (body !== undefined) headers["Content-Type"] = rawBody && body instanceof Blob ? body.type : "application/json";

  const boundary = beginRequest();
  const cancel=()=>boundary.controller.abort();
  signal?.addEventListener("abort",cancel,{once:true});
  if(signal?.aborted)cancel();
  const finish=()=>{boundary.finish();signal?.removeEventListener("abort",cancel);};
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: "include",
      signal: boundary.controller.signal,
      cache: "no-store",
      ...(body === undefined ? {} : { body: rawBody ? body as BodyInit : JSON.stringify(body) }),
    });
  } catch {
    finish();
    if(boundary.controller.signal.aborted)throw new ApiError("CANCELLED","処理を中止しました。入力は保持しています。",0);
    throw new ApiError("NETWORK", "サーバーと通信できませんでした。接続状況を確認し、時間を置いて再試行してください", 0);
  }

  let json: unknown = null;
  try {
    json = await res.json();
    finish();
    if (!boundary.current()) throw new Error("session changed");
  } catch {
    finish();
    if(boundary.controller.signal.aborted)throw new ApiError("CANCELLED","処理を中止しました。入力は保持しています。",0);
    throw new ApiError("INTERNAL", "サーバーの応答を読めませんでした", res.status);
  }

  const owner = res.headers.get("X-Authenticated-User");
  const ownerChanged = Boolean(owner && responseOwner && owner !== responseOwner);
  const authMeExpired = res.status === 401 && path === "/auth/me" && Boolean(responseOwner);
  const otherUnauthorized = res.status === 401 && !path.startsWith("/auth/");
  if (ownerChanged || authMeExpired || (otherUnauthorized && !(await sessionIsStillValid()))) {
    window.dispatchEvent(new Event("tap:unauthorized"));
    throw new ApiError("UNAUTHORIZED", "ログイン状態が変わりました。再読み込みします", 401);
  }
  if (owner) responseOwner = owner;
  const payload = json as ApiResponse<T> | { ok: boolean; [k: string]: unknown };
  if (payload && typeof payload === "object" && "ok" in payload && payload.ok === false) {
    const e = (payload as { error?: { code?: string; message?: string; detail?: unknown } }).error;
    throw new ApiError(e?.code ?? "INTERNAL", e?.message ?? "処理に失敗しました", res.status, e?.detail);
  }
  if (!res.ok) {
    throw new ApiError("INTERNAL", "処理に失敗しました", res.status);
  }

  // {ok:true,data} 包みなら data を、素の形（/health）ならそのまま返す
  return ("data" in (payload as object) ? (payload as { data: T }).data : (payload as T)) as T;
}

export const api = {
  get: <T>(path: string, signal?:AbortSignal) => request<T>("GET", path, undefined, signal),
  post: <T>(path: string, body?: unknown, signal?:AbortSignal) => request<T>("POST", path, body ?? {}, signal),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
  upload: <T>(path: string, file: Blob, signal?: AbortSignal) => request<T>("POST", path, file, signal, true),
};
