# 2026-09-07 実装と検証の引き継ぎ

## 配信状態

- GitHub: 非公開 `KOYAMANI/threads-autopilot` を作成し、既存履歴を SSH で保存。`main` は開始時点、`staging` と `codex/staging-foundation` に今回の変更を保存する。
- ステージング: https://threads-autopilot-staging.yama-threads-apps.workers.dev
- 最終 Worker version: `df13a1ec-7a47-4b78-9edd-35b8dcf07dec`。Threads OAuth用Secretと専用テストアカウント初回接続対応を配信。D1 は 0007/0008/0009 適用済み。
- 本番: 投稿枠・認証強化等の新コードは未配信。既存コードにThreads OAuth用Secretだけを追加した `f7e5b77f-4583-474c-b039-7b776640244f` を配信。実ユーザーのトークン・APのON/OFF・DBスキーマは変更していない。
- GitHub Actions: 自動承認レビューが有効化を拒否。自動テスト限定での有効化についてユーザー確認待ち。CIはまだ稼働していない。Cloudflare配信用のCI Secretも未登録。

## 実装

### 投稿枠と毎日の自動生成

アカウントのタイムゾーンで毎日共通の時刻を1〜10個保存し、日別カレンダーに空き・予約・取消済みを表示。次の空き枠または選んだ枠へ下書きを入れられる。DBトリガーと再送キーで予約の競合を防ぐ。時刻設定の変更で既存予約を勝手に移動しない。

APは毎日1〜3本が上限。新規アカウントは最大3本、既存の1/2本設定や承認方式は維持。無料設定は1ジョブにつき1本生成し、今後24時間の枠へ補充する。承認待ちの在庫は上限本数ぶんまで。材料は7日再利用しないため毎日3本なら21素材/週が目安であり、素材不足の日に3本を保証しない。

OFFでは未実行のAP予約を下書きへ戻し、手動予約を保持。生成途中のOFFや並行設定保存による再ON、取消・削除・編集・承認と投稿開始の競合も防ぐ。日時変更だけでは承認待ちを解除しない。外部への公開処理が既に始まった投稿までは取り消せない。

公開日時を可変のキュー状態から分離し、ツリー返信失敗や再開後も実公開日の上限に数える。詳細は [publication-safety.md](publication-safety.md)。外部APIの応答喪失など、DBとAPIを跨ぐあらゆる障害に対するexactly-once保証ではない。

### 認証とAPIキー

新しいセッションCookieは256bitの乱数、DBにはSHA-256だけを保存。旧Cookieは受け付けないが、既存DB行や端末登録を一括削除しない。パスワードは専用PASSWORD_PEPPERのHMACを追加し、旧PWを成功ログイン時に移行する。PBKDF2は100,000回のままで600,000回相当とは扱わない。詳細は [auth-security-migration.md](auth-security-migration.md)。

独立したPASSWORD_PEPPERをローカル・stage・prod用に生成。ローカルとstageへ設定済み。prodへの登録は本番コード切替前に必要。実値はGit・会話に含めていない。

通常のThreads APIはBearerヘッダへ移行。プロフィール読み取りで実API200を確認。リダイレクトを拒否し、外部通信にタイムアウトを追加。Meta所定のトークン交換・延長だけはクエリ方式を維持している。

### 定期実行・バックアップ

管理者限定の /api/admin/scheduler-status に開始・成功・失敗・未到達を表示。例外本文や投稿本文は返さない。Cronの失敗を握りつぶさない。stageのCronは毎分の到達記録のみで、同期・生成・公開・メールを実行しない。

本番は3種類のCron設定とscheduledハンドラー登録を確認したが、実イベント到達は未確認。stageでも初回配信後の読み取り時点では not_observed。定期同期・トークン延長・予約投稿・毎日生成の運用確認が完了したとは扱わない。詳細は [scheduler-monitoring.md](scheduler-monitoring.md)。

本番D1をローカルの非公開フォルダへ退避し、メモリ上のSQLiteへ復元。quick_check=ok、外部キー不整合0、チェックサム一致。0007〜0009を復元コピーへ適用して再度整合性を確認した。backup-d1.shに復元検証を組み込み、verify-backup.pyを追加。独立した暗号化保存先への日次転送・世代保持・失敗通知は未設定。DBと暗号鍵は別管理が必要。

## 検証

全体: 型チェック、shared91件 + worker493件 = 584件、Webビルド、モック除去検査、stage構成検査を通過。その後の公開安全性の関連39件も通過。

UI: 完全なモックAPIを使用して1440px PC / 390pxスマホで確認。10枠上限、重複時刻、予約操作、AP上限変更、横溢れなしを検証。実アカウントの公開は行っていない。

実stage API: 既存PWログイン、環境表示、API未連携拒否、本番IDへの404、別ユーザーのスケジュールアクセス404、時刻保存、重複/11枠拒否、別々の空き枠予約、AP4本拒否、PW変更と旧セッション失効、新PWログインを確認。最終版では承認待ちの日程変更で状態を維持、AP OFFで自動予約のみ下書きへ戻り手動予約を保持することも実D1で確認。使い捨てユーザーと無効なダミートークンのみ使用し、試験後に削除した。

