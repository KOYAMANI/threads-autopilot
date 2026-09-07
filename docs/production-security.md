# 共通URL配布の実装と運用

## 実装した境界

生徒のブラウザ → Cloudflare Worker → D1（原本・暗号化した秘密）という構成。WorkerがThreads/AI APIを利用し、本人のGoogleスプレッドシートへデータを同期する。生徒ごとのシートを共有DBや鍵置き場としては使わない。同期仕様は [google-sheets.md](google-sheets.md)。

- AIキーの端末保存とclientKey送信を廃止。設定取得APIはキー本体を返さない。AIキー削除で自動運用も停止する。
- AIキー・Threadsトークン・Google refresh tokenはD1でAES-256-GCM暗号化。ENC_KEYはWorker Secretとして別管理。実行時にはWorkerが復号できるため、運営者も読めない仕組みではない。Workerを改変できる権限の侵害は防ぎ切れない。
- ログイン・ログアウト・認証失効で通信を中止し、キャッシュと画面を破棄する。別タブの切替や履歴復帰も再読込する。旧localStorage.aiKeyは自動移行せず削除するので、利用者は本人のキーを設定画面で再登録する。
- Push購読をセッションに紐付け、失効済みセッションへ送らない。通知にはアカウント名や下書きを含めず、ログイン後に確認する案内だけ送る。
- パスワード再設定はトークン取得・パスワード更新・セッション失効を同一DBバッチにまとめ、競合で拒否された要求がパスワードを変更する問題を修正。
- APIはno-store、変更操作のCSRFヘッダ、サイズ上限1MB、認証IPと利用者ごとの回数制限を適用。静的画面にCSPとフレーム埋め込み禁止。参考情報は利用者あたり最大200件、一覧では本文全体を読まない。
- 管理者APIは既存の専用Secret認証にIP回数制限を追加。公開前にCloudflare Accessなどで管理経路へのアクセスも絞る。CloudflareアカウントのMFA・権限分離は管理画面側の設定であり、この変更だけでは設定されない。

## 本番を有効にする順序

`wrangler.production.toml` を本番用に追加した。通常の `wrangler.toml` はローカルの単一実行用。DB ID・APP_ORIGINは設定済み。Secretと送信元メールは未設定なので、そのままデプロイしない。

1. 初回10名はWorkers Freeを維持し、専用の本番DBとQueueを使う。既存の本番DBを使う場合は新規作成せず、IDを合わせる。
2. `wrangler.production.toml` の `database_id`、HTTPSの `APP_ORIGIN`、Googleの公開Client ID、メール・Push公開設定を入れる。`THREADS_MOCK` と `AI_MOCK` は0のままにする。
3. ENC_KEY（32バイトのbase64）、SESSION_SECRET、ADMIN_SECRET、GOOGLE_CLIENT_SECRET、必要なメール/Push秘密をWorker Secretsに登録する。既存ENC_KEYを新しい値で上書きすると既存データを復号できなくなる。
4. DBを退避してからマイグレーションを適用し、ビルド・デプロイする。新規DB以外ではメンテナンス時間を取る。

```sh
# 新規リソースが必要な場合だけ
npx wrangler d1 create threads-autopilot
npx wrangler queues create threads-autopilot-jobs

# 対話入力。値をコマンド引数やGitに残さない
npx wrangler secret put ENC_KEY --config wrangler.production.toml
npx wrangler secret put SESSION_SECRET --config wrangler.production.toml
npx wrangler secret put ADMIN_SECRET --config wrangler.production.toml
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.production.toml

npx wrangler d1 migrations apply threads-autopilot --remote --config wrangler.production.toml
npm run build
npm run check:production
npm run deploy:production
```

初回実装時点では本番操作・外部アカウント接続は実行していなかった。現在の作成状況は末尾の更新を参照。マイグレーション0004は既存Push購読を解除し通知設定をオフにする。以前の購読を端末セッションに結び付けられないためで、利用者は設定画面から再登録する。投稿・下書き・参考情報・保存済みAPIキーは削除しない。`npm run clean` もローカルDBを削除しない形に変更した。

## 大規模運用向けの実行方式（初回Free設定とは別）

定期処理は200接続アカウントずつ登録し、周期とカーソルをD1に保存する。並行した登録でも同じ周期・同じ種類・同じアカウントのジョブを二重登録しない。毎分、D1に残した未実行ジョブを最大980件（98件×10バッチ）Queueへ送る。メッセージはジョブIDだけ。送信失敗は5分のリース失効後に再送する。Queueは1メッセージずつ最大10並列の設定で、完了済みジョブの再配送は実行しない。

