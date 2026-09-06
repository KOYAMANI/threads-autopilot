/**
 * メールからの承認/取消（SPEC §7.9）。**Cookie を一切読まず、Cookie も作らない**。
 *
 * セッション Cookie は `SameSite=Strict` なので、メールクライアントからの遷移には付かない。
 * アプリ内URLを貼ると必ずログイン画面に飛ぶため、承認/取消だけは専用の経路にする。
 *
 * - `GET  /a/:token` … 確認画面（HTML）。トークンは消費しない
 * - `POST /a/:token` … 実行。トークンを消費して結果画面（HTML）を返す
 *
 * GET で確定させないのは、メールクライアントのリンクプリフェッチで誤って実行される
 * のを防ぐため。`X-Requested-With` も要求しない（メールから来た素のブラウザなので）。
 *
 * SPA のルートではなく Worker が直接 HTML を返す（`index.ts` から呼ばれる）。
 */
import type { Env } from "../env";
import { apLog } from "../lib/autopilot";
import { createBudget } from "../lib/budget";
import { createDb, type Db } from "../lib/db";
import { RATE_LIMITS, actionKey, rateAllow, rateRecord } from "../lib/rate";
import { verifyToken } from "../lib/session";

/** この経路で使う D1 クエリの上限（リクエスト1本ぶん。認証が無いので小さく取る）。 */
const ACTION_DB_QUERIES = 40;

type Outcome = {
  status: number;
  title: string;
  message: string;
  /** 確認画面のときだけ。押すと同じ URL に POST する */
  confirm?: { label: string; note: string };
};

