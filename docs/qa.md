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

## M3 ホーム画面

### M3-0. 準備

```bash
npm run db:migrate
# Worker（モック）: SPEC §11 の THAAdemo トークンだけがモックに入る
npx wrangler dev --port 8787 --test-scheduled --define __DEV__:true \
  --var THREADS_MOCK:1 --var ADMIN_SECRET:dev-admin-secret \
  --var ENC_KEY:"$(openssl rand -base64 32)" \
  --var SESSION_SECRET:"$(openssl rand -base64 48)"
# 別端末で vite（5173）
npm run dev:web
```

`http://localhost:5173` が開発用。`http://127.0.0.1:8787` は `web/dist`（`npm run build` の結果）を
Worker が返す本番と同じ経路で、両方で通ることを見る。

### M3-1. ビルドとテスト

| # | 手順 | 期待 | 種別 |
|---|---|---|---|
| 1-1 | `npm run typecheck` | エラー0（shared / worker / web / scripts） | 自動 |
| 1-2 | `npm test` | shared 58件・worker 159件すべて green | 自動 |
| 1-3 | `npm run build` | `web/dist/` が出る（recharts と motion を含むので約 750KB） | 手動 |
| 1-4 | `npm run check:bundle` | モック識別子0件 | 自動 |

### M3-2. 画面の流れ（SPEC §13 M3 の完了条件）

スクリーンショットは `docs/screenshots/m3-*.png`。

| # | 手順 | 期待 | 画像 |
|---|---|---|---|
| 2-1 | `/login` を開く | 430px 中央寄せのログインフォーム | m3-01 |
| 2-2 | 「ライセンスキーで登録」→ 登録 | アカウント0件なので `/connect` へ飛ぶ（SPEC §12.1） | m3-02 |
| 2-3 | Connect の手順が4段出る | Metaアプリ → 権限 → トークン発行 → 貼付 | m3-02 |
| 2-4 | 「App Secret を入れる（任意）」 | 開閉する。入れた場合だけ長期化を試す | m3-02 |
| 2-5 | `THAAdemo_...` を貼って「つなぐ」 | 進捗バーの画面。「先にホームへ進んでも大丈夫です」＋「ホームへ」 | m3-03 |
| 2-6 | cron を回してから `/app/home` | KPI4つ・グラフ2つ・トップ投稿・リンクが出る | m3-04 |
| 2-7 | 期間を「7日」に変える | KPI・グラフ・投稿数・リンクの数字がまとめて変わる | m3-05 |
| 2-8 | 指標を「クリック」に変える | 並び順が変わり、行の先頭の数字がクリックになる | m3-06 |
| 2-9 | 行をタップ | 各段（2投稿目以降）の表示回数と、返信/リポスト/引用/クリック/遷移率が開く | m3-06 |
| 2-10 | 行の「⋯」 | 下からシートが出て「リライト / これを型にして作る / リポスト / Threads で開く」 | m3-07 |
| 2-11 | 「これを型にして作る」 | `/app/create` に `location.state.preset` 付きで移り、本文が出る | m3-08 |
| 2-12 | 下部タブでキュー / 自動 / 設定 | それぞれ「M4〜M7 で作ります」のプレースホルダ | m3-11〜13 |
| 2-13 | ハンバーガー | ドロワーにアカウント一覧・画面一覧・メールアドレス・ログアウト | m3-10 |
| 2-14 | フォロワーのスナップショットが1点 | グラフの代わりに「明日から推移が出ます」（SPEC §7.2） | m3-04 |

### M3-3. 触感（SPEC §12.5 / apple-design）

| # | 確認 | 期待 |
|---|---|---|
| 3-1 | ボタン・チップ・タブ・行を押した瞬間 | 指を離す前に縮む（pointer-down で反応） |
| 3-2 | ドロワーを指で左へ引く | 指に1:1で追従する。途中で掴み直しても現在位置から続く |
| 3-3 | ドロワーをゆっくり少しだけ引いて離す | 速度を継いだまま開いた位置へ戻る（硬く跳ね返らない） |
| 3-4 | ドロワーを左へ弾く | 投影点が半分を越えるので閉じる（離した位置ではなく勢いで決まる） |
| 3-5 | ドロワーを右へ引っ張る | 進むほど付いてこない（ラバーバンド）。硬く止まらない |
| 3-6 | シートを下へ弾く | 閉じる。ゆっくり離すと戻る |
| 3-7 | タブを切り替える | 前の画面の退場を待たずに、新しい画面が cross-fade ＋ 軽い上下移動で出る |
| 3-8 | 行を開閉する | 動くのは `transform` と `opacity` だけ（高さのアニメーションはしない） |
| 3-9 | OS の「視差効果を減らす」を ON | spring とスライドが消え、opacity だけになる。落ちない（m3-09） |
| 3-10 | OS の「透明度を下げる」を ON | TopBar の `backdrop-filter` が外れて不透明になる |

