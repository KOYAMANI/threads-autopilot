# 手動確認チェックリスト

マイルストーンごとの手動確認項目（SPEC §14 の末尾「M3〜M6 の完了条件をチェックリスト化して `docs/qa.md` に置く」）。
自動テストで担保している項目は「自動」と書き、二重に手で確認しない。

---

## M1 基盤

### 0. 準備

```bash
npm install
cp .dev.vars.example .dev.vars     # ENC_KEY / SESSION_SECRET / ADMIN_SECRET を埋める
#   ENC_KEY:        openssl rand -base64 32
#   SESSION_SECRET: openssl rand -base64 48
#   ADMIN_SECRET:   openssl rand -hex 32
npm run db:migrate                 # ローカル D1 にスキーマを流す
```

`RESEND_API_KEY` は空のままでよい。空のときメールは送らず、`wrangler dev` のコンソールに本文が出る（SPEC §10.5 のダミー送信）。

### 1. ビルドとテスト

| # | 手順 | 期待 | 種別 |
|---|---|---|---|
| 1-1 | `npm run typecheck` | エラー0（shared / worker / web / scripts の4プロジェクト） | 自動 |
| 1-2 | `npm test` | shared 51件・worker 96件すべて green（M2 時点では shared 58件・worker 158件） | 自動 |
| 1-3 | `npm run build` | `web/dist/` が生成される | 手動 |

### 2. Worker の起動と `/api/health`

| # | 手順 | 期待 |
|---|---|---|
| 2-1 | `npm run dev:worker` → 別端末で `curl -s http://127.0.0.1:8787/api/health` | `{"ok":true,"version":"0.1.0","mock":false}` |
| 2-2 | `npx wrangler dev --define __DEV__:true --var THREADS_MOCK:1` で同じ curl | `mock` が `true` |
| 2-3 | `npx wrangler dev --var THREADS_MOCK:1`（`__DEV__` は wrangler.toml の false） | `mock` が `false`（本番ビルドでモックに落ちないことの確認。SPEC §11） |
| 2-4 | `npm run check:bundle`（= `./scripts/check-bundle.sh`） | `✓ OK: モックは本番バンドルに含まれていません`（終了コード0） |

**2-4 の中身**: `lib/threads.ts` の `call()` は M1 時点でどこからも呼ばれていないので、素の
`wrangler deploy --dry-run` では「未使用だから消えている」だけで DEV ガードの効きを判定できない。
`check-bundle.sh` は `call()` を到達可能にした一時エントリ（`worker/src/__bundle_probe.ts`、実行後に削除）
でビルドし、それでも `SEED_TEXTS` / `Unsupported mock path` / `MockThreadsError` / `mockCall` /
`callMock` / `seedStore` / `storeFor` / `metricsFor` / `resetMock` / `mock/threads` が
すべて0件であることを見る。`call()` がバンドルに入っていない（＝検査が無意味な）状態も検出して止まる。

ガードが崩れたときに落ちることの確認（負の対照）: `lib/threads.ts` の分岐を
`if (shouldUseMock(env, token))` に戻すと、バンドルが 7KB → 22KB になり上記の識別子が27件出て NG になる。
**分岐には `__DEV__` を識別子のまま直接書くこと**（クロスモジュール定数や関数を挟むと esbuild が枝を落とさない）。

### 3. 登録 → ログイン → me（SPEC §13 M1 完了条件1）

自動テスト（`worker/test/auth.test.ts`）で担保。手で見るなら:

```bash
# ライセンスを1本発行（ADMIN_SECRET は .dev.vars から読む）
npm run licenses -- --count 1

curl -s -c /tmp/c.txt -X POST http://127.0.0.1:8787/api/auth/register \
  -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
  -d '{"email":"you@example.com","password":"password1234","license_key":"TAP-...."}'

curl -s -b /tmp/c.txt -H 'X-Requested-With: fetch' http://127.0.0.1:8787/api/auth/me
```

