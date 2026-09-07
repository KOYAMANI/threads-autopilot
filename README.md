# Threads オートパイロット

Threads アカウントを「見る → 作る → 出す → 学ぶ」まで1つの画面で回すウェブアプリ。

- 仕様: [SPEC.md](./SPEC.md)
- 決定ログ: [DECISIONS.md](./DECISIONS.md)
- 手動確認チェックリスト: [docs/qa.md](./docs/qa.md)
- 背景資料: [docs/](./docs/)

## 構成

```
[ブラウザ] React SPA (PWA)
    │ HTTPS  /api/*
[Cloudflare Worker]  Hono + TypeScript
    ├ fetch      … API と SPA 配信
    └ scheduled  … Cron Triggers（*/5, 毎時, 日次）
[D1]  SQLite
[外部] graph.threads.net / Gemini か OpenRouter / api.resend.com
```

**初回は10名程度の Cloudflare Free 試験運用**。本番設定は `WORKERS_PLAN="free"`。
1回のDB作業32クエリ＋台帳16クエリ以内、同期は25件ごとに続きの位置を保存する。
無料枠の上限・更新速度・公開前確認は [無料試験運用](docs/free-pilot.md) を参照。
Workers Paidへの変更は自動では行わない。AIプロバイダの利用料は別。

---

## 開発

```bash
npm install
cp .dev.vars.example .dev.vars   # ENC_KEY / SESSION_SECRET / ADMIN_SECRET を入れる
npm run db:migrate               # ローカル D1 にスキーマを流す
npm run seed:demo                # デモデータ（demo@example.com / password1234）

npm run dev                      # wrangler dev（8787）+ vite（5173）
npm test
npm run typecheck
```

`.dev.vars` の値の作り方:

```bash
openssl rand -base64 32   # ENC_KEY（32バイト）
openssl rand -base64 48   # SESSION_SECRET
openssl rand -hex 32      # ADMIN_SECRET
```

`RESEND_API_KEY` を空にしておくと、メールは送らず `wrangler dev` のコンソールに本文が出る。

| コマンド | 内容 |
|---|---|
| `npm run dev:worker` | Worker だけ（`--define __DEV__:true` でモックを有効化） |
| `npm run db:migrate` | ローカル D1 にマイグレーション |
| `npm run db:migrate:remote` | 本番 D1 にマイグレーション |
| `npm run seed:demo` | デモデータ投入（何度実行しても同じ状態） |
| `npm run check:bundle` | 本番バンドルにモック（Threads / AI）が入っていないことの回帰確認（SPEC §11） |
| `npm run licenses -- --count 10` | ライセンスキー発行（管理API を叩く） |
| `npm run smoke` | 実トークンでの Threads API 疎通確認（下記） |
| `node scripts/shots.mjs m7` | 画面のスクリーンショットを撮る（`docs/screenshots/`） |

Threads API はモック（`THREADS_MOCK=1` ＋ トークン `THAAdemo...`）で開発する。
モックは `__DEV__=false` の本番ビルドから消える（`npm run check:bundle` で回帰確認）ので、
env の設定ミスで本番がモックに落ちることはない。
`lib/threads.ts` の分岐には **`__DEV__` を識別子のまま直接書く**こと。定数や関数を挟むと
esbuild のデッドコード除去が効かず、モックが本番バンドルに入る。

cron を手で走らせる（開発時）:

```bash
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"   # publish
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"     # 毎時（ap_plan / ap_notify / digest）
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+18+*+*+*"    # 日次（同期 / 採点 / cleanup）
```

### 実トークンでの疎通確認（`scripts/smoke.ts`）

SPEC §14 の H5（`auto_publish_text` と `reply_to_id` の併用可否）と、絵文字を含む本文の
文字数の数え方を、実アカウントで確かめる。**実際に投稿して消す**ので、捨ててよいアカウントで行う。

```bash
export THREADS_TOKEN='THAA...'        # 長期トークン（threads_content_publish と threads_manage_insights が要る）
npm run smoke                          # 投稿 → ツリー → insights → clicks → 後片付け（DELETE）
```

結果の反映:

- ツリーの2投稿目が1ステップで作れなかった → `wrangler.toml` の `REPLY_TWO_STEP` を `"1"` にする（SPEC §8.3）
- 文字数の上限が UTF-8 バイト数だった → `shared/src/validate.ts` の数え方を確定させる（いまは「コードポイント数とバイト数の厳しい方」）

---

## 本番へのデプロイ

