# Threads オートパイロット 実装仕様書

版: 1.1（2026-09-03）
v1.0 からの変更: `DECISIONS.md` 参照
対象: Claude Code（この文書だけで実装を進められるように書いてある）

同梱ファイル（必ず先に読む）:
- `docs/prototype.jsx` … 画面の完成形。CSSトークン・レイアウト・文言はこれを正とする。**現時点で未着（再提供待ち）**。届くまでプロトタイプ準拠の実装（`tokens.css` の移植、`seed-demo` のデモデータ、M3以降の画面）には着手しない。M1 は暫定で進める（§11・§12.2・§13 M1）
- `docs/threads-api.md` … Threads APIの一次情報まとめ
- `docs/design-v0.2.md` … 背景と意図
- `docs/spec-v1.0.md` … 改訂前の仕様書（履歴用）

---

## 0. Claude Codeへの進め方

1. この仕様書を読み、§13の順番でマイルストーンごとに実装する。1マイルストーン＝1コミット以上
2. 各マイルストーンの「完了条件」を満たしたら、次へ進む前に `npm test` と `npm run typecheck` を通す
3. UIは `docs/prototype.jsx` を分解して実装する。見た目・文言・操作の流れを変えない。変える必要があるときは理由をコミットメッセージに書く。動き・触感・タイポの詰めは §12.5 のデザイン原則に従う
   - プロトタイプが未着の間は、M1 の `tokens.css` と `seed-demo` を**暫定版**で作る（§11・§12.2）。到着後、M3 の最初に両方をプロトタイプ準拠へ差し替える。暫定版に独自のデザイン判断を足さない（差し替えを重くしないため）
4. 判断に迷ったら、この文書の「決めごと」（§2.4）に従う。書いていないことは、既存の実装と最も整合する方を選び、`DECISIONS.md` に1行追記する
5. Threads APIの実トークンなしで開発できるよう、§11のモックモードを最初に作る
6. `docs/design-v0.2.md` と食い違ったら、この文書が正。特に費用は「本番はCloudflare Paid（月5ドル）必須」が正で、設計書の「0円」は誤り

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
- ホスティングとDBは運営側が持つ。運営コストは永続するので、販売時に「買い切り＝ホスティング込み◯年間」と期間を明示して売る（年数はオーナー確定待ち）。想定販売本数はD1の10GB上限に直結するため、§2.5 の注記を参照

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
| Web | react 18, react-dom, react-router-dom 6, @tanstack/react-query 5, recharts, lucide-react, motion, vite, vite-plugin-pwa |
| 共通 | typescript (strict), vitest |
| ツール | wrangler 3.x |

`motion` は §12.5 の spring アニメーション専用。CSS transition で足りるもの（`:active` のスケール等）には使わない。
ORMは使わない。D1は `env.DB.prepare(...).bind(...)` を薄くラップした `worker/src/lib/db.ts` から呼ぶ。

### 2.3 リポジトリ構成
```
threads-autopilot/
  package.json            # npm workspaces: worker, web, shared
  wrangler.toml
  README.md
  SPEC.md
  DECISIONS.md
  docs/                   # prototype.jsx（未着）, threads-api.md, design-v0.2.md, spec-v1.0.md
  .claude/skills/apple-design/SKILL.md   # §12.5 の出典。フロント実装時は必読
  shared/
    src/types.ts          # API のリクエスト/レスポンス型（web と worker で共有）
    src/tags.ts           # フック型分類などの純関数（web/worker 両方で使う）
    src/url.ts            # normalizeUrl / extractUrls（クリック按分とリンク突合で共用、§8.5）
  worker/
    src/index.ts          # export default { fetch, scheduled }
    src/app.ts            # Hono app
    src/routes/auth.ts accounts.ts dashboard.ts posts.ts queue.ts sources.ts links.ts ai.ts autopilot.ts notifications.ts admin.ts action.ts users.ts
    src/lib/db.ts crypto.ts session.ts threads.ts ai.ts extract.ts email.ts jobs.ts budget.ts time.ts
    src/jobs/publish.ts sync.ts insights.ts clicks.ts followers.ts score.ts plan.ts notify.ts cleanup.ts
    src/mock/threads.ts   # モック応答（DEVビルドのみ、§11）
    migrations/0001_init.sql
    test/*.test.ts
  web/
    index.html
    src/main.tsx App.tsx
    src/api/client.ts     # fetch ラッパ（credentials: include）
    src/styles/tokens.css # プロトタイプの CSS をそのまま移植（M1 は暫定版。§12.2）
    src/screens/Login.tsx Connect.tsx Home.tsx Create.tsx Queue.tsx Autopilot.tsx Settings.tsx
    src/components/*      # Sheet, Switch, Option, Toast, TopBar, ApBar, Tabs, Drawer, PostPicker, SourceAdder, ScheduleSheet ...
    src/lib/format.ts     # fmtN, fmtK, pct, md, mdhm（プロトタイプから）
    src/lib/motion.ts     # spring プリセット（§12.5）
  scripts/
    seed-demo.ts          # デモ用ダミーデータ投入（プロトタイプの makeAccount を移植）
    make-licenses.ts      # ライセンスキー生成
    smoke.ts              # 実トークンでのAPI疎通確認（§14、H5検証）
```

### 2.4 決めごと
- 時刻はDBにUTC（ISO8601文字列）で保存。表示はアカウントの `timezone`（既定 `Asia/Tokyo`）。timezone はアカウント単位のみで持つ（ユーザー単位では持たない）
- IDはすべて `crypto.randomUUID()`。Threads側のIDは文字列のまま保存（17桁の数値なので数値型にしない）
- Threads由来の行（`posts`, `post_metrics_history`）は必ず `account_id` を主キーに含める。同じThreadsアカウントを別ユーザーが接続してもデータが混ざらないようにする
- 金額・回数はすべて整数
- API応答は `{ ok: true, data }` / `{ ok: false, error: { code, message } }`
- ユーザーに見せる文言は日本語、識別子は英語
- 秘密情報（トークン・AIキー）はログに出さない。`redact()` を通す
- Threads APIの失敗は、ユーザー向けの短い日本語＋原文（`#code message`）の両方を保存して表示する（既存ツールの教訓）

### 2.5 Cloudflareの制約と対応
実測値（出典: Cloudflare Workers limits / D1 limits、2026-09-03 確認）。

| 制約 | Free | Paid($5/月) | 対応 |
|---|---|---|---|
| CPU時間/呼び出し | 10ms | 既定30秒・最大5分 | 重い処理（PBKDF2、大量JSON）はPaid前提。`JOB_TIME_BUDGET_MS`（既定20,000）は既定30秒の内側に収める |
| 外部fetch回数/呼び出し | 50 | 10,000（拡張可） | ジョブは1回の実行で `MAX_SUBREQUESTS`（env、既定300）までしか呼ばず、残りは次回に持ち越す |
| D1クエリ回数/呼び出し | 50 | 1,000 | `MAX_DB_QUERIES`（env、既定800）で数える。超過は subrequest と同じく持ち越し。upsertはマルチVALUESでまとめてクエリ数を圧縮する |
| 外部fetchの同時接続 | 6 | 6 | 並列取得を書くときの上限。6本を超えて並べない |
| Cronの壁時計時間 | 15分 | 15分 | 1回のジョブ実行は15分を超えない。時間予算はCPU側（20秒）で先に当たる |
| Cron Trigger本数/アカウント | 5 | 250 | 3本使う。増やす余地はある |
| D1 ストレージ | 5GB | 10GB/DB | `post_metrics_history` は投稿あたり3行のみ（§8.4）。全買い手が1つのDBに相乗りするため、販売本数がそのままストレージ寿命になる。1,000本以上を狙うならユーザー単位のシャーディング（shardごとにD1）をスキーマ段階で入れ直す必要がある |
| D1 読み書き/日 | 5M読, 100k書 | 拡張 | 数字の更新はUPSERTで1行1書き込み |
| D1 Time Travel | 7日 | 30日 | トークンを預かるので、復旧方針をREADMEに書く |
| Threads API 呼び出し/24h | `4800 × インプレッション数`（最低10で計算＝48,000回/日） | 同左 | アカウント側の制限（`docs/threads-api.md` §9）。表示回数が少ないアカウントほど上限が低い。投稿数千件を毎時全件取得する設計にしない（§8.2 の `insights_recent` は3日以内の投稿だけ） |

**本番はPaid必須**。Freeでは D1 クエリ50/呼び出しの制限により同期ジョブが1件も完走しない。
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
run_worker_first = ["/api/*", "/a/*"]

[[d1_databases]]
binding = "DB"
database_name = "threads-autopilot"
database_id = "<wrangler d1 create で取得>"

[triggers]
crons = ["*/5 * * * *", "0 * * * *", "0 18 * * *"]   # UTC。18:00 UTC = 03:00 JST