### M3-4. レイアウト

| # | 確認 | 期待 |
|---|---|---|
| 4-1 | 幅 430px で `document.documentElement.scrollWidth` | `clientWidth` と同じ（横スクロールが出ない）。ホーム・各タブとも確認済み |
| 4-2 | 端末の文字サイズを大きくする | 余白が `rem` なので一緒に広がり、崩れない |
| 4-3 | 指標チップ・期間チップ | 入りきらない分は横スクロール（本文は横に流れない） |

### M3-5. 自動テストで担保していないこと（M3 の残り）

| 項目 | いつ |
|---|---|
| ApBar が `GET /autopilot/next` と連動する（いまはプレースホルダ文言） | M6 |
| Create / Queue / Autopilot / Settings の中身 | M4〜M7 |
| リポスト（シートの項目）の実挙動 | モックでは通る。実トークンは M4 の smoke で |

---

## M4 キューと投稿

### M4-0. 準備

M3 と同じ（web は `npm run dev:web`、worker は `wrangler dev`）。cron の手動実行だけ
注意点がある。

```bash
# --test-scheduled を付けて起動した場合
curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"

# 付けずに起動した場合（wrangler が常に生やしている口。M4 の確認はこちらで行った）
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"
```

`--test-scheduled` を付けずに起動していると `/__scheduled` は SPA の HTML を返す
（Worker の fetch ハンドラが未知パスとして ASSETS に流すため）。`/cdn-cgi/handler/scheduled`
は wrangler dev が常に持っている入口で、フラグの有無によらず `scheduled()` を呼ぶ。

ツリー投稿はコメントごとに `commentDelaySec`（既定120秒）待つので、1本の完了までに
5分 cron を数回（本文 → コメント① → コメント②）叩く必要がある。

### M4-1. ビルドとテスト

| # | 手順 | 期待 | 種別 |
|---|---|---|---|
| 1-1 | `npm run typecheck` | エラー0（shared / worker / web / scripts） | 自動 |
| 1-2 | `npm test` | shared 58件・worker 200件すべて green | 自動 |
| 1-3 | `npm run build` | `web/dist/` が出る（約 778KB / gzip 231KB） | 手動 |
| 1-4 | `npm run check:bundle` | 本番エントリ・一時エントリの両方でモック識別子0件 | 自動 |

### M4-2. 投稿の3経路（SPEC §13 M4 の完了条件）

スクリーンショットは `docs/screenshots/m4-*.png`。

| # | 手順 | 期待 | 画像 |
|---|---|---|---|
| 2-1 | 作る画面で本文＋コメント①②③を書く | 文字数カウンタが動き、500文字超で赤くなる | m4-05 |
| 2-2 | 「キューに入れる」→「今すぐ」 | キューへ移動。予約タブに `予約` の行。週表示の今日が 1 になる | m4-01 |
| 2-3 | 「キューに入れる」→「日時を指定」 | Asia/Tokyo の壁時計で解釈され、その日の欄が 1 になる | m4-01 |
| 2-4 | 「キューに入れる」→「おすすめの枠」 | `9/6 12:00 ・ 実績がまだ足りないので既定の枠です`（日曜=12時 / 平日=21時。SPEC §9.3） | m4-06 |
| 2-5 | 5分 cron を叩く | `queue.status` が `publishing` になり、本文が公開されて `result_ids` に1件入る | — |
| 2-6 | 120秒後にもう一度 cron | コメント①が `reply_to_id` で root にぶら下がる。さらに120秒でコメント②→`done` | — |
| 2-7 | 投稿済タブ | 行に 表示 / いいね / クリック が出る。開くと各段と 返信・リポスト・引用・クリック | m4-02 |
| 2-8 | 下書きタブ | 「下書きに保存」したものが並ぶ | m4-08 |

**モックの数字について**: `mock/threads.ts` の数字は投稿からの経過時間で増える（SPEC §11）。
出したばかりの投稿は 0〜数回になるのが正しい挙動で、時間が経つか `full_sync` 済みの
古い投稿を見ると値が入る。

### M4-3. 失敗の見え方

| # | 手順 | 期待 | 画像 |
|---|---|---|---|
| 3-1 | 本文にリンクを6本入れて「下書きに保存」 | 保存されず「1投稿に入れられるリンクは5つまでです（いまは6つ）」がフォーム内とトーストに出る（`validatePost`、SPEC §9.6） | m4-07 |
| 3-2 | 失敗タブ | 行に日本語の理由が2行まで、開くと理由と「Threads からの返答: #100 …」（`error_raw`） | m4-03 |
| 3-3 | 失敗の行の「⋯」→「もう一度ためす」 | `publish-now` が走り、`step` と `result_ids` は保持されたまま続きから進む（二重投稿しない） | — |
| 3-4 | 直前チェック | 30分以内に投稿があると「前の投稿から30分あける設定です（いまは◯分）」で failed（`minGapMin`、SPEC §8.3） | — |