| # | 確認 | 期待 |
|---|---|---|
| 3-1 | register の応答 | 201 / `{ok:true,data:{user:{...}}}` / `Set-Cookie: sid=...; HttpOnly; Secure; SameSite=Strict` |
| 3-2 | me の応答 | `user` / `accounts:[]` / `ai` / `notifications` が入っている |
| 3-3 | Cookie 無しで me | 401 `UNAUTHORIZED` |
| 3-4 | `X-Requested-With` 無しで POST | 403 `CSRF` |

### 4. ライセンス（完了条件3・4）

| # | 確認 | 期待 | 種別 |
|---|---|---|---|
| 4-1 | 同じキーで2回目の register | `LICENSE_INVALID` | 自動 |
| 4-2 | `npm run licenses -- --revoke <id>` のあとログイン | `LICENSE_REVOKED`、既存セッションも失効 | 自動 |
| 4-3 | 発行したキーの形 | `TAP-XXXX-XXXX-XXXX`。`I` `O` `0` `1` を含まない | 自動 |

### 5. パスワード再設定（完了条件5）

| # | 手順 | 期待 |
|---|---|---|
| 5-1 | `POST /api/auth/forgot` | 常に `{ok:true,data:{requested:true}}`（存在しないメールでも同じ） |
| 5-2 | `wrangler dev` のコンソール | `[email:dummy] ... /login?reset=<token>` が出る |
| 5-3 | そのトークンで `POST /api/auth/reset` | 200。旧パスワードでログインできない |
| 5-4 | reset 前に取ったすべての Cookie で me | 401（全端末ログアウト） |
| 5-5 | 同じトークンで2回目の reset | `RESET_INVALID` |
| 5-6 | forgot を10分に4回 | 4回目もレスポンスは `ok:true`。`password_resets` の行は3件で止まる |

5-1〜5-6 は自動テスト（`auth.test.ts` / `rate.test.ts`）で担保済み。ダミーメールの見た目だけ 5-2 で目視する。

### 6. 予算・回数制限（完了条件6・7）

| # | 確認 | 期待 | 種別 |
|---|---|---|---|
| 6-1 | D1 クエリ801回目 | `BudgetExceeded`（`kind='dbQueries'`） | 自動 |
| 6-2 | 外部fetch 301回目・経過20秒超 | 同じ `BudgetExceeded` | 自動 |
| 6-3 | ログイン失敗11回目 | 429 `RATE_LIMITED`。10分の窓を過ぎると通る | 自動 |

### 7. 純関数（完了条件8）

`classifyHook` / `lengthBucket` / `slotOf` / `normalizeUrl` / `extractUrls` / 3-gram Jaccard / `validatePost` / `signToken`・`verifyToken` / `rate_events` の窓 — すべて自動テスト。手動確認は不要。

### 8. デモデータ（完了条件9）

```bash
npm run seed:demo
npx wrangler d1 execute threads-autopilot --local \
  --command "SELECT COUNT(*) posts FROM posts; SELECT COUNT(*) daily FROM daily_views;"
npm run seed:demo    # もう一度流す
```

| # | 確認 | 期待 |
|---|---|---|
| 8-1 | posts の件数 | 20（root 15 + コメント5） |
| 8-2 | daily_views / follower_snapshots | それぞれ30 |
| 8-3 | queue / sources / links | 3 / 2 / 2 |
| 8-4 | 2回実行後の中身 | 1回目と完全に同じ（乱数を使っていない） |
| 8-5 | 投入後のログイン | `demo@example.com` / `password1234` |

### 9. Login 画面

```bash
npm run dev          # vite（5173）と wrangler dev（8787）を並行起動
```

| # | 手順 | 期待 |
|---|---|---|
| 9-1 | `http://localhost:5173/login` | ログインフォームが 430px 幅で中央に出る |
| 9-2 | 「ライセンスキーで登録」 | 登録フォームに切り替わり、ライセンスキー欄が増える |
| 9-3 | ライセンスキー欄に小文字入力 | 大文字に変換される |
| 9-4 | 誤ったパスワードでログイン | 赤い帯に「メールアドレスかパスワードが違います」（API の `error.message` そのまま） |
| 9-5 | ボタンを押した瞬間 | 指を離す前に縮む（pointer-down で反応。SPEC §12.5） |
| 9-6 | OS の「視差効果を減らす」を ON にして 9-5 | 縮まず、透明度だけ変わる（`prefers-reduced-motion`） |
| 9-7 | 「パスワードを忘れた」 | フォームが切り替わり、送信後に緑の帯が出る |
| 9-8 | コンソールに出た `/login?reset=<token>` を開く | 新しいパスワードの入力画面になる |
| 9-9 | 設定後 | 「設定しました」→「ログイン画面へ」でログインに戻る |
| 9-10 | ログイン成功 | `/app/home` に遷移する（中身は M3 のプレースホルダ） |
| 9-11 | 未ログインで `/app/home` を直接開く | `/login` に飛ぶ |

