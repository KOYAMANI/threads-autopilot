# Threads オートパイロット 実装仕様書

版: 1.0（2026-09-01）
対象: Claude Code（この文書だけで実装を進められるように書いてある）

同梱ファイル（必ず先に読む）:
- `threads-autopilot-prototype.jsx` … 画面の完成形。CSSトークン・レイアウト・文言はこれを正とする
- `Threads_API_全エンドポイント整理.md` … Threads APIの一次情報まとめ
- `Threadsオートパイロット_設計書v0.2.md` … 背景と意図

---

## 0. Claude Codeへの進め方

1. この仕様書を読み、§13の順番でマイルストーンごとに実装する。1マイルストーン＝1コミット以上
2. 各マイルストーンの「完了条件」を満たしたら、次へ進む前に `npm test` と `npm run typecheck` を通す
3. UIは `threads-autopilot-prototype.jsx` を分解して実装する。見た目・文言・操作の流れを変えない。変える必要があるときは理由をコミットメッセージに書く
4. 判断に迷ったら、この文書の「決めごと」（§2.4）に従う。書いていないことは、既存の実装と最も整合する方を選び、`DECISIONS.md` に1行追記する
5. Threads APIの実トークンなしで開発できるよう、§11のモックモードを最初に作る

---

## 1. プロダクト概要

Threadsアカウントを「見る→作る→出す→学ぶ」まで1つの画面で回すウェブアプリ。

| 機能 | 内容 |
|---|---|
| ホーム | 期間×指標で切り替えるダッシュボード（フォロワー推移、日別表示、トップ投稿、リンク別クリック） |
| 作る | 自分の過去投稿（型/リライト元）＋参考情報（テキスト/YouTube/ファイル/記事URL）＋指示 → AIで3案生成 → 編集/指示で修正 → キューへ |
| キュー | 予約・下書き・投稿済・失敗の管理。ツリー投稿（本文＋コメント①②③）、画像、リポスト |
| オートパイロット | 頻度・時間帯・ネタ源・リンクを設定すると、自動で下書き→承認方式に応じて投稿→48時間後に採点→次の生成に反映 |
| 設定 | アカウント（最大3）、AIキー（BYOK）、通知、リンク一覧、ライセンス |

ビジネス制約:
- 買い切り（ライセンスキー）。月額課金なし
- AIは買い手のキー（Gemini / OpenRouter）で動く。運営側にAI費用が発生しない
- Meta App Reviewを受けない。買い手が自分のMetaアプリでトークンを取得して貼る
- DM送信・他人のアカウントの取得・Webhookは使わない（API未提供または要審査）

---

## 2. 技術スタック

### 2.1 構成
```
[ブラウザ] React SPA (PWA)
    │ HTTPS  /api/*
[Cloudflare Worker]  Hono + TypeScript
    ├ fetch handler   … API と SPA配信（Workers Static Assets）
    └ scheduled handler … Cron Triggers（*/5, 毎時, 日次）
[D1]  SQLite
[外部] graph.threads.net / generativelanguage.googleapis.com / openrouter.ai / api.resend.com
```

### 2.2 採用ライブラリ
| 層 | ライブラリ |
|---|---|
| Worker | hono, zod, @cloudflare/workers-types |
| Web | react 18, react-dom, react-router-dom 6, @tanstack/react-query 5, recharts, lucide-react, vite, vite-plugin-pwa |
| 共通 | typescript (strict), vitest |
| ツール | wrangler 3.x |

ORMは使わない。D1は `env.DB.prepare(...).bind(...)` を薄くラップした `worker/src/lib/db.ts` から呼ぶ。

### 2.3 リポジトリ構成
```
threads-autopilot/
  package.json            # npm workspaces: worker, web, shared
  wrangler.toml
  README.md
  DECISIONS.md
  shared/
    src/types.ts          # API のリクエスト/レスポンス型（web と worker で共有）
    src/tags.ts           # フック型分類などの純関数（web/worker 両方で使う）
  worker/
    src/index.ts          # export default { fetch, scheduled }
    src/app.ts            # Hono app
    src/routes/auth.ts accounts.ts dashboard.ts posts.ts queue.ts sources.ts links.ts ai.ts autopilot.ts notifications.ts admin.ts
    src/lib/db.ts crypto.ts session.ts threads.ts ai.ts extract.ts email.ts jobs.ts budget.ts time.ts
    src/jobs/publish.ts sync.ts insights.ts clicks.ts followers.ts score.ts plan.ts notify.ts cleanup.ts
    src/mock/threads.ts   # モック応答
    migrations/0001_init.sql
    test/*.test.ts
  web/
    index.html
    src/main.tsx App.tsx
    src/api/client.ts     # fetch ラッパ（credentials: include）
    src/styles/tokens.css # プロトタイプの CSS をそのまま移植
    src/screens/Login.tsx Connect.tsx Home.tsx Create.tsx Queue.tsx Autopilot.tsx Settings.tsx
    src/components/*      # Sheet, Switch, Option, Toast, TopBar, ApBar, Tabs, Drawer, PostPicker, SourceAdder, ScheduleSheet ...
    src/lib/format.ts     # fmtN, fmtK, pct, md, mdhm（プロトタイプから）
  scripts/
    seed-demo.ts          # デモ用ダミーデータ投入（プロトタイプの makeAccount を移植）
    make-licenses.ts      # ライセンスキー生成
```

### 2.4 決めごと
- 時刻はDBにUTC（ISO8601文字列）で保存。表示はアカウントの `timezone`（既定 `Asia/Tokyo`）
- IDはすべて `crypto.randomUUID()`。Threads側のIDは文字列のまま保存（17桁の数値なので数値型にしない）
- 金額・回数はすべて整数
- API応答は `{ ok: true, data }` / `{ ok: false, error: { code, message } }`
- ユーザーに見せる文言は日本語、識別子は英語
- 秘密情報（トークン・AIキー）はログに出さない。`redact()` を通す
- Threads APIの失敗は、ユーザー向けの短い日本語＋原文（`#code message`）の両方を保存して表示する（既存ツールの教訓）