3-2 の材料の作り方: 本文に**同じURLを2回含む6本**を入れる。`extractUrls()` は重複を
除く（SPEC §8.5）ので `validatePost` は5本と数えて通り、Threads（モック）は6回と数えて
`LINK_LIMIT_EXCEEDED` を返す。この食い違いは DECISIONS 2026-09-06 に記録してある。

### M4-4. 操作（design-v0.2 §3-5）

| # | 確認 | 期待 | 画像 |
|---|---|---|---|
| 4-1 | 行の「⋯」 | 状態ごとに項目が変わる（予約: 編集 / 日時を変える / 今すぐ投稿 / 複製 / 取り消す / 削除） | m4-04 |
| 4-2 | 投稿済の「⋯」 | リライト / リポスト / 数字を見る / Threads で開く / 複製（削除は出ない） | — |
| 4-3 | 編集 | シートで本文とコメントを直して保存。`publishing` と `done` は編集できない（409） | — |
| 4-4 | 複製 | 下書きタブに同じ本文で増える | — |
| 4-5 | 削除 | `done` 以外は消える。`done` は「投稿済みのものは消せません」 | — |
| 4-6 | 予約タブの週表示 | 7日分。日をタップするとその日だけに絞られ、もう一度で解除 | m4-01 |
| 4-7 | 「リライト」 | `/app/create` に `location.state.preset` で本文が渡る | — |

### M4-5. 自動テストで担保していること

`worker/test/publish.test.ts`（18件）と `worker/test/queue.test.ts`（23件）:

- 3経路（`status:'now'` / `'scheduled'` / `suggest-slot` の `at`）と publish ジョブの投入
- ツリーのコメントが `reply_to_id` で付く。`REPLY_TWO_STEP=1`（3ステップ方式）でも同じ結果
- step 2 の失敗 → 再試行で root を作り直さない（二重投稿しない）
- リンク6本で日本語エラー（POST / PATCH の両方）
- `dailyPostLimit` / `minGapMin` / 3-gram Jaccard 0.8 の重複で failed
- 画像コンテナ IN_PROGRESS → FINISHED → publish。`container_polls` 10 で failed
- レート制限（code 4）で `next_step_at` が後ろに倒れ、再試行で成功する
- 他人の accountId ではキュー系9ルートすべてが 404

### M4-6. 自動テストで担保していないこと（M4 の残り）

| 項目 | いつ |
|---|---|
| `auto_publish_text` × `reply_to_id` の併用可否（H5）。`REPLY_TWO_STEP` の既定値の確定 | 実トークンでの `scripts/smoke.ts` |
| 本文500文字の数え方（コードポイント / UTF-8バイト） | 同上 |
| リンク本数を「重複を除いた数」で数えてよいか | 同上（M4-3 の注記） |
| 画像投稿（`image_url`）の実 API での挙動 | 同上。UI からの画像添付は M5 以降 |
| `pending_approval` / `approve_deadline` の実運用（作るのはオートパイロット） | M6 |
| 承認・取消のメール導線（`/a/:token`） | M6 |

---

## M5 作る（AI）

### M5-0. 準備

M4 と同じ（web は `npm run dev:web`、worker は `wrangler dev`）。M5 は AI を叩くので
`.dev.vars` に `AI_MOCK=1` を足してから worker を起動する。

```bash
# .dev.vars（SPEC §11。`__DEV__=false` の本番ビルドでは効かない）
THREADS_MOCK=1
AI_MOCK=1
```

`AI_MOCK=1` のとき `lib/ai.ts` の `generateRaw()` は外に出ず、`mock/ai.ts` の固定 JSON を
返す。乱数は使っていないので、同じ操作からは常に同じ3案が出る。`/api/health` の `mock`
は Threads 側のフラグなので、AI モックが効いているかは「生成が0msで返って
`案A/案B/案C` が出るか」で見る。

デモの前提: `demo@example.com` / `password1234` でログイン、`@demo_yama`、AIキーは
サーバー保存（設定画面で `AIza…` を1回保存しておく）。

### M5-1. ビルドとテスト

| # | 手順 | 期待 | 種別 |
|---|---|---|---|
| 1-1 | `npm run typecheck` | エラー0（shared / worker / web / scripts） | 自動 |
| 1-2 | `npm test` | shared 58件・worker 257件すべて green | 自動 |
| 1-3 | `npm run build` | `web/dist/` が出る（約 794KB / gzip 236KB） | 手動 |
| 1-4 | `npm run check:bundle` | 本番エントリ・一時エントリの両方で、Threads・AI 両方のモック識別子が0件 | 自動 |

### M5-2. Create の一本道（SPEC §12.3 / design-v0.2 §3-4）

スクリーンショットは `docs/screenshots/m5-*.png`。

