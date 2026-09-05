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
 * ビルド時定数。wrangler.toml の [define] で false（本番安全側）、
 * `wrangler dev --define __DEV__:true` で true にする。
 * false のとき mock/ への動的 import が esbuild のデッドコード除去で消える（SPEC §11）。
 * vitest（workerd）では define されないので、undefined = 開発扱いにする。
 */
declare const __DEV__: boolean | undefined;
export const DEV: boolean = typeof __DEV__ === "undefined" ? true : __DEV__;

export function envInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}