## Metaアプリ作成

2026-09-08: Chrome Canaryで新規「Threads Autopilot」の作成完了を確認。Meta管理用アプリIDは `1584346690092191`、OAuthに使用するThreads専用アプリIDは `924086796982144`（両者を取り違えない）。既存アプリは変更していない。

threads_basicに加え、実装が要求するthreads_content_publish / threads_manage_insights / threads_read_replies / threads_manage_repliesを追加し、全5権限の「テスト準備完了」を確認。下記のstage/prodリダイレクトURLを保存し、設定画面に両方が残っていることを確認した。

本人によるFacebook再認証後、Threads App Secretを画面から取得。CUAのemit:falseで実値を出力せず、Cloudflareのstage/prod両方にTHREADS_APP_IDとTHREADS_APP_SECRETをSecretとして登録した。ブラウザのパスワード保存は断った。秘密値はGit・会話・ローカルファイルに保存していない。

DashboardでのSecret登録は新しい未配信バージョンを作るだけだったため、登録前後のバージョンを比較。既存bindingsとscript_runtimeは同一、script情報の差分はlast_deployed_fromのみで、新規bindingsは認証用Secretの2項目だけであることを確認して、stage→prodの順でそのバージョンを配信した。本番へ開発中の新コードは配信していない。

2026-09-07T15:36:29Z: 両環境で本人ログイン後のGET /api/threads/oauth/statusが200・configured=true。stageのPOST /api/threads/oauth/startは200で、認証ホストthreads.net、Threads専用アプリID、stage戻り先URL、5スコープが正しいことを確認。チェック用セッションはログアウト済み。認可の同意・トークン交換・実アカウント接続はまだ未検証。

Metaアプリは未公開。公開画面はプライバシーポリシーURL不足を表示し、「公開する」が無効。ユースケースとアプリレビュー承認の確認も案内されている。アプリには公開済みプライバシーポリシーの実装がまだ見当たらない。指定された `yama_threads.sub` をThreadsテスターとして追加。本人から招待承諾の連絡後、Metaを再読込して「承認待ち」が消えたことを確認済み。stageは初回接続時のみ認証済みプロフィールの指定ユーザー名を照合し、その後に数値IDへ固定する準備を進める。Chrome Canaryのstageは未ログイン、Threadsは確認時点でyama_threadsだったため、stageとsubアカウントへの本人ログインを依頼済み。yama_threadsでの投稿テストは行わない。

Cron監視は上記確認時点でもnot_observedで未検証のまま。

戻り先URL:

- https://threads-autopilot-staging.yama-threads-apps.workers.dev/api/threads/oauth/callback
- https://threads-autopilot.yama-threads-apps.workers.dev/api/threads/oauth/callback

運営アプリを一度設定し、各利用者が自分のThreadsへのアクセスを個別に許可する設計。開発モードのテストと一般公開は別。必要な権限審査・公開設定は未完了。公開に必要なビジネス確認、プライバシーポリシー、データ削除手順等を管理画面に従って整える。

## 次に行うこと

1. Macのロック解除とMetaの本人確認後、新しいアプリ作成・Threads権限・戻り先URL・運営Secret設定を完了する。専用のテスト用Threadsアカウントを選ぶ。
2. GitHub Actions有効化の許可後、自動テストを稼働させる。stage配信は環境限定の権限を設定してから。本番の自動配信は無効のまま。
3. 実Cron到達を確認・原因調査し、実投稿を避けた運用テストを完了する。
4. 本番の新しいバックアップ取得、PASSWORD_PEPPER登録、0007〜0009適用、最終確認済みコードの配信、既存PWログイン・読取確認を行う。認証変更後は利用者の再ログインが必要。

## 2026-09-08 初回OAuth接続とMetaエラー

`yama_threads.sub` のThreadsテスター招待承諾をMeta管理画面で確認。ID未取得時のみ認証済みプロフィールの指定ユーザー名を照合できるようにし、stageへ配信。関連32テスト・型チェック・stage構成検査が成功。数値IDが取得できたらIDで固定し、ユーザー名の初回照合設定を空にすること。実投稿・削除・メール禁止は維持。コードはfd13ddcを開発・stagingブランチに保存済み。

本人はローカル保存済みstage認証ファイルでログインできたと回答。更新後のstage OAuth開始200、両環境configured=trueを確認。2026-09-07T15:48:51Z時点でCronはnot_observed。CUAはChrome Canaryのウィンドウ名だけを返し、AXもスクリーンショットも取得不可。前面化・再初期化でも改善せず。

本人によるOAuth操作でMetaエラー1349168（redirect URIがホワイトリスト未登録）が発生。アプリ側のclient_id・stage redirect_uriは検証済み。Metaで以前保存操作後にチップ表示までは確認したが、再読込後の永続化確認は不十分だった。Meta設定ページを新しいタブで開いたが、UI内容の取得不可が続いており登録内容を再確認できていない。URLの保存・反映不備か不一致かは未確定。OAuth完了、ID固定、分析同期は未検証。