| # | 手順 | 期待 | 画像 |
|---|---|---|---|
| 2-1 | 作る画面を開く | 箱1「自分の投稿から」・箱2「参考情報」・指示・[生成する（3案）] の順に並ぶ。結果はまだ無く、「自分で書く」に素の入力欄が出る | m5-04 |
| 2-2 | 箱1の「選ぶ」 | 過去投稿が並ぶ。既定は表示回数の降順 | m5-05 |
| 2-3 | 「本文で探す」にキーワード | 本文一致だけに絞られる（`GET /accounts/:id/posts?q=`） | — |
| 2-4 | 指標チップ（新しい順 / 表示回数 / いいね / クリック） | 並びが変わる。押したチップだけ `aria-pressed=true` | m5-05 |
| 2-5 | 「型として使う」で2本以上タップ | 複数選択できる。閉じると「文体の見本に N 本を選んでいます」 | m5-05 |
| 2-6 | 「リライト元にする」に切り替え | 選択が1本に絞られ、別の1本を押すと入れ替わる | — |
| 2-7 | 箱2の「＋テキスト貼付」→本文→追加 | プールに残り、追加したものは自動で選択状態になる | m5-06 |
| 2-8 | 「＋ファイル」で .txt / .md | ブラウザで読んで `content` として送る。ファイル名がタイトルになる | — |
| 2-9 | 2MB超のファイル / .pdf | 「ファイルは2MBまでです」「.txt か .md を選んでください」（送信前に止まる。SPEC §10.4） | — |
| 2-10 | 指示を書いて [生成する（3案）] | 案A/案B/案C のタブ、根拠（`basis`）、本文＋コメント①②③ | m5-07 |
| 2-11 | 案B / 案C を押す | 本文とコメントがその案に入れ替わる | — |
| 2-12 | 本文を手で直してから「指示で直す」 | **画面で直した本文**を下敷きに直る。ラベルが「指示で直す（1回目）」→「（2回目）」と増える（会話履歴を保持） | m5-08 |
| 2-13 | [キューに入れる] | シートに 今すぐ / 日時を指定 / おすすめの枠。おすすめは `GET /queue/suggest-slot` の結果と理由が出る（M4 の ScheduleSheet を再利用） | m5-09 |
| 2-14 | 日時を指定して予約 | キュー画面へ移動し、その日の欄が増える。行には `origin_post_id` と `source_ids` が付く（SPEC §7.4） | — |
| 2-15 | [下書きに保存] | 下書きタブに入る | — |
| 2-16 | ホームの行 →「リライト」 | 作る画面が `location.state.preset` を受け、モード=リライト元・その1本が選択済み・本文に流し込み済み | — |
| 2-17 | ホームの行 →「これを型にして作る」 | モード=型として使う・その1本が選択済み。**本文は空のまま** | — |

**文字数カウンタについて**: 日本語は1文字が3と数えられる（`bodyLength()` は
「コードポイント数と UTF-8 バイト数の厳しい方」。SPEC §6.3）。77文字の本文が
`213 / 500` と出るのは、実測で数え方が確定するまでの意図した挙動（M4-6 の残り項目）。

### M5-3. AIキーの置き場（SPEC §12.3 Settings / §7.6）

| # | 手順 | 期待 | 画像 |
|---|---|---|---|
| 3-1 | 設定画面 | プロバイダ（Gemini / OpenRouter）、モデル、APIキー、「つながるか試す」 | m5-01 |
| 3-2 | 「つながるか試す」 | `つながりました（gemini-2.5-flash / ◯ms）`（`POST /ai/test`） | m5-03 |
| 3-3 | 「キーをこの端末にだけ保存」を押す | **保存する前に**シートが出る:「この端末にだけ保存すると、オートパイロットは使えません…それでもよろしいですか？」。ONのアカウントがあればその一覧も付く | m5-02 |
| 3-4 | キー未入力のまま「この端末にだけ保存する」 | 「この端末に保存するキーを入力してください」。保存しない | — |
| 3-5 | キーを入れて「この端末にだけ保存する」 | `localStorage.aiKey` に入る。`GET /ai/settings` は `hasKey=false` `storeOnServer=false` `autopilotAvailable=false`。DB の `key_enc` は NULL | — |
| 3-6 | そのまま作る画面で生成 | 通る（`clientKey` を付けて送っている）。同じリクエストを `clientKey` 無しで叩くと `AI_KEY_REQUIRED` | — |
| 3-7 | `localStorage.aiKey` を消して作る画面 | 生成ボタンの代わりに「AIキーがまだ設定されていません」＋[設定でキーを登録する]（design-v0.2 §3-4） | — |
| 3-8 | 設定でサーバー保存に戻して保存 | `localStorage.aiKey` が消える。表示が「いまはサーバーに保存しています。オートパイロットが使えます。」に戻る | — |

### M5-4. API だけで一本道をなぞる（画面を使わない確認）

