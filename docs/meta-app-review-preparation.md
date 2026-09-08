# Meta App Review 準備資料（未公開草案）

作成日: 2026-09-08 JST。これは運営者向けの準備資料であり、公開済みプライバシーポリシーでも、提出・承認済み申請でもない。コードの存在、ステージングの実測、本番での利用可能性を区別する。認証情報、招待キー、App Secret、アクセストークンは本書に記載しない。

## 審査専用環境の準備（2026-09-08、以下の履歴より新しい）

**権限のアプリレビューは未提出。** Business Verificationは承認済み、Access Verificationは提出済み。これらを権限レビューの受付と混同しない。

- ステージング版 `9c8ec751-a371-4ce0-841f-094f56173345` を配備。審査専用ユーザーと固定した `@yama_threads.sub` に限り、手動で作った投稿・予約を実行する。通常のステージング利用者の投稿とAutopilotは引き続き停止。既存の本人用予約2件は実行していない。
- 審査用 user_id: `86ff2600-c8a7-4d04-9ed2-a8480b2c6bae`。接続 account_id: `0ec0fd92-0294-46ed-b61b-15050977d3c6`。D1で固定Threads ID `28121200714239994`、username `yama_threads.sub`、status `ok`、初回同期完了 `2026-09-08T02:28:42.513Z` を確認。
- 専用ログイン・利用資格を新規作成。秘密は運営端末の `~/.config/threads-autopilot/staging-meta-reviewer.json`（0600）に保存。Gitや公開ドキュメントには載せない。アプリの実ログインとAPI capabilityで専用ユーザーのみ `enabled=true, review=true`、通常ユーザーは両方falseを確認。
- 実投稿直前に同じトークンの `/me` を照合。別プロフィール・別利用者・期限切れ設定は拒否する。許可する変更APIも本人投稿の作成と公開に限定。Cronは専用ユーザーの期限到来済み手動キューだけを送出する。
- 公開許可の有効期限は `2027-10-01T00:00:00Z`。これはThreadsトークンがその日まで有効なことを保証しない。トークンの更新・再接続と審査中の稼働確認は別途必要。
- `npm test`: 47ファイル629テスト成功。型検査、ビルド、ステージング構成検査、差分空白検査成功。新しい制限のテストと通常公開処理の回帰確認を含む。本番は未変更。
- **アプリ画面経由の新規実投稿・Cron完了と実画面録画は未実施。** 先の直接APIによる公開成功を、その証拠として代用しない。
- データ処理事業者: 自身・Resendは保存済み。Cloudflareは53か国（AEからHNまで）の途中状態が保存されていることを再確認。公開ネットワーク所在地だけで実処理国を断定せず、サービス・契約・再委託先の範囲を照合して最終化する。まだ申告完了とは扱わない。
- Gemini/OpenRouterの実際の送信先・契約条件を揃える必要がある。課金有効Geminiに初期版を限定するか、両方残すかをユーザーへ質問中。利用者の返答前に課金開始やプロバイダ廃止は行わない。
- MetaフォームのAXと画面表示が一致せず、クリックが適用されない問題が再発。未確認の保存や提出は行わない。ユーザーへタブ表示の復旧を依頼中。
- 提出前: 実録画、審査担当者への専用ログイン情報の入力、古い「準備中」手順の更新、各権限のAPIテストと使用条件の確認、処理事業者申告を完了し、受付状態を検証する。

## 2026-09-08 最新の申請準備状況

この節が下記の履歴より新しい。**アプリレビューは未提出。**