[vars]
APP_ORIGIN = "https://threads-autopilot.<subdomain>.workers.dev"
DEFAULT_TZ = "Asia/Tokyo"
MAX_SUBREQUESTS = "300"
MAX_DB_QUERIES = "800"
JOB_TIME_BUDGET_MS = "20000"
THREADS_MOCK = "0"
REPLY_TWO_STEP = "0"   # 1 にすると §8.3 のコメント投稿を3ステップ方式に切り替える
```

### 3.2 Secrets（`wrangler secret put`）
| 名前 | 内容 |
|---|---|
| `ENC_KEY` | 32バイトをbase64。トークン・AIキーの暗号化鍵 |
| `SESSION_SECRET` | 32バイト以上。セッション署名、および §5.4 / §7.9 のワンタイムトークンのHMAC鍵 |
| `ADMIN_SECRET` | 管理API（ライセンス発行）の鍵 |
| `RESEND_API_KEY` | メール送信 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push（M6） |

---

## 4. データモデル（D1）

`worker/migrations/0001_init.sql`:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL,
  license_id TEXT NOT NULL,
  created_at TEXT NOT NULL, last_login_at TEXT
);
CREATE TABLE licenses (
  id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'unused', -- unused|active|revoked
  note TEXT, issued_at TEXT NOT NULL, activated_at TEXT, user_id TEXT, revoked_at TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, ua TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE rate_events (                   -- 回数制限の記録（ログイン失敗・forgot・/a/* を1つのテーブルで持つ）
  key TEXT NOT NULL,                         -- 'login:<email>' | 'forgot:<email>' | 'action:<ip>'
  at TEXT NOT NULL
);
CREATE INDEX idx_rate_events ON rate_events(key, at);

CREATE TABLE password_resets (
  id TEXT PRIMARY KEY,                       -- トークンの jti。トークン本体は保存しない
  user_id TEXT NOT NULL, token_hash TEXT NOT NULL,  -- SHA-256(token)
  expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id, created_at DESC);

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
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,                          -- Threads media id（アカウントをまたぐと重複しうるので単独では主キーにしない）
  root_id TEXT NOT NULL, is_reply INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '', permalink TEXT, media_type TEXT NOT NULL DEFAULT 'TEXT_POST',
  media_url TEXT, link_attachment_url TEXT, posted_at TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0, quotes INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0,            -- 按分後の推定クリック（root のみ）
  metrics_fetched_at TEXT, tags_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'external',   -- external|manual|autopilot|recycle
  queue_id TEXT, deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id, id)
);
CREATE INDEX idx_posts_account_posted ON posts(account_id, posted_at DESC);
CREATE INDEX idx_posts_root ON posts(account_id, root_id);

CREATE TABLE post_metrics_history (
  account_id TEXT NOT NULL, post_id TEXT NOT NULL,
  checkpoint TEXT NOT NULL,                  -- '48h'|'7d'|'30d'
  at TEXT NOT NULL,                          -- 実際に取得した時刻（記録用。主キーには入れない）
  views INTEGER, likes INTEGER, replies INTEGER, reposts INTEGER, quotes INTEGER,
  PRIMARY KEY(account_id, post_id, checkpoint)
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
  action_token_used_at TEXT,                 -- メールからの承認/取消トークンを使った時刻（§7.9。1回で失効）
  step INTEGER NOT NULL DEFAULT 0, next_step_at TEXT, container_id TEXT,
  container_polls INTEGER NOT NULL DEFAULT 0, -- 今の container_id を IN_PROGRESS で何回見たか（§8.3。attempts とは別物）
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
  account_id TEXT NOT NULL, dim TEXT NOT NULL, value TEXT NOT NULL, -- dim: hook|slot|length|source
  n INTEGER NOT NULL DEFAULT 0, score_sum REAL NOT NULL DEFAULT 0,
  views_sum INTEGER NOT NULL DEFAULT 0, like_rate_sum REAL NOT NULL DEFAULT 0,  -- 画面表示用の素の集計（§7.7）
  updated_at TEXT NOT NULL,
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

投稿を参照するときは必ず `(account_id, id)` の組で引く。`queue.origin_post_id` は同じ行の `account_id` とセットで `posts` を引く。`post_metrics_history` も `(account_id, post_id)` で引く。

---

## 5. 認証・ライセンス・暗号

### 5.1 登録・ログイン・パスワード再設定
- `POST /api/auth/register` `{email, password, license_key}`
  - `licenses.key` が `unused` なら `active` にして `users` を作る。使用済み・存在しない・`revoked` → `LICENSE_INVALID`
  - パスワード: 8文字以上。PBKDF2-SHA256, 100,000回, salt 16バイト（WebCrypto）
- `POST /api/auth/login` `{email, password}` → セッション作成。失敗は同一メールで10分に10回まで
- 回数制限は `rate_events` テーブルで数える（`lib/session.ts` の `rateLimit(key, limit, windowMin)`）。数える対象が起きるたびに1行追記し、窓（`at > now - windowMin`）の件数が上限以上なら弾く。窓の外の行は `cleanup` が消す（§8.7）。キーの形:

  | 用途 | キー | 数える対象 | 制限 |
  |---|---|---|---|
  | ログイン | `login:<email>`（小文字化したメール） | 失敗だけ（成功したら消す） | 10分に10回 |
  | パスワード再設定の要求 | `forgot:<email>` | 全リクエスト | 10分に3回 |
  | メールからの承認/取消（§7.9） | `action:<ip>`（`CF-Connecting-IP`） | 全リクエスト（GET / POST とも） | 1分に20回 |

- セッション: `sessions` 行＋Cookie `sid`（HttpOnly, Secure, SameSite=Strict, 30日）。CSRF対策として `/api/*` の変更系は `X-Requested-With: fetch` ヘッダ必須
  - `SameSite=Strict` はメールからの遷移にCookieが付かない。承認/取消はCookieに依存しない別経路（§7.9）で行うので、この設定は緩めない
- `POST /api/auth/logout`, `GET /api/auth/me` → `{user, accounts[], ai:{provider,model,hasKey,storeOnServer}, notifications}`
- `POST /api/auth/forgot` `{email}`
  - 常に `{ok:true}` を返す（メールの存在を漏らさない）。制限は `forgot:<email>` で10分に3回まで（超えても `{ok:true}` を返し、メールだけ送らない）
  - 該当ユーザーがいれば `password_resets` に1行作り、リセットURLをメールで送る（テンプレ `password_reset`、§10.5）
  - トークン: §5.3 の署名トークン。`purpose='pwreset'`、`sub=password_resets.id`、有効30分。URLは `{APP_ORIGIN}/login?reset=<token>`
- `POST /api/auth/reset` `{token, password}`
  - 署名検証 → `password_resets` を `id` で引き、`SHA-256(token)` が `token_hash` と一致、`used_at IS NULL`、`expires_at > now` を確認。どれか外れたら `RESET_INVALID`（「リンクの有効期限が切れています。もう一度お試しください」）
  - 成功時: `pass_hash`/`pass_salt` を作り直す → `used_at=now` → **そのユーザーの `sessions` を全削除**（全端末ログアウト）→ 同じユーザーの未使用 `password_resets` も無効化 → `audit_log` に記録
  - 応答後、ログイン画面に戻して再ログインさせる（自動ログインはしない）

### 5.2 暗号（`lib/crypto.ts`）
- `encrypt(plain) → base64(iv(12) + ciphertext)`、`decrypt()`。AES-256-GCM、鍵は `ENC_KEY`
- Threadsトークン、AIキー、Push購読の3種にだけ使う
- 復号した値は関数スコープ内で使い切り、レスポンスやログに含めない

### 5.3 署名トークン（`lib/session.ts` の `signToken` / `verifyToken`）
パスワード再設定（§5.1）と、メールからの承認/取消（§7.9）で共用する。

```
payload = `${purpose}|${sub}|${extra}|${expires}`   // expires は UNIX秒
sig     = HMAC-SHA256(SESSION_SECRET, payload)
token   = base64url(payload) + "." + base64url(sig)
```
- `purpose ∈ {pwreset, qaction}`。`sub` は対象行のID、`extra` は用途ごとの補助値（`qaction` なら `approve|cancel`、`pwreset` なら空文字）
- 検証は「base64urlをデコード → 署名を再計算 → 定数時間比較 → `expires > now` → purpose 一致」の順。ひとつでも外れたら同じエラーを返す（どこで落ちたかを漏らさない）
- 署名だけでは1回性を保証できないので、消費済みかどうかは必ずDB側で見る（`password_resets.used_at` / `queue.action_token_used_at`）

### 5.4 管理API・ライセンス状態
- `POST /api/admin/licenses` ヘッダ `X-Admin-Secret` `{count, note}` → `{keys:[]}`。形式 `TAP-XXXX-XXXX-XXXX`（英大文字+数字、I/O/0/1除外）
- `POST /api/admin/licenses/:id/revoke` ヘッダ `X-Admin-Secret` → `status='revoked'`, `revoked_at=now`
- `scripts/make-licenses.ts` はこのAPIを叩くだけ
- `revoked` の扱い（返金対応で必ず踏む）:
  - ログイン時に確認。`revoked` なら `LICENSE_REVOKED`（「ライセンスが無効化されています」）でログインさせず、既存の `sessions` も全削除する
  - ジョブ実行時にも確認。`ap_plan` / `publish` は対象ユーザーの `licenses.status` を見て、`revoked` なら実行せず `autopilot.enabled=0` にして `ap_log` に記録する（セッションが生きているうちに自動投稿が続くのを防ぐ）
  - データは消さない（`DELETE /users/me` を踏んだときのみ削除、§7.8）

---

## 6. Threads API 連携（`lib/threads.ts`）

### 6.1 共通
```ts
const BASE = "https://graph.threads.net/v1.0";
type ThreadsError = { code: number; subcode?: number; message: string; userMsg?: string; raw: string };
type Budget = {
  subrequests: { use(n?: number): void; used: number; limit: number };  // 外部fetch回数（MAX_SUBREQUESTS）
  dbQueries:   { use(n?: number): void; used: number; limit: number };  // D1クエリ回数（MAX_DB_QUERIES）
  timeMs:      { check(): void; startedAt: number; limit: number };     // 経過時間（JOB_TIME_BUDGET_MS）
};
async function call(token, method: "GET"|"POST"|"DELETE", path, params, budget): Promise<any>
```
- `access_token` はクエリに付ける。POSTでもクエリでよい
- 失敗時はJSONの `error` から `ThreadsError` を作って throw。`code` が `4,17,32,613`（レート制限）は 1.5s→3s→6s で最大3回リトライ。`190` はアカウントを `needs_reauth` にして通知。それ以外はリトライしない
- `budget.subrequests.use()` で1回の実行の外部fetch回数を数え、上限で `BudgetExceeded` を throw（ジョブは次回へ持ち越す）。`budget.dbQueries.use()` は `lib/db.ts` が自動で呼び、`budget.timeMs.check()` はジョブのループ先頭で呼ぶ。3つのうちどれが尽きても同じ `BudgetExceeded` になる
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
| テキスト投稿 | `POST /me/threads` `media_type=TEXT&text=&auto_publish_text=true[&reply_to_id=][&reply_control=][&link_attachment=]` | 応答 `{id}` が公開済み投稿ID。`auto_publish_text` と `reply_to_id` の併用は未検証（§8.3・§14） |

`docs/threads-api.md` §3-6 は `auto_publish_text=true` と `reply_to_id` の併用を前提にツリー投稿の手順を書いているが、公式ドキュメントに併用可の明記が確認できていないため、この仕様書では**未検証扱い**とする。§8.3 に3ステップ方式の分岐を用意し、`scripts/smoke.ts`（§14）の結果で確定させる。

| 画像投稿 | `POST /me/threads` `media_type=IMAGE&image_url=&text=` → `GET /{container}?fields=status,error_message` → `FINISHED` で `POST /me/threads_publish?creation_id=` | statusは `IN_PROGRESS|FINISHED|ERROR|EXPIRED|PUBLISHED` |
| リポスト | `POST /{id}/repost` | |
| 残り枠 | `GET /me/threads_publishing_limit?fields=quota_usage,config,reply_quota_usage,reply_config` | 診断で表示 |

制限: 本文500文字、1投稿にリンク5本まで、投稿250/日、返信1,000/日。投稿前に `validatePost()` で本文長・リンク本数・NGワードを検査する。
本文長の数え方はAPI資料が「絵文字はUTF-8バイト数で数える」としており、コードポイント数と食い違う。`scripts/smoke.ts`（§14）で絵文字入りの本文を実測し、`validatePost()` の数え方を確定させる。確定するまでは「コードポイント数と UTF-8 バイト数の厳しい方」で判定する。

---

## 7. API 仕様（Hono ルート）

`GET|POST /a/:token`（§7.9）を除き、全ルート `/api` 配下。認証必須（`/auth/register`, `/auth/login`, `/auth/forgot`, `/auth/reset`, `/health`, `/admin/*` 以外）。アカウント系は `accounts.user_id` が本人か必ず確認する。投稿は `(account_id, id)` の組で引く。バリデーションは zod、型は `shared/src/types.ts` に置いて web と共有。

### 7.1 アカウント
| メソッド/パス | 内容 |
|---|---|
| `GET /accounts` | 一覧 `{id,username,name,avatar_url,color,status,tokenExpiresInDays,longLived,lastFullSyncAt,autopilotEnabled}` |
| `POST /accounts` `{token, app_secret?}` | §6.3の接続確認→長期化→保存。同一ユーザーで3件まで（`ACCOUNT_LIMIT`）。作成後に `full_sync` ジョブを投入。応答に `{account, longLived, secretIgnored}` |
| `DELETE /accounts/:id` | 関連データを全削除（posts, post_metrics_history, queue, learning, links, autopilot, jobs, daily_views, follower_snapshots, click_weeks, demographics, ap_log） |
| `POST /accounts/:id/refresh-token` | 手動延長 |
| `GET /accounts/:id/diagnose` | 6段の点検（トークン→/me→投稿→投稿の数字→アカウントの表示→クリック）を順に実行し `[{name, ok, detail}]` |
| `POST /accounts/:id/sync` | `full_sync` ジョブ投入（既に走っていれば何もしない）。`GET /accounts/:id/sync` で進捗 `{running, progress, total}` |
| `PATCH /accounts/:id` `{color?, timezone?, settings?}` | timezone はこのアカウントの表示時刻 |

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
- スナップショットが1点しかないとき（接続直後）は `followers.series.length===1` になる。画面は「明日から推移が出ます」を出す（§12.3 Home）
- クリックの按分: 期間に関係なく全期間で按分してから期間で絞る（§8.5）

### 7.3 投稿
| メソッド/パス | 内容 |
|---|---|
| `GET /accounts/:id/posts?q=&sort=views|likes|clicks|new&limit=30&cursor=` | 投稿選択用 |
| `GET /accounts/:id/posts/:postId` | 詳細＋履歴（`posts` と `post_metrics_history` を `(account_id, post_id)` で引く。履歴は 48h/7d/30d の3点） |
| `POST /accounts/:id/posts/:postId/repost` | |

### 7.4 キュー
アプリ内から操作するときの経路。メールのリンクからは §7.9 を使う。

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
| `GET /accounts/:id/queue/suggest-slot` | おすすめ枠 `{at, reason, n}`（§9.3） |

### 7.5 参考情報・リンク
| メソッド/パス | 内容 |
|---|---|
| `GET /sources` / `POST /sources` `{type,title?,url?,content?}` / `PATCH /sources/:id` / `DELETE /sources/:id` | `url` 型はサーバーで本文抽出（§10.4）。`content` は 50,000 文字で切る |
| `GET /accounts/:id/links` / `POST` `{url,label,kind}` / `PATCH /:lid` / `DELETE /:lid` | 同期で見つかったURLは `normalizeUrl()` を通して `label=url` で自動追加 |

### 7.6 AI
| メソッド/パス | 内容 |
|---|---|
| `GET /ai/settings` / `PUT /ai/settings` `{provider, key?, model?, storeOnServer}` | `storeOnServer=false` ならキーを保存せず、`hasKey=false`。その場合オートパイロットは有効化できない（`PUT` の応答に `{autopilotAvailable:false}` を含め、画面は保存前に確認を出す。§12.3 Settings） |
| `POST /ai/test` | 1回だけ短い生成を試して `{ok, model, latencyMs}` |
| `POST /ai/generate` `{accountId, picks:[postId], pickMode:'template'|'rewrite', sourceIds:[], instruction, n:3, clientKey?}` | `{candidates:[{key,hook,body,comments[],basis}]}`。`clientKey` はブラウザ保存モード用（サーバーに保存しない） |
| `POST /ai/revise` `{accountId, candidate, instruction, history:[], clientKey?}` | 1案を直す |

### 7.7 オートパイロット
| メソッド/パス | 内容 |
|---|---|
| `GET /accounts/:id/autopilot` / `PUT` | 設定。`enabled=true` にする条件: AIキーがサーバー保存、参考情報1件以上、`status='ok'`、ライセンスが `active` |
| `GET /accounts/:id/autopilot/learning` | 集計結果。`[{dim, value, n, avgScore, avgViews, likeRate}]`（§9.2）。`dim ∈ {hook, slot, length, source}`、`value` の形式は §9.1。`n < 10` の行は `avgScore`・`avgViews`・`likeRate` を `null` で返し、画面は数値を出さない（§12.3） |

`likeRate` = `like_rate_sum / n`。投稿ごとの「いいね ÷ 表示回数」を出してから平均した値であって、いいね合計 ÷ 表示回数合計ではない（表示回数の多い1本に引っ張られないようにするため）。`avgViews` = `views_sum / n`、`avgScore` = `score_sum / n`。いずれも 48h 時点の数字で集計する（§9.2）。
| `GET /accounts/:id/autopilot/log?limit=50` | |
| `GET /accounts/:id/autopilot/next` | 次の自動投稿（queue の source=autopilot で status in pending_approval/scheduled の最初） |

### 7.8 通知・その他
| メソッド/パス | 内容 |
|---|---|
| `GET /notifications` / `PUT` | |
| `POST /push/subscribe` / `DELETE` | M6 |
| `GET /export/:accountId?format=csv` | 投稿と数字。`format` は `csv` のみ（既定 `csv`）。パスに拡張子を食い込ませない |
| `DELETE /users/me` `{password}` | 退会。パスワード再確認のうえ全データを削除する（下） |
| `GET /health` | `{ok, version, mock}`。`mock` は `THREADS_MOCK` が有効かつモック実装がバンドルに含まれているときだけ `true`（§11） |

**`DELETE /users/me` の削除範囲**
そのユーザーが持つ全アカウントに対して §7.1 の `DELETE /accounts/:id` と同じ削除を実行したうえで、`user_id` を持つテーブルを全部消す。消し残しを作らないよう、対象を列挙する:

| 経路 | テーブル |
|---|---|
| §7.1 の全削除（アカウントごと） | `accounts`, `posts`, `post_metrics_history`, `queue`, `learning`, `links`, `autopilot`, `jobs`, `daily_views`, `follower_snapshots`, `click_weeks`, `click_weeks_done`, `demographics`, `ap_log` |
| `user_id` を持つテーブル | `sessions`, `password_resets`, `sources`, `ai_settings`, `notifications`, `push_subscriptions` |
| キー付きの記録 | `rate_events`（`login:<email>` / `forgot:<email>` の行） |

`licenses` は行を残し、`user_id` を外して `status='revoked'`, `revoked_at=now` にする（再利用させない）。`users` 行は削除する。`audit_log` には削除の事実だけ残す（メールは SHA-256 でハッシュ化して保存し、平文を残さない）。完了後にメールで通知する。

### 7.9 メールからの承認/取消（Cookie 非依存）
セッションCookieは `SameSite=Strict` なので、メールクライアントからの遷移にCookieは付かない。承認/取消はCookieを一切読まない専用経路で行う。

- `GET /a/:token` … 確認画面（HTML）。トークンは消費しない
- `POST /a/:token` … 実行。トークンを消費して結果画面（HTML）を返す
- 確認画面には「この下書きを投稿する / 取り消す」のボタンが1つだけあり、同じトークンを `POST` する same-origin フォーム。GETで確定させないのは、メールクライアントのリンクプリフェッチで誤って実行されるのを防ぐため
- どちらも Cookie を読まず、Cookie も作らない。`X-Requested-With` も要求しない

トークン仕様（§5.3 の `signToken` を `purpose='qaction'` で使う）:
```
payload = `qaction|${queue_id}|${action}|${expires}`   // action ∈ approve|cancel、expires は UNIX秒
sig     = HMAC-SHA256(SESSION_SECRET, payload)
token   = base64url(payload) + "." + base64url(sig)
```
- `expires` = `min(scheduled_at + 1時間, 発行時刻 + 72時間)` を UNIX秒にしたもの
- `POST` の処理順（この順を守る）:
  1. 署名検証・期限確認。失敗 → 「リンクの有効期限が切れています」
  2. `queue` を `id` で引く。無い → 「見つかりませんでした」
  3. `status` が既に `publishing|done` → 遷移も消費もせず「もう投稿されています」を返す（HTTP 200）。トークンは残るが、この状態から戻ることはないので実害はない
  4. `status` が `cancelled|failed` → 「この下書きはすでに取り消されています」（HTTP 200）
  5. `action_token_used_at IS NOT NULL` → 「この操作はすでに完了しています」（エラーにしない）
  6. `UPDATE queue SET action_token_used_at=now WHERE id=? AND action_token_used_at IS NULL` を実行し、`changes=0` なら5と同じ扱い（同時押し対策）
  7. 状態遷移。`approve`: `pending_approval` → `scheduled`（`approve_deadline=NULL`）。`cancel`: `pending_approval|scheduled` → `cancelled`
  8. `ap_log` と `audit_log` に記録
- レート制限: `/a/*` は認証が無いので、`rate_events` のキー `action:<ip>`（`CF-Connecting-IP`）で1分20回まで（§5.1）
- 結果画面は日本語のHTML1枚（アプリへのリンク付き）。SPAには入れず、Workerが直接返す

---

## 8. ジョブ実行（`lib/jobs.ts`）

### 8.1 仕組み
- `jobs` テーブルがキュー。`scheduled()` が cron に応じてジョブを投入し、`runJobs()` が期限到来分を優先度順に処理する
- 1回の `runJobs()` は3つの予算（§6.1 の `budget`）の範囲で動く: `JOB_TIME_BUDGET_MS`（既定20,000）、`MAX_SUBREQUESTS`（既定300）、`MAX_DB_QUERIES`（既定800）。どれか1つでも尽きたら `BudgetExceeded` を投げ、ジョブの `state_json` を保存して `next_run_at=now` で戻す（続きは次の5分で）
- D1クエリ予算は `lib/db.ts` が全クエリで `budget.dbQueries.use()` を呼んで数える。1呼び出しあたりの実測上限は Paid で1,000なので、既定800は余裕を200残した値。Free（50）では同期ジョブが完走しない
- クエリ数を減らす書き方を守る: 同期のupsertはマルチVALUES（`INSERT ... VALUES (...),(...),... ON CONFLICT DO UPDATE`）で1クエリ50行までまとめる。ループ内で1行ずつ書かない。分布や設定値はジョブの冒頭で1回だけ読む
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
  - 画像あり: コンテナ作成 → container_id 保存, container_polls=0 → step=1, next_step_at=now+30s
  - 画像なし: auto_publish_text で公開 → result_ids=[id] → コメントがあれば step=2, next_step_at=now+delay、なければ done
step 1: コンテナ状態確認 → FINISHED なら threads_publish → result_ids=[id] → コメントがあれば step=2 / ERROR なら failed
        IN_PROGRESS なら container_polls+=1, next_step_at=now+30s（10回で failed）
step 2..: コメントを reply_to_id=result_ids[last] で投稿する（下の2方式）
```

コメント投稿の2方式（`auto_publish_text` と `reply_to_id` の併用可否が未確定なので、切替を先に用意する）:

- **1ステップ方式（既定。`REPLY_TWO_STEP=0`）**
  `POST /me/threads media_type=TEXT&text=<comment[i]>&reply_to_id=<result_ids[last]>&auto_publish_text=true` → 応答の `{id}` を `result_ids` に追加 → 次のコメントがあれば `step+=1, next_step_at=now+delay`、無ければ done
  コメントの添字は `i = step - 2`

- **3ステップ方式（`REPLY_TWO_STEP=1`）**
  併用が Threads に拒否された場合の分岐。`i = floor((step-2)/3)`、`phase = (step-2)%3` として:
  ```
  phase 0: POST /me/threads media_type=TEXT&text=<comment[i]>&reply_to_id=<result_ids[last]>
           （auto_publish_text は付けない）→ 応答の {id} を container_id に保存, container_polls=0
           → step+=1, next_step_at=now+10s
  phase 1: GET /{container_id}?fields=status,error_message
           FINISHED → step+=1, next_step_at=now
           IN_PROGRESS → container_polls+=1, next_step_at=now+15s（同じ phase を繰り返す。10回で failed）
           ERROR|EXPIRED → failed（error_message を error_raw に保存）
  phase 2: POST /me/threads_publish?creation_id=<container_id> → 応答の {id} を result_ids に追加
           → container_id をクリア, container_polls=0
           → 次のコメントがあれば step+=1, next_step_at=now+delay、無ければ done
  ```
- コンテナ待ちの回数は `queue.container_polls` で数える（step 1 と phase 1 で共用）。`queue.attempts` はジョブ失敗の指数バックオフ用（§8.1）なので兼用しない。`container_id` を新しく取るたびに `container_polls=0` に戻す
- 切替の判断: `scripts/smoke.ts`（§14）で実トークンを使い、1ステップ方式でツリー2投稿目が作れるかを確認する。作れなければ `REPLY_TWO_STEP=1` にする。両方式のステップマシンをM4で実装し、テストも両方に対して書く
- ジョブ実行中に方式が変わっても壊れないよう、`step` の意味は「そのジョブ開始時の方式」で解釈せず、毎回 env を読んで解釈する。方式を切り替えるときは `publishing` のキューが無いことを確認してからにする

- `delay` はアカウント設定 `commentDelaySec`（既定 120。cronが5分刻みなので実際は次の実行時）
- `done` 時: `posts` に root と comments を `source=manual|autopilot` で挿入（数字は次の `insights_recent` で入る）、`queue.tags_json` を root の `tags_json` にコピー
- 失敗: `error`（日本語）と `error_raw` を保存。レート制限は `next_step_at` を後ろにずらして再試行。二重投稿防止のため、成功した `result_ids` は必ず保存してから次へ進む
- 直前チェック: 1日の投稿上限（アカウント設定 `dailyPostLimit` 既定20）、投稿間隔（`minGapMin` 既定30）、重複チェック（下）

**重複チェックの定義**（`shared/src/tags.ts` の `similarity(a, b)`）
```
normalize(t): URL（/https?:\/\/\S+/g）を除去 → 空白・改行・全角空白を除去 → 小文字化
grams(t):     normalize(t) の連続3文字を集合にする（長さ3未満なら1文字ずつの集合）
similarity(a,b) = |grams(a) ∩ grams(b)| / |grams(a) ∪ grams(b)|   // Jaccard係数
```
同一アカウントの直近30日の投稿（`posts` の `deleted=0` と、`queue` の `scheduled|pending_approval`）と比較し、`similarity >= 0.8` のものが1件でもあれば `failed`（error: 「直近30日に似た内容の投稿があります」）。`source='recycle'` の投稿は比較対象からも判定対象からも外す。

### 8.4 同期ジョブ
- `full_sync`: `/me/threads` を15ページまで → upsert（既存の数字は保持）。次に `/me/replies` から自分の投稿にぶら下がる自分の返信を取り込む。`state_json={phase, after}` で再開可能。`REPOST_FACADE` は `deleted=1` 相当として画面に出さない
- `insights_recent|daily|old`: 対象投稿を `metrics_fetched_at` 古い順に、予算内で `/{id}/insights`。取れなかった投稿は前回値を残す（0で上書きしない）。`posts` の現在値（views/likes/...）は毎回更新する
  - 履歴は**チェックポイント方式**で残す。投稿からの経過時間が `48h` / `7d` / `30d` を初めて超えた取得時に、そのチェックポイントの行を `post_metrics_history` に1行だけ挿入する（`INSERT ... ON CONFLICT DO NOTHING`。同じチェックポイントを2回書かない）
  - 1投稿あたり最大3行。日次のスナップショットは取らない（D1のストレージがそのまま販売本数の上限になるため、§2.5）
  - 30日を超えて初めて取得した投稿は `48h` と `7d` を埋めない（後から作らない）。欠けたチェックポイントは欠けたままにする
- `daily_views`: 直近63日を7日窓で取得し `daily_views` へ upsert
- `followers`: `followers_count` を当日の `follower_snapshots` に upsert（取れた回だけ）
- `demographics`: 週1

### 8.5 `clicks` ジョブ（URL別クリックの週グリッド）
既存ツールで実証済みの方式をそのまま採用する。
- 起点 `CLICK_FLOOR = 1712991600`（2024-04-13）から7日刻みの固定グリッド。週の名前は `week_end` のUTC日付
- 遡る下限は「いちばん古い投稿の1週間前」
- 直近2週は毎回数え直し。それ以前は `click_weeks_done` に無い週だけ、1回の実行で最大26週
- 取れた週は `click_weeks` に upsert。同じ週×URLで前回より小さい値が来たら前回を残す
- 合計 = `SUM(clicks) GROUP BY url`

**投稿への割り当て**
1. 突合キーは正規化URL。Threads が返す `link_url` も、投稿本文から拾ったURLも、両方 `normalizeUrl()`（`shared/src/url.ts`）を通してから比べる
2. 投稿側のURLは `extractUrls()` で root と children の本文から集める
3. あるURLについて、そのURLを含む投稿（root でも child でもよい）の `views` の比で按分する。既定の `link_placement='comment'` ではリンクはコメント側にあり、クリックは実際にコメントの表示回数に比例するため、root の views では按分しない
4. 1つのツリー内で root と child の両方に同じURLがあるときは、そのツリーの代表値として `max(views)` を1回だけ使う（同じツリーを二重に数えない）
5. 按分した値は root に集約して `posts.clicks`（root のみ）に書く。child に付いたクリックも root に足す
6. どの投稿とも一致しないURLの合計は `unassignedClicks`

**`normalizeUrl(u)`（`shared/src/url.ts`）**
```
1. トリムして、URLとしてパースできなければ小文字化した入力をそのまま返す
2. scheme と host を小文字化。host 末尾の "." を除去
3. 既定ポート（http:80 / https:443）を除去
4. フラグメント（#...）を除去
5. クエリから utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_id,
   fbclid, gclid, igshid, ref, ref_src, si を除去。残りはキー昇順に並べ替える
6. パス末尾の "/" を除去（パスが "/" だけの場合も除去して空にする）
7. 組み立て直して返す
```
**`extractUrls(text)`**: `/https?:\/\/[^\s]+/g` で拾い、末尾の `。、，．,.!?！？)）」』】>` と全角括弧を剥がしてから返す。重複は除く。

### 8.6 `token_refresh`
`token_obtained_at` から24時間以上経過かつ最終延長から7日以上なら `refresh_access_token`。残り7日を切ったら通知。`190` なら `status='needs_reauth'` にして通知、オートパイロットを一時停止。

### 8.7 `cleanup`
`ap_log` 90日、`jobs.done` 7日、`sessions` 期限切れ、`password_resets` 期限切れ7日超、`rate_events` 1日（最長の窓が10分なので1日で十分）。
`post_metrics_history` は期間では消さない（1投稿あたり最大3行しかないため）。削除された投稿（`posts.deleted=1` かつ削除から90日）に紐づく履歴だけを掃除する。

---

## 9. オートパイロット（`jobs/plan.ts`, `jobs/score.ts`, `shared/src/tags.ts`）

学習は「AIに考えさせる」ものではなく、投稿実績の単純集計。採点も集計も選択もすべて決定的な計算で行い、AIは本文生成にしか使わない（§10 冒頭）。

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
外部投稿（`source='external'`）にも `full_sync` 時に同じ関数でタグを付ける（集計の母数を最初から確保するため）。

学習する次元は `hook` / `slot` / `length` / `source` の4つ。型と枠は**独立に**集計する。交絡した組み合わせ次元（型×枠）は作らない。
`learning.value` の形式:

| dim | value の形 | 例 |
|---|---|---|
| `hook` | `classifyHook()` の型名 | `警告型` |
| `slot` | `<daytype>-<slot>`（`slotOf()` の3時間刻みの時） | `weekday-21`, `weekend-12` |
| `length` | `lengthBucket()` の値 | `100-200` |
| `source` | `sources.id`（外部投稿は `external`） | `9f3c...`, `external` |

`slot` だけ daytype と結合した1つの値にする。曜日種別で人の行動が変わり、切り離すと意味を失うため。型（`hook`）とは結合しない（§9.1 冒頭の独立集計）。画面では `weekday-21` を「平日 21時台」と表示する。

### 9.2 採点（`ap_score`、日次）
対象: 投稿から48時間以上経過し、まだ採点していない root 投稿（`tags_json.scored` 無し）。

**使う数字は 48h チェックポイントの値**。`posts` の現在値（`insights_recent` が更新し続ける最新値）ではなく、`post_metrics_history` の `checkpoint='48h'` 行の `views` / `likes` / `replies` を使う。古い投稿ほど数字が伸びて有利になる、という比較のゆがみを避けるため、全投稿を同じ経過時間の断面で並べる。
- `checkpoint='48h'` の行が無い投稿は**採点しない**。`tags_json.scored` は付けず、次回の日次で拾い直す（`insights_*` が 48h 行を入れた後に採点される）
- 30日を超えてから初めて同期された投稿は 48h 行を持たないので、永久に採点されない。これは意図した挙動（§8.4 の「欠けたチェックポイントは後から作らない」と揃える）
- `carry`（children[0].views）と `clicks` は 48h 行を持たないので、`posts` の現在値を使う。この2つは比率であって水準ではないため、断面のずれの影響が小さい

```
V     = history(48h).views、L = history(48h).likes
pv    = percentile(V, 分布)                                // 0..1
pl    = percentile(L/V, 分布)                              // 0..1（V=0は除外）
carry = children[0] ? children[0].views / V : null         // 0..1
ctr   = link ? clicks / V : null
weights balanced : views .5, likes .2, carry .2, ctr .1
        followers: views .4, likes .3, carry .3, ctr 0
        clicks   : views .3, likes .1, carry .2, ctr .4
score = Σ w_i * v_i / Σ w_i（null の項は分母からも外す）
```
- `percentile()` の分布は、ジョブの冒頭で**1回だけ**取得する。直近180日に投稿された root 投稿のうち `checkpoint='48h'` 行を持つものの `views` と `likes/views` を、それぞれ昇順のソート済み配列にしてメモリに置き、投稿ごとには二分探索で順位を引く。投稿ごとにSQLを投げない（D1クエリ予算とCPUの両方を食うため）。分布も採点対象と同じ 48h 断面で作る
- 分布の母数が10本未満のときは採点を見送る（`tags_json.scored` を付けない）。順位が意味を持たないため
- `learning` を更新: `dim ∈ {hook, slot, length, source}` それぞれ `n+=1, score_sum+=score, views_sum+=V, like_rate_sum+=(V>0 ? L/V : 0)`。加算する `views` と `likes` も 48h 時点の値
- `tags_json.scored=true` にする
- **採点は48時間の1回だけ**。7日後の再採点・差し替えはしない（`scored7` は廃止）。`post_metrics_history` の `7d` / `30d` は画面で伸び方を見せるための記録であって、採点には使わない

画面に返す値（§7.7）は集計そのもの。すべて 48h 時点の数字でできている:
```
avgScore  = score_sum / n
avgViews  = views_sum / n          // 48h時点の表示回数の平均
likeRate  = like_rate_sum / n      // 投稿ごとの (48hのいいね ÷ 48hの表示回数) の平均
```
事前分布・倍率（`posterior`, `multiplier`, `k`）は使わない。倍率は n が小さいときに大きく振れ、買い手が信じて運用を変えた結果が外れると信頼を失うため、平均値と本数をそのまま出す。

### 9.3 枠の選択（`suggest-slot` とAPで共用）
- 候補: 今から7日先までの、3時間刻み×曜日種別の枠。`quiet_hours` なら 0〜6時を除外。`slot_mode='fixed'` なら `fixed_hour` 固定
- `learning` の `dim='slot'` で `n >= 10` の枠だけを「実績あり」とする
- 実績ありが1つ以上あるとき: 平均 score（`score_sum / n`）の高い順に並べ、直近の未来で最も早く空いている枠を選ぶ。ただし直近3本の自動投稿と同じ枠は避ける（ローテーション）。候補が全部塞がったら制約を外して上位から選び直す
- 実績ありが0のとき: 既定枠（`learning.value` で言えば `weekday-21` / `weekend-12`）
- ランダム探索はしない（ローテーションで自然に散る）
- 既に予約がある日は避ける（`daily_limit`）。`minGapMin` も守る
- `suggest-slot` の応答 `{at, reason, n}`。`reason` は「21時台は32本の平均が上位です」または「実績がまだ足りないので既定の枠です」。倍率は返さない

### 9.4 `ap_plan`（毎時）
enabled なアカウントごとに:
1. ライセンスが `active` か確認する（`revoked` なら `enabled=0` にして終了、§5.4）
2. 今後24時間で必要な本数 = `per_week/7` を日割り（余りは週の前半に寄せる）。既に `source='autopilot'` で `pending_approval|scheduled` があれば差し引く
3. 不足分について順に決める:
   - 枠 … §9.3
   - 型 … `learning` の `dim='hook'` で `n >= 10` の型を平均 score の高い順に並べ、直近3本の自動投稿と同じ型を避けて選ぶ。`n >= 10` の型が1つも無ければ既定順（呼びかけ型 → 警告型 → 意外性型 → 数字型 → 体験談型 → 疑問型 → 断定型）のローテーション。`hook_mode='fixed'` なら `fixed_hook` に固定
   - ネタ源 … `enabled_for_ap` かつ `last_used_at` が古い順。同じ源を7日以内に再使用しない
   - リンク … `enabled_for_ap`、`last_used_at` 古い順
4. 生成（§10.3のAPプロンプト）。失敗したら `ap_log` に記録し、`consecutive_failures+=1`。3回連続で `enabled=0` にして通知
5. `queue` に挿入: `source='autopilot'`, `approval_mode`, `scheduled_at=枠`, `tags_json`, `origin_post_id`(文体見本の先頭), `source_ids_json`
   - `manual`: `status='pending_approval'`
   - `cancel`: `status='scheduled'`, `approve_deadline = scheduled_at - approval_window_h`
   - `auto`: `status='scheduled'`
6. `ap_log`: 「9/2 21:00の下書きを作りました（警告型 / ネタ源: 〇〇）」

### 9.5 `ap_notify`（毎時）
- `manual`: 作成直後に通知（「承認してください」）
- `cancel`: `now >= approve_deadline` かつ `notified_at` 無しなら通知（「4時間後に出ます。取り消すならこちら」）
- `auto`: 投稿後に通知
通知はメール（§10.5）。承認・取消のリンクは §7.9 の `{APP_ORIGIN}/a/<token>` を使う。ログイン状態に関係なく踏めるURLであることが要件（`SameSite=Strict` のCookieはメールからの遷移に付かないため、アプリ内URLを貼ると必ずログイン画面に飛ぶ）。Web Push は M6。

### 9.6 安全装置
- `validatePost()` にNGワード、500文字、リンク5本、本文にリンクを置かない（`link_placement='comment'` 時）
- 重複チェック（§8.3、3-gram Jaccard ≥ 0.8）
- `daily_limit`、`quiet_hours`
- Threads失敗3連続で自動停止＋通知
- `needs_reauth` のアカウントは計画しない
- ライセンス `revoked` のユーザーは計画しない（§5.4）

---

## 10. AI 連携（`lib/ai.ts`）

AIを使うのは本文の生成と修正だけ（`POST /ai/generate`, `POST /ai/revise`, `ap_plan` の生成）。採点（§9.2）・集計（`learning`）・枠と型の選択（§9.3, §9.4）・重複判定（§8.3）・クリックの按分（§8.5）にAIは一切使わない。すべて決定的な計算で行い、同じ入力から常に同じ結果が出るようにする。

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
User（オートパイロット）: 同上だが型は1つに固定し `n=1`、ネタ源は選ばれた1件、リンクは選ばれた1件。型・枠・ネタ源の選択はサーバー側の集計で済ませてから渡す（AIに選ばせない）。
Revise: 直前の候補JSON＋会話履歴＋指示 → 同じJSON形式で1案。

### 10.4 参考情報の抽出（`lib/extract.ts`）
- `url`: サーバーで `fetch`（UA はブラウザ風、タイムアウト10秒、最大2MB）。`<script>/<style>/<nav>/<footer>` を除去し、`<article>` か `<main>` があればそこを優先、無ければ `<p>` を連結。50,000文字で切る。失敗したら `EXTRACT_FAILED`（画面は「本文を貼ってください」）
- `youtube`: URL正規化（`v=`, `youtu.be/`, `shorts/`）。タイトルは `https://www.youtube.com/oembed?url=...&format=json` から。本文は取らない（Geminiに動画を渡す。それ以外は貼付を促す）
- `file`: ブラウザで読んで `content` として送る（.txt/.md、2MBまで）

### 10.5 メール（`lib/email.ts`）
Resend `POST https://api.resend.com/emails`。差出人 `noreply@<domain>`。テンプレ:

| テンプレ | 中身 |
|---|---|
| `ap_draft` | 自動投稿の下書き通知。承認/取消のリンクは §7.9 の `{APP_ORIGIN}/a/<token>`（ログイン不要で踏める） |
| `publish_failed` | 投稿失敗。日本語の理由＋原文 |
| `token_expiring` | トークン期限が近い |
| `needs_reauth` | 再接続が必要 |
| `ap_stopped` | 3連続失敗でオートパイロット停止 |
| `password_reset` | パスワード再設定リンク `{APP_ORIGIN}/login?reset=<token>`（30分・1回限り、§5.1） |

本文は日本語のプレーンテキスト＋アプリへのリンク。`ap_draft` と `password_reset` のリンクだけはCookie非依存のトークン付きURLで、それ以外はアプリのURLでよい。

---

## 11. モックとシード

- `THREADS_MOCK=1` のとき `lib/threads.ts` は `mock/threads.ts` を使う。モックはメモリ上に投稿を持ち、`POST /me/threads` で投稿を追加して `{id}` を返す。`/insights` は投稿日からの経過で増える擬似数字を返す。`clicks` は本文中URLに対して返す。トークンが `THAAdemo` で始まる場合のみモックに入る（それ以外は実API）
- **本番バンドルにモックを含めない**。`mock/threads.ts` の読み込みは `import.meta.env.DEV` ガードの内側に置き、本番ビルドではツリーシェイクで消えるようにする。env の消し忘れで本番がモックに落ちる事故を、コードの側で不可能にする
- `GET /health` は `{ok, version, mock}` を返す。`mock` は「`THREADS_MOCK=1` かつモック実装がバンドルに存在する」ときだけ `true`。本番では常に `false` になる
- `scripts/seed-demo.ts`: `accounts/posts/daily_views/follower_snapshots/click_weeks/queue/sources/links/learning` を投入する。`npm run seed:demo -- --email demo@example.com`
  - **M1（暫定版）**: プロトタイプが未着なので、スクリプト内に直書きした固定のダミーデータを入れる。投稿20本（うち root 15・children 5、型が3種類以上ばらけるようにタグ付け）、日別表示30日分、フォロワースナップショット30日分、キュー3件（draft / scheduled / done）、参考情報2件、リンク2件。乱数は使わず、何度実行しても同じ値になるようにする（テストが値を前提にできるように）
  - **M3（差し替え）**: プロトタイプ到着後、`makeAccount()` を移植して現実的な分布のデモデータに差し替える。呼び出し方（`npm run seed:demo`）とテーブルの範囲は変えない
- 開発は `wrangler dev` ＋ `vite`（プロキシ `/api` → 8787）

---

## 12. フロントエンド仕様

### 12.1 ルート
| パス | 画面 |
|---|---|
| `/login` | Login（登録/ログイン切替。`?reset=<token>` でパスワード再設定フォーム、`忘れた方` から forgot） |
| `/connect` | Connect（初回・追加の両方。`?add=1` で「戻る」表示） |
| `/app/home` `/app/create` `/app/queue` `/app/autopilot` `/app/settings` | 5画面。選択中アカウントは `localStorage.activeAccountId` |

未認証で `/app/*` → `/login`。アカウント0件で `/app/*` → `/connect`。
`/a/:token`（§7.9）はSPAのルートではなく、Workerが直接HTMLを返す。

### 12.2 共通
- 画面幅 430px を上限に中央寄せ。`tokens.css` はプロトタイプの `CSS` 定数をそのまま移植する
  - **M1（暫定版）**: プロトタイプが未着なので、Login 画面が読めれば足りる最小限の CSS 変数だけを置く（背景色・文字色・アクセント色・角丸・余白の基本単位・フォントスタック・最大幅430px）。色と数値は暫定であることをファイル先頭にコメントで書く。独自のデザイン判断を足さない
  - **M3（差し替え）**: プロトタイプ到着後、`tokens.css` を丸ごとプロトタイプの `CSS` 定数に置き換える。M1 で書いた変数名がプロトタイプと違っても、プロトタイプ側の名前に合わせる（暫定側を残さない）
- TopBar（ハンバーガー / アカウントチップ / ＋）、ApBar（オートパイロット帯。`GET /autopilot/next` と連動）、Tabs（下部5タブ）、Drawer（アカウント切替＋メニュー＋ログアウト）
- データ取得は React Query。キーは `[accountId, resource, params]`。変更系の後は関連キーを invalidate
- 失敗はトースト＋画面内メッセージ。文言はAPIの `error.message` をそのまま出す
- `prefers-reduced-motion` を尊重（プロトタイプ同様。詳細は §12.5）

### 12.3 各画面（プロトタイプとの対応）
| 画面 | データ | 備考 |
|---|---|---|
| Home | `GET /dashboard?period=` | 指標チップの並び替えは client。行タップで children と操作（リライト/リポスト/型にして作る/開く）。フォロワーのスナップショットが1点しかないときはグラフの代わりに「明日から推移が出ます」を出す |
| Create | `GET /posts`（picker）, `GET /sources`, `POST /ai/generate`, `POST /ai/revise`, `POST /queue`, `GET /queue/suggest-slot` | 「型にして作る/リライト」は `location.state.preset` で受ける。`clientKey` モードのときは `localStorage.aiKey` を付けて送る |
| Queue | `GET /queue?status=`, `PATCH/POST/DELETE` | 週表示は7日分。`approve_deadline` の残り時間は client で計算 |
| Autopilot | `GET/PUT /autopilot`, `GET /autopilot/learning`, `/log`, `/next` | ONにできない理由（AIキー未保存 / 参考情報0件 / 要再接続 / ライセンス無効）をトーストで返す。学習の表示は下記 |
| Settings | `GET /accounts`, `GET/PUT /ai/settings`, `POST /ai/test`, `GET/PUT /notifications`, `GET /links`, `GET /accounts/:id/diagnose` | 「キーをこの端末にだけ保存」の扱いは下記 |

**Autopilot 画面の学習表示**
倍率・おすすめ・予測は出さない。出すのは事実の集計だけ。

- 表は2つ。「型別」（`dim=hook`）と「枠別」（`dim=slot`）。列は `型/枠 | 平均表示回数 | いいね率 | 本数`
- 「平均表示回数」= `avgViews`、「いいね率」= `likeRate`（投稿ごとのいいね率の平均。§7.7）、「本数」= `n`。どちらの数字も**投稿から48時間後の断面**で集計した値（§9.2）で、いま画面のホームに出ている最新の表示回数とは一致しない
- 枠の表示は `learning.value` の `weekday-21` を「平日 21時台」、`weekend-12` を「土日 12時台」に置き換える（§9.1）
- 並びは平均表示回数の降順。`length` と `source` は表には出さず、`GET /autopilot/learning` の応答としてだけ持つ（将来の表示用）
- `n < 10` の行は数値を出さない。3列とも「集計中（あと◯本）」（◯ = `10 - n`）と表示する
- 表の下に1行: 「投稿から48時間後の数字をもとに集計しています。ホームの表示回数（最新値）とは一致しません。AIは本文を書くだけで、この集計には関わりません」

**Settings のAIキー保存**
「キーをこの端末にだけ保存」をONにしようとした時点で、保存前に確認を出す:
「この端末にだけ保存すると、オートパイロットは使えません（サーバーが自動生成のときにキーを読めないため）。それでもよろしいですか？」
OKなら `localStorage.aiKey` に保存し、サーバーには `storeOnServer=false` を送る。トーストでの事後通知にはしない。既にオートパイロットがONのアカウントがある場合は、その一覧も確認文に添える。

### 12.4 PWA（M6）
`vite-plugin-pwa`。マニフェスト名「Threads オートパイロット」、アイコンは飛行機モチーフ（プロトタイプのロゴ）。Service Worker は静的資産のみキャッシュ、APIはキャッシュしない。Push は `push_subscriptions` に登録。

### 12.5 デザイン原則
`.claude/skills/apple-design/SKILL.md` を正とする。フロントを実装・レビューするときは必ず読む。

**役割分担**
| 対象 | 正 |
|---|---|
| レイアウト、CSSトークン、文言、操作の流れ | `docs/prototype.jsx`（§0 のとおり変えない） |
| 動き、触感、タイポの詰め | `.claude/skills/apple-design/SKILL.md` |

プロトタイプが「何がどこにあるか」を決め、apple-design が「触ったときにどう返すか」を決める。両者が食い違って見えるとき（例: プロトタイプがCSS transitionで書いている箇所）は、見た目の結果を変えずに実装だけ spring に差し替える。

**適用箇所と実装方針**
対象: Sheet（下からのシート）、Drawer（左メニュー）、Tabs 切替、Toast、ホームの行展開、キューのスワイプ操作。

- **spring で動かす**（`motion` の `animate` / `useAnimate`）。固定時間の CSS `transition` や `@keyframes` は、指で触れる要素には使わない。掴んで途中で反転できないため
- **pointer-down で反応する**。押した瞬間にハイライトやスケールが返る。`click` や touch-up を待たない。ドラッグ中は指と1:1で追従し、離した瞬間だけ動くのではなく最初から最後まで連続してフィードバックする
- **中断可能にする**。動いている最中に掴んだら、その場（画面上の現在値＝presentation value）から新しい動きを始める。論理上の目標値から始めるとカクつく。入力をロックしない
- **速度を引き継ぐ**。ドラッグを離したときの速度を spring の初速として渡す。反転したときは速度をハードカットせず、そのまま繋ぐ
- **行き先は投影で決める**。離した位置の最寄りではなく、速度から減速後の到達点を計算し、その最寄りのスナップ点へ向かう（`current + (v/1000)·d/(1−d)`, `d ≈ 0.998`）。シートを弾いたら閉じ、ゆっくり離したら戻る
- **境界はラバーバンド**。シートを上限より引っ張ったら、進むほど付いてこなくなる。硬く止めない
- **アニメーションするのは `transform` と `opacity` だけ**。`height` / `top` / `width` は動かさない。動きが来る直前だけ `will-change` を付ける
- **出入りは同じ経路**。右から出たものは右へ戻す。シートやポップオーバーの `transform-origin` は、それを開いたボタンに合わせる

**spring のパラメータ**（`web/src/lib/motion.ts` にプリセットとして置き、画面から直接数値を書かない）
| 用途 | 値 |
|---|---|
| 既定（Tabs、Toast、行展開、メニュー） | `bounce: 0`（臨界減衰）, `duration: 0.35` |
| Sheet / Drawer（指で動かすもの） | `bounce: 0.2`, `duration: 0.3` |
| 弾いて閉じたとき（勢いがある） | `bounce: 0.2`, `duration: 0.4` ＋ 離した速度を `velocity` に渡す |
オーバーシュートは「ジェスチャーが勢いを持っていたとき」だけ。ただ開いただけのメニューは跳ねさせない。

**環境設定の尊重**
| メディアクエリ | 挙動 |
|---|---|
| `prefers-reduced-motion: reduce` | spring とスライドをやめ、200ms の opacity クロスフェードにする。`transform` は動かさない。オーバーシュートは全廃 |
| `prefers-reduced-transparency: reduce` | 半透明レイヤー（TopBar・ApBar・Sheet）の背景を不透明にし、`backdrop-filter` を外す |
| `prefers-contrast: more` | 背景をほぼ不透明にし、輪郭線を1本足す |

**タイポグラフィ**
- 大見出し（画面タイトル・数字の大表示）は `letter-spacing: -0.02em`、本文は `0`。全サイズに同じ値を当てない
- 行間は大きい文字ほど詰める（見出し 1.1〜1.2、本文 1.5〜1.6）
- フォントはプロトタイプの `font-family`（システムフォント）を維持する。Webフォントは足さない
- 余白は `rem` / `em` で書き、端末の文字サイズ設定を大きくしてもレイアウトが壊れないようにする

---

## 13. マイルストーンと完了条件

### M1 基盤
- monorepo、wrangler、D1マイグレーション（v1.1スキーマ）、Hono、セッション、ライセンス登録/ログイン、暗号、署名トークン（§5.3）、パスワード再設定（forgot / reset）、管理API、`/health`
- 予算の三本立て（subrequests / dbQueries / timeMs）を `lib/budget.ts` と `lib/db.ts` に実装
- `shared/src/tags.ts`（`classifyHook` / `lengthBucket` / `slotOf` / `similarity`）、`shared/src/url.ts`（`normalizeUrl` / `extractUrls`）
- 回数制限（`rate_events` と `rateLimit()`、§5.1）
- モックモード（DEVガード）、`scripts/smoke.ts` の用意（実行はオーナーからトークンが届いた時点。§14）
- メール（`lib/email.ts`）は `password_reset` テンプレだけ先行実装
- **プロトタイプ未着のため暫定で作るもの**（到着後、M3 の最初に差し替える。§0-3）:
  - `web/src/styles/tokens.css` … Login が読める最小限の CSS 変数のみ（§12.2）
  - `scripts/seed-demo.ts` … 固定のダミーデータ版（投稿20本等、§11）
- web は骨格のみ（Vite + React + Router + React Query、暫定 `tokens.css`、Login 画面と forgot / reset 導線）
- 完了条件:
  1. `register→login→me` が通る
  2. `ENC_KEY` で暗号化したトークンが復号できるテスト
  3. ライセンス使い回し拒否のテスト、`revoked` のライセンスでログインできないテスト
  4. **forgot → メール（モック）→ reset → 旧セッションが全部無効になる** テスト
  5. `budget` が D1 クエリ 800 超で `BudgetExceeded` を投げるテスト
  6. `classifyHook` / `lengthBucket` / `slotOf` / `normalizeUrl` / `extractUrls` / `similarity`（3-gram Jaccard）の純関数テスト
  7. `rateLimit()` が `login:<email>` で11回目を弾き、窓（10分）を過ぎると通るテスト
  8. `wrangler dev` で `/health` が `{ok, version, mock}` を返し、本番ビルドに `mock/` が含まれないこと
  9. 暫定 `seed-demo` を実行すると投稿20本と日別データが入り、2回実行しても同じ状態になること

### M2 アカウント接続と同期
- `POST /accounts`（検証→長期化→保存）、`full_sync`、`insights_*`（チェックポイント方式）、`daily_views`、`followers`、`clicks`、`token_refresh`、ジョブ基盤、Cron
- 完了条件: モックで接続→5分cron相当を手動実行→`posts` と数字が入る。予算超過（fetch・D1クエリ・時間のいずれか）で途中終了→次回続きから完了する（テスト）。クリックの週グリッドが固定起点で二重計上しない（テスト）。`post_metrics_history` が1投稿あたり最大3行で、同じチェックポイントを二度書かない（テスト）。**実アカウントで clicks が投稿に紐づく**（`normalizeUrl` を通した突合で `unassignedClicks` に全部落ちない。実トークンで手動確認）

### M3 ホーム画面
- `docs/prototype.jsx` が届いてから着手する。**最初にやるのは M1 の暫定版2つの差し替え**:
  - `web/src/styles/tokens.css` … 暫定の最小 CSS 変数を、プロトタイプの `CSS` 定数で丸ごと置き換える（変数名もプロトタイプ側に合わせ、暫定側を残さない。§12.2）
  - `scripts/seed-demo.ts` … 固定ダミーデータ版を、プロトタイプの `makeAccount()` 移植版に置き換える（呼び出し方とテーブルの範囲は変えない。§11）
- そのうえで Login / Connect / Shell（TopBar, ApBar, Tabs, Drawer）/ Home を実装する
- 完了条件: 暫定 `tokens.css` の記述がリポジトリに残っていない。デモデータで期間・指標を切り替えて数字が変わる。ツリー展開、行の操作から `preset` 付きで Create に遷移する。§12.5 の spring・pointer-down 反応・reduced-motion が Drawer と行展開で確認できる

### M4 キューと投稿
- Queue API、`publish` ジョブ（テキスト/ツリー/画像/リポスト、1ステップ方式と3ステップ方式の両方）、Queue画面、`validatePost`
- 完了条件: モックで「今すぐ」「日時指定」「おすすめ枠」の3経路で投稿され、ツリーのコメントが `reply_to_id` で付く。`REPLY_TWO_STEP=1` でも同じ結果になる（テスト）。途中失敗で二重投稿しない（テスト）。リンク6本で日本語エラー。3-gram Jaccard 0.8 の重複判定が効く（テスト）

### M5 作る（AI）
- AI設定、`generate/revise`、`extract`、Create画面（箱1/箱2/指示/3案/指示で直す/キューへ）
- 完了条件: Gemini と OpenRouter の両方でJSONが返り3案が出る（実キーで手動確認）。YouTube URL が Gemini 経路で通る。キーをブラウザ保存にしたときサーバーにキーが残らない（テスト）。端末保存を選ぶ前に「オートパイロットは使えません」の確認が出る

### M6 オートパイロットと通知
- タグ付け、採点（48hの1回のみ）、learning（4次元・独立集計）、`ap_plan`、`ap_notify`、承認/取消（§7.9 の `/a/:token` を含む）、Autopilot画面、メール通知、PWA、Web Push、ライセンス `revoked` 時の停止
- 完了条件: デモアカウントでONにすると24時間分の下書きができ、`cancel` モードで `approve_deadline` に通知、期限後に投稿される（時刻を進めるテスト）。**メールのリンク（Cookieを送らないリクエスト）から承認/取消ができ、同じトークンは2回目で「すでに完了しています」になる**（テスト）。取消→`ap_log`。3連続失敗で自動停止。`n<10` の次元が「集計中（あと◯本）」になる

### M7 仕上げ
- 複数アカウント（3件上限、切替、削除）、診断、CSV書き出し（`/export/:accountId?format=csv`）、`DELETE /users/me`（退会・全データ削除）、レート制限（`/a/*` を含む）、監査ログ、README
- README に書くこと: デプロイ手順、買い手向けセットアップ手順のリンク、プライバシーポリシーと特定商取引法表記の置き場、D1 Time Travel を使った復旧方針（Paid 30日）、「買い切り＝ホスティング込み◯年間」の表記
- 完了条件: 3アカウントで数字とキューが混ざらない（テスト）。同じThreadsアカウントを2ユーザーが接続してもデータが混ざらない（テスト、B1の主キー確認）。退会でユーザーに紐づく行が全部消える（テスト）。`wrangler deploy` で本番に上がる

---

## 14. テスト方針
- 純関数（`tags.ts`, `similarity`, `url.ts` の `normalizeUrl`/`extractUrls`, 按分, 採点, 枠選択, `validatePost`, 暗号, 署名トークン）は vitest で網羅
- ジョブは D1 をメモリ（`better-sqlite3` か Miniflare）で動かし、`now` を注入して時刻を進める
- 予算は3種類（subrequests / dbQueries / timeMs）それぞれで超過→再開のテストを書く
- Threads はモックで。実APIの疎通は `scripts/smoke.ts`（トークンを env で渡す）で手動
- `scripts/smoke.ts` で確認すること（M1で用意し、実トークンが届いた時点で実行）:
  1. `/me` が返る
  2. `auto_publish_text=true` のテキスト投稿が1ステップで公開される
  3. **`auto_publish_text=true` と `reply_to_id` の併用でツリー2投稿目が作れるか**（H5）。作れなければ `REPLY_TWO_STEP=1` に切り替える（§8.3）
  4. 絵文字を含む本文の文字数上限が「コードポイント数」か「UTF-8バイト数」か（§6.3）
  5. `threads_insights?metric=clicks` の `link_url` が投稿本文のURLとどこまで一致するか（§8.5 の `normalizeUrl` の調整用）
  6. 実行後は投稿を削除する（`DELETE /{media-id}`）
- 画面はスナップショットより「操作の流れ」の手動確認を優先。M3〜M6 の完了条件をチェックリスト化して `docs/qa.md` に置く

---

## 15. 非対象（やらないこと）
- DM送信、フォロー操作、いいね
- 他人のアカウントの検索・取得（`keyword_search`, `profile_lookup`）
- Webhook
- 動画投稿（M8以降で検討）
- 画像生成
- 買い手のセルフホスト用ボタン（将来）。ただし構成は Worker + D1 ＋ Resend だけに保ち、`wrangler deploy` でそのまま買い手の環境に載る状態を崩さない。運営側のホスティング負担が重くなったときの逃げ道として残す

---

## 16. 用語
| 用語 | 意味 |
|---|---|
| ツリー | 1投稿目（root）＋自分のコメント（children）。数字は root の views をリーチとみなす |
| 遷移率 | children[0].views / root.views |
| 按分 | 同じURLが複数の投稿にあるとき、クリックをそのURLを含む投稿（root または child）の views 比で分けること。同じツリー内の重複は max(views) で1回だけ数える |
| 正規化URL | `normalizeUrl()` を通したURL。末尾スラッシュ・UTM等の追跡パラメータ・フラグメントを落とし、ホストを小文字化したもの。クリックの突合キー |
| 枠 | 3時間刻みの時間帯×曜日種別 |
| 実績あり | ある次元の値で `n >= 10`。これ未満は数値を出さず「集計中」と表示する |
| チェックポイント | 数字の履歴を残す時点。投稿から 48h / 7d / 30d の3点だけ |
| 取消可 | 投稿の N 時間前に通知し、取消が無ければ自動で出る承認方式 |