```bash
J=/tmp/tap-cookies.txt; B=http://127.0.0.1:8787/api
AID=33333333-3333-4333-8333-333333333333
H='-H content-type:application/json -H X-Requested-With:fetch'   # CSRF（SPEC §5.1）

curl -s -c $J -X POST $B/auth/login $H \
  -d '{"email":"demo@example.com","password":"password1234"}'

# 箱1: 指標で並べ替えた過去投稿
curl -s -b $J "$B/accounts/$AID/posts?q=&sort=views&limit=3"

# 箱2: 参考情報をプールに足す
curl -s -b $J -X POST $B/sources $H \
  -d '{"type":"text","title":"下書き運用メモ","content":"毎晩3本の下書きをためる。"}'

# 生成（3案）→ 直す → キューへ
curl -s -b $J -X POST $B/ai/generate $H \
  -d '{"accountId":"'$AID'","picks":["9000000000000111"],"pickMode":"template",
       "sourceIds":["<上で返った id>"],"instruction":"初心者向けに","n":3}'
curl -s -b $J -X POST $B/ai/revise $H \
  -d '{"accountId":"'$AID'","candidate":{...案A...},"instruction":"1行目を短く","history":[]}'
curl -s -b $J -X POST $B/accounts/$AID/queue $H \
  -d '{"status":"scheduled","scheduledAt":"2026-09-09T12:00:00.000Z","body":"…",
       "comments":["…"],"originPostId":"9000000000000111","sourceIds":["…"]}'
```

`AI_MOCK=1` なら `/ai/generate` は `candidates` を3件返し、`/ai/revise` は1件だけ返す。
`history` を積んで2回目を投げても、直前の案の本文が下敷きになる。

### M5-5. 実キーでの疎通（SPEC §13 M5 の完了条件。キーが用意できた時点で行う）

**モックを切ってから行う。** `.dev.vars` の `AI_MOCK` を `0` にする（または行ごと消す）
→ worker を起動し直す。`AI_MOCK=1` のままだと外に出ないので、何も確認できない。

| # | 手順 | 期待 |
|---|---|---|
| 5-1 | 設定で provider=`gemini` / model=`gemini-2.5-flash` に実キーを保存 →「つながるか試す」 | `つながりました（gemini-2.5-flash / ◯◯ms）`。数百ms〜数秒 |
| 5-2 | 箱2にテキストを1件入れて [生成する（3案）] | **JSONが返って3案が出る**。`hook` が3つとも違う。`basis` に参考情報のどこを使ったかが1文 |
| 5-3 | 「指示で直す」を2回 | 2回目が1回目の結果を踏まえて直る（履歴が効いている） |
| 5-4 | 箱2に **YouTube URL** を足して生成 | タイトルだけが取れて（oEmbed）、生成は通る。Gemini 側に `file_data:{file_uri}` として渡る（SPEC §10.2）。動画の中身に触れた本文が出れば経路が生きている |
| 5-5 | provider=`openrouter` / model=`anthropic/claude-sonnet-4.6` に切り替えて 5-2 | 同じく3案。`HTTP-Referer` と `X-Title` が付く（SPEC §10.1） |
| 5-6 | OpenRouter のまま YouTube のソースを選んで生成 | `notes` に「文字起こしを貼ってください」が出る（動画は読めない。SPEC §10.2） |
| 5-7 | 箱2に **記事URL** を足す | サーバーが本文を抽出（SPEC §10.4）。取れなければ「本文を貼ってください」（`EXTRACT_FAILED`） |
| 5-8 | わざと壊れたキーで生成 | `AI_FAILED`「AIの呼び出しに失敗しました（401）」がトーストに出て、画面は壊れない。プロバイダの生の返答は Worker のログにだけ出る（`redact()` 済み） |

5-4・5-7 は外部への実 fetch を伴う（YouTube の oEmbed / 記事の取得）。モック確認では
踏まないので、この節でだけ行う。

### M5-6. 自動テストで担保していること

`worker/test/ai.test.ts`・`worker/test/ai-routes.test.ts`・`worker/test/extract.test.ts`:

- `GET/PUT /ai/settings`: キー本体は応答に出ない。端末保存に切り替えると `key_enc` が
  NULL になり `autopilotAvailable=false`。モデルだけ変えたときはキーを消さない
- `POST /ai/generate`: 端末保存のときは `clientKey` を付ければ通り、付けないと
  `AI_KEY_REQUIRED`。**`clientKey` はサーバーに残らない**（`key_enc` が NULL のまま）
- `POST /ai/revise`: 1案だけ返り `key` は元のまま。指示が空なら 400
- 他人の `accountId` は 404
- `buildContext`: 参考情報は各3,000文字・合計9,000文字で切る。OpenRouter × YouTube は
  `notes` に文字起こしの案内
- `lib/extract.ts`: `<article>` → `<main>` → `<p>` の優先順、`script/style/nav/footer` の
  除去、50,000文字での切り詰め、YouTube の3形式（`v=` / `youtu.be/` / `shorts/`）の正規化

