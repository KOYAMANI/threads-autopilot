/**
 * Threads API 呼び出し（SPEC §6）。
 * M1 では call() の骨格・threadsReason()・モック分岐までを置く。
 * 各エンドポイントのラッパ（full_sync / insights / publish）は M2 以降。
 */
import { DEV, type Env } from "../env";
import type { Budget } from "./budget";
import { redact } from "./redact";
import {
  isRateLimit,
  parseThreadsError,
  ThreadsApiError,
  type ThreadsError,
} from "./threads-error";

export const BASE = "https://graph.threads.net/v1.0";

// エラーまわりは lib/threads-error.ts に置いてある（mock からも使うため）。
// 呼び出し側は従来どおり lib/threads.ts から import できる。
export {
  isRateLimit,
  isTokenInvalid,
  parseThreadsError,
  RATE_LIMIT_CODES,
  ThreadsApiError,
  threadsReason,
  type ThreadsError,
} from "./threads-error";

const RETRY_DELAYS_MS = [1500, 3000, 6000];

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

/**
 * THREADS_MOCK=1 かつ DEV ビルドかつ `THAAdemo` トークンならモックに入る（SPEC §11）。
 * **表示・診断用**。`call()` の分岐にこの関数を使ってはいけない。関数を挟むと
 * esbuild のデッドコード除去が効かず、mock/ が本番バンドルに残る。
 */
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

  // `__DEV__` は esbuild の define で置き換わるビルド時定数（worker/src/globals.d.ts）。
  // ここは **識別子を直接** 書く。別モジュールの定数（env.ts の DEV）や shouldUseMock()
  // を挟むとデッドコード除去が効かない。枝の中でもモック側の名前を使わない
  // （default エクスポート経由。エラー整形もモック側で済ませる）。名前で呼ぶと
  // `__DEV__=false` のビルドで、消えた枝の中にその名前だけが文字列として残る。
  // 回帰確認は scripts/check-bundle.sh。
  if (__DEV__ && env.THREADS_MOCK === "1" && token.startsWith("THAAdemo")) {
    budget.subrequests.use();
    const mod = await import("../mock/threads");
    return mod.default({ token, method, path: p, params, now: options.now });
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

    lastError = parseThreadsError(res.status, bodyText);
    if (!isRateLimit(lastError) || attempt === RETRY_DELAYS_MS.length) break;
    await sleep(RETRY_DELAYS_MS[attempt]!);
  }

  throw new ThreadsApiError(lastError ?? { code: 0, message: "unknown", raw: "" });
}
