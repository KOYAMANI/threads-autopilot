/**
 * Threads API のエラー型と日本語化（SPEC §6.1 / §6.2）。
 *
 * `lib/threads.ts` と `mock/threads.ts` の両方から使うので独立したモジュールにしてある。
 * ここに置くことで `lib/threads.ts` がモック側の識別子を1つも書かずに済み、
 * `__DEV__=false` のビルドでモックの枝が完全に空になる（scripts/check-bundle.sh）。
 */
import { redact } from "./redact";

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
export const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

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

/** HTTP 応答の本文から ThreadsError を組み立てる。 */
export function parseThreadsError(status: number, bodyText: string): ThreadsError {
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