### M5-7. 自動テストで担保していないこと（M5 の残り）

| 項目 | いつ |
|---|---|
| 実キーでの JSON 出力・3案（Gemini / OpenRouter の両方） | M5-5（実キー） |
| YouTube URL の Gemini 経路（`file_data`） | M5-5（実キー） |
| 実サイトからの本文抽出の当たり外れ | M5-5（実キー） |
| 画像の添付（`image_url`） | M6 以降 |
| オートパイロットからの生成（`ap_plan`。型・枠・ネタ源はサーバーが選ぶ） | M6 |

---

## M6 オートパイロットと通知

### M6-0. 準備

M5 と同じ（`.dev.vars` に `THREADS_MOCK=1` / `AI_MOCK=1`、worker は `wrangler dev`、web は
`npm run dev:web`）。デモは `demo@example.com` / `password1234`、`@demo_yama`。
AIキーは**サーバー保存**にしておく（端末保存だとオートパイロットをオンにできない。SPEC §7.7）。

cron の手動実行（M4-0 と同じ入口）:

```bash
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"     # 毎時: insights_recent / ap_plan / ap_notify
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"   # 5分: runJobs（publish）
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+18+*+*+*"    # 日次: full_sync ほか + ap_score
```

毎時の cron は**投入**と**実行**の両方を回す。1回で終わらなかったぶんは `jobs` に
`pending` で残るので、続けて5分の cron を叩くと消化される。

メールは `RESEND_API_KEY` が空のとき送らず、DEV ビルドでは worker のコンソールに
`[email:dummy] to=… template=…` として本文がそのまま出る（承認/取消の URL もここで読める）。

### M6-1. ビルドとテスト

| # | 手順 | 期待 | 種別 |
|---|---|---|---|
| 1-1 | `npm run typecheck` | エラー0（shared / worker / web / scripts） | 自動 |
| 1-2 | `npm test` | shared 85件・worker 338件すべて green | 自動 |
| 1-3 | `npm run build` | `web/dist/` に加えて `manifest.webmanifest` と `sw.js` が出る（PWA v1.3.0 / precache 15件） | 手動 |
| 1-4 | `npm run check:bundle` | 本番エントリ・一時エントリの両方でモック識別子が0件 | 自動 |

### M6-2. オートパイロットをオンにする（SPEC §7.7 / §12.3）

スクリーンショットは `docs/screenshots/m6-*.png`。

| # | 手順 | 期待 | 画像 |
|---|---|---|---|
| 2-1 | 自動タブを開く | 「止まっています」→ 頻度 → いつ出すか → どの型で書くか → 何から書くか → リンク → 承認方式 → 上限 → 分かったこと → したこと の順 | m6-autopilot |
| 2-2 | ネタ源のチップを全部オフにする | 「いまはオンにできません。参考情報が1件もありません…」が**その場で**出る（設定を引き直している） | — |
| 2-3 | その状態で [オンにする] | 同じ文言がトーストで出る。オンにならない | — |
| 2-4 | 設定でAIキーを「この端末にだけ保存」にしてから自動タブ | 「AIキーがサーバーに保存されていません…」 | — |
| 2-5 | アカウントを `needs_reauth` にする | 「このアカウントは再接続が必要です」 | — |
| 2-6 | ライセンスを `revoked` にする | 「ライセンスが無効になっています」 | — |
| 2-7 | 4つとも満たして [オンにする] | 「オンにしました」。ApBar が「次の下書きを準備しています」に変わる。`ap_log` に1行 | — |
| 2-8 | 頻度・時間帯・型・リンク・承認方式・上限を触る | 押すたびに保存される（`PUT /autopilot`）。再読み込みしても残る | m6-autopilot |
| 2-9 | 「使わない言葉」に文字を入れて欄の外をタップ | 「使わない言葉を保存しました」 | — |

### M6-3. 下書きができる（`ap_plan`。SPEC §9.4）

| # | 手順 | 期待 |
|---|---|---|
| 3-1 | 承認方式を「取消可」・4時間前にして毎時の cron | `queue` に `source='autopilot'` `status='scheduled'` が1件。`approve_deadline = scheduled_at − 4時間` |
| 3-2 | キュー画面の予約タブ | その行に「自動」のタグと「あと◯日◯時間で自動的に出ます（取り消せます）」 |
| 3-3 | ApBar | 「次は 9/11 21:00。9/11 17:00 まで取り消せます」（アカウントの timezone で組み立てる） |
| 3-4 | もう一度、続けて毎時の cron を叩く | **増えない**。未消化の自動下書きは在庫として数える（SPEC §9.4-2） |
| 3-5 | 承認方式を「毎回承認する」にして cron | `status='pending_approval'`、`approve_deadline` は NULL |
| 3-6 | 承認方式を「全部おまかせ」にして cron | `status='scheduled'`、`approve_deadline` は NULL |
| 3-7 | `ap_log` | 「9/11 21:00の下書きを作りました（呼びかけ型 / ネタ源: ◯◯）」 |
| 3-8 | リンクの置き場所が「コメントに置く」のとき本文 | 本文に URL が入らず、コメント①の末尾にリンクが付く |