### 2.5 Cloudflareの制約と対応
| 制約 | Free | Paid($5/月) | 対応 |
|---|---|---|---|
| CPU時間/呼び出し | 10ms | 30s | 重い処理（PBKDF2、大量JSON）はPaid前提。**本番はPaidを推奨** |
| 外部fetch回数/呼び出し | 50 | 1,000 | ジョブは1回の実行で `MAX_SUBREQUESTS`（env、既定40）までしか呼ばず、残りは次回に持ち越す |
| Cron | 可 | 可 | 3本使う |
| D1 | 5M読/日, 100k書/日 | 拡張 | 数字の更新はUPSERTで1行1書き込み |

すべてのジョブは「途中で止まっても次回続きから再開できる」ように書く（§8）。

---

## 3. 環境変数・設定

### 3.1 wrangler.toml
```toml
name = "threads-autopilot"
main = "worker/src/index.ts"
compatibility_date = "2026-08-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./web/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*"]

[[d1_databases]]
binding = "DB"
database_name = "threads-autopilot"
database_id = "<wrangler d1 create で取得>"

[triggers]
crons = ["*/5 * * * *", "0 * * * *", "0 18 * * *"]   # UTC。18:00 UTC = 03:00 JST

[vars]
APP_ORIGIN = "https://threads-autopilot.<subdomain>.workers.dev"
DEFAULT_TZ = "Asia/Tokyo"
MAX_SUBREQUESTS = "40"
JOB_TIME_BUDGET_MS = "20000"
THREADS_MOCK = "0"
```

### 3.2 Secrets（`wrangler secret put`）
| 名前 | 内容 |
|---|---|
| `ENC_KEY` | 32バイトをbase64。トークン・AIキーの暗号化鍵 |
| `SESSION_SECRET` | 32バイト以上。セッション署名 |
| `ADMIN_SECRET` | 管理API（ライセンス発行）の鍵 |
| `RESEND_API_KEY` | メール送信 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push（M6） |

---

## 4. データモデル（D1）

`worker/migrations/0001_init.sql`:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL,
  license_id TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  created_at TEXT NOT NULL, last_login_at TEXT
);
CREATE TABLE licenses (
  id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'unused', -- unused|active|revoked
  note TEXT, issued_at TEXT NOT NULL, activated_at TEXT, user_id TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, ua TEXT
);
CREATE TABLE login_attempts (email TEXT NOT NULL, at TEXT NOT NULL);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, threads_user_id TEXT NOT NULL, username TEXT NOT NULL,
  name TEXT, avatar_url TEXT, color TEXT NOT NULL,
  token_enc TEXT NOT NULL, token_obtained_at TEXT NOT NULL, token_long_lived INTEGER NOT NULL DEFAULT 0,
  token_last_refresh_at TEXT, status TEXT NOT NULL DEFAULT 'ok', -- ok|needs_reauth|disabled
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo', settings_json TEXT NOT NULL DEFAULT '{}',
  last_full_sync_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(user_id, threads_user_id)
);
CREATE INDEX idx_accounts_user ON accounts(user_id);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,                       -- Threads media id
  account_id TEXT NOT NULL, root_id TEXT NOT NULL, is_reply INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '', permalink TEXT, media_type TEXT NOT NULL DEFAULT 'TEXT_POST',
  media_url TEXT, link_attachment_url TEXT, posted_at TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0, quotes INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0,            -- 按分後の推定クリック（root のみ）
  metrics_fetched_at TEXT, tags_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'external',   -- external|manual|autopilot|recycle
  queue_id TEXT, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_posts_account_posted ON posts(account_id, posted_at DESC);
CREATE INDEX idx_posts_root ON posts(root_id);

CREATE TABLE post_metrics_history (
  post_id TEXT NOT NULL, at TEXT NOT NULL, views INTEGER, likes INTEGER, replies INTEGER, reposts INTEGER, quotes INTEGER,
  PRIMARY KEY(post_id, at)
);
CREATE TABLE daily_views (account_id TEXT NOT NULL, date TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY(account_id, date));
CREATE TABLE follower_snapshots (account_id TEXT NOT NULL, date TEXT NOT NULL, followers INTEGER NOT NULL, PRIMARY KEY(account_id, date));
CREATE TABLE demographics (account_id TEXT NOT NULL, breakdown TEXT NOT NULL, json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(account_id, breakdown));
CREATE TABLE click_weeks (
  account_id TEXT NOT NULL, week_end TEXT NOT NULL, url TEXT NOT NULL, clicks INTEGER NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY(account_id, week_end, url)
);
CREATE TABLE click_weeks_done (account_id TEXT NOT NULL, week_end TEXT NOT NULL, PRIMARY KEY(account_id, week_end));

