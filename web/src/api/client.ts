/**
 * API クライアント（SPEC §12.2）。
 * - Cookie を送る（credentials: include）
 * - 変更系は `X-Requested-With: fetch` を付ける（SPEC §5.1 の CSRF 対策）
 * - 失敗は ApiError（error.message をそのまま画面に出す）
 */
import type { ApiResponse } from "@tap/shared";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "fetch" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: "include",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError("NETWORK", "通信に失敗しました。電波の状況をご確認ください", 0);
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("INTERNAL", "サーバーの応答を読めませんでした", res.status);
  }

  const payload = json as ApiResponse<T> | { ok: boolean; [k: string]: unknown };
  if (payload && typeof payload === "object" && "ok" in payload && payload.ok === false) {
    const e = (payload as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(e?.code ?? "INTERNAL", e?.message ?? "処理に失敗しました", res.status);
  }
  if (!res.ok) {
    throw new ApiError("INTERNAL", "処理に失敗しました", res.status);
  }

  // {ok:true,data} 包みなら data を、素の形（/health）ならそのまま返す
  return ("data" in (payload as object) ? (payload as { data: T }).data : (payload as T)) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
};