### M6-4. 通知と、メールからの承認/取消（SPEC §9.5 / §7.9 / §10.5）

`approve_deadline` を過ぎるまで通知は出ない。手で確かめるときは行の `approve_deadline` を
過去にずらしてから毎時の cron を叩く:

```bash
npx wrangler d1 execute threads-autopilot --local \
  --command "UPDATE queue SET approve_deadline='2026-01-01T00:00:00.000Z' WHERE source='autopilot' AND status='scheduled'"
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
# worker のコンソールに [email:dummy] … 本文の中に {APP_ORIGIN}/a/<token> が出る
```

| # | 手順 | 期待 |
|---|---|---|
| 4-1 | 締切前に cron | 送らない（`notified_at` は NULL のまま） |
| 4-2 | 締切後に cron | 件名「◯/◯ ◯◯:◯◯ に投稿します（取り消せます）」。本文に取消のURLだけ（承認リンクは出さない） |
| 4-3 | 承認方式が「毎回承認する」のとき | 件名「…の下書きを承認してください」。承認と取消の**両方**のURL |
| 4-4 | もう一度 cron | 送らない（`notified_at` が入っている） |
| 4-5 | 設定 → 通知 → 「メールで知らせる」をオフ | 送らない。行には印だけ付いて、毎時見に行かない |
| 4-6 | メール本文の URL を **Cookie なし**で GET | 確認画面（HTML）。ボタンは1つ、同じURLへの POST フォーム。まだ状態は変わらない |
| 4-7 | 同じ URL に POST | 「取り消しました」。`queue.status='cancelled'`、`ap_log` に「メールのリンクから取り消しました」、`audit_log` に `queue.cancel.email` |
| 4-8 | もう一度 POST | 「この操作はすでに完了しています」（エラーにしない） |
| 4-9 | すでに `done` の行のトークンで POST | 「もう投稿されています」。`action_token_used_at` は **NULL のまま**（消費しない） |
| 4-10 | 署名を1文字書き換えて POST | 「リンクの有効期限が切れています」（どこで落ちたかは出さない） |
| 4-11 | 同じIPから1分に21回 | 21回目が 429「しばらく待ってからお試しください」 |

curl でなぞる場合（トークンはメール本文からコピーする）:

```bash
T='<メール本文の /a/ 以降>'
curl -s "http://127.0.0.1:8787/a/$T"        | grep -oE '<h1>[^<]*</h1>|method="post"'
curl -s -X POST "http://127.0.0.1:8787/a/$T" | grep -oE '<h1>[^<]*</h1>'   # → 取り消しました
curl -s -X POST "http://127.0.0.1:8787/a/$T" | grep -oE '<h1>[^<]*</h1>'   # → この操作はすでに完了しています
```

Cookie を一切送っていないことが要件（セッションは `SameSite=Strict` なので、メールからの
遷移には付かない。SPEC §7.9）。`curl` は既定で Cookie を送らないので、そのままで確認になる。

### M6-5. 期限後に投稿される / 取り消したら出ない

| # | 手順 | 期待 |
|---|---|---|
| 5-1 | 自動の行の `scheduled_at` を過去にして5分の cron | `publishing` を経て `done`。`result_ids` が入る。ツリーのコメントは `commentDelaySec`（既定120秒）後の実行で付くので、cron を2〜3回叩く |
| 5-2 | 取り消してから同じことをする | `cancelled` のまま。`result_ids` は空 |
| 5-3 | 投稿に失敗させる（本文を500文字超にする等） | `failed` になり、`publish_failed` のメールが出る。自動の行なら `ap_log` に残り `consecutive_failures` が増える |
| 5-4 | 失敗を3回続ける | `autopilot.enabled=0` になり `ap_stopped` のメール。画面の「したこと」に「3回続けて失敗したので…」 |

### M6-6. 採点と学習（`ap_score`。SPEC §9.2 / §12.3）

| # | 手順 | 期待 | 画像 |
|---|---|---|---|
| 6-1 | 日次の cron | `post_metrics_history` に `checkpoint='48h'` の行がある投稿だけ採点される。48h 行の無い投稿には `tags_json.scored` が付かない | — |
| 6-2 | 自動タブの「分かったこと」 | 「型別」と「枠別」の2つ。列は 型/枠｜平均表示回数｜いいね率｜本数 | m6-autopilot-learning |
| 6-3 | `n < 10` の行 | 3列とも「集計中（あと◯本）」。数字は出さない | m6-autopilot-learning |
| 6-4 | `n >= 10` の行 | 「平日 21時台 / 3,100 / 2.9% / 12」のように出る。**倍率・おすすめ・予測は出ない** | m6-autopilot-learning |
| 6-5 | 表の下の1行 | 「投稿から48時間後の数字をもとに集計しています。ホームの表示回数（最新値）とは一致しません。AIは本文を書くだけで、この集計には関わりません」 | m6-autopilot-learning |
| 6-6 | 分布の母数が10本未満のアカウント | 採点そのものを見送る（`scored` を付けず、次の日次で拾い直す） | — |

