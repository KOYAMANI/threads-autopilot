# Threads オートパイロット

Threads アカウントを「見る → 作る → 出す → 学ぶ」まで1つの画面で回すウェブアプリ。

- 仕様: [SPEC.md](./SPEC.md)
- 決定ログ: [DECISIONS.md](./DECISIONS.md)
- 背景資料: [docs/](./docs/)

## 構成

```
[ブラウザ] React SPA (PWA)
    │ HTTPS  /api/*
[Cloudflare Worker]  Hono + TypeScript
    ├ fetch      … API と SPA 配信
    └ scheduled  … Cron Triggers（*/5, 毎時, 日次）
[D1]  SQLite
```

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
| `npm run seed:demo` | デモデータ投入（何度実行しても同じ状態） |
| `npm run check:bundle` | 本番バンドルに Threads モックが入っていないことの回帰確認（SPEC §11） |
| `npm run licenses -- --count 10` | ライセンスキー発行（管理API を叩く） |
| `npm run smoke` | 実トークンでの Threads API 疎通確認（`THREADS_TOKEN` 必須） |

手動確認のチェックリストは [docs/qa.md](./docs/qa.md)。

Threads API はモック（`THREADS_MOCK=1` ＋ トークン `THAAdemo...`）で開発する。
モックは `__DEV__=false` の本番ビルドから消える（`npm run check:bundle` で回帰確認）ので、
env の設定ミスで本番がモックに落ちることはない。
`lib/threads.ts` の分岐には **`__DEV__` を識別子のまま直接書く**こと。定数や関数を挟むと
esbuild のデッドコード除去が効かず、モックが本番バンドルに入る。

デプロイ手順・買い手向けセットアップ手順・D1 Time Travel の復旧方針は M7 で追記。
