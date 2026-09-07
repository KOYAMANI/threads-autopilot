# 10名で始める無料試験運用

2026-09-07: Cloudflare Freeのまま進める。Paidの契約・支払いは行わない。
D1はデータの原本。スプレッドシートは後から設定できる閲覧・集計用の一方向同期。
最初は10名に限定してライセンスを発行し、1〜2名の実測後に残りを案内する。

## 実装の上限

- `WORKERS_PLAN="free"`。リクエスト/ジョブのDB作業32回＋台帳16回＝最大48回。Cronは作業8回＋台帳40回＝48回。
- Queueは1回1メッセージ、同時実行1。Cronの配送は1回2件まで。通常毎分＋毎時＋日次の合計で最大2,930配送/日、通常の送信・読取・削除だけなら8,790操作。再配送・再試行や同じアカウントの別アプリは追加で消費するため、無料枠内を保証する日次課金ガードではない。
- 投稿履歴は25件ごとに取得・保存し、カーソルから次回再開。最大1,500親投稿＋1,500返信という取得範囲は維持する。初回取得には時間がかかる。
- 指標更新は各周期で古いものから最大50投稿を選ぶ。50件を超える対象は次の周期へ回る。
- 自動生成は1回1案、投稿処理は1回1段階。投稿は優先配送するが、ツリーの完成や予約時刻ぴったりの実行は保証しない。
- オートパイロットがオフのアカウントには計画・通知ジョブを投入しない。
- クリック配分は投稿数に依存しない2文のトランザクションで更新。採点結果と採点済みマークも同一トランザクション。退会は全アカウント分を一括で削除し、予算不足なら途中削除しない。
- QueueにはジョブIDだけを送り、続きの位置はD1に保持。配送が失敗/期限切れでもD1の未完了ジョブはリース失効後に再配送対象になる。

## 無料枠と確認項目

- Workers: 10万リクエスト/日。HTTP/Cron CPU 10ms。待ち時間とCPU時間は異なり、`JOB_TIME_BUDGET_MS=20000`はCPU上限の緩和にはならない。[公式](https://developers.cloudflare.com/workers/platform/limits/)
- D1: 読取500万行/日、書込10万行/日、1DB 500MB。インデックス更新も書込み数を消費する。上限に達した際は操作が失敗する。[料金](https://developers.cloudflare.com/d1/platform/pricing/)、[制限](https://developers.cloudflare.com/d1/platform/limits/)
- Queues: 1万操作/日、保持24時間。送信・読取・削除を別々に数える。[公式](https://developers.cloudflare.com/queues/platform/pricing/)
- Time Travel: Freeは7日。DBと暗号鍵の別保管・復旧演習は別途必要。[公式](https://developers.cloudflare.com/d1/reference/time-travel/)

ローカルテストではCloudflareのCPU制限を再現できない。公開後、登録・ログイン・初回同期・ダッシュボード・AI生成の実測を行う。暗号処理の強度を下げて無料枠に合わせることはしない。
確認する値: Worker CPU/p95・1102エラー、D1のread/write/容量、Queues操作数、D1 jobsの最長待ち時間・失敗件数。
10名でも履歴件数や利用頻度で限界に達し得る。上限が近ければ招待を止め、同期頻度や対象量を見直す。有料への変更はユーザーと相談する。
AI API、送信メール、独自ドメインは別サービス。Cloudflare Freeだけで総費用0円を保証しない。

## 公開前に残る作業

アプリ本体は未デプロイ。D1・Queue・workers.devサブドメインは作成済み。Secret登録のためのWorker本体（初期状態）は作成済みだが、アプリのコード・静的ファイル・D1/Queueバインディングはまだデプロイしていない。
本番用の暗号鍵・署名鍵・管理鍵は、ユーザーの明示許可を受けて2026-09-07に新規生成・Worker Secretsへ登録済み。Secret名の再取得で3件を確認。控えはリポジトリ外 `/Users/yutaro/.config/threads-autopilot/production-secrets.json`（0600、親ディレクトリ0700）。既存のローカルAPIキーや生徒データは移行していない。別媒体への鍵のバックアップは未実施。
送信元info@yama-threads.comは設定済み。Resendでドメイン追加済みだがDNS認証は途中で、実送信APIキーは未設定（進捗はmail-setup.md）。`npm run check:production`で検出する。
準備後にビルド・本番Secret確認・デプロイを行い、実環境で動作とCPUを測る。実投稿/メールの試験対象は明示して確認する。


## 2026-09-07 本番公開・確認結果

- URL: https://threads-autopilot.yama-threads-apps.workers.dev
- Worker version: f274ca65-d1e6-4ab7-8c9d-044d368a4bb0
- Workers無料環境。D1、Queue producer / consumer、3つのCronトリガーのデプロイ成功。
- Resend yama-threads.com は Verified。ドメイン限定・送信専用キーを RESEND_API_KEY Secret に登録。
- 本番チェック成功。暗号・セッション・管理・メールの4つのSecretを名前だけ照会して存在確認。
- ブラウザのログイン画面表示、GET /login・/app/create は200。静的画面のCSP・nosniff確認。
- GET /api/health は200、mock:false。未認証 /api/auth/me・/api/accounts は401、/api/admin/licenses は403。
- オーナー用ライセンス1件発行、指定メールアドレスで登録201・ログイン200・本人情報200・ログアウト200。
- 登録時Cookieは Secure / HttpOnly / SameSite=Strict。本番オーナーにThreadsアカウントは未連携（0件）、自動投稿データはない。
- 本人ログイン情報は /Users/yutaro/.config/threads-autopilot/production-owner.json に0600で保存。秘密値をこの文書に転記しない。
- 未確認: 実メール配送、実APIキーの本番連携、実投稿・実ジョブ、複数人同時利用のCPU/無料枠使用量。今回の登録・ログイン成功だけで10人運用の性能を保証しない。
- 初回Secret照会が一時失敗したが、個別照会成功後の事前チェック付き再実行でデプロイ成功。
- Python標準HTTPクライアントの照会はCloudflareエラー1010。ブラウザ、curl、Node fetchでは正常応答を確認。