本番は **`wrangler.production.toml`** を使う。`wrangler.toml` はローカル用。
D1・Queue・HTTPS URL・メール送信元・Worker Secretsの準備手順は [本番運用手順](docs/production-security.md) を参照。
Google連携とPushは任意。D1だけでアプリを利用できる。

```bash
npm run typecheck && npm test && npm run build && npm run check:bundle
npm run check:production
# 新規DBに適用。既存DBの場合は先に非公開バックアップを取る
npm run db:migrate:remote
npm run deploy:production
```

`check:production` はPython 3.11以上を使い、仮のDB ID・localhost・モック有効・メール送信元未設定・Queue欠落を拒否する。
`deploy:production` はさらにCloudflare上の必須Secret名を確認してからデプロイする。鍵の値は表示しない。
初回Secret投入時は本番用Workerと暗号鍵を準備し、全てのWrangler操作に `--config wrangler.production.toml` を付ける。
新規の本番DBでは新しい暗号鍵・セッション署名鍵・管理鍵を使い、ローカルのテストデータ・鍵を自動移行しない。
既存の本番DBがある場合、暗号鍵の上書きは禁止。対応する鍵を別の安全な保管先へバックアップする。

WebとWorkerを一緒に公開する。公開後は `/api/health` の `mock:false`、認証・利用者分離・手動下書き保存・定期処理を確認する。
チェックの成功だけで1,000人の負荷や実API生成品質が保証されるわけではない。

### 5. ライセンスキーを発行する

```bash
ADMIN_SECRET='…' npm run licenses -- --count 10 --note '初回ロット' --origin 'https://…'
```

出力のキー（`TAP-XXXX-XXXX-XXXX`）を買い手に渡す。返金や不正利用のときは
`POST /api/admin/licenses/:id/revoke` で失効させる。失効させると、そのユーザーは
ログインできなくなり、既存セッションも消え、自動投稿も止まる（SPEC §5.4）。データは消えない。

### 6. Cron の確認

`wrangler.toml` の `[triggers]` に3本（`*/5`・毎時・`0 18` UTC）が入っている。デプロイ後、
Cloudflare のダッシュボード（Workers → Settings → Triggers）で3本とも有効になっていることを見る。

### バックアップと復旧（D1 Time Travel）

Free プランは直近 **7日**、Paid プランは直近 **30日** の時点に戻せる。買い手のトークンを預かっているので、
壊したときの手順を先に用意しておく。

```bash
npx wrangler d1 time-travel info threads-autopilot                      # 戻せる範囲を見る
npx wrangler d1 time-travel restore threads-autopilot --timestamp <ISO>  # その時点へ戻す
```

戻すと**その時点以降の全買い手の変更が消える**。特定の1人だけを戻すことはできないので、
実行の前に必ず「いま何が壊れているのか」「戻して失うものは何か」を確認する。
1人ぶんのデータを取り出したいだけなら、その買い手に「設定 → データの書き出し」で
CSV を取ってもらうほうが早い。

---

## 買い手向けのセットアップ（6ステップ）

`docs/design-v0.2.md` §7 の導線。所要はステップ3を除けば5分ほど。

1. 購入する → ライセンスキー（`TAP-XXXX-XXXX-XXXX`）をメールで受け取る
2. アプリを開いて登録する（メールアドレス・パスワード・ライセンスキー）
3. **Meta のアプリを作ってアクセストークンを取る**（約15〜20分。ここだけは省けない）
   → 手順書: **［別マニュアルへのリンクをここに入れる］**
   必要な権限は `threads_basic` / `threads_content_publish` / `threads_manage_insights` の3つ
4. 取ったトークンをアプリに貼る → 自動で同期が始まる（初回は数分）
5. AI を使う人は Gemini か OpenRouter のキーを設定する（設定 → AIのプロバイダ。Gemini は無料枠あり）
6. 参考情報を2〜3件入れて、オートパイロットをオンにする

GAS 版から減る手間: スプレッドシートのコピー、Apps Script のデプロイ、Google の未検証警告、トリガーの設定。

### 買い手に伝えること

- 買い切りです。**ホスティング込みで◯年間**（← 販売ページと[特商法の表記](./web/public/legal/tokushoho.html)で年数を揃える）
- 本文を書く AI は**買い手ご自身のキー**で動きます。その料金は AI 提供者から直接請求されます
- 1つのライセンスで Threads アカウントを3つまでつなげます
- 自分のデータはいつでも「設定 → データの書き出し」で CSV に取り出せます
- 退会すると全部消えます（ライセンスキーも無効になり、再登録はできません）

---

## 法務の表記

雛形が `web/public/legal/` にある。**「◯◯」を埋めてから公開する**（雛形であり、法務のレビューは受けていない）。