- Metaの申請画面で `yama_skill` は「認証済み」。認証の進捗100%を確認。従来の「事業者認証の結果待ち」は解消した。アクセス認証（Access Verification）は別手続きで、2026-09-08 10:17 JST頃に送信済み。「提出情報を審査中です。追加情報が必要な場合は5日以内に連絡」と表示された。これは承認期限や権限審査の提出完了を意味しない。
- 既存の `web/public/icon-512.png` をMetaへ登録。カテゴリを「ユーティリティ・プロダクティビティ」に設定。
- Websiteプラットフォームを追加。サイトURLはステージング。基本設定を保存後、申請画面の「アプリ設定100%」を確認。
- プライバシーポリシーを実装と公式条件に合わせて修正し、ステージングで公開。事業者情報は本人がLPとの一致を確認した内容。APIキーの復号可能性、OAuth、AIへの送信と学習条件、Resendの正式運営名、削除の範囲、無料D1の7日間の復旧履歴を明示。旧雛形の「監査ログ90日」「全バックアップ即削除」「書き出しUI」等を事実として保証しない。
- 公開URL: https://threads-autopilot-staging.yama-threads-apps.workers.dev/legal/privacy.html 。認証なしGET 200 / text/html / ソースと完全一致 / 雛形の◯◯なしを確認。
- MetaのプライバシーURLとデータ削除手順URLを上記へ設定。誤った利用規約URL `https://www.facebook.com/` は空欄へ戻した。Threadsユースケースの署名付き通知用URLは変更していない。
- ステージング版: `c3727372-bcd3-4293-9c32-024630333133`。変更はポリシーHTMLのみ。ビルド、ステージング構成チェック、公開内容検証に成功。本番WorkerとDBは変更していない。
- 審査担当者の英語手順をMetaに下書き保存。Facebook Loginは利用しない（Threads OAuthとは区別）。専用認証情報、投稿可能な審査環境、動画が未用意であることを下書きにも明記。最終申請前にこの準備中表示を実測済み手順へ更新する。
- 処理事業者に `小山雄太朗（個人事業主 / yama_skill）` を分析・測定／ITサービス、日本として追加保存。フォームは自社も含めるよう要求している。
- 処理事業者のうち `Plus Five Five, Inc. (Resend)` をITサービス／米国として保存。Cloudflare・AI関連を含む全事業者の申告が完了したわけではない。
- データ管理者は小山雄太朗（個人事業主）／日本。国家安全保障の要請による過去12か月の開示は「いいえ」。当局の要請に関する既存運用ルールは「上記のいずれにも当てはまらない」。いずれも本人の回答に基づき保存済み。

### アクセス認証の提出内容（2026-09-08）

- 業種はSaaSプラットフォーム。個人事業主という理由だけでフリーランサー業務と分類せず、提供サービスに合わせた。
- 本人が「管理していない」と回答したため、複数のビジネスポートフォリオ管理はNo。
- プロフィール・本人の投稿と続き・指標の分析、下書きと利用者が選んだ投稿、任意のAI連携、ベータ状態を英語で説明。
- Webサイト欄は https://threads-autopilot-staging.yama-threads-apps.workers.dev/about.html 。サービス・運営者・公開プライバシー/削除手順へのリンクを掲載。
- 公開ページはHTTP 200、ソースとの完全一致を確認。ビルド・ステージング構成チェック成功。新バージョンは `1d171cf7-845c-4024-8277-ad8110ae742f`。本番は変更していない。
- 既存LP https://koyamani.github.io/lp/ の必要な修正はユーザー承認済み。今回はアプリ専用説明ページを提出したため、LPは未変更。

### 残る提出条件

1. 委託先の申告を完了する。Cloudflare、Gemini、OpenRouterとその実際のモデル提供先、メールのResendなど、送信経路と処理国を照合する。米国に本社があるという理由だけで処理国を米国のみにしない。国外拠点を使うCloudflare／Googleの全処理国とOpenRouterの動的提供先は未確定。
2. AI利用の契約・設定を確認する。Geminiの無償サービスは入力・出力が改善・人手確認に利用され得る。OpenRouterはモデル提供先ごとに条件が異なり、現行リクエストは `data_collection: deny` やZDRを強制していない。ポリシーに説明を載せるだけでMetaの条件への適合を保証しない。許可された用途の同意を未確認のままチェックしない。
3. 審査用アプリログインとテストアカウントを用意し、投稿を含む実機テストを完成する。Metaのフォームは提供する認証情報／コードを提出後1年間有効にするよう要求している。通常の利用者や運営者の認証情報を審査担当者へ流用しない。
4. OAuth開始からプロフィール・本人の投稿ツリー・分析・下書き・実投稿とその結果までの動画を用意する。実投稿の撮影には投稿先と本文を確認する。ステージング全員の投稿禁止は現在維持しており、実投稿成功の動画は未作成。
5. 各権限の必須APIテストを確認し、最終申請内容と公開版の機能を一致させる。最後に確認した4権限のAPIテスト表示は0/1。コードや既存の同期成功だけで審査画面のテスト完了とみなさない。

### 審査用投稿の直接API検証記録

対象プロフィール候補：`@yama_threads.sub`。メインの `@yama_threads` は使わない。

- 親投稿：`Threads Autopilotの連携テストです。投稿作成・公開・分析の動作を確認しています。`
- 続き1件：`これは同じアカウントによるツリー投稿の動作確認です。Metaアプリレビュー用のテストとして作成しています。`