CREATE TABLE queue (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  status TEXT NOT NULL,                      -- draft|pending_approval|scheduled|publishing|done|failed|cancelled
  scheduled_at TEXT, body TEXT NOT NULL, comments_json TEXT NOT NULL DEFAULT '[]',
  image_url TEXT, reply_control TEXT NOT NULL DEFAULT 'everyone',
  source TEXT NOT NULL DEFAULT 'manual',     -- manual|autopilot|recycle
  approval_mode TEXT,                        -- manual|cancel|auto（autopilot のみ）
  approve_deadline TEXT, notified_at TEXT,
  step INTEGER NOT NULL DEFAULT 0, next_step_at TEXT, container_id TEXT,
  result_ids_json TEXT NOT NULL DEFAULT '[]', error TEXT, error_raw TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '{}', origin_post_id TEXT, source_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_queue_account_status ON queue(account_id, status, scheduled_at);
CREATE INDEX idx_queue_due ON queue(status, next_step_at);

CREATE TABLE sources (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, -- text|youtube|file|url
  title TEXT NOT NULL, url TEXT, content TEXT NOT NULL DEFAULT '', char_count INTEGER NOT NULL DEFAULT 0,
  enabled_for_ap INTEGER NOT NULL DEFAULT 1, last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE links (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, url TEXT NOT NULL, label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',        -- line|affiliate|other
  enabled_for_ap INTEGER NOT NULL DEFAULT 1, last_used_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(account_id, url)
);

CREATE TABLE ai_settings (
  user_id TEXT PRIMARY KEY, provider TEXT NOT NULL,        -- gemini|openrouter
  key_enc TEXT, model TEXT, store_on_server INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE autopilot (
  account_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
  per_week INTEGER NOT NULL DEFAULT 7,       -- 週あたり本数（1日1本=7, 1日2本=14, 週3本=3, 週5本=5）
  slot_mode TEXT NOT NULL DEFAULT 'auto',    -- auto|fixed
  fixed_hour INTEGER, approval_mode TEXT NOT NULL DEFAULT 'cancel', -- manual|cancel|auto
  approval_window_h INTEGER NOT NULL DEFAULT 4, daily_limit INTEGER NOT NULL DEFAULT 1,
  quiet_hours INTEGER NOT NULL DEFAULT 1,    -- 0〜6時は出さない
  ng_words TEXT NOT NULL DEFAULT '', link_placement TEXT NOT NULL DEFAULT 'comment', -- comment|body|none
  hook_mode TEXT NOT NULL DEFAULT 'auto', fixed_hook TEXT, score_weights TEXT NOT NULL DEFAULT 'balanced', -- balanced|followers|clicks
  consecutive_failures INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE learning (
  account_id TEXT NOT NULL, dim TEXT NOT NULL, value TEXT NOT NULL, -- dim: hook|slot|hook_slot|length|source
  n INTEGER NOT NULL DEFAULT 0, score_sum REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, dim, value)
);
CREATE TABLE ap_log (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, ref_id TEXT);
CREATE INDEX idx_ap_log ON ap_log(account_id, at DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, account_id TEXT, state_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',    -- pending|running|done|failed
  priority INTEGER NOT NULL DEFAULT 5, next_run_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(status, next_run_at, priority);

CREATE TABLE notifications (
  user_id TEXT PRIMARY KEY, email_enabled INTEGER NOT NULL DEFAULT 1, push_enabled INTEGER NOT NULL DEFAULT 0,
  digest_hour INTEGER NOT NULL DEFAULT 8, updated_at TEXT NOT NULL
);
CREATE TABLE push_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
```

`tags_json` の形: `{"hook":"警告型","length":"100-200","slot":"21","daytype":"weekday","source_id":"...","link":"comment"}`

---

## 5. 認証・ライセンス・暗号

### 5.1 登録・ログイン
- `POST /api/auth/register` `{email, password, license_key}`
  - `licenses.key` が `unused` なら `active` にして `users` を作る。使用済み・存在しない → `LICENSE_INVALID`
  - パスワード: 8文字以上。PBKDF2-SHA256, 100,000回, salt 16バイト（WebCrypto）
- `POST /api/auth/login` `{email, password}` → セッション作成。失敗は同一メールで10分に10回まで（`login_attempts`）
- セッション: `sessions` 行＋Cookie `sid`（HttpOnly, Secure, SameSite=Strict, 30日）。CSRF対策として `/api/*` の変更系は `X-Requested-With: fetch` ヘッダ必須
- `POST /api/auth/logout`, `GET /api/auth/me` → `{user, accounts[], ai:{provider,model,hasKey,storeOnServer}, notifications}`

### 5.2 暗号（`lib/crypto.ts`）
- `encrypt(plain) → base64(iv(12) + ciphertext)`、`decrypt()`。AES-256-GCM、鍵は `ENC_KEY`
- Threadsトークン、AIキー、Push購読の3種にだけ使う
- 復号した値は関数スコープ内で使い切り、レスポンスやログに含めない

### 5.3 管理API
- `POST /api/admin/licenses` ヘッダ `X-Admin-Secret` `{count, note}` → `{keys:[]}`。形式 `TAP-XXXX-XXXX-XXXX`（英大文字+数字、I/O/0/1除外）
- `scripts/make-licenses.ts` はこのAPIを叩くだけ

---

## 6. Threads API 連携（`lib/threads.ts`）

### 6.1 共通
```ts
const BASE = "https://graph.threads.net/v1.0";
type ThreadsError = { code: number; subcode?: number; message: string; userMsg?: string; raw: string };
async function call(token, method: "GET"|"POST"|"DELETE", path, params, budget): Promise<any>
```
- `access_token` はクエリに付ける。POSTでもクエリでよい
- 失敗時はJSONの `error` から `ThreadsError` を作って throw。`code` が `4,17,32,613`（レート制限）は 1.5s→3s→6s で最大3回リトライ。`190` はアカウントを `needs_reauth` にして通知。それ以外はリトライしない
- `budget.use()` で1回の実行の外部fetch回数を数え、上限で `BudgetExceeded` を throw（ジョブは次回へ持ち越す）
- `THREADS_MOCK=1` のときは `mock/threads.ts` の応答を返す（§11）

### 6.2 ユーザー向け日本語（`threadsReason(e)`）
| 条件 | 文言 |
|---|---|
| code 10/200 または message に permission | 権限が足りません。Metaのアプリで threads_manage_insights と threads_content_publish にチェックを入れ、トークンを作り直してください |
| code 190 | トークンが期限切れか無効です。設定からつなぎ直してください |
| code 4/17/32/613 | Threads側が混み合っています。しばらく待つと自動で再試行します |
| message に LINK_LIMIT | 1投稿に入れられるリンクは5つまでです |
| それ以外 | Threadsがこの操作を受け付けませんでした |
常に末尾に `（Threadsからの返答: #code message）` を付ける。

### 6.3 使う呼び出し
| 目的 | 呼び出し | 備考 |
|---|---|---|
| 接続確認 | `GET /me?fields=id,username,name,threads_profile_picture_url` | |
| 長期化 | `GET /access_token?grant_type=th_exchange_token&client_secret=&access_token=` | App Secret は保存しない |
| 延長 | `GET /refresh_access_token?grant_type=th_refresh_token&access_token=` | 発行24h後から。週1で自動 |
| 投稿一覧 | `GET /me/threads?fields=id,text,permalink,timestamp,is_reply,replied_to,root_post,has_replies,media_type,media_url,link_attachment_url,is_quote_post&limit=100&after=` | 最大15ページ |
| 自分の返信 | `GET /me/replies?fields=同上&limit=100&after=` | `root_post.id` が自分の投稿のものだけ採用 |
| 投稿の数字 | `GET /{id}/insights?metric=views,likes,replies,reposts,quotes,shares` | `data[].values[0].value ?? total_value.value` |
| 日別表示 | `GET /me/threads_insights?metric=views&since=&until=` | 7日ずつ区切る。`data[0].values[{value,end_time}]` |
| URL別クリック | `GET /me/threads_insights?metric=clicks&since=&until=` | `data[0].link_total_values[{value,link_url}]`。§8.5の週グリッド |
| フォロワー数 | `GET /me/threads_insights?metric=followers_count` | `data[0].total_value.value` |
| 属性 | `GET /me/threads_insights?metric=follower_demographics&breakdown=age` | フォロワー100未満は失敗して良い |
| テキスト投稿 | `POST /me/threads` `media_type=TEXT&text=&auto_publish_text=true[&reply_to_id=][&reply_control=][&link_attachment=]` | 応答 `{id}` が公開済み投稿ID |
| 画像投稿 | `POST /me/threads` `media_type=IMAGE&image_url=&text=` → `GET /{container}?fields=status,error_message` → `FINISHED` で `POST /me/threads_publish?creation_id=` | statusは `IN_PROGRESS|FINISHED|ERROR|EXPIRED|PUBLISHED` |
| リポスト | `POST /{id}/repost` | |
| 残り枠 | `GET /me/threads_publishing_limit?fields=quota_usage,config,reply_quota_usage,reply_config` | 診断で表示 |

制限: 本文500文字（UTF-8で数える、絵文字注意）、1投稿にリンク5本まで、投稿250/日、返信1,000/日。投稿前に `validatePost()` で本文長・リンク本数・NGワードを検査する。

---

## 7. API 仕様（Hono ルート）

全ルート `/api` 配下。認証必須（`/auth/register`, `/auth/login`, `/health`, `/admin/*` 以外）。アカウント系は `accounts.user_id` が本人か必ず確認する。バリデーションは zod、型は `shared/src/types.ts` に置いて web と共有。

### 7.1 アカウント
| メソッド/パス | 内容 |
|---|---|
| `GET /accounts` | 一覧 `{id,username,name,avatar_url,color,status,tokenExpiresInDays,longLived,lastFullSyncAt,autopilotEnabled}` |
| `POST /accounts` `{token, app_secret?}` | §6.3の接続確認→長期化→保存。同一ユーザーで3件まで（`ACCOUNT_LIMIT`）。作成後に `full_sync` ジョブを投入。応答に `{account, longLived, secretIgnored}` |
| `DELETE /accounts/:id` | 関連データを全削除（posts, queue, learning, links, autopilot, jobs） |
| `POST /accounts/:id/refresh-token` | 手動延長 |
| `GET /accounts/:id/diagnose` | 6段の点検（トークン→/me→投稿→投稿の数字→アカウントの表示→クリック）を順に実行し `[{name, ok, detail}]` |
| `POST /accounts/:id/sync` | `full_sync` ジョブ投入（既に走っていれば何もしない）。`GET /accounts/:id/sync` で進捗 `{running, progress, total}` |
| `PATCH /accounts/:id` `{color?, timezone?, settings?}` | |

### 7.2 ダッシュボード
`GET /accounts/:id/dashboard?period=7|14|21|30|90|all`
```ts
{
  period, from, to,
  followers: { current, delta, series: [{date, n}] },
  views: { total, series: [{date, v}] },
  likes: number, clicks: number,
  posts: PostSummary[],        // 期間内のroot投稿すべて（client側で指標ソート）。children を含む
  links: [{url, label, kind, clicks, posts}],
  unassignedClicks: number
}
type PostSummary = { id, text, permalink, postedAt, mediaType, hasImage, views, likes, replies, reposts, quotes, shares, clicks, link:{url,label,kind}|null, hook, children:[{id,text,views}] }
```
- `delta` = 期間末フォロワー − 期間初フォロワー（スナップショットが1点しかない場合は0）
- クリックの按分: 期間に関係なく全期間で按分してから期間で絞る（§8.5）

### 7.3 投稿
| メソッド/パス | 内容 |
|---|---|
| `GET /accounts/:id/posts?q=&sort=views|likes|clicks|new&limit=30&cursor=` | 投稿選択用 |
| `GET /accounts/:id/posts/:postId` | 詳細＋履歴 |
| `POST /accounts/:id/posts/:postId/repost` | |

### 7.4 キュー
| メソッド/パス | 内容 |
|---|---|
| `GET /accounts/:id/queue?status=` | 一覧。`done` は `posts` の数字を結合 |
| `POST /accounts/:id/queue` `{status:'draft'|'scheduled', scheduledAt?, body, comments[], imageUrl?, replyControl?, originPostId?, sourceIds?}` | `validatePost()`。`scheduled` は `scheduledAt` 必須。`now` は `scheduledAt = now` |
| `PATCH /accounts/:id/queue/:qid` `{body?, comments?, scheduledAt?, status?}` | 編集・日時変更。`status:'scheduled'` で下書き→予約 |
| `POST /accounts/:id/queue/:qid/approve` | `pending_approval`→`scheduled`、または `approve_deadline` を消す |
| `POST /accounts/:id/queue/:qid/cancel` | 自動投稿の取消 → `status='cancelled'` ＋ `ap_log`。AP側は次の枠に別案を作る |
| `POST /accounts/:id/queue/:qid/publish-now` | `scheduled_at=now, next_step_at=now` |
| `POST /accounts/:id/queue/:qid/duplicate` | 下書きとして複製 |
| `DELETE /accounts/:id/queue/:qid` | `done` 以外 |
| `GET /accounts/:id/queue/suggest-slot` | おすすめ枠 `{at, reason, multiplier}`（§9.3） |

### 7.5 参考情報・リンク
| メソッド/パス | 内容 |
|---|---|
| `GET /sources` / `POST /sources` `{type,title?,url?,content?}` / `PATCH /sources/:id` / `DELETE /sources/:id` | `url` 型はサーバーで本文抽出（§10.4）。`content` は 50,000 文字で切る |
| `GET /accounts/:id/links` / `POST` `{url,label,kind}` / `PATCH /:lid` / `DELETE /:lid` | 同期で見つかったURLは `label=url` で自動追加 |

### 7.6 AI
| メソッド/パス | 内容 |
|---|---|
| `GET /ai/settings` / `PUT /ai/settings` `{provider, key?, model?, storeOnServer}` | `storeOnServer=false` ならキーを保存せず、`hasKey=false`。その場合オートパイロットは有効化できない |
| `POST /ai/test` | 1回だけ短い生成を試して `{ok, model, latencyMs}` |
| `POST /ai/generate` `{accountId, picks:[postId], pickMode:'template'|'rewrite', sourceIds:[], instruction, n:3, clientKey?}` | `{candidates:[{key,hook,body,comments[],basis}]}`。`clientKey` はブラウザ保存モード用（サーバーに保存しない） |
| `POST /ai/revise` `{accountId, candidate, instruction, history:[], clientKey?}` | 1案を直す |

### 7.7 オートパイロット
| メソッド/パス | 内容 |
|---|---|
| `GET /accounts/:id/autopilot` / `PUT` | 設定。`enabled=true` にする条件: AIキーがサーバー保存、参考情報1件以上、`status='ok'` |
| `GET /accounts/:id/autopilot/learning` | `[{dim, value, n, multiplier}]`（§9.2） |
| `GET /accounts/:id/autopilot/log?limit=50` | |
| `GET /accounts/:id/autopilot/next` | 次の自動投稿（queue の source=autopilot で status in pending_approval/scheduled の最初） |

### 7.8 通知・その他
| メソッド/パス | 内容 |
|---|---|
| `GET /notifications` / `PUT` | |
| `POST /push/subscribe` / `DELETE` | M6 |
| `GET /export/:accountId.csv` | 投稿と数字 |
| `GET /health` | `{ok, version}` |

---

## 8. ジョブ実行（`lib/jobs.ts`）

### 8.1 仕組み
- `jobs` テーブルがキュー。`scheduled()` が cron に応じてジョブを投入し、`runJobs()` が期限到来分を優先度順に処理する
- 1回の `runJobs()` は `JOB_TIME_BUDGET_MS` と `MAX_SUBREQUESTS` の範囲で動き、超えたらジョブの `state_json` を保存して `next_run_at=now` で戻す（続きは次の5分で）
- 同じ `type+account_id` の `pending|running` ジョブは重複投入しない
- `running` のまま10分以上経ったジョブは `pending` に戻す（クラッシュ対策）
- 失敗は `attempts` を増やし、指数バックオフ（1,2,4,8分）で5回まで。以後 `failed`

### 8.2 Cronと投入するジョブ
| cron | 投入 |
|---|---|
| `*/5 * * * *` | `runJobs()` のみ（publish系は常に最優先） |
| `0 * * * *` | 各アカウント: `insights_recent`（3日以内の投稿）、`ap_plan`、`ap_notify` |
| `0 18 * * *`（03:00 JST） | 各アカウント: `full_sync` → `insights_daily`（3〜60日）→ 週1で `insights_old`（60日超）、`daily_views`、`clicks`、`followers`、`demographics`（週1）、`ap_score`、`token_refresh`（週1）、`cleanup` |

### 8.3 `publish` ジョブ（キュー1件＝ステップ実行）
`queue.status='scheduled' AND scheduled_at<=now AND (next_step_at IS NULL OR next_step_at<=now)` を拾い `publishing` にして進める。

```
step 0: 本文を投稿
  - approval_mode='manual' で status が pending_approval なら拾わない（approveで scheduled になる）
  - 画像あり: コンテナ作成 → container_id 保存 → step=1, next_step_at=now+30s
  - 画像なし: auto_publish_text で公開 → result_ids=[id] → コメントがあれば step=2, next_step_at=now+delay、なければ done
step 1: コンテナ状態確認 → FINISHED なら threads_publish → result_ids=[id] → コメントがあれば step=2 / ERROR なら failed / IN_PROGRESS なら next_step_at=now+30s
step 2..: comments[i] を reply_to_id=result_ids[last] で投稿 → result_ids に追加 → 次のコメントがあれば next_step_at=now+delay、無ければ done
```
- `delay` はアカウント設定 `commentDelaySec`（既定 120。cronが5分刻みなので実際は次の実行時）
- `done` 時: `posts` に root と comments を `source=manual|autopilot` で挿入（数字は次の `insights_recent` で入る）、`queue.tags_json` を root の `tags_json` にコピー
- 失敗: `error`（日本語）と `error_raw` を保存。レート制限は `next_step_at` を後ろにずらして再試行。二重投稿防止のため、成功した `result_ids` は必ず保存してから次へ進む
- 直前チェック: 1日の投稿上限（アカウント設定 `dailyPostLimit` 既定20）、投稿間隔（`minGapMin` 既定30）、直近30日と本文が80%以上一致するものがあれば `failed`（`source='recycle'` は除外）

### 8.4 同期ジョブ
- `full_sync`: `/me/threads` を15ページまで → upsert（既存の数字は保持）。次に `/me/replies` から自分の投稿にぶら下がる自分の返信を取り込む。`state_json={phase, after}` で再開可能。`REPOST_FACADE` は `deleted=1` 相当として画面に出さない
- `insights_recent|daily|old`: 対象投稿を `metrics_fetched_at` 古い順に、予算内で `/{id}/insights`。取れなかった投稿は前回値を残す（0で上書きしない）。`post_metrics_history` に1日1点だけ残す
- `daily_views`: 直近63日を7日窓で取得し `daily_views` へ upsert
- `followers`: `followers_count` を当日の `follower_snapshots` に upsert（取れた回だけ）
- `demographics`: 週1

### 8.5 `clicks` ジョブ（URL別クリックの週グリッド）
既存ツールで実証済みの方式をそのまま採用する。
- 起点 `CLICK_FLOOR = 1712991600`（2024-04-13）から7日刻みの固定グリッド。週の名前は `week_end` のUTC日付
- 遡る下限は「いちばん古い投稿の1週間前」
- 直近2週は毎回数え直し。それ以前は `click_weeks_done` に無い週だけ、1回の実行で最大26週
- 取れた週は `click_weeks` に upsert。同じ週×URLで前回より小さい値が来たら前回を残す
- 合計 = `SUM(clicks) GROUP BY url`。投稿への割り当て: 本文中URL（`extractUrls()`、末尾の句読点と全角括弧を除く）を root＋children から集め、同じURLが複数のツリーにある場合は root の `views` で按分。どの投稿にも無いURLは `unassignedClicks`
- 割り当て結果は `posts.clicks`（root のみ）に書く

### 8.6 `token_refresh`
`token_obtained_at` から24時間以上経過かつ最終延長から7日以上なら `refresh_access_token`。残り7日を切ったら通知。`190` なら `status='needs_reauth'` にして通知、オートパイロットを一時停止。

### 8.7 `cleanup`
`ap_log` 90日、`post_metrics_history` 180日、`login_attempts` 1日、`jobs.done` 7日、`sessions` 期限切れ。

---

## 9. オートパイロット（`jobs/plan.ts`, `jobs/score.ts`, `shared/src/tags.ts`）

### 9.1 タグ付け（純関数、web/worker共通）
`classifyHook(text)`: 1行目（60文字まで）に対する順序付きルール。最初に当たったもの。
| 型 | ルール（正規表現） |
|---|---|
| 意外性型 | `実は|本当は|誰も|知らない|バレ|裏側|知ってました` |
| 警告型 | `危険|注意|NG|ダメ|やめて|やめた方|禁止|逆効果|間違い|失敗|しないで|ないと|損` |
| 疑問型 | `[?？]\s*$|ますか|ですか|でしょうか|ある人` |
| 呼びかけ型 | `人へ|人は必見|人集合|方へ|あなた|さん、|全員|人、` |
| 数字型 | `[0-9０-９]+(つ|個|選|割|％|%|倍|日|分|円|位|歳|代|本)` |
| 体験談型 | `私は|私が|やってみた|続けて|分かった|わかった|してた|だった` |
| 断定型 | `です。|ます。|です$|ます$|だ。|である` |
| その他 | 上記以外 |

`lengthBucket(text)`: `<100 | 100-200 | 200-300 | 300+`（文字数）
`slotOf(date, tz)`: 時刻の「時」（0〜23）を3時間刻みで `0,3,6,...,21`。`daytype`: 土日なら `weekend`、それ以外 `weekday`
外部投稿（`source='external'`）にも `full_sync` 時に同じ関数でタグを付ける（学習の母数を最初から確保するため）。

### 9.2 採点（`ap_score`、日次）
対象: 投稿から48時間以上経過し、まだ採点していない root 投稿（`tags_json.scored` 無し）。
```
pv = percentile(views, 直近180日のroot投稿のviews)          // 0..1
pl = percentile(likes/views, 同上)                          // 0..1（views=0は除外）
carry = children[0] ? children[0].views / views : null     // 0..1
ctr = link ? clicks/views : null
weights balanced : views .5, likes .2, carry .2, ctr .1
        followers: views .4, likes .3, carry .3, ctr 0
        clicks   : views .3, likes .1, carry .2, ctr .4
score = Σ w_i * v_i / Σ w_i（null の項は分母からも外す）
```
`learning` を更新: `dim ∈ {hook, slot(=slot+daytype), hook_slot, length, source}` それぞれ `n+=1, score_sum+=score`。`tags_json.scored=true`。
7日後にもう一度採点して差し替える（`scored7`）。差し替え時は前回分を引いてから足す。

倍率（画面表示用）: `multiplier = posterior / accountMean`、
`posterior = (score_sum + k*accountMean) / (n + k)`, `k=3`, `accountMean` = そのアカウントの全 score 平均（無ければ0.5）。

### 9.3 枠の選択（`suggest-slot` とAPで共用）
- 候補: 今から7日先までの、3時間刻み×曜日種別の枠。`quiet_hours` なら 0〜6時を除外。`slot_mode='fixed'` なら `fixed_hour` 固定
- 各候補の `posterior`（dim=slot）を計算。`n>=3` の枠を「実績あり」とする
- 80%: 実績ありの上位から、直近の未来で最も早いものを選ぶ。20%: `n<3` の枠からランダム（探索）
- 実績が1つも無いアカウント（投稿20本未満）は既定枠 `weekday 21時 / weekend 12時`
- 既に予約がある日は避ける（`daily_limit`）。`minGapMin` も守る

### 9.4 `ap_plan`（毎時）
enabled なアカウントごとに:
1. 今後24時間で必要な本数 = `per_week/7` を日割り（余りは週の前半に寄せる）。既に `source='autopilot'` で `pending_approval|scheduled` があれば差し引く
2. 不足分について、枠（§9.3）→ 型（dim=hook で同じ 80/20 選択。`hook_mode='fixed'` なら固定）→ ネタ源（`enabled_for_ap` かつ `last_used_at` が古い順。同じ源を7日以内に再使用しない）→ リンク（`enabled_for_ap`、`last_used_at` 古い順）を決める
3. 生成（§10.3のAPプロンプト）。失敗したら `ap_log` に記録し、`consecutive_failures+=1`。3回連続で `enabled=0` にして通知
4. `queue` に挿入: `source='autopilot'`, `approval_mode`, `scheduled_at=枠`, `tags_json`, `origin_post_id`(文体見本の先頭), `source_ids_json`
   - `manual`: `status='pending_approval'`
   - `cancel`: `status='scheduled'`, `approve_deadline = scheduled_at - approval_window_h`
   - `auto`: `status='scheduled'`
5. `ap_log`: 「9/2 21:00の下書きを作りました（警告型 / ネタ源: 〇〇）」

### 9.5 `ap_notify`（毎時）
- `manual`: 作成直後に通知（「承認してください」）
- `cancel`: `now >= approve_deadline` かつ `notified_at` 無しなら通知（「4時間後に出ます。取り消すならこちら」）
- `auto`: 投稿後に通知
通知はメール（§10.5）。Web Push は M6。

### 9.6 安全装置
- `validatePost()` にNGワード、500文字、リンク5本、本文にリンクを置かない（`link_placement='comment'` 時）
- 重複80%チェック（§8.3）
- `daily_limit`、`quiet_hours`
- Threads失敗3連続で自動停止＋通知
- `needs_reauth` のアカウントは計画しない

---

## 10. AI 連携（`lib/ai.ts`）

### 10.1 プロバイダ
| provider | エンドポイント | 既定モデル |
|---|---|---|
| gemini | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=` | `gemini-2.5-flash` |
| openrouter | `POST https://openrouter.ai/api/v1/chat/completions`（`Authorization: Bearer`, `HTTP-Referer: APP_ORIGIN`, `X-Title: Threads Autopilot`） | ユーザー選択（既定 `anthropic/claude-sonnet-4.6`） |

- 出力はJSON固定。Gemini は `generationConfig.responseMimeType='application/json'`、OpenRouter は `response_format:{type:'json_object'}`。どちらも失敗時は ```json フェンスを剥がしてパースを試み、それでもダメなら `AI_BAD_OUTPUT`
- タイムアウト 60秒、1回リトライ
- キーの所在: `store_on_server=1` ならDBの `key_enc`、`0` ならリクエストの `clientKey`（保存しない）

### 10.2 生成の入力を組み立てる（`buildContext`）
```
文体の見本: picks（pickMode=template）または、指定が無ければアカウントの score 上位3本（型が重ならないように）
リライト元: picks（pickMode=rewrite）の本文（1本目）
参考情報: sources の content を各3,000文字、合計9,000文字まで。youtube で Gemini の場合は content 空でも `file_data:{file_uri:url}` を contents に追加する（OpenRouter の場合は「文字起こしを貼ってください」の案内を返す）
リンク: アカウントの links（ラベルとURL）
制約: 500文字、リンク5本まで、リンクの置き場所、NGワード、絵文字方針（設定 `emoji: none|few`）
```

### 10.3 プロンプト
System（共通・日本語）:
```
あなたはThreads（Meta）の投稿を書く編集者です。読者はスマホで流し読みしています。
ルール:
- 1行目で「誰に向けた話か」か「結論」を言う。前置きは書かない
- 1投稿目は500文字以内。改行で区切り、1段落は3行以内
- リンクは {link_placement} に置く。本文にURLを書かない（placement=comment のとき）
- 使わない言葉: {ng_words}
- 文体は「文体の見本」に合わせる。語尾・一人称・改行の癖を真似る。内容は真似ない
- 参考情報に無いことを事実として書かない。数字は参考情報にあるものだけ使う
出力はJSONのみ:
{"candidates":[{"hook":"型名","body":"1投稿目","comments":["コメント①",...],"basis":"参考情報のどこを使ったか1文"}]}
```
User（作る画面）: 文体の見本 / リライト元（あれば「この投稿を、内容を保ったまま別の切り口で書き直す」）/ 参考情報 / 指示 / 「型を変えて{n}案。型の候補: 呼びかけ型, 警告型, 意外性型, 疑問型, 数字型, 断定型, 体験談型」
User（オートパイロット）: 同上だが型は1つに固定し `n=1`、ネタ源は選ばれた1件、リンクは選ばれた1件。
Revise: 直前の候補JSON＋会話履歴＋指示 → 同じJSON形式で1案。

### 10.4 参考情報の抽出（`lib/extract.ts`）
- `url`: サーバーで `fetch`（UA はブラウザ風、タイムアウト10秒、最大2MB）。`<script>/<style>/<nav>/<footer>` を除去し、`<article>` か `<main>` があればそこを優先、無ければ `<p>` を連結。50,000文字で切る。失敗したら `EXTRACT_FAILED`（画面は「本文を貼ってください」）
- `youtube`: URL正規化（`v=`, `youtu.be/`, `shorts/`）。タイトルは `https://www.youtube.com/oembed?url=...&format=json` から。本文は取らない（Geminiに動画を渡す。それ以外は貼付を促す）
- `file`: ブラウザで読んで `content` として送る（.txt/.md、2MBまで）

### 10.5 メール（`lib/email.ts`）
Resend `POST https://api.resend.com/emails`。差出人 `noreply@<domain>`。テンプレ: `ap_draft`（承認/取消リンク付き）、`publish_failed`、`token_expiring`、`needs_reauth`、`ap_stopped`。本文は日本語のプレーンテキスト＋アプリへのリンク。

---

## 11. モックとシード

- `THREADS_MOCK=1` のとき `lib/threads.ts` は `mock/threads.ts` を使う。モックはメモリ上に投稿を持ち、`POST /me/threads` で投稿を追加して `{id}` を返す。`/insights` は投稿日からの経過で増える擬似数字を返す。`clicks` は本文中URLに対して返す。トークンが `THAAdemo` で始まる場合のみモックに入る（それ以外は実API）
- `scripts/seed-demo.ts`: プロトタイプの `makeAccount()` を移植し、`accounts/posts/daily_views/follower_snapshots/click_weeks/queue/sources/links/learning` を投入する。`npm run seed:demo -- --email demo@example.com`
- 開発は `wrangler dev` ＋ `vite`（プロキシ `/api` → 8787）

---

## 12. フロントエンド仕様

### 12.1 ルート
| パス | 画面 |
|---|---|
| `/login` | Login（登録/ログイン切替） |
| `/connect` | Connect（初回・追加の両方。`?add=1` で「戻る」表示） |
| `/app/home` `/app/create` `/app/queue` `/app/autopilot` `/app/settings` | 5画面。選択中アカウントは `localStorage.activeAccountId` |

未認証で `/app/*` → `/login`。アカウント0件で `/app/*` → `/connect`。

### 12.2 共通
- 画面幅 430px を上限に中央寄せ。`tokens.css` はプロトタイプの `CSS` 定数をそのまま移植
- TopBar（ハンバーガー / アカウントチップ / ＋）、ApBar（オートパイロット帯。`GET /autopilot/next` と連動）、Tabs（下部5タブ）、Drawer（アカウント切替＋メニュー＋ログアウト）
- データ取得は React Query。キーは `[accountId, resource, params]`。変更系の後は関連キーを invalidate
- 失敗はトースト＋画面内メッセージ。文言はAPIの `error.message` をそのまま出す
- `prefers-reduced-motion` を尊重（プロトタイプ同様）

### 12.3 各画面（プロトタイプとの対応）
| 画面 | データ | 備考 |
|---|---|---|
| Home | `GET /dashboard?period=` | 指標チップの並び替えは client。行タップで children と操作（リライト/リポスト/型にして作る/開く） |
| Create | `GET /posts`（picker）, `GET /sources`, `POST /ai/generate`, `POST /ai/revise`, `POST /queue`, `GET /queue/suggest-slot` | 「型にして作る/リライト」は `location.state.preset` で受ける。`clientKey` モードのときは `localStorage.aiKey` を付けて送る |
| Queue | `GET /queue?status=`, `PATCH/POST/DELETE` | 週表示は7日分。`approve_deadline` の残り時間は client で計算 |
| Autopilot | `GET/PUT /autopilot`, `GET /autopilot/learning`, `/log`, `/next` | ONにできない理由（AIキー未保存 / 参考情報0件 / 要再接続）をトーストで返す |
| Settings | `GET /accounts`, `GET/PUT /ai/settings`, `POST /ai/test`, `GET/PUT /notifications`, `GET /links`, `GET /accounts/:id/diagnose` | 「キーをこの端末にだけ保存」ONで `localStorage.aiKey` に保存し、サーバーには `storeOnServer=false` を送る |

### 12.4 PWA（M6）
`vite-plugin-pwa`。マニフェスト名「Threads オートパイロット」、アイコンは飛行機モチーフ（プロトタイプのロゴ）。Service Worker は静的資産のみキャッシュ、APIはキャッシュしない。Push は `push_subscriptions` に登録。

---

## 13. マイルストーンと完了条件

### M1 基盤
- monorepo、wrangler、D1マイグレーション、Hono、セッション、ライセンス登録/ログイン、暗号、管理API、`/health`
- モックモード、`seed-demo`
- 完了条件: `register→login→me` が通る。`ENC_KEY` で暗号化したトークンが復号できるテスト。ライセンス使い回し拒否のテスト

### M2 アカウント接続と同期
- `POST /accounts`（検証→長期化→保存）、`full_sync`、`insights_*`、`daily_views`、`followers`、`clicks`、`token_refresh`、ジョブ基盤、Cron
- 完了条件: モックで接続→5分cron相当を手動実行→`posts` と数字が入る。予算超過で途中終了→次回続きから完了する（テスト）。クリックの週グリッドが固定起点で二重計上しない（テスト）

### M3 ホーム画面
- Login / Connect / Shell（TopBar, ApBar, Tabs, Drawer）/ Home
- 完了条件: デモデータで期間・指標を切り替えて数字が変わる。ツリー展開、行の操作から `preset` 付きで Create に遷移する

### M4 キューと投稿
- Queue API、`publish` ジョブ（テキスト/ツリー/画像/リポスト）、Queue画面、`validatePost`
- 完了条件: モックで「今すぐ」「日時指定」「おすすめ枠」の3経路で投稿され、ツリーのコメントが `reply_to_id` で付く。途中失敗で二重投稿しない（テスト）。リンク6本で日本語エラー

### M5 作る（AI）
- AI設定、`generate/revise`、`extract`、Create画面（箱1/箱2/指示/3案/指示で直す/キューへ）
- 完了条件: Gemini と OpenRouter の両方でJSONが返り3案が出る（実キーで手動確認）。YouTube URL が Gemini 経路で通る。キーをブラウザ保存にしたときサーバーにキーが残らない（テスト）

### M6 オートパイロットと通知
- タグ付け、採点、learning、`ap_plan`、`ap_notify`、承認/取消、Autopilot画面、メール通知、PWA、Web Push
- 完了条件: デモアカウントでONにすると24時間分の下書きができ、`cancel` モードで `approve_deadline` に通知、期限後に投稿される（時刻を進めるテスト）。取消→`ap_log`。3連続失敗で自動停止

### M7 仕上げ
- 複数アカウント（3件上限、切替、削除）、診断、CSV書き出し、レート制限、監査ログ、README（デプロイ手順・買い手向けセットアップ手順のリンク）
- 完了条件: 3アカウントで数字とキューが混ざらない（テスト）。`wrangler deploy` で本番に上がる

---

## 14. テスト方針
- 純関数（`tags.ts`, `extractUrls`, 按分, 採点, 枠選択, 重複判定, `validatePost`, 暗号）は vitest で網羅
- ジョブは D1 をメモリ（`better-sqlite3` か Miniflare）で動かし、`now` を注入して時刻を進める
- Threads はモックで。実APIの疎通は `scripts/smoke.ts`（トークンを env で渡す）で手動
- 画面はスナップショットより「操作の流れ」の手動確認を優先。M3〜M6 の完了条件をチェックリスト化して `docs/qa.md` に置く

---

## 15. 非対象（やらないこと）
- DM送信、フォロー操作、いいね
- 他人のアカウントの検索・取得（`keyword_search`, `profile_lookup`）
- Webhook
- 動画投稿（M8以降で検討）
- 画像生成
- 買い手のセルフホスト用ボタン（将来）

---

## 16. 用語
| 用語 | 意味 |
|---|---|
| ツリー | 1投稿目（root）＋自分のコメント（children）。数字は root の views をリーチとみなす |
| 遷移率 | children[0].views / root.views |
| 按分 | 同じURLが複数ツリーにあるとき、クリックを root の views 比で分けること |
| 枠 | 3時間刻みの時間帯×曜日種別 |
| 取消可 | 投稿の N 時間前に通知し、取消が無ければ自動で出る承認方式 |
