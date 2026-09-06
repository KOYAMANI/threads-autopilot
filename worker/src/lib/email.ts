/**
 * メール送信（SPEC §10.5）。M1 は `password_reset` テンプレのみ先行実装する。
 * RESEND_API_KEY が未設定なら送らず、開発用にコンソールへ出して outbox に積む。
 */
import { DEV, type Env } from "../env";
import { redact, redactEmail } from "./redact";

export type EmailTemplate =
  | "password_reset"
  | "ap_draft"
  | "ap_published"
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
  /** 自動投稿の下書き（SPEC §9.5）。`approveUrl` / `cancelUrl` は `/a/<token>`（ログイン不要） */
  ap_draft: {
    username: string;
    when: string;
    hook: string;
    body: string;
    mode: string;
    approveUrl?: string;
    cancelUrl?: string;
    appOrigin: string;
  };
  ap_published: { username: string; when: string; body: string; appOrigin: string };
  publish_failed: { username: string; reason: string; raw?: string; appOrigin: string };
  token_expiring: { username: string; days: string; appOrigin: string };
  needs_reauth: { username: string; appOrigin: string };
  ap_stopped: { username: string; reason: string; appOrigin: string };
};

/** 本文を読みやすい長さに切る（メールに投稿の全文を貼らない）。 */
function excerpt(text: string | undefined, max = 300): string {
  const t = (text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

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
    case "ap_draft": {
      // 承認方式で意味が変わる（SPEC §9.5）。`manual` は承認しないと出ない、
      // `cancel` は放っておくと出る。件名と1行目でどちらかが分かるようにする
      const cancelMode = Boolean(vars.cancelUrl) && !vars.approveUrl;
      const lines = [
        cancelMode
          ? `${vars.when ?? ""} に自動で投稿します。止めたいときだけ下のリンクを押してください。`
          : `${vars.when ?? ""} の下書きができました。承認すると投稿します。`,
        "",
        `アカウント: ${vars.username ?? ""}`,
        `型: ${vars.hook ?? ""}`,
        "",
        "--- 本文 ---",
        excerpt(vars.body),
        "------------",
        "",
      ];
      if (vars.approveUrl) lines.push("承認して投稿する:", vars.approveUrl, "");
      if (vars.cancelUrl) lines.push("取り消す:", vars.cancelUrl, "");
      lines.push(
        "リンクはログインしなくても開けます。1回だけ使えます。",
        "",
        vars.appOrigin ?? "",
      );
      return {
        subject: cancelMode
          ? `【Threads オートパイロット】${vars.when ?? ""} に投稿します（取り消せます）`
          : `【Threads オートパイロット】${vars.when ?? ""} の下書きを承認してください`,
        text: lines.join("\n"),
      };
    }

    case "ap_published":
      return {
        subject: "【Threads オートパイロット】自動投稿しました",
        text: [
          `${vars.when ?? ""} に自動で投稿しました。`,
          "",
          `アカウント: ${vars.username ?? ""}`,
          "",
          "--- 本文 ---",
          excerpt(vars.body),
          "------------",
          "",
          vars.appOrigin ?? "",
        ].join("\n"),
      };

    case "publish_failed":
      return {
        subject: "【Threads オートパイロット】投稿に失敗しました",
        text: [
          `${vars.username ?? ""} の投稿に失敗しました。`,
          "",
          vars.reason ?? "",
          ...(vars.raw ? ["", `Threads からの返答: ${vars.raw}`] : []),
          "",
          "キューの「失敗」タブから本文を直して出し直せます。",
          "",
          vars.appOrigin ?? "",
        ].join("\n"),
      };

    case "token_expiring":
      return {
        subject: "【Threads オートパイロット】トークンの期限が近づいています",
        text: [
          `${vars.username ?? ""} のトークンが、あと${vars.days ?? ""}日で切れます。`,
          "",
          "設定からつなぎ直してください。切れると自動投稿も数字の取得も止まります。",
          "",
          vars.appOrigin ?? "",
        ].join("\n"),
      };

    case "needs_reauth":
      return {
        subject: "【Threads オートパイロット】再接続が必要です",
        text: [
          `${vars.username ?? ""} のトークンが無効になりました。`,
          "",
          "設定からつなぎ直してください。つなぎ直すまで、自動投稿は止まります。",
          "",
          vars.appOrigin ?? "",
        ].join("\n"),
      };

    case "ap_stopped":
      return {
        subject: "【Threads オートパイロット】オートパイロットを止めました",
        text: [
          `${vars.username ?? ""} のオートパイロットを止めました。`,
          "",
          `3回続けて失敗したためです。最後の理由: ${vars.reason ?? ""}`,
          "",
          "原因を直したら、自動の画面からもう一度オンにしてください。",
          "",
          vars.appOrigin ?? "",
        ].join("\n"),
      };

    default:
      return {
        subject: `【Threads オートパイロット】${template as string}`,
        text: `このテンプレート（${template as string}）は未実装です。`,
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