2026-09-08、ユーザーが「公開OK」と明示承認。ステージングの待機中予約2件を動かさず、Meta公式APIへ限定した単発処理で上記の親投稿・返信1件を公開した。APIの本人照合、既存同文なし、公開後の本文・投稿者・URL一致を確認。トークンと暗号鍵はメモリ内でのみ利用し、出力・記録していない。

- 親投稿: https://www.threads.com/@yama_threads.sub/post/DdAhMh8EjQC （2026-09-08 10:35:14 JST）
- 返信: https://www.threads.com/@yama_threads.sub/post/DdAhNY0khqX （2026-09-08 10:35:21 JST）
- `POST /me/threads` の `auto_publish_text=true` と `reply_to_id` で公開。GETによる公開結果の照合に成功。
- これは直接APIの疎通確認であり、アプリ画面からの投稿・Cron予約実行・審査動画の完成を意味しない。ステージングの投稿停止とCron監視のみの設定は維持。
- 本人ログインの現在のuser_idは `665b796c-ba94-4451-8e99-a9d15f28d850`、対象連携account_idは `415015ae-6037-434b-904f-7094cde820ba`。古い作業メモのIDを流用しない。
- 2026-09-08 10:29頃の読み取りで、8:22・9:00 JSTの既存予約2件はscheduled、publishジョブ1件はpending、Cronはsuccess。ステージングは定期起動を記録するだけでdispatchしないため、予約が実行されない。削除・再予約・実行はしていない。

### ベータ版の方針

ユーザーは審査準備と並行し、各参加者が自分のMetaアプリで自分用トークンを発行して動作検証する方式を検討・了承している。一般提供の審査免除を意味しない。現状ステージングは単一のThreadsプロフィールIDに固定されており、参加者のトークンも拒否する。参加者の受け入れには、招待・ユーザー別プロフィールの許可範囲を設計し、他人のアカウント混入や運営者のメインアカウントの誤投稿を防ぐ必要がある。現時点で利用制限を緩和したとは案内しない。

### 参照した公式情報

- Cloudflare D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/ （無料7日、有料30日）
- Cloudflare DPA: https://www.cloudflare.com/cloudflare-customer-dpa/
- Cloudflare再委託先: https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/
- Gemini API利用条件: https://ai.google.dev/gemini-api/terms
- OpenRouter privacy: https://openrouter.ai/privacy
- Resend privacy: https://resend.com/legal/privacy-policy （Plus Five Five, Inc.）
- Resend再委託先: https://resend.com/legal/subprocessors

## 過去の準備履歴（最新状態は上記を参照）

## 1. 申請前に解消するブロッカー

**Meta管理画面で Tech Provider 登録が要求されている。** `threads_basic` → アクション → アプリレビューに追加を実行した際に、`To add a permission or feature to App Review, become a Tech Provider` と表示された。Business Verification、Access Verification、データの取り扱い・保護に関する回答を求める画面で、Tech Provider と認定された後は決定を取り消せない旨の注意がある。ユーザーの明示承認を受け、2026-09-08に Continue を実行した。「認証」「アプリレビュー」のメニューが表示される状態になった。その後、ユーザー指定の既存ポートフォリオ `yama_skill`（ID `608992394964510`）へ接続し、「アプリは現在yama_skillによって管理されています」の完了表示と再読み込み後の所有先を確認した。ビジネス認証は未認証。アクセス認証の開始にはビジネス認証の完了が必要と表示されている。Tech Providerの必要な認証がすべて完了した状態ではない。事業者情報と証明資料の確認を続ける。