/* ── HTML（日本語1枚。SPA には入れない） ─────────────── */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(env: Env, out: Outcome, formAction: string | null): Response {
  const appOrigin = env.APP_ORIGIN.replace(/\/+$/, "");
  const form =
    out.confirm && formAction
      ? `<form method="post" action="${esc(formAction)}">
           <p class="note">${esc(out.confirm.note)}</p>
           <button type="submit">${esc(out.confirm.label)}</button>
         </form>`
      : "";
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(out.title)}｜Threads オートパイロット</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#f6f7f9; color:#16181d;
         font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  .card { width:min(26rem, calc(100vw - 2rem)); background:#fff; border-radius:1rem; padding:1.75rem;
          box-shadow:0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.06); }
  h1 { font-size:1.25rem; line-height:1.25; letter-spacing:-.02em; margin:0 0 .75rem; }
  p { font-size:.95rem; line-height:1.6; margin:0 0 1rem; }
  .note { color:#5b6068; font-size:.85rem; }
  button { width:100%; padding:.85rem 1rem; font-size:1rem; font-weight:600; color:#fff;
           background:#4f7cff; border:0; border-radius:.7rem; cursor:pointer; }
  button:active { transform:scale(.98); }
  a { display:inline-block; margin-top:1rem; color:#4f7cff; font-size:.9rem; }
  @media (prefers-color-scheme: dark) {
    body { background:#0d0f13; color:#e8eaed; }
    .card { background:#171a1f; box-shadow:none; }
    .note { color:#9aa0a8; }
  }
</style>
</head>
<body>
  <main class="card">
    <h1>${esc(out.title)}</h1>
    <p>${esc(out.message)}</p>
    ${form}
    <a href="${esc(appOrigin)}/app/queue">アプリで開く</a>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: out.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // メールクライアントのプリフェッチと中間キャッシュに残さない
      "Cache-Control": "no-store, private",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}

const EXPIRED: Outcome = {
  status: 200,
  title: "リンクの有効期限が切れています",
  message: "もう一度お試しください。アプリからも承認・取消ができます。",
};

/* ── 本体 ───────────────────────────────────────────── */

type QueueRow = {
  id: string;
  account_id: string;
  status: string;
  scheduled_at: string | null;
  action_token_used_at: string | null;
};

async function loadQueue(db: Db, id: string): Promise<QueueRow | null> {
  return db.first<QueueRow>(
    "SELECT id, account_id, status, scheduled_at, action_token_used_at FROM queue WHERE id=?",
    id,
  );
}

const ALREADY_DONE: Outcome = {
  status: 200,
  title: "この操作はすでに完了しています",
  message: "同じリンクは1回だけ使えます。",
};

/**
 * SPEC §7.9 の3・4・5（遷移させずに返す状態）を判定する。
 *
 * 順番は 3（`publishing|done`）→ 5（トークン消費済み）→ 4（`cancelled|failed`）にしてある。
 * 仕様書の並びは 3 → 4 → 5 だが、そのままだと **自分で取り消した直後の2回目**が
 * 4 に当たり「すでに取り消されたか、投稿に失敗しています」になる。SPEC §13 M6 の完了条件は
 * 「同じトークンは2回目で『すでに完了しています』になる」と定めているので、消費済みの
 * 判定を先に置く。仕様書が 3 を最優先にしている理由（もう出てしまったことを伝える・
 * 遷移も消費もしない）は変えていない。
 */
function terminalOutcome(row: QueueRow): Outcome | null {
  if (row.status === "publishing" || row.status === "done") {
    return {
      status: 200,
      title: "もう投稿されています",
      message: "この下書きは投稿済みです。取り消しはできません。",
    };
  }
  if (row.action_token_used_at !== null) return ALREADY_DONE;
  if (row.status === "cancelled" || row.status === "failed") {
    return {
      status: 200,
      title: "この下書きは動かせません",
      message: "この下書きはすでに取り消されたか、投稿に失敗しています。",
    };
  }
  return null;
}

/**
 * `GET|POST /a/:token` を処理する。`index.ts` が `/a/` で始まるパスをここに渡す。
 * 呼び出し側は Cookie を渡さないし、こちらも読まない。
 */
export async function handleAction(request: Request, env: Env): Promise<Response> {
  const budget = createBudget({
    dbQueries: ACTION_DB_QUERIES,
    subrequests: 0,
    timeMs: Number.MAX_SAFE_INTEGER,
  });
  const db = createDb(env.DB, budget);
  const url = new URL(request.url);
  const token = decodeURIComponent(url.pathname.slice("/a/".length));
  const now = new Date();

  // レート制限（SPEC §5.1 / §7.9）。GET / POST の両方を数える
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = actionKey(ip);
  const allowed = await rateAllow(db, key, RATE_LIMITS.action.limit, RATE_LIMITS.action.windowMin, now);
  await rateRecord(db, key, now);
  if (!allowed) {
    return page(
      env,
      {
        status: 429,
        title: "しばらく待ってからお試しください",
        message: "短い時間に何度も開かれました。1分ほど空けてからもう一度どうぞ。",
      },
      null,
    );
  }

  if (token === "") return page(env, EXPIRED, null);

  const payload = await verifyToken(env.SESSION_SECRET, token, "qaction", Math.floor(now.getTime() / 1000));
  if (!payload) return page(env, EXPIRED, null);
  const action = payload.extra === "approve" ? "approve" : payload.extra === "cancel" ? "cancel" : null;
  if (!action) return page(env, EXPIRED, null);

  const row = await loadQueue(db, payload.sub);
  if (!row) {
    return page(
      env,
      { status: 200, title: "見つかりませんでした", message: "この下書きはもうありません。" },
      null,
    );
  }

  /* ── GET: 確認画面。トークンは消費しない ────────── */
  if (request.method !== "POST") {
    const terminal = terminalOutcome(row);
    if (terminal) return page(env, terminal, null);
    return page(
      env,
      {
        status: 200,
        title: action === "approve" ? "この下書きを投稿しますか？" : "この投稿を取り消しますか？",
        message:
          action === "approve"
            ? "承認すると、予定の時刻に自動で投稿します。"
            : "取り消すと投稿されません。オートパイロットは次の枠に別の案を作ります。",
        confirm: {
          label: action === "approve" ? "この下書きを投稿する" : "取り消す",
          note: "ボタンは1回だけ使えます。",
        },
      },
      url.pathname,
    );
  }

  /* ── POST: 実行（SPEC §7.9 の処理順を守る） ─────── */
  const terminal = terminalOutcome(row);
  if (terminal) return page(env, terminal, null); // 3・4。遷移も消費もしない

  const nowIso = now.toISOString();
  // 5・6。条件付き UPDATE の changes で同時押しも弾く
  const claim = await db.run(
    "UPDATE queue SET action_token_used_at=?, updated_at=? WHERE id=? AND action_token_used_at IS NULL",
    nowIso,
    nowIso,
    row.id,
  );
  if (claim.changes === 0) return page(env, ALREADY_DONE, null); // 同時押し

  // 7. 状態遷移
  if (action === "approve") {
    if (row.status !== "pending_approval") {
      return page(
        env,
        {
          status: 200,
          title: "承認は済んでいます",
          message: "この下書きは予定の時刻に投稿されます。",
        },
        null,
      );
    }
    await db.run(
      "UPDATE queue SET status='scheduled', approve_deadline=NULL, updated_at=? WHERE id=?",
      nowIso,
      row.id,
    );
  } else {
    if (row.status !== "pending_approval" && row.status !== "scheduled") {
      return page(
        env,
        { status: 200, title: "この下書きは動かせません", message: "状態が変わっています。" },
        null,
      );
    }
    await db.run(
      "UPDATE queue SET status='cancelled', next_step_at=NULL, updated_at=? WHERE id=?",
      nowIso,
      row.id,
    );
  }

  // 8. ap_log と audit_log
  await apLog(
    db,
    row.account_id,
    action === "approve" ? "approve" : "cancel",
    action === "approve"
      ? "メールのリンクから承認しました"
      : "メールのリンクから取り消しました",
    row.id,
    now,
  );
  await db.run(
    "INSERT INTO audit_log (id, user_id, at, action, detail) VALUES (?,NULL,?,?,?)",
    crypto.randomUUID(),
    nowIso,
    `queue.${action}.email`,
    JSON.stringify({ queueId: row.id, accountId: row.account_id }),
  );

  return page(
    env,
    action === "approve"
      ? {
          status: 200,
          title: "承認しました",
          message: "予定の時刻に投稿します。アプリからいつでも取り消せます。",
        }
      : { status: 200, title: "取り消しました", message: "この下書きは投稿されません。" },
    null,
  );
}