### M6-7. 通知設定と PWA（SPEC §7.8 / §12.4）

| # | 手順 | 期待 | 画像 |
|---|---|---|---|
| 7-1 | 設定 → 通知 | メール（既定オン）・プッシュ（既定オフ）・まとめて知らせる時刻（既定8時） | m6-settings-notifications |
| 7-2 | `VAPID_PUBLIC_KEY` が未設定のとき | プッシュのスイッチが押せず、「サーバーに鍵が設定されていないので、いまは使えません」 | m6-settings-notifications |
| 7-3 | 鍵を入れてプッシュをオン | 通知の許可を求め、許可されたら `push_subscriptions` に1行（`json` は暗号化済みで、endpoint が平文で読めない）。断られたら設定は変わらない | — |
| 7-4 | 同じ端末でもう一度オン | 行は増えない（`user_id` + endpoint から決まる id） | — |
| 7-5 | `npm run build` → `web/dist/manifest.webmanifest` | `name` が「Threads オートパイロット」、`display: standalone`、飛行機のアイコン3枚（192 / 512 / maskable 512） | — |
| 7-6 | `web/dist/sw.js` | precache は静的資産15件だけ。`registerRoute` は SPA のフォールバック1本で、`denylist:[/^\/api\//,/^\/a\//]`。`runtimeCaching` は無い（＝API はキャッシュしない） | — |

`sw.js` の中身を機械的に確かめる:

```bash
node -e '
const s=require("fs").readFileSync("web/dist/sw.js","utf8");
const urls=[...(s.match(/precacheAndRoute\(\[(.*?)\],/s)?.[1]??"").matchAll(/url:"([^"]+)"/g)].map(x=>x[1]);
console.log("precache:", urls.length, "API を含む:", urls.some(u=>u.startsWith("/api")||u.includes("/a/")));
console.log(s.match(/denylist:\[[^\]]*\]/)?.[0]);
'
```

アイコンを作り直すときは `npm run make:icons`（`scripts/make-icons.mjs`。画像変換の依存を
足さないよう、Node の zlib だけで PNG を書いている）。
スクリーンショットの取り直しは `node scripts/shots.mjs m6`（ヘッドレス Chrome を CDP で動かす）。

### M6-8. 自動テストで担保していること

`shared/test/autopilot.test.ts`（27件）と `worker/test/autopilot.test.ts`（40件）:

- `percentile` / `scorePost`（null の項は分母からも外す・carry と ctr の上限・
  `weights='followers'` で ctr が効かない）/ `pickHook`（ローテーションと fixed）/
  `postsForDay`（合計が必ず `perWeek` になる）/ `toLearningAggregate`（`n<10` は null）
- ON にできない4条件それぞれで `PUT` が 409 を返し、理由が日本語で付く
- 48h 行のある投稿だけ採点され、`learning` が4次元で増える。2回走らせても n が増えない。
  母数10未満は見送る。48h 行を後から入れると次の日次で採点される
- 承認方式ごとの `status` と `approve_deadline`。すでに足りていれば作らない。
  先の日に置かれた下書きも在庫として数える（毎時走らせても積み上がらない）
- `needs_reauth` / ライセンス `revoked` では計画しない。3連続失敗で自動停止＋メール
- `link_placement='comment'` の本文URLで AP のキューが `validatePost` に弾かれ、
  手で書いた投稿（`manual`）は通る
- `/a/:token`: GET は消費しない・POST は1回だけ成立し2回目は「すでに完了しています」・
  `publishing|done` は遷移も消費もしない・期限切れと壊れた署名・1分20回のレート制限
- 計画 → 通知 → 期限後に投稿されるまでの一巡（時刻を進める）と、取り消したら出ないこと
- `/notifications` の既定値と更新、Push 購読の暗号化・重複しないこと

`worker/test/jobs.test.ts`: 台帳（`jobs` テーブル）の予算が尽きても、すでに終えた
ジョブの結果を巻き添えにせず打ち切ること（M6 で毎時の投入が3倍になって踏んだ回帰）。

### M6-9. 自動テストで担保していないこと（M6 の残り）

| 項目 | いつ |
|---|---|
| Web Push の実送信（VAPID の JWT 署名と aes128gcm 暗号化） | M7（DECISIONS.md 2026-09-06） |
| 実キーでの `ap_plan` の生成品質 | 実キーが用意できた時点 |
| 実端末（iOS / Android）でのホーム画面追加と通知の受信 | M7 |
| `digest_hour`（まとめて知らせる時刻）にもとづく配信 | M7（いまは設定値を持つだけ） |
