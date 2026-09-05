/**
 * Threads API 呼び出し（SPEC §6）。
 * M1 では call() の骨格・threadsReason()・モック分岐までを置く。
 * 各エンドポイントのラッパ（full_sync / insights / publish）は M2 以降。
 */
import { DEV, type Env } from "../env";
import type { Budget } from "./budget";
import { redact } from "./redact";

export const BASE = "https://graph.threads.net/v1.0";

export type ThreadsError = {
  code: number;
  subcode?: number;
  message: string;
  userMsg?: string;
  raw: string;
};

export class ThreadsApiError extends Error {
  readonly code: number;
  readonly subcode?: number;
  readonly raw: string;

  constructor(e: ThreadsError) {
    super(e.message);
    this.name = "ThreadsApiError";
    this.code = e.code;
    if (e.subcode !== undefined) this.subcode = e.subcode;
    this.raw = e.raw;
  }

  toThreadsError(): ThreadsError {
    const out: ThreadsError = { code: this.code, message: this.message, raw: this.raw };
    if (this.subcode !== undefined) out.subcode = this.subcode;
    out.userMsg = threadsReason(out);
    return out;
  }
}

/** レート制限扱いのコード。1.5s → 3s → 6s で最大3回リトライする。 */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const RETRY_DELAYS_MS = [1500, 3000, 6000];

export function isRateLimit(e: ThreadsError): boolean {
  return RATE_LIMIT_CODES.has(e.code);
}

/** code 190 はトークン失効。アカウントを needs_reauth にする合図（SPEC §6.1）。 */
export function isTokenInvalid(e: ThreadsError): boolean {
  return e.code === 190;
}

/** SPEC §6.2 の対応表。末尾に必ず原文を付ける。 */
export function threadsReason(e: ThreadsError): string {
  const head = (() => {
    if (e.code === 10 || e.code === 200 || /permission/i.test(e.message)) {
      return "権限が足りません。Metaのアプリで threads_manage_insights と threads_content_publish にチェックを入れ、トークンを作り直してください";
    }
    if (e.code === 190) {
      return "トークンが期限切れか無効です。設定からつなぎ直してください";
    }
    if (RATE_LIMIT_CODES.has(e.code)) {
      return "Threads側が混み合っています。しばらく待つと自動で再試行します";
    }
    if (/LINK_LIMIT/i.test(e.message)) {
      return "1投稿に入れられるリンクは5つまでです";
    }
    return "Threadsがこの操作を受け付けませんでした";
  })();
  return `${head}（Threadsからの返答: #${e.code} ${e.message}）`;
}

export type ThreadsParams = Record<string, string | number | boolean | undefined | null>;

export type CallOptions = {
  budget: Budget;
  env: Env;
  /** テストで時刻・待機を差し替えるための注入点 */
  now?: number;
  sleep?: (ms: number) => Promise<void>;
};

function toQuery(params: ThreadsParams): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    q.set(k, String(v));
  }
  return q;
}

function parseError(status: number, bodyText: string): ThreadsError {
  let code = status;
  let message = bodyText.slice(0, 300);
  let subcode: number | undefined;
  try {
    const json = JSON.parse(bodyText) as {
      error?: { code?: number; error_subcode?: number; message?: string; type?: string };
    };
    if (json.error) {
      code = json.error.code ?? status;
      message = json.error.message ?? message;
      subcode = json.error.error_subcode;
    }
  } catch {
    // JSON でないときは本文をそのまま原文にする
  }
  const e: ThreadsError = { code, message, raw: redact(bodyText.slice(0, 1000)) };
  if (subcode !== undefined) e.subcode = subcode;
  return e;
}

/** THREADS_MOCK=1 かつ DEV ビルドかつ `THAAdemo` トークンならモックに入る（SPEC §11）。 */
export function shouldUseMock(env: Env, token: string): boolean {
  return DEV && env.THREADS_MOCK === "1" && token.startsWith("THAAdemo");
}

/** /api/health の `mock` フラグ。本番ビルドでは常に false になる。 */
export function mockAvailable(env: Env): boolean {
  return DEV && env.THREADS_MOCK === "1";
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Threads API を1回呼ぶ。
 * - access_token はクエリに付ける（POST でもクエリでよい）
 * - 失敗は ThreadsApiError を throw
 * - レート制限（4/17/32/613）だけ 1.5s→3s→6s で最大3回リトライ
 * - budget.subrequests.use() で外部 fetch 回数を数える（尽きたら BudgetExceeded）
 */
export async function call(
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: ThreadsParams,
  options: CallOptions,
): Promise<unknown> {
  const { budget, env } = options;
  const p = path.startsWith("/") ? path : `/${path}`;

  if (shouldUseMock(env, token)) {
    budget.subrequests.use();
    // DEV ガードの内側なので、本番バンドルではこの分岐ごと消える。
    const { mockCall, MockThreadsError } = await import("../mock/threads");
    try {
      const flat: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) flat[k] = String(v);
      }
      const args: Parameters<typeof mockCall>[0] = { token, method, path: p, params: flat };
      if (options.now !== undefined) args.now = options.now;
      return mockCall(args);
    } catch (e) {
      if (e instanceof MockThreadsError) {
        throw new ThreadsApiError({ code: e.code, message: e.message, raw: `#${e.code} ${e.message}` });
      }
      throw e;
    }
  }

  const sleep = options.sleep ?? defaultSleep;
  let lastError: ThreadsError | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    budget.subrequests.use();
    const query = toQuery({ ...params, access_token: token });
    const url = `${BASE}${p}?${query.toString()}`;

    const res = await fetch(url, { method });
    const bodyText = await res.text();

    if (res.ok) {
      try {
        return JSON.parse(bodyText) as unknown;
      } catch {
        throw new ThreadsApiError({
          code: res.status,
          message: "応答をJSONとして読めませんでした",
          raw: redact(bodyText.slice(0, 1000)),
        });
      }
    }

    lastError = parseError(res.status, bodyText);
    if (!isRateLimit(lastError) || attempt === RETRY_DELAYS_MS.length) break;
    await sleep(RETRY_DELAYS_MS[attempt]!);
  }

  throw new ThreadsApiError(lastError ?? { code: 0, message: "unknown", raw: "" });
}