### 10. 実トークンでの疎通（SPEC §14。トークン到着後）

`scripts/smoke.ts` は M1 で用意するだけで、**実行しない**。オーナーから実トークンが届いたら:

```bash
THREADS_TOKEN=... npm run smoke -- --dry   # まず読み取りだけ
THREADS_TOKEN=... npm run smoke            # 投稿して確認し、最後に削除する
```

結果のうち次の2つは実装に跳ね返るので、必ず `DECISIONS.md` に1行残す。

| 項目 | 分岐 |
|---|---|
| H5: `auto_publish_text` × `reply_to_id` | 使えなければ `wrangler.toml` の `REPLY_TWO_STEP` を `1` に（SPEC §8.3） |
| 500文字の数え方 | コードポイント数なら `shared/src/validate.ts` の `bodyLength()` を緩める（SPEC §6.3） |

---

## M2 アカウント接続と同期

### M2-0. 準備

M1 の「0. 準備」と同じ。`.dev.vars` の代わりに `--var` で渡してもよい（下のコマンドはその形）。

```bash
npm run db:migrate
npx wrangler dev --port 8787 --test-scheduled --define __DEV__:true \
  --var THREADS_MOCK:1 \
  --var ADMIN_SECRET:dev-admin-secret \
  --var ENC_KEY:"$(openssl rand -base64 32)" \
  --var SESSION_SECRET:"$(openssl rand -base64 48)"
```

`--test-scheduled` が cron の手動実行口（`/__scheduled`）を足す。`wrangler.toml` の
`run_worker_first` に `/__scheduled` が入っているのは、これが静的アセット側に取られて
Worker まで届かないため（DECISIONS 2026-09-05）。

### M2-1. ビルドとテスト

| # | 手順 | 期待 | 種別 |
|---|---|---|---|
| 1-1 | `npm run typecheck` | エラー0 | 自動 |
| 1-2 | `npm test` | shared 58件・worker 158件すべて green | 自動 |
| 1-3 | `npm run check:bundle` | 本番エントリ・一時エントリの両方でモック識別子0件 | 自動 |

`call()` が M2 でジョブから呼ばれるようになったので、1-3 は本番エントリ
（`worker/src/index.ts`）そのものの確認になっている。

### M2-2. モックで接続 → cron → 数字が入る（SPEC §13 M2 の完了条件）

```bash
# ライセンスを1本発行して登録する
KEY=$(curl -s -X POST http://127.0.0.1:8787/api/admin/licenses \
  -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
  -H 'X-Admin-Secret: dev-admin-secret' -d '{"count":1}' | jq -r .data.keys[0].key)
curl -s -c /tmp/c.txt -X POST http://127.0.0.1:8787/api/auth/register \
  -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
  -d "{\"email\":\"you@example.com\",\"password\":\"password1234\",\"license_key\":\"$KEY\"}"

# モックトークンで接続（THAAdemo で始まるトークンだけがモックに入る）
ACC=$(curl -s -b /tmp/c.txt -X POST http://127.0.0.1:8787/api/accounts \
  -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
  -d '{"token":"THAAdemo_manual"}' | jq -r .data.account.id)

# cron を手動実行（5分 → 毎時 → 日次 → 5分でやり残しを片付ける）
for CRON in '*/5+*+*+*+*' '0+*+*+*+*' '0+18+*+*+*' '*/5+*+*+*+*'; do
  curl -s -o /dev/null -w "$CRON %{http_code}\n" "http://127.0.0.1:8787/__scheduled?cron=$CRON"
  sleep 3
done
```

