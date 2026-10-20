# 審査動画の撮影手順

## v2（2026-10-10、却下を受けた撮り直し版。以下の旧版より優先）

### 却下理由（2026-09-19 通知、5権限すべて同じ）
「スクリーンキャストがユースケースの詳細に整合しない」（開発者ポリシー 1.6）。用途自体は許可可能と判断されている。動画に次の3点が無かった。

1. 完全な Meta のログインフロー
2. ユーザーがアプリに権限を付与する場面
3. 各権限のユースケースの端から端までの操作

あわせて、英語UI・キャプション・ボタンの意味の説明を求められている。

### 2026-10-10 撮り直し結果
- 冒頭（アプリへのログイン、Threads で接続、権限一覧つき許可画面、接続完了）は `Screen Recording 2026-10-10 at 13.17.31.mov` から使用。許可は事前に Threads 側で削除済み
- 機能部分は `Screen Recording 2026-10-10 at 12.44.36.mov` から使用。その冒頭の再連携画面（権限一覧なし）は使わない
- Chrome は Threads にログイン済みだったため、Threads のログイン画面は映っていない。許可画面にはアカウント名と5権限が表示されている
- ログイン画面に出たクリップボード履歴メニューはぼかし済み
- 生成スクリプト `ops/review-video/build.py`。出力 `~/Desktop/meta-review-2026-10-10/`（全体1本と権限別5本、英語字幕つき）

### 2026-10-10 再申請（審査中）
- 5権限それぞれに権限別の新動画を添付し、説明文の後半を新動画の時刻つき説明に差し替えた（冒頭の用途説明段落は維持）
- 審査担当者の指示の手順5〜8を更新。「再認証」の記述を削除し、初回許可の流れと 2026-10-10 のテスト投稿に置き換えた
- データの取り扱いは前回提出と同じ自動入力内容のまま確認
- 送信後のステータスは「審査中」（Meta 表示で20日以内）

### 申請欄に貼る英語メモ（権限別動画の時刻）
各権限別動画は共通の冒頭 0:00〜0:26 から始まる。0:00 app sign-in, 0:10 Connect with Threads, 0:15 Meta authorization screen listing all requested permissions, 0:20 connected.

- threads_basic: "0:26 the app shows the connected profile and the user's own posts, and opens a post's full text."
- threads_manage_insights: "0:26 Analytics shows views, likes and followers for the user's own profile and posts; the user switches periods."
- threads_content_publish: "0:26 the user writes a post with a follow-up, saves a draft, chooses Publish now from Drafts, confirms the account and full text, and the post appears as Published."
- threads_manage_replies: "0:26 the user creates and publishes a post with a follow-up; 1:34 on Threads the follow-up is shown as a reply from the same account under the root post."
- threads_read_replies: "0:26 the user clicks Sync now; the app imports the user's own reply and shows it together with the root post."

### 前回動画の問題点
- 17分49秒・無音・字幕なしの1本を5権限すべてに添付していた
- 分析画面から開始しており、アプリへのログインが映っていない
- Threads は「再認証」で、権限一覧つきの同意画面と Threads ログイン画面が出ていない
- UIが日本語のみで、説明が一切ない

### 撮影前の準備（録画しない）
1. Threads（@yama_threads.sub）の設定 → アカウント → ウェブサイトのアクセス許可から Threads Autopilot を削除する。これで同意画面が権限一覧つきで再表示される
2. 録画用ブラウザは新規プロファイルかシークレットウィンドウにし、Threads・Instagram からログアウトした状態にする。Threads のログイン画面を映すため
3. 英語表示を用意する。アプリ本体は日本語のみなので、最低でも Chrome の「英語に翻訳」を常時オンにし、全場面に英語キャプションを付ける。英語UIを実装できるならそちらが確実
4. 審査用アプリアカウントでログインできること、前回投稿から30分以上空いていることを確認する
5. 画面サイズは1280x800前後、ブラウザズーム125%。通知・ブックマークバー・他タブを隠す

### 構成：権限ごとに短い動画を分ける
各動画は共通の冒頭（A）から始め、その権限の操作（B〜F）だけを続ける。1本2〜4分。各場面に英語キャプションを入れる。