Queues自体は重複配送し得る。外部APIへの送信とDB更新は一つのトランザクションにはできないため、障害直後の投稿の二重実行を絶対に防ぐ保証はしない。既存の投稿段階・結果IDによる再開処理を維持している。[Queues配送保証](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)

1,000接続アカウント全件のジョブ登録と末尾到達はローカルテストで検証するが、1,000人の同時利用を本番で負荷試験した結果ではない。利用者あたり最大3接続なので、公開前には3,000接続を含む実データ量で、API応答p95、D1読み書き時間、ジョブ最長待ち時間、Sheets最終成功の遅延、外部429、費用を測る。全員の初回同期は段階的に受け付ける。設定上限を上げるだけではDB性能の保証にはならない。

この節の大規模設定はPaid向け。現在の本番設定は10名用Freeで、処理量を制限する（[詳細](free-pilot.md)）。Freeで1,000人運用を約束しない。[D1制限](https://developers.cloudflare.com/d1/platform/limits/)、[Queues制限](https://developers.cloudflare.com/queues/platform/limits/)

## バックアップと復旧

D1 Time TravelはクラウドDBの復旧手段だが、共通DB全体の巻き戻しになる。スプシには認証情報や全設定がないので、完全復旧には使えない。[Time Travel仕様](https://developers.cloudflare.com/d1/reference/time-travel/)

`bash scripts/backup-d1.sh --remote /絶対パス/非公開の保存先` でDB全体をSQLに退避できる。ローカル用は `--local`。プロジェクト内への保存を拒否し、出力を所有者のみ読める権限にし、ハッシュを残す。SQLは秘密の列が暗号化された状態でも個人情報を含むため、保存先は暗号化した専用領域を使う。独立保存先への日次転送・世代保持・失敗通知は運用側で設定する必要があり、今回そのスケジュールは作成していない。

ENC_KEYをDBと別の権限・別の安全な保管先へバックアップする。キー変更は旧キーでの復号→新キーでの再暗号化→復元検証を伴う移行が必要で、単なるSecret上書きはしない。本実装には自動鍵ローテーションは含まない。

復旧は次の順序で行う。

1. `MAINTENANCE_MODE = "1"` をデプロイ。APIと承認リンクを停止し、Cron/Queueの仕事を停止する。すでに始まった処理が終わったことを確認してからDBを触る。
2. 障害直前のDBも退避。復旧対象時刻と他の利用者の変更への影響を確認する。一人だけの復旧は、SQLバックアップを隔離DBへ復元して本人の必要レコードだけ取り出す。稼働中の共通DBを安易に巻き戻さない。
3. 対応するDB・暗号鍵で復元し、マイグレーション状態を確認する。最初に隔離環境でSQLの整合性・件数・ダミー鍵の復号を確かめる。
4. 復元したセッション、OAuth進行状態、Push購読、パスワード再設定・承認リンクを無効化する。復元前に退会・失効した利用者を復活させない。
5. 自動運用と投稿キューを停止した状態で、Threads側の実投稿IDとDBの結果IDを照合する。すでに送った投稿・通知を再送しない状態にしてから段階的に再開する。
6. 二人の利用者で隔離、Google接続、AI、同期を確認し、メンテナンスを解除する。

ローカルSQLの復元試験とクラウド本番の復旧演習は別。クラウドDBの復元、Secret紛失、外部投稿との突合まで演習して、実測したRPO/RTOを公開条件にする。消失ゼロ・漏洩ゼロの保証はしない。


## 2026-09-07 デプロイ準備の追加確認

D1を正本として先に公開する方針。Sheetsは任意の一方向同期であり、Google連携未設定でもD1とアプリは動く。現在ローカル開発で使うDBは `.wrangler/state/v3/d1` 内のSQLite（D1エミュレーション）。クラウドD1へのデプロイ・ローカルデータ移行はまだ実行していない。

- ホーム期間は7日・2週間・1ヶ月・3ヶ月。作成は型参考／リライトの2モード。どちらも自分の投稿または他人のツリー全文を入力でき、追加情報は共通の資料欄を使う。
- リンク名と自動投稿の候補に含める設定を編集可能にした。CSV書き出しカードは削除。
- Threadsの未連携・要再認証・無効・既知の期限切れは予約作成、日時変更、承認、即時投稿で拒否。メール承認も拒否し、そのリンクは再連携後まで消費しない。下書き保存・取消は可能。連携の有効性は既知の状態を判定し、外部で直ちに失効したトークンまで予約時に常に検出する保証はない。
- `/auth/me` と `/accounts` は同じサーバー由来の連携判定を返し、キー本体は返さない。
- 500件の全体テスト通過後、メール承認と認証応答の追加テストを含む該当スイートも通過。型チェック・Webビルド・本番モック除去・本番設定のdry-run通過。画面ではPC/スマホ・5件表示・2モード・貼付リライト・候補編集保持・リンク名/候補スイッチ・未連携制限を固定API応答で検証。投稿・予約・メールの実送信は行っていない。
- 本番チェックにより、APP_ORIGINがlocalhost、DB IDが仮値、MAIL_FROM未設定を検出。Cloudflare CLIは未ログインで、OAuth認証待ちは時間切れ。リモートのリソース・プラン・Secretの確認は未実施。
- `npm audit --omit=dev` は依存情報の外部送信が自動承認レビューで拒否され、実行していない。ユーザーの許可待ち。これは脆弱性ゼロという結果ではない。
- 最終プロンプトの実Gemini品質確認は以前の429により未完了。1,000人のクラウド負荷試験、クラウド復元演習も未実施。少人数での本番確認と1,000人への全面配布は別の段階として扱う。


## 本番リソース作成状況（2026-09-07 追加）

- Cloudflare OAuth認証完了。アカウントID `983c65a0c3fccb8c1a40ac8ca7e8c3d4` を本番設定に固定。
- D1 `threads-autopilot` を新規作成。ID `89935cef-db44-49c9-b0aa-50cc8105a786`、APAC。0001/0002/0004マイグレーション適用済み。`PRAGMA quick_check` は `ok`、usersは0件。既存ローカルデータは移行していない。
- Queue `threads-autopilot-jobs` 作成済み。
- アカウントのWorkersサブドメイン `yama-threads-apps` 登録済み。本番予定URLは `https://threads-autopilot.yama-threads-apps.workers.dev`。アプリ本体は未デプロイで、このURLで利用できる状態ではない。
- 管理画面でWorkers Freeが現在のプランであることを確認。Paid（月5ドル＋使用量）の支払い画面をChromeに開いた。その後ユーザーがFree・初回10名を選択したため、Paid契約は進めない。
- ローカルRESEND_API_KEYは仮値と判定。実際の送信キーと認証済み送信元ドメインが必要。
- 本番用ENC_KEY/SESSION_SECRET/ADMIN_SECRETを新規生成してWorker Secretsへ登録するコマンドは、自動承認レビューが具体的な秘密情報の登録の明示承認不足として拒否。コマンドは実行されておらず、鍵の生成・登録は未実施。ユーザーへ許可を依頼中。
- 既存テストの再実行や変更のないアプリの再ビルドはしていない。構成変更は本番アカウント、実DB ID、本番予定URLのみ。

## 2026-09-07 Free試験運用への変更

本番を `WORKERS_PLAN="free"` に変更。予算・同期の分割・クリック更新・採点の原子性・複数アカウント退会を修正した。公開状況と実測の限界は [free-pilot.md](free-pilot.md) を参照。

## 2026-09-07 本番Secret登録完了

- ユーザーが3鍵の役割の説明後に「OK,全部進めて」と明示許可したため、前回止まっていた登録操作を実施した。
- 対象Workerが未作成であることを確認したうえで、専用のENC_KEY/SESSION_SECRET/ADMIN_SECRETを新規生成し登録。Wranglerの再取得で3件のSecret名を確認。値は会話・Git・コマンド引数に表示していない。
- Secret控え: `/Users/yutaro/.config/threads-autopilot/production-secrets.json`、権限0600、親ディレクトリ0700。既存鍵のローテーションはしていない。独立した保管先への追加バックアップは未実施。
- D1は348kB・29テーブル。Queueは存在し、producer/consumerは0（アプリ未デプロイのため）。Free設定は維持し、有料契約は実行していない。
- 本番アプリは未デプロイ。Secret登録時にWorkerの初期状態のみ作成された。ローカルのResendキーは仮値で、実送信キーと認証済みMAIL_FROMが必要。Resendのログイン画面を開き、ユーザーへ独自ドメイン名と利用状況を確認中。
- コードの変更はないため、前ターンに完了した計508件のテスト・型チェック・Webビルド・モック除去・本番dry-runを繰り返していない。本番CPUの実測は未実施。


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
