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
npm run dev        # wrangler dev + vite
npm test
npm run typecheck
```

デプロイ手順・買い手向けセットアップ手順は M7 で追記。
