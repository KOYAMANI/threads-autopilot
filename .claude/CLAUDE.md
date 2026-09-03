# threads-autopilot

Threads アカウントの分析・予約投稿・AI生成・自動投稿を1画面で回す買い切りウェブアプリ。
Cloudflare Workers（Hono）+ D1 + React PWA。AI は買い手のキー（BYOK）。

## 正本

- **仕様**: `SPEC.md`（v1.1）。実装はここに書かれた順（§13 マイルストーン）で進める。§0 の進め方に従う
- **決定ログ**: `DECISIONS.md`。仕様に無いことを決めたら1行追記（日付つき）
- **背景資料**: `docs/`（設計書 v0.2 / Threads API 整理 / SPEC v1.0 / prototype.jsx）。読み取り専用
- **UI の正**: `docs/prototype.jsx` — レイアウト・CSS トークン・文言・操作の流れはこれを変えない

## デザイン

`.claude/skills/apple-design/SKILL.md` を、フロントエンドを書く前に必ず読む。役割分担:

- プロトタイプ = 見た目（レイアウト・トークン・文言・流れ）
- apple-design = 動き・触感・タイポ調整（spring / pointer-down 反応 / 中断可能 / `transform`・`opacity` のみ / reduced-motion 尊重）

詳細は `SPEC.md` §12.5。

## 開発

- `npm test` と `npm run typecheck` をマイルストーン完了の前に通す
- Threads API はモック（`THREADS_MOCK=1`、トークン `THAAdemo...`）で開発。実 API の疎通は `scripts/smoke.ts`
- 秘密情報（トークン・AI キー）はログに出さない。`redact()` を通す
- 時刻は DB に UTC、表示はアカウントの timezone

## 言語

コード・識別子・コミットメッセージは英語。ユーザーに見せる文言と仕様書は日本語。
