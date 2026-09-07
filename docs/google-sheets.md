# Googleスプレッドシート連携

## 今回の動作

設定画面で「Googleと連携して管理表を作る」を押し、本人のGoogleアカウントで許可すると、次の定期処理で本人のマイドライブに管理表を作る。共有権限を追加する処理はない。既存のGoogle認証情報がないため、ローカル画面では「管理者による設定待ち」と表示する。

アプリのD1を原本とし、スプシには「投稿実績」「分析」「下書き」「参考情報」「予約・実行結果」を約1時間ごとに一方向で書き出す。初回は連携後に順次処理する。ブラウザを閉じていても、本番CronとQueuesが動いていれば同期する。初回の一斉登録、データ量、外部API制限によって遅れるため、設定画面の最終同期日時を確認する。

管理する5タブの指定列はアプリが上書きし、古い行の値も消す。「自由メモ」、追加タブ、管理列の右側に追加した列は独自集計に利用できる。行の対応は変化するため、独自データは行番号で結び付けず、IDを検索して参照する。スプシで本文を編集してもアプリには戻らない。編集・承認・予約はアプリで行う。同期中の表はタブごとに更新されるため、全タブを同時点に固定したスナップショットではない。

APIキー、Threadsトークン、Googleトークン、パスワード、ライセンスキー、セッション、外部エラー原文は同期対象に含めない。ただし投稿や参考資料の本文に利用者が秘密を入力すると、その本文は同期される。数式として解釈されない文字列セルを使う。

## 管理者の初期設定

1. Google Cloudの専用プロジェクトでGoogle Drive APIとGoogle Sheets APIを有効にする。
2. OAuth同意画面と「ウェブアプリケーション」のOAuthクライアントを作る。公開URL・問い合わせ先・プライバシーポリシーを登録し、一般配布に必要な公開設定・確認手続きを済ませる。
3. リダイレクトURIを `https://公開ホスト/api/google/callback` と完全一致で登録する。ローカル検証用は `http://localhost:5173/api/google/callback`。APP_ORIGINも同じオリジンにする。
4. `GOOGLE_CLIENT_ID` は `wrangler.production.toml` のvars、`GOOGLE_CLIENT_SECRET` は下のSecretsコマンドで設定する。クライアントシークレットをGit、HTML、チャットへ貼らない。

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.production.toml
```

ローカルはGit対象外の `.dev.vars` に専用の検証用IDとシークレットを設定する。未設定でもその他の機能は使える。本番の定期実行は [production-security.md](production-security.md) を参照。

権限は `openid` と `https://www.googleapis.com/auth/drive.file`。このアプリが作成した、または利用者がこのアプリへ明示的に許可したファイルに絞る。全Driveへの権限は要求しない。アプリを閉じても同期できるようofflineアクセスを要求する。[GoogleのOAuth仕様](https://developers.google.com/identity/protocols/oauth2/web-server)、[Driveの権限](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

認証途中のstateは10分・一回限りで、開始した利用者、セッション、ブラウザに結び付ける。PKCEを使い、Googleからの戻り先は外部リソースのない専用ページ。Googleのrefresh tokenはENC_KEYで暗号化してD1へ保存し、access tokenはサーバーの処理中だけ使用する。Googleアカウントを変更すると旧管理表との関連を外す。

## 失敗・解除・復旧

- Googleの許可が失効：設定から再連携する。
- 管理表が削除・アクセス不可：「管理表を復旧する」でアプリがアクセスできる管理表を探し、なければ再作成する。アプリにない独自編集は戻せない。自動で無断再作成はしない。
- 混雑・一時障害：同期を再試行する。最終成功日時は全タブの同期完了後だけ更新する。
- 解除：暗号化したGoogleトークンと未実行の同期ジョブを削除する。ドライブ上の表は残る。Google側の許可取消はGoogleアカウントの接続設定で行う。解除直前に送信済みの外部リクエストは取り消せない。

Google向けの読み取り・書き込みは、それぞれプロジェクト全体で最大150回/分に抑え、1分に新規同期を最大20人投入する。1回の処理は最大5ページ、1ページは最大200行かつ概ね500KBまでに分割し、続きをD1に保存する。大きな表では1時間以上かかることがある。[Sheets APIの利用上限](https://developers.google.com/workspace/sheets/api/limits)

スプシは完全バックアップではない。共有リンクを公開した場合は本文・分析も公開されるので、利用者自身の共有設定が適用される。実際のGoogle同意、作成、閉じた後の同期は、認証設定後に検証用アカウントで確認する必要がある。