| 場面 | 操作 | 英語キャプション例 |
|---|---|---|
| A1 アプリへのログイン | 申請URLを開き、審査用メールとパスワードでログイン（パスワード欄は伏せ字のまま映してよい） | This is Threads Autopilot, a web app. The user signs in with an app account. |
| A2 Threadsで接続 | 設定 → Threadsで接続 | The user clicks "Connect with Threads" to link their own Threads profile. |
| A3 Metaログイン | Threads のログイン画面でユーザー名とパスワードを入力 | The user logs in to Threads on Meta's official login page. |
| A4 権限付与 | 同意画面の権限一覧を数秒止めて映し、許可 | The user reviews the requested permissions and grants access. |
| A5 戻り | アプリへ戻り、接続済み表示と @yama_threads.sub を確認 | The app is now connected to @yama_threads.sub. |
| B threads_basic | プロフィール名・アイコン・本人の投稿一覧。同じ投稿を Threads 側でも開いて一致を見せる | The app shows the connected user's profile and their own posts. (threads_basic) |
| C threads_manage_insights | アナリティクスで期間を切り替え、投稿別の閲覧数などを表示 | The user views metrics for their own profile and posts. (threads_manage_insights) |
| D threads_content_publish | 投稿をつくる → 本文入力 → 今すぐ投稿 → 確認画面 → 投稿済 → Threads で公開を確認 | The user writes a post and confirms publishing to their own profile. (threads_content_publish) |
| E threads_manage_replies | 続きを1件付けて投稿し、Threads 上でルートに本人の返信が付いたことを見せる | The follow-up is published as a reply from the same user. (threads_manage_replies) |
| F threads_read_replies | 今すぐ同期 → アプリ内でツリーを開き、本人の続きが表示されることを Threads 側と並べて見せる | The app imports the user's own replies that continue their thread. (threads_read_replies) |

D と E は1回の投稿で撮れる。E の動画ではD部分を短く切ってよい。実装していない機能（他人の返信の非表示・承認など）は映さず、キャプションでも触れない。

### 申請フォーム側で直すこと
- 各権限の説明文を動画の順序と一致させる（「動画の 0:40 で同意画面、1:30 で投稿」のようにタイムスタンプを書くと通りやすい）
- 審査担当者向け手順（英語）に「Threads のログインと権限付与が動画の冒頭にある」と明記する
- サーバー間アプリではなく、ユーザーが自分で OAuth 接続するウェブアプリであることを書く

### 添付前チェック
- [ ] Threads ログイン画面と権限一覧つき同意画面が映っている
- [ ] 全場面に英語キャプションがある
- [ ] 各動画が対応する権限の操作を最後まで示している
- [ ] パスワード・トークン・App Secret・他タブが映っていない
- [ ] 実際の操作と公開結果のみ。過去の成功を合成していない

---

## 旧版（2026-09-08、却下された版の手順。参考のみ）

対象はステージングの審査専用ログイン、Threadsは@yama_threads.subのみ。
録画にパスワード、アクセストークン、Meta App Secret、他アプリや他のタブを映さない。マイク音声は不要。

## 録画開始
MacでCommand+Shift+5を押し「選択部分を収録」でアプリ画面の範囲を指定。オプションでマイクなし、保存先をローカルにする。
録画開始だけ利用者に依頼し、その後の操作はこちらで進行できる。新しいテスト投稿は確認画面で対象と本文を照合する。

## 動画1: 接続・プロフィール・分析・本人の返信
1. 審査用ログイン後から開始（ログインのパスワード入力は録画しない）。
2. 設定のThreadsで接続 → 公式OAuth認可 → アプリへ戻る。同じ@yama_threads.subを選ぶ。
3. アナリティクスのプロフィール、実データ、7日/2週間/1ヶ月/3ヶ月切り替え。
4. トップ投稿のツリーを開いて本人の続きの返信を表示。
5. 非表示・返信承認など実装していない機能はデモしない。

## 動画2: 手動下書きと公開
1. 投稿をつくる → 下書き・プレビューにテスト本文を直接入力 → 続きを1件追加。
2. 下書き保存 → 下書き・予約 → 下書き → この投稿の操作。
3. 今すぐ投稿 → 対象@yama_threads.subと本文 → この内容で今すぐ投稿。
4. 投稿済への遷移を待つ。ツリーは分割処理のため数分かかる場合がある。
5. アナリティクスの今すぐ同期後、Threadsで開くか公開プロフィールから本文を確認。
6. 投稿間隔は既定30分。前のroot投稿から30分以上空ける。許可なく他人のアカウントへ投稿しない。

## 予約の証拠
2026-09-08 13:15 JSTのUI予約が13:15:58に完了したことを確認済み。
https://www.threads.com/@yama_threads.sub/post/DdAzmPyG3Ts
画面録画として必要なら別の将来時刻で同じ流れを収録する。過去の成功を操作動画として合成しない。

## 添付前
動画を再生して機密情報の映り込み、読める画面サイズ、実際の操作・公開結果を確認。Metaの対応する権限説明へ添付する。
現在は動画未作成・未添付。審査申請も未提出。