| # | 確認 | 期待 |
|---|---|---|
| 2-1 | `POST /api/accounts` の応答 | 201 / `{account, longLived:false, secretIgnored:false}` |
| 2-2 | `accounts.token_enc` | 平文の `THAAdemo…` を含まない（暗号化して保存。SPEC §5.2） |
| 2-3 | 5分 cron のあと `SELECT COUNT(*) FROM posts` | 14件（root 10 + 自分の返信4） |
| 2-4 | `SELECT COUNT(*) FROM links` | 2件。本文のURLが `normalizeUrl()` 済みで自動追加される（SPEC §7.5） |
| 2-5 | 日次 cron のあと | `daily_views` 63件 / `follower_snapshots` 1件 / `click_weeks` に行 / `posts.clicks` が 0 でない |
| 2-6 | `SELECT type, status, last_error FROM jobs` | 全て `done`、`last_error` は NULL |
| 2-7 | `GET /api/accounts/$ACC/sync` | 同期後は `{running:false, progress:30, total:30}` |
| 2-8 | `GET /api/accounts/$ACC/diagnose` | 6段すべて `ok:true`（トークン / アカウント情報 / 投稿の取得 / 投稿の数字 / アカウントの表示回数 / リンクのクリック） |

### M2-3. ダッシュボード（SPEC §7.2）

```bash
curl -s -b /tmp/c.txt -H 'X-Requested-With: fetch' \
  "http://127.0.0.1:8787/api/accounts/$ACC/dashboard?period=30" | jq .
```

| # | 確認 | 期待 |
|---|---|---|
| 3-1 | 応答の形 | `period / from / to / followers{current,delta,series} / views{total,series} / likes / clicks / posts[] / links[] / unassignedClicks` |
| 3-2 | `posts[]` | 期間内の root だけ。`children` と `hook` と `link` が入っている |
| 3-3 | `links[]` | `lin.ee` と `example.com/sheet` にクリックが付き、`unassignedClicks` が 0 |
| 3-4 | フォロワーが1点しかないとき | `delta` が 0（画面は「明日から推移が出ます」を出す。M3） |
| 3-5 | `?period=all` / `?period=999` | `all` はそのまま、不正値は 7 に丸める |

### M2-4. 自動テストで担保している項目（手で見ない）

| 項目 | テスト |
|---|---|
| 予算超過（fetch / D1クエリ）で途中終了 → 次回続きから完了 | `worker/test/sync.test.ts`, `insights.test.ts`, `clicks.test.ts` |
| クリックの週グリッドが固定起点で二重計上しない | `worker/test/clicks.test.ts` |
| 按分が §8.5 の基準どおり（views 比・同一ツリーは max・正規化URLで突合） | `shared/test/clicks.test.ts`, `worker/test/clicks.test.ts` |
| `post_metrics_history` が 48h/7d/30d を1回ずつ、1投稿最大3行 | `worker/test/insights.test.ts` |
| 3アカウント上限・再接続・他人のアカウントに触れない | `worker/test/accounts.test.ts` |
| `DELETE /accounts/:id` で関連テーブル（`click_weeks_done` 含む）が全部消える | `worker/test/accounts.test.ts` |
| code 190 で `needs_reauth`、日本語＋原文のエラー | `worker/test/maintenance.test.ts` |
| ジョブの優先度・重複投入なし・バックオフ・running の回収 | `worker/test/jobs.test.ts` |

### M2-5. 実トークンでの確認（トークン到着後）

SPEC §13 M2 の残り1件。モックでは代替できない。

| # | 確認 | 期待 |
|---|---|---|
| 5-1 | 実アカウントで `clicks` ジョブを回す | `threads_insights?metric=clicks` の `link_url` が `normalizeUrl()` 経由で投稿と突合でき、`unassignedClicks` に全部落ちない |

外れた場合は `shared/src/url.ts` の `normalizeUrl()` の除去パラメータを調整し、`DECISIONS.md` に1行残す。

---

## M3 以降

各マイルストーンの完了条件（SPEC §13）を、着手時にこのファイルへ表として起こす。
