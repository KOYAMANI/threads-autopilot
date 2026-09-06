/** Worker のバインディング一式（wrangler.toml の [vars] と Secrets）。 */
export type Env = {
  DB: D1Database;
  ASSETS?: Fetcher;

  // vars（SPEC §3.1）
  APP_ORIGIN: string;
  DEFAULT_TZ: string;
  MAX_SUBREQUESTS: string;
  MAX_DB_QUERIES: string;
  JOB_TIME_BUDGET_MS: string;
  THREADS_MOCK: string;
  REPLY_TWO_STEP: string;
  /** AI 呼び出しのモック（SPEC §11 と同じ DEV ガード）。`1` で `mock/ai.ts` を使う */
  AI_MOCK?: string;

  // secrets（SPEC §3.2）。開発は .dev.vars
  ENC_KEY: string;
  SESSION_SECRET: string;
  ADMIN_SECRET?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
};

/** package.json の version と揃える。/api/health が返す（SPEC §7.8）。 */
export const APP_VERSION = "0.1.0";

/**
 * `__DEV__`（ビルド時定数、`worker/src/globals.d.ts` 参照）の**実行時**の読み出し。
 * `/api/health` の `mock` フラグや診断表示に使う。
 *
 * デッドコード除去を当てにする分岐（`lib/threads.ts` のモック分岐）では、この定数ではなく
 * `__DEV__` を直接書くこと。クロスモジュールの定数を挟むと esbuild が枝を落とさない。
 * define が無い環境（素の node など）でも落ちないよう typeof で受ける。
 */
export const DEV: boolean = typeof __DEV__ === "undefined" ? true : __DEV__;

export function envInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}
