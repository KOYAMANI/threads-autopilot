/**
 * Claude 連携の許可画面（`/oauth/authorize`）。SPA には入れず Worker が HTML を返す（`routes/action.ts` と同じ作り）。
 *
 * claude.ai からの遷移はクロスサイトなので、`SameSite=Strict` のセッション Cookie は最初の GET に付かない。
 * そこで GET では許可画面を出すだけにし、ログイン状態は「許可する」の POST（この画面からの同一サイト送信）で読む。
 */
import type { Env } from "../env";

export type ConsentView = {
  status: number;
  title: string;
  message: string;
  /** 許可フォーム。無ければ結果だけの画面 */
  form?: { handle: string; clientName: string; redirectHost: string; loopback: boolean };
  /** フォームの上に出す注意（ログインしていない等） */
  warn?: string;
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function consentPage(env: Env, view: ConsentView, extra?: Headers): Response {
  const appOrigin = env.APP_ORIGIN.replace(/\/+$/, "");
  const f = view.form;
  const form = f
    ? `<dl>
         <dt>接続するアプリ</dt><dd>${esc(f.clientName)}</dd>
         <dt>送り先</dt><dd>${esc(f.redirectHost)}${f.loopback ? "（この端末で動くアプリ。心当たりが無ければ許可しないでください）" : ""}</dd>
       </dl>
       <p class="note">できること: 「作る」画面で選んだ材料を読む・案を書き戻す。<br>できないこと: 投稿・予約・削除・設定の変更。</p>
       ${view.warn ? `<p class="warn" role="alert">${esc(view.warn)}</p>` : ""}
       <form method="post" action="/oauth/authorize">
         <input type="hidden" name="handle" value="${esc(f.handle)}">
         <button type="submit" name="decision" value="approve">許可する</button>
         <button type="submit" name="decision" value="deny" class="sub">許可しない</button>
       </form>`
    : "";
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(view.title)}｜Threads オートパイロット</title>
<style>
  :root { color-scheme: light dark; }
  /* アプリと同じ配色（白黒＋青1色。主ボタンは黒、青はリンクとフォーカスだけ。影は使わず細い線で区切る） */
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#f2f3f0; color:#16191d;
         font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  .card { width:min(26rem, calc(100vw - 2rem)); background:#fff; border:1px solid #e2e4e0; border-radius:14px; padding:1.75rem; }
  h1 { font-size:1.25rem; line-height:1.25; letter-spacing:-.02em; margin:0 0 .75rem; }
  p { font-size:.95rem; line-height:1.6; margin:0 0 1rem; }
  dl { margin:0 0 1rem; display:grid; grid-template-columns:auto 1fr; gap:.35rem .75rem; font-size:.9rem; }
  dt { color:#5b626a; } dd { margin:0; font-weight:600; overflow-wrap:anywhere; }
  .note { color:#5b626a; font-size:.85rem; }
  .warn { color:#8a5a00; background:#fff6e5; border-radius:10px; padding:.6rem .75rem; font-size:.9rem; }
  form { display:grid; gap:.6rem; }
  button { width:100%; padding:.85rem 1rem; font-size:1rem; font-weight:600; color:#fff;
           background:#16191d; border:1px solid #16191d; border-radius:10px; cursor:pointer; transition:transform 100ms ease-out; }
  button.sub { color:#16191d; background:#fff; border-color:#e2e4e0; }
  button:active { transform:scale(.97); }
  button:focus-visible, a:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
  a { display:inline-block; margin-top:1rem; color:#2563eb; font-size:.9rem; }
  @media (prefers-reduced-motion: reduce) { button { transition:none; } button:active { transform:none; } }
  @media (prefers-color-scheme: dark) {
    body { background:#0d0f13; color:#e8eaed; }
    .card { background:#171a1f; border-color:#262a31; }
    .note, dt { color:#9aa0a8; }
    .warn { color:#ffd38a; background:#3a2a10; }
    button { color:#0d0f13; background:#e8eaed; border-color:#e8eaed; }
    button.sub { color:#e8eaed; background:#171a1f; border-color:#3a3f47; }
  }
</style>
</head>
<body>
  <main class="card">
    <h1>${esc(view.title)}</h1>
    <p>${esc(view.message)}</p>
    ${form}
    <a href="${esc(appOrigin)}/app/home" target="_blank" rel="noopener">アプリを開く（ログイン）</a>
  </main>
</body>
</html>`;
  const headers = new Headers(extra);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store, private");
  // no-referrer だとブラウザは同一オリジンのフォーム送信でも `Origin: null` を送り、
  // `mcp/index.ts` の Origin 照合が必ず落ちる。外には出さず、同一オリジンにだけ送る
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Robots-Tag", "noindex");
  headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("X-Frame-Options")) headers.set("X-Frame-Options", "DENY");
  return new Response(html, { status: view.status, headers });
}