| ファイル | 公開URL | 埋めるところ |
|---|---|---|
| `web/public/legal/privacy.html` | `/legal/privacy.html` | 事業者名・所在地・連絡先・監査ログの保存期間 |
| `web/public/legal/tokushoho.html` | `/legal/tokushoho.html` | 事業者名・責任者・所在地・電話・メール・価格・提供年数・支払い方法・返金の条件 |

`web/public/` の中身は `npm run build` でそのまま `web/dist/` に入り、Workers Static Assets から
配信される（Worker のルート `/api/*` `/a/*` とはぶつからない）。

---

## 既知の制限（実キーで未検証の項目）

**実際の Threads アカウント・実際の AI キー・実際の Resend・実際のブラウザ Push で
動かした確認は、まだ1つも取れていない。** 開発はすべてモックで行った。
以下は「モックでは通るが、実物で確かめていない」ものの一覧。

| # | 項目 | 影響 | 確かめ方 |
|---|---|---|---|
| 1 | `auto_publish_text=true` と `reply_to_id` の併用（H5） | ツリー投稿の2本目以降が作れない可能性。作れなければ `REPLY_TWO_STEP=1` に切り替える（3ステップ方式は実装済み・テスト済み） | `npm run smoke` |
| 2 | 本文500文字の数え方（コードポイントか UTF-8 バイトか） | 絵文字の多い投稿が弾かれる、または通ってから Threads に断られる | `npm run smoke` |
| 3 | `threads_insights?metric=clicks` の `link_url` の実際の形 | クリックが投稿に紐づかず `unassignedClicks` に落ちる。`normalizeUrl()` の調整が要る | 実アカウントで数日運用してダッシュボードを見る |
| 4 | 長期トークンの交換と延長（`th_exchange_token` / `th_refresh_token`） | トークンが60日で切れる | 実トークンで `POST /accounts` と `POST /accounts/:id/refresh-token` |
| 5 | Gemini / OpenRouter の実キーでの JSON 生成 | 3案が返らない（`AI_BAD_OUTPUT`） | 設定 → 「つながるか試す」 |
| 6 | YouTube URL を Gemini に `file_data` で渡す経路 | 動画のネタ源が使えない | 実キーで参考情報に YouTube URL を入れて生成 |
| 7 | Resend の実送信（差出人ドメインの検証を含む） | 承認・取消・失敗・ダイジェストのメールが届かない | `RESEND_API_KEY` を入れて自分宛に1通 |
| 8 | Web Push が実際の Push サービス（FCM / APNs 経由の Mozilla・Apple）に受理されるか | プッシュが届かない。**メールは届くので運用は回る**。暗号（aes128gcm）と JWT（ES256）の形は自動テストで往復まで確認済み | 実機（iOS はホーム画面に追加した PWA のみ）で購読して自動投稿を待つ |
| 9 | 画像投稿（`image_url` を Threads 側が取りに来る） | 画像つき投稿が失敗する。公開URLが要る | 実トークンで画像つきを1本 |
| 10 | リポスト（`POST /{id}/repost`） | ホームの「リポスト」が失敗する | 実トークンで1本 |
| 11 | Cloudflare Free の実測（D1 50クエリ/呼び出し、HTTP/Cron CPU 10ms） | 32作業＋16台帳の範囲で再開でき、CPU制限にも収まるか | 本番で投稿数千件のアカウントを同期し、`jobs.last_error` を見る |

このほか、[docs/qa.md](./docs/qa.md) の各マイルストーンに「実トークンでの確認」の節がある。

---

## テスト

```bash
npm run typecheck    # shared / worker / web / scripts の4プロジェクト
npm test             # shared（vitest）+ worker（@cloudflare/vitest-pool-workers、実 D1）
npm run build
npm run check:bundle # 本番バンドルにモックが入っていないこと
npx wrangler deploy --dry-run --outdir /tmp/out   # 上げずにビルドだけ通す
```

画面の確認は自動テストではなく [docs/qa.md](./docs/qa.md) の手順書で行う（SPEC §14）。
M1〜M7 を通しで見る「総合チェックリスト」が末尾にある。

## 共通URL配布・Googleスプレッドシート連携（2026-09-07）

本番の新しい実行構成は [docs/production-security.md](docs/production-security.md)、Google認証と同期は [docs/google-sheets.md](docs/google-sheets.md) を参照してください。本番では `wrangler.production.toml` を使います。従来の端末保存AIキーは廃止し、設定画面で本人のキーを再登録する方式に変えています。スプシはデータの定期書き出し先で、編集・予約の原本はアプリのD1です。