管理画面が案内する公式資料: [Tech Providers](https://developers.facebook.com/docs/development/release/tech-providers/)、[Business Verification](https://developers.facebook.com/docs/development/release/business-verification/)、[Access Verification](https://developers.facebook.com/docs/development/release/access-verification/)、[App Review概要](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review)、[App Reviewの提出内容](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/content)。Tech Provider資料の機械取得は429で制限されたため、不可逆の登録要求は実際の管理画面の表示を根拠にしている。後者2件の公式App Review資料はブラウザで確認済み。**審査日数・承認日は未確認。固定日数や承認保証を案内しない。** 登録審査、権限審査、差し戻し対応を分けて進捗管理する。

公式App Review資料は、Advanced Access審査について2023-06-12以降のBusiness Verificationとデータ取り扱い質問への回答、およびアプリアイコン・ポリシーURL・カテゴリ・事業用メール・プラットフォーム設定等を案内している。アプリのロールを持つ利用者による開発テストにはレビュー不要とされる一方、審査担当者がアプリへアクセス・機能テストできなければ却下され得る。公式資料で審査期間の記載は確認できなかった。

ほかに以下が残る。

- Metaの公開画面ではプライバシーポリシーURLが未登録で、公開ボタンが無効。後述の草案の未確認項目を確定し、ログイン不要のHTTPSページとして公開・登録する。
- ステージングではThreadsへの実投稿・リポスト等の変更操作とメール送信を停止している。投稿権限の実動作を示す動画をこの環境だけで完成させることはできない。テスター全員への投稿解禁はしない。
- 本番はステージングより古いアプリ版・DBスキーマで稼働している。新しいボタンやパスワード・予約機能を、本番で確認済みとして説明しない。申請対象環境を決め、必要な変更を別途検証してから動画・手順を確定する。
- Meta署名付きの実際の連携解除／データ削除通知は未検証。専用Workerのデプロイ、署名・削除のローカルテスト、公開URL到達、未署名POST拒否は確認済み。`issued_at` の必須チェックをMetaの実通知が満たすか検証する。GETの200応答はこの検証の代わりにならない。
- 初回同期は検証済みだが、将来の定期同期・トークン自動更新は観測済みCronによる完了を確認できていない。予約投稿の審査では時刻到来後の完了まで別途確認する。
- 審査用のアプリログイン、Meta側で使用するテストプロフィール、必要なアクセス範囲を決める。ステージングの招待キーだけでは、Metaの開発モードのテスター登録や招待承認を代替しない。今回4人分のキーを発行したが、キー自体は本書に含めない。

最新の実測結果は [OAuth検証記録](meta-oauth-validation-2026-09-08.md) と [投稿ボタンのステージング検証](publish-actions-staging-2026-09-08.md)、通知処理の制約は [Meta callbacks](meta-callbacks.md) を参照。

### 2026-09-08 書類提出後の状態

ユーザーが開業届等の書類提出を実施し、Metaの認証画面で `yama_skill` の「ビジネス認証：審査中」を確認した。アプリレビュー申請の完了ではない。アクセス認証は「ビジネス認証を完了する必要があります」と表示され、開始不可。アプリレビュー下書きの「審査を申請」も必要項目未完了で無効のまま。ビジネス認証の追加資料依頼・結果を待ち、その後アクセス認証と権限レビューを進める。

### 2026-09-08 認証フォームの実確認

- Business Suiteの認証開始ウィザードを開いた。ビジネス名・住所・電話番号・メール・Webサイトで公的記録を検索し、記録が見つからない場合は書類提出、続いて本人と事業の関係を確認する流れ。
- ユーザーは個人事業主と回答。提供された事業紹介ページは https://koyamani.github.io/lp/ 。同ページに販売事業者名と連絡先の掲載があるが、書類との一致・現在の正確性は未確認。架空の法人名・法人番号は入力しない。
- Meta公式の書類案内 https://business.facebook.com/business/help/159334372093366 をブラウザで確認。正式名称と住所または電話番号が必要。登録・ライセンス書類、公的税務書類、事業用銀行明細等を案内し、公共料金は住所・電話の認証のみ。日本語対応。Webサイトのみでこの書類確認を代替できるとは記載されていない。日本の個人事業主で実際に受理される書類は、本人の所持書類と認証フローで確認が必要。
- LPは講座紹介であり、Threads Autopilotの製品説明・データ処理に合わせたポリシーは別途必要。
- Meta App Reviewには5権限の未申請リクエストが表示された。申請下書きIDは `1584686080058252`。審査提出・事業者認証の承認は未完了。

## 2. アプリ説明（英語・提出候補）

以下は製品の実装用途の説明。公開機能と審査動画が一致することを確かめてから提出する。

> Threads Autopilot helps individual creators manage their own Threads presence. After signing into the application, a user explicitly connects their Threads profile through Threads OAuth. The application imports that profile's posts and the user's own replies that continue their own posts, displays account and post performance metrics, and lets the user prepare drafts, choose a publishing time, or confirm an immediate post. Multi-part posts are published as a root post followed by replies from the same connected profile. An optional automation feature uses the user's configured schedule and approval settings. Optional AI drafting uses the provider and API key configured by the user and sends the selected reference material and instructions to that provider. Threads account data is scoped to its owning application user. Users can remove a connected account in settings; Meta deauthorization and data deletion callbacks are also implemented. The application does not require users to enter their Threads password into our application.

提出時に付けるアクセス情報は別の非公開欄で提供する。

- App URL: `[申請対象の公開HTTPS URLを確定]`
- Application test login: `[専用メールアドレス・パスワードをMeta指定の非公開欄へ]`
- Threads test profile and access instructions: `[審査用プロフィール・利用方法を確定]`
- Privacy policy URL: `[公開後のURL]`
- Operator / support contact: `[事業者情報と問い合わせ窓口を確定]`

「利用者の許可なく投稿する」「全ユーザーの投稿を一覧公開する」「他人の返信を一括収集・管理する」アプリとして説明しない。現行の投稿確認・Autopilot承認設定を、実際に申請する版に合わせて示す。

## 3. 現在要求している5権限とコードの実利用

`worker/src/routes/threads-oauth.ts` の `THREADS_SCOPES` は下記5件。権限が文字列にあるだけで使用実績・必要性が立証されたとは扱わない。

| 権限 | 現在の具体的な用途と根拠 | 審査で見せる内容 / 不要候補の判断 |
| --- | --- | --- |
| `threads_basic` | `lib/threads.ts:getProfile` の `GET /me`、`listThreads` の `GET /me/threads`。プロフィールID・ユーザー名・アイコンと本人の投稿を取得し、接続アカウントと分析・参考投稿選択に使う。 | OAuth同意→接続した本人のアイコン・投稿本文表示。基礎機能のため残す候補。 |
| `threads_manage_insights` | `getPostInsights` の `/{mediaId}/insights`、日別閲覧数・フォロワー数・属性・リンククリックの `/me/threads_insights`。`jobs/insights.ts` 等でD1に保存。 | 自分のアカウント／投稿の数値が画面に表示される経路。取得できない属性や過去のフォロワー数を作らない。分析のため残す候補。 |
| `threads_content_publish` | `createTextPost`、`createImageContainer`、`publishContainer`。`jobs/publish.ts` が利用者の本文・日時に基づき投稿する。リポスト経路も `lib/threads.ts:repost` に存在。 | 手動作成→確認→実際のThreads投稿を示す。予約なら指定時刻後の結果も示す。公開を提供するなら残す候補。 |
| `threads_read_replies` | **返信取得の実コードが存在する。** `jobs/sync.ts:fullSyncJob` → `listReplies` → `GET /me/replies`。`keepOwnReplies` は root が本人の投稿である本人の返信だけを保存し、ツリーの続きとして表示・参考素材に利用する。 | 元のThreadsツリーと、同期後にアプリが表示する本人の続き投稿を対応付ける。他人の返信一覧・モデレーション受信箱は実装していない。未使用として削除しない。ただし `/me/replies` に対する最小必須スコープは限定スコープの実テストで未検証。公式契約と実テストで不要と確認できた場合のみ削除候補。 |
| `threads_manage_replies` | `jobs/publish.ts` のツリー続きが `replyToId` を渡し、`POST /me/threads` に `reply_to_id` を送る。投稿時 `reply_control` を送れるAPIもある。 | 本人のルート投稿に本人の続きが返信としてつく様子を示す。非表示・再表示・返信承認の管理APIや専用UIは確認できないため、これらを申請用途に含めない。ツリー返信に必要な権限を公式契約・実テストで確定し、返信機能を外す場合などに削減を検討。 |

英語の用途文候補:

- **Basic:** “We retrieve the connected user's profile ID, username, profile picture, and own posts to identify the selected account and display its content in the user's private dashboard.”
- **Insights:** “We display performance metrics for the connected profile and its posts so the user can understand their own content performance and choose future posting times.”
- **Publish:** “The user creates or edits a draft, selects a scheduled time or confirms immediate publishing, and the app publishes the content to that user's connected Threads profile.”
- **Read replies:** “We import replies authored by the connected user and retain those that continue that user's own root posts, so multi-part posts are displayed and can be selected as complete reference material.”
- **Manage replies:** “We create follow-up replies from the connected user's profile to form the multi-part post that the user prepared in our editor.”

上記は実装上の利用理由であり、Metaの各権限審査に必要なアクセス水準や許可を断定するものではない。今回確認した [Meta公式Postman workspace](https://www.postman.com/meta/threads/overview) では、[本人の返信取得](https://www.postman.com/meta/threads/request/2oj5hld/get-a-list-of-all-a-user-s-replies) と [reply_to_id による返信](https://www.postman.com/meta/threads/request/y4uzu58/respond-to-replies) が掲載されている。ただしサンプルが列挙する共通スコープ一式から、その個別APIの最小必須権限までは証明できない。申請前に管理画面の最新権限説明を確認する。

## 4. 審査手順・実機動画台本

以下は撮影・動作確認の台本で、実施済み記録ではない。動画の時間は構成例であり、Metaの必須時間制限ではない。テスト投稿の本文、対象プロフィール、公開タイミングを運営者が承認してから実施する。既存のメインプロフィールへの投稿や、テストのためのアカウント全削除は不要。

| 場面 | 実機操作 | 英語ナレーション例 / 証跡 |
| --- | --- | --- |
| 0:00 アプリへ入る | 申請対象URLとアプリ名を表示。専用ログインでアプリに入る。初回登録を説明する場合は別の専用招待キーを使う。 | “This is Threads Autopilot. I am signing into the application using the review test account.” 入力するパスワードと招待キーは映さない。 |
| 0:20 OAuth | 「Threadsで接続」を選び、Threadsの公式同意画面、アプリ名、権限、対象プロフィールを表示して許可する。 | “The user chooses to connect their own Threads profile through the official OAuth screen.” 秘密、認可コード、state を表示しない。 |
| 0:55 同期・Basic | 戻り後に接続成功、本人のユーザー名とアイコン、投稿一覧を示す。同期中なら完了まで待つ。 | “The application imports the connected profile and its own posts.” 実際のThreadsの同一投稿と対応を示す。 |
| 1:20 Insights | 分析の期間を変更し、数値、トップ投稿、投稿別指標を示す。 | “These are metrics for this profile and its own posts.” 取得できた実数値のみ。フォロワー履歴は観測開始後のみ。 |
| 1:50 Read replies | 既存の本人のツリー投稿を開き、アプリ内の続きとThreads側の続きを示す。 | “The reply is written by this same user and continues their own root post.” `/me/replies` 由来の実データを使い、他人の返信管理機能があるように見せない。 |
| 2:20 Draft | 「作る」で承認済みの短いテスト本文と続き1件を手入力し「下書き保存」。保存後に開いて確認。 | “Saving a draft does not publish it.” AIキーなしでも投稿機能を検証できる手入力を使う。 |
| 2:50 Schedule | 下書きの日時指定で未来の時刻を選ぶか、次の空き枠に追加し、カレンダーの日時を確認。 | “The user explicitly chooses a publishing time.” 後で実行完了と公開結果を撮影する。作成直後の予約行だけを完了証拠にしない。 |
| 3:20 Publish | 別の承認済みテスト投稿で「今すぐ投稿」→対象プロフィール・全文確認→確定。 | “Immediate publishing is a separate action. The user confirms the account and complete content.” ステージングではボタン無効のため、この工程を実施しない。 |
| 3:50 Publish / Manage replies | アプリで投稿済み状態と結果リンク、Threadsで同じルート本文と本人の続き返信を表示。 | “The root post and its follow-up reply were published to the selected profile.” 失敗時に成功動画として編集しない。 |
| 最後 設定とデータ管理 | 公開ポリシー、問い合わせ先、接続アカウント削除の説明を表示。実削除は独立した専用データで検証。 | “Users can manage their connected account and request deletion.” Meta署名通知の実証は別テストで行い、GET疎通だけを実通知成功と説明しない。 |

審査担当者向け英語手順候補（環境確定後にURL・画面名を再確認）:

1. Open the review URL and sign in with the application test credentials supplied in the private review fields.
2. Open account connection or Settings and select “Connect with Threads.” Complete the official Threads authorization flow for the designated test profile.
3. Wait for synchronization to finish, then open Analytics to view the profile, its own posts, and their metrics. Expand the designated multi-part post to view the user's own follow-up replies.
4. Open Create, enter the approved test text and a follow-up reply, and save a draft. Open Drafts & Schedule to verify that it has not been published.
5. To test scheduling, choose a future time and verify the scheduled item; after that time, verify the published result. To test immediate publishing, use the separate immediate-publish action and confirm the selected profile and complete text.
6. Open the result link in Threads and compare the root post and its follow-up reply with the draft.
7. Open Settings to view the privacy policy and connected-account management options.

公開を伴う手順に、投稿停止中のステージングURLをそのまま指定しない。審査用に制限を変更する場合は、別環境または運営者が承認したテスト対象だけの設計・検証を先に行う。本書はその変更を実行する指示ではない。

## 5. プライバシーポリシー草案（日本語・未公開）

**この節は未確定項目を含む。`[要確認]` を埋め、実際の提供環境・委託契約・運用と照合してから公開する。** 一般公開に必要な法的記載の充足を保証する資料ではない。

### 運営者とお問い合わせ

Threads Autopilot は、`[要確認: 運営者の正式名称・所在地・代表者等の必要事項]` が提供します。個人情報の取り扱い、サービス利用、情報の削除に関するお問い合わせは、`[要確認: 実際に受信・対応できるメールアドレスまたは窓口URL]` までご連絡ください。制定日・改定日: `[公開日を確定]`。

### 取得する情報

本サービスは、利用登録・ログインに必要なメールアドレス、パスワードの照合用ハッシュ、招待・利用資格に関する記録、ログインセッション、設定情報を取り扱います。パスワードを平文で保存する設計ではありません。

利用者がThreadsを連携すると、許可された範囲で、プロフィールID・ユーザー名・名前・プロフィール画像URL、本人の投稿と本人のツリーの続き、投稿日時・投稿URL・メディアURL、閲覧数・反応数・フォロワー数・提供されるフォロワー属性・リンククリック等の指標、アクセストークンとその有効期間に関する情報を取得します。利用者が作成した下書き、予約、承認・自動運用の設定、リンク情報、投稿結果と必要な処理記録も保存します。

参考情報やAI機能を利用すると、利用者が入力・選択した投稿、文章、指示、URL、ファイルから読み取ったテキスト、AI設定・APIキー等を取り扱います。Google連携を提供し利用者が許可した場合は、Googleの認証に必要な情報、暗号化した更新トークン、管理用スプレッドシートの識別子と同期状況を取り扱います。ブラウザ通知を有効にした場合は通知購読情報を保存します。

サービス提供基盤が処理する通信情報・IPアドレス・アクセスログ・エラー記録の項目と保存期間は `[要確認: Cloudflare等の有効設定を含めて確定]` です。

### 利用目的

取得した情報は、本人のアプリログイン、Threads接続、投稿・分析の表示、下書きの作成・修正、利用者が設定した予約・承認・自動運用による投稿、参考資料の管理、利用者が許可した外部サービスとの連携、通知、障害対応、不正利用の防止、お問い合わせ・削除対応に使用します。

### 外部サービスとデータの送信

- **Cloudflare:** アプリケーション処理とD1データベース等の提供基盤として利用します。秘密情報の一部はアプリ側で暗号化して保存します。
- **Meta / Threads:** OAuth認証、プロフィール・投稿・指標の取得、および利用者が指示・設定した投稿のために利用します。
- **AIサービス:** 利用者が設定したGoogle Gemini、またはOpenRouter経由の選択モデルに、生成・修正に必要な参考投稿、参考情報、指示、本文等を送信します。自動運用を有効にした場合は、その設定に従って選んだ材料が送信されます。各提供者の保存・学習・再提供条件は `[要確認: 利用プラン、設定、モデル提供元ごとの契約]` です。AIへの送信を伴うことを画面・同意導線でも明示する必要があります。
- **Google Drive / Sheets:** 連携機能を提供し利用者が許可した場合、投稿・分析・下書き等を利用者の管理表に一方向で同期します。トークンやAPIキー、パスワード等の秘密列を同期する設計ではありません。ただし、利用者自身が本文に記載した秘密までは自動で除けません。現在の実環境ではGoogle連携の設定・実動作は未確認のため、提供開始に合わせて本記載を確定します。
- **メール・ブラウザ通知:** メールにはResendを利用する実装があり、通知先と通知内容を送信します。ブラウザ通知では必要な通知内容を購読先へ送信します。提供する通知機能と処理内容は `[要確認: 公開環境の有効設定]` です。ステージングの実メールは停止しています。
- **参考URL先:** 参考資料として指定されたURLやYouTube情報を取得するため、その提供先にアクセスする場合があります。

委託先・再委託先、国外での取り扱い、適用される保護措置の説明は `[要確認: 実際の契約・処理場所]` です。本書だけを根拠に「第三者提供は一切ない」「広告・解析は一切使わない」「学習に使われない」と断言しません。事業上の販売・広告利用方針、外部SDK・タグ・基盤側解析の設定を運営者が確認して公開文を確定します。

### 保管と安全管理

ThreadsトークンとAIキー等は、サーバーが必要時に復号してAPIを呼ぶため、復号可能な暗号化で保存します。暗号鍵はCloudflareのSecretとしてDBと分離する設計です。**運営者にも技術的に復号不可能な方式ではありません。** 権限のある運用者とシステムのアクセス範囲・運用記録は `[要確認: 実際の権限管理手順]` です。利用者間でデータを分離し、通信・認証・署名検証等で保護する設計ですが、漏洩や消失が絶対に発生しない保証をするものではありません。

保存期間は `[要確認: 登録情報、連携情報、本文・資料、指標、監査記録それぞれの期限と削除基準]` です。現行コードには一部の古い処理記録を整理する処理がありますが、全データに一律の自動削除期限を設けていません。バックアップの保存場所、世代保持期間、削除要求後の消去期限は `[要確認]` です。

### 解除・削除・訂正

利用者はアプリの設定から連携アカウントを削除できます。これはそのThreadsアカウントに対応するアプリ内の情報を削除する操作であり、Threadsそのもののアカウント・公開済み投稿や、別のThreadsアカウント、アプリのログイン情報を一括削除する操作ではありません。資料やAIキー、Google連携等の独立した情報は、それぞれの設定・削除操作または問い合わせで対応します。アプリ利用登録そのものの削除・開示・訂正の窓口と本人確認方法、対応期限は `[要確認]` です。

Metaから正当な連携解除通知を受けた場合は、対象のトークンを破棄して投稿等を停止します。分析や下書きは再連携のため保持する設計です。Metaから正当なデータ削除要求を受けた場合は、対象の連携アカウントと関連する投稿・指標・下書き等を稼働中のDBから削除します。不正な復活を防ぐための最小限の識別子・解除時刻等は保護記録として保持します。この保護記録の保存期限も `[要確認]` です。

稼働中DBからの削除は、Cloudflareの復旧履歴、別途保管したバックアップ、過去の書き出しやGoogleスプレッドシートを即時に消去することと同一ではありません。Google連携を解除してもDrive上の表は残り、表の共有・削除はGoogle側で管理します。削除前に外部へ送信済みの投稿や通知を取り消すことはできません。バックアップから復元する際は、削除済み情報が再び提供されないよう削除記録を反映する運用が必要です。

### Cookie等と変更

本サービスはログイン状態の維持にCookieを使用し、選択中のアカウント等の画面状態にブラウザ保存領域を利用する実装があります。AIキーをブラウザに恒常保存する設計は廃止しています。アクセス解析・広告Cookie等の有無は `[要確認: 本番のタグ・基盤設定を含めて確認]` です。

本ポリシーを変更する場合の告知場所・重要な変更の通知方法・適用開始時期は `[要確認: 運営手順]` とします。

## 6. 公開文へ移す前の確認表

- 正式な運営者・問い合わせ先・事業者確認資料を確定する。
- Tech Provider の不可逆の登録を運営者が確認する。Business / Access Verification の要求事項を実画面に従って用意する。
- 利用規約とプライバシーポリシーの未確定箇所を確定する。ログイン不要のURL、アプリ内リンク、Meta登録を揃える。
- AIへのデータ送信、OpenRouterのモデル提供先、Google連携の実提供範囲を実際の設定と合わせる。Meta由来データのAI処理の許容範囲もMetaの契約・方針と照合する。
- 最小権限の理由を、実API経路・画面・動画で一致させる。返信モデレーション等の未実装機能は申請理由に含めない。
- 専用の審査環境とテスト対象を定め、投稿・予約を最後まで検証する。ステージングの投稿停止を全員に対して外さない。
- Meta署名付き通知の実送達、再接続、別利用者への影響なし、必要な削除範囲と保持範囲を検証する。
- 保存期間、削除対応期限、バックアップ消去期限、削除後の復元手順を運用可能な形で確定する。
- 申請フォームの実入力、非公開テスト情報、動画を最終確認した後に提出し、受付番号・提出日・対象権限を記録する。現時点では未提出。

## 実装根拠・運営用メモ

- `worker/src/routes/threads-oauth.ts`: 5スコープ、OAuth開始と戻り先。
- `worker/src/lib/threads.ts`, `worker/src/jobs/sync.ts`, `worker/src/jobs/insights.ts`, `worker/src/jobs/publish.ts`: 実API利用とステージング変更禁止。
- `worker/src/routes/ai.ts`, `worker/src/lib/ai.ts`, `worker/src/routes/sources.ts`: 材料の所有者チェックとAI・資料処理。
- `worker/src/routes/accounts.ts`, `worker/src/lib/accounts.ts`, `callbacks/src/index.ts`, `ops/meta-callback-guards.sql`: 削除・解除の実際の範囲。通常のアカウント削除とMeta通知の処理は同一ではない。
- `worker/src/jobs/maintenance.ts`: コード上はAPログ90日、完了ジョブ7日、失効セッション等の整理。全体の保存期間ポリシーではなく、定期実行の観測も別途必要。
- `worker/src/routes/google.ts`, `worker/src/jobs/sheets.ts`: 任意の一方向同期。実環境でのGoogle接続検証は未完了。
- `worker/src/lib/crypto.ts`, `worker/src/lib/email.ts`, `web/src/lib/session-boundary.ts`: 暗号化、メール送信、端末側状態の実装。本番の旧版と差があるため、最新ソースの機能を本番の事実として断定しない。
