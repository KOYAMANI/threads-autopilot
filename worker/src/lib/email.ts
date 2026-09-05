/**
 * メール送信（SPEC §10.5）。M1 は `password_reset` テンプレのみ先行実装する。
 * RESEND_API_KEY が未設定なら送らず、開発用にコンソールへ出して outbox に積む。
 */
import { DEV, type Env } from "../env";
import { redact, redactEmail } from "./redact";

export type EmailTemplate =
  | "password_reset"
  // 以下は M4 / M6 で実装する（テンプレ名だけ先に確定させておく）
  | "ap_draft"
  | "publish_failed"
  | "token_expiring"
  | "needs_reauth"
  | "ap_stopped";

export type SentEmail = {
  to: string;
  subject: string;
  text: string;
  template: EmailTemplate;
  at: string;
  via: "resend" | "console";
};

/**
 * ダミー送信（RESEND_API_KEY 未設定時）の控え。開発とテストから読む。
 * 本番では Resend 経路になるので積まれない。
 */
const outbox: SentEmail[] = [];

export function getOutbox(): readonly SentEmail[] {
  return outbox;
}

export function clearOutbox(): void {
  outbox.length = 0;
}

type Rendered = { subject: string; text: string };

export type TemplateVars = {
  password_reset: { url: string; appOrigin: string };
  ap_draft: Record<string, string>;
  publish_failed: Record<string, string>;
  token_expiring: Record<string, string>;
  needs_reauth: Record<string, string>;
  ap_stopped: Record<string, string>;
};

function render(template: EmailTemplate, vars: Record<string, string>): Rendered {
  switch (template) {
    case "password_reset":
      return {
        subject: "【Threads オートパイロット】パスワードの再設定",
        text: [
          "パスワードの再設定リンクをお送りします。",
          "",
          vars.url ?? "",
          "",
          "このリンクは30分で切れます。1回だけ使えます。",
          "再設定すると、いまログイン中のすべての端末からログアウトされます。",
          "",
          "心当たりがない場合は、このメールを捨ててください。パスワードは変わりません。",
          "",
          vars.appOrigin ?? "",
        ].join("\n"),
      };
    default:
      // M4 / M6 で埋める。到達したら分かるように本文へ書く。
      return {
        subject: `【Threads オートパイロット】${template}`,
        text: `このテンプレート（${template}）は未実装です。`,
      };
  }
}

export type SendResult = { ok: boolean; via: "resend" | "console"; error?: string };

/**
 * メールを1通送る。失敗しても呼び出し側の処理は止めない（結果を返すだけ）。
 * 本文・件名は日本語のプレーンテキスト。
 */
export async function sendEmail(
  env: Env,
  to: string,
  template: EmailTemplate,
  vars: Record<string, string> = {},
): Promise<SendResult> {
  const { subject, text } = render(template, vars);
  const from = env.MAIL_FROM ?? "noreply@example.com";

  if (!env.RESEND_API_KEY) {
    if (!DEV) {
      // 本番で鍵が無いのは設定漏れ。本文（リセットURL＝有効なワンタイムトークン）は絶対に出さない
      console.error(
        `[email] RESEND_API_KEY が未設定のため送信できません to=${redactEmail(to)} template=${template}`,
      );
      return { ok: false, via: "console", error: "RESEND_API_KEY unset" };
    }
    // DEV ビルドのみ。開発時の唯一の配送経路なので本文をそのまま出し、outbox に控える。
    // 本番ビルド（__DEV__=false）ではこの枝ごと通らず、outbox も積まれない。
    const entry: SentEmail = {
      to,
      subject,
      text,
      template,
      at: new Date().toISOString(),
      via: "console",
    };
    outbox.push(entry);
    if (outbox.length > 200) outbox.splice(0, outbox.length - 200);
    // 本文はそのまま出す。ここが開発時の唯一の配送経路で、リセットリンクを踏めないと
    // forgot → reset の手動確認（docs/qa.md 5-2）ができないため。DEV ビルド限定。
    console.log(
      `[email:dummy] to=${to} template=${template}\n--- subject ---\n${subject}\n--- body ---\n${text}\n---------------`,
    );
    return { ok: true, via: "console" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[email] resend failed status=${res.status} body=${redact(body).slice(0, 500)}`);
      return { ok: false, via: "resend", error: `status ${res.status}` };
    }
    return { ok: true, via: "resend" };
  } catch (e) {
    console.error(`[email] resend error: ${redact(String(e))}`);
    return { ok: false, via: "resend", error: "network" };
  }
}
