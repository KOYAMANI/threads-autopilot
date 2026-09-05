/**
 * ログに出す前に秘密情報を伏せる（SPEC §2.4）。
 * トークン・AIキー・Cookie・パスワードは redact() を通してからでないと出さない。
 */

const PATTERNS: Array<[RegExp, string]> = [
  // クエリに載る access_token / key / client_secret
  [/([?&](?:access_token|key|client_secret|token)=)[^&\s"']+/gi, "$1***"],
  // Authorization: Bearer xxx
  [/(Bearer\s+)[A-Za-z0-9._\-]+/g, "$1***"],
  // Cookie の sid
  [/(\bsid=)[^;\s"']+/g, "$1***"],
  // よくある API キーの見た目
  [/\bTHAAdemo[A-Za-z0-9_-]*/g, "THAAdemo***"],
  [/\bTHQ[A-Za-z0-9_-]{10,}/g, "THQ***"],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, "sk-***"],
  [/\bre_[A-Za-z0-9_-]{10,}/g, "re_***"],
  [/\bAIza[A-Za-z0-9_-]{10,}/g, "AIza***"],
];

/** 文字列内の秘密らしき箇所を伏せる。 */
export function redact(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

const SECRET_KEYS =
  /^(token|access_token|token_enc|password|pass|pass_hash|pass_salt|key|key_enc|client_secret|secret|enc_key|session_secret|admin_secret|resend_api_key|clientkey|authorization|cookie)$/i;

/** オブジェクトを丸ごとログに出すときに使う。値ごと伏せる。 */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "***" : redactObject(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** メールアドレスを部分的に伏せる（ログに残す必要があるときだけ使う）。 */
export function redactEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}***@${email.slice(at + 1)}`;
}
