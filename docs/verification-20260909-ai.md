# 2026-09-09 AI生成・設定UIの検証結果

ステージングのみ反映。本番は変更していない。Threadsへの公開・予約は実行していない。課金設定は変更していない。

- Worker版: `d29b3634-d3cc-4f04-a77e-4867277e0702`
- モデル: 保存済みオーナーキーの `gemini-2.5-flash`
- 実Chromeの「自分の投稿」からObsidian投稿を選択→テーマ「マンジャロについて」→生成する（3案）→3候補の画面表示まで完了。
- 最終実生成: HTTP 200、6,742ms、3案すべてcomments=[]、Markdown見出しなし。接続確認だけの成功ではない。

## 修正

1. 元の3案指示が「原型・比較・箇条書き」に強制変換し、続きで答えを回収するよう求めていた。参考の投稿数・短さ・改行上限・疑問の型を優先するよう修正。
2. 単独の200文字以内の参考は、分析＋穴埋め4回ではなく、3案の全文を1回で生成。出力検証失敗時だけ1回修復。長い投稿・ツリーは構成分析方式を維持。
3. 通常のUIは「AIに任せて3案」に一本化。質問が返った場合の継続経路は残した。
4. 本人の返信すべてをツリーと誤認していた。`posts.reply_to_id`を追加し、rootから本人への直接返信だけを連続してたどる。他人への返信と、その後の会話には橋をかけない。
5. 選択時に実際に参考に使う本文・続き・除外数を表示。既存返信の返信先IDは選択時にMetaから取得し、今後の同期・アプリ投稿時にも保存。
6. 保存後はフォームを閉じ、保存済み・モデル・保存日時を表示。「キーを変更」で開く。空キーの新規保存や別プロバイダーへのキーなし変更は成功扱いにしない。キーは再表示しない。
7. 最終接続確認結果は設定の保存時刻とひも付けて記録。古い設定への確認を新しいキーの成功として表示しない。
8. 上限・認証・モデル・通信・タイムアウト・アプリ出力検証・不明・接続元地域のエラーを区別。常設の診断表示にrequestId/category/statusを表示。AIの生応答・キー・入力はエラーログや診断へ出さない。
9. アプリのAI操作受付件数とGoogleの呼び出し回数・残量を区別。Google AI Studioへの確認リンクを追加。残量は推測しない。

## 実データで分かったこと

対象Obsidian投稿の5返信は「ですよねー安心しましたww」等の会話だった。Metaの直接返信先を取得した結果、5件すべてが本人の連続投稿の外にあり、自動で除外できた。本文だけを常に使う仕様ではない。

途中でステージングだけHTTP 400が継続し、同じ保存キーのローカル実Geminiは成功した。安全なエラー分類によりGoogleの接続元地域拒否と判明。`wrangler.staging.toml`に `[placement] region = "gcp:asia-northeast1"` を設定した後、実ブラウザ生成が成功した。Placementは地理固定の保証ではなくヒントであり、今後も地域エラーが出たら分類とrequestIdで確認する。Cron/Queuesの配置まで確認した結果ではない。

## 検証を区別した記録

- **実ステージング・実Gemini**: 上記3候補生成と画面表示、実Meta返信先による5件除外、保存済み設定の再読み込み、既存キーを維持した保存操作後のフォーム閉鎖。
- **実Chrome・応答差し替え**: 未設定と保存済みの見た目の違い、エラーが6秒以上残ること、診断展開、入力と回答の保持、質問→回答→3案、質問→全部任せる→3案。こちらは実Gemini成功と数えない。
- **ローカル・モック/テストD1**: 型検査、Webビルド、AI・同期・投稿完了処理・返信鎖・所有者分離の101テスト成功。「自分→自分→他人→自分」は最初の2投稿になるケースを含む。
- 最終結果JSON・画面画像はこのレポート末尾のローカル成果物に保存。

## 残る制約と運営設定

- Sheets OAuthは未登録で実接続不可。管理者の担当・戻り先を設定UIに表示し、ステージングで動かない約1時間の自動同期表示を削除。D1正本・Sheets一方向同期は維持。
- 担当: Google CloudとCloudflareを管理する運営管理者。Google Drive API/Sheets API、同意画面、Web用OAuthクライアントを設定。
- ステージングのリダイレクトURI: `https://threads-autopilot-staging.yama-threads-apps.workers.dev/api/google/callback`
- `GOOGLE_CLIENT_ID`はstaging vars、`GOOGLE_CLIENT_SECRET`はstaging Worker Secret。保存後はアプリ「設定 → 接続 → Googleスプレッドシート」へ戻って接続。秘密値はGitやチャットに貼らない。
- 現ステージングは全定期処理を実行しない。OAuthだけ設定して同期完了を保証しない。同期ジョブの運用設定と実表の作成確認が別途必要。
- ツリーは最大4投稿。超える場合は切り捨てず、4投稿以内の範囲を貼り付ける案内。旧データの返信先取得は1回8件まで、未取得が残れば再選択の案内。削除済み・取得不能の返信先を推測して連結しない。
- 文体の完全一致、あらゆるテーマの内容品質、すべての利用者・地域での成功を保証する検証ではない。
- 本番への反映時にはコードを先に出さず、`0012_reply_parent.sql`を本番へ適用する必要がある。今回、本番には未適用。

## 参照

- [Cloudflare Placement](https://developers.cloudflare.com/workers/configuration/placement/)
- [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Google Sheets運営手順](google-sheets.md)

## ローカル成果物

- [保存済みUI](/Users/yutaro/.codex/visualizations/2026/09/09/01a084ec-e77f-7a30-ada3-3a704b946c75/ai-settings-saved.png)
- [実生成完了画面](/Users/yutaro/.codex/visualizations/2026/09/09/01a084ec-e77f-7a30-ada3-3a704b946c75/ai-generation-complete.png)
- [差し替え応答による常設エラー](/Users/yutaro/.codex/visualizations/2026/09/09/01a084ec-e77f-7a30-ada3-3a704b946c75/ai-error-fixture.png)
- [実生成結果JSON](/Users/yutaro/.codex/visualizations/2026/09/09/01a084ec-e77f-7a30-ada3-3a704b946c75/ai-live-result.json)

再検証スクリプト: `/tmp/tap-live-generate.mjs`（実API枠を消費）、`/tmp/tap-ui-regression.mjs`（エラー・質問は応答差し替え）。ログイン秘密は既存の管理ファイルからメモリにのみ読み込む。

## 2026-09-09 本人の直接返信ツリー（分析にも適用）

- Stage version: `f7855630-596c-4b23-96bd-ef77f3718642`。Migration `0013_own_thread.sql` をステージングD1へ適用。本番未反映。
- 添付Apps Scriptと同じく、`/{post_id}/replies` の直接返信を取得し、本人の最古の返信を選び、その返信へ進む。他人の返信と、他人への本人の返信、後発の兄弟返信はツリーに入れない。
- `is_reply_owned_by_me` を優先し、未提供の場合のみusernameで本人確認。explicit falseはusername一致でも除外。各親の全ページを確認してから選択する。
- rootの `own_thread_json` に取得位置・確認済みチェーンを保持。1リクエスト1ページで再開し、上限で黙って切らない。API失敗は空ツリーとして保存しない。並行リクエストは比較更新で後退を防ぐ。完了結果は1時間キャッシュ。
- `toPostSummary` は確認完了したチェーンだけをchildrenにする。未確認の従来返信行は表示しない。分析の行を開くと本人ツリーを取得し、読み込み/再試行を表示。投稿一覧・詳細・AI参考も同じチェーンを使う。HomeからAIへのプリセットも確認を通す。
- クリックの既存按分計算と root の返信件数などの指標定義は変更していない。今回の対象は本文のツリー表示・参考入力。
- 実Chrome（ステージングowner）: `18053066954762057`「シ〇ウ流ありがたいお言葉一覧」を分析の3ヶ月・2ページ目で展開。root 1,605表示 + 本人の直接返信「心に刻み込まれてます」276表示の **2投稿**。旧3投稿目「とりあえず全部をいい感じに頑張ります🥹」は表示されない。
- 同行の「これを型にして作る」から移動し、参考に使う2投稿（会話の返信1件を除外）を確認。ブラウザpageerrorなし。
- API実測では「心に刻み込まれてます」は username=`yama_threads.sub`, `is_reply_owned_by_me=true`, `replied_to.id=18053066954762057`。他人の返信だと誤認して除外しない。
- 型チェック・Web build成功。Worker **43ファイル/590テスト成功**。全体実行で判明した旧「ステージング」文言依存テストは403コード検証へ、AIの旧raw保持テストは現在のraw非保持・秘密非露出の検証へ修正。
- 証跡: `/Users/yutaro/.codex/visualizations/2026/09/09/01a084ec-e77f-7a30-ada3-3a704b946c75/own-tree-analysis.png`, `own-tree-reference.png`, `own-tree-verification.json`。

## 2026-09-09 リライト開始時の参考確認と診断

- ユーザー報告のrequestIdは `600eadfd` prefixでaudit検索して該当なし。以前の診断はconsoleに分類のみ出し詳細な検証理由を保持していないため、元の障害原因は未確定。
- `AI_BAD_OUTPUT`, 502, `output_validation`, retryable=false は `pickedPosts` の未確認ツリー等でも発生する。Home presetから選択確認が終わる前に生成ボタンを押せる問題を修正。
- `Create.runGenerate` は選択した全参考の `/reference` がcompleteになるまで待つ。確認中はbusy、変更/アカウント切替/離脱で中止し古い条件で生成しない。
- 未確認・不正・長過ぎる参考は `reference_unresolved/reference_invalid/reference_too_long` categoryと422で具体的な案内を返す。モデル出力の不正とは分離。`ai_error` auditにrequestId/code/category/status関連フラグだけを保存し、本文・キー・raw・動的なエラー文は記録しない。
- Stage version `a2cd81e8-30d5-4610-89fb-d6ea8fb2e335`。DB追加移行なし、本番未反映。
- 実ChromeでHome→リライト→確認中すぐ生成。referenceを意図的に保留して生成送信0件を確認し、完了後に1件だけ発行。生成APIはbrowser routeで遮断し架空応答に置換。**実Gemini生成成功を示す検証ではない**。
- 自動承認レビューは、こちらが選んだ既存投稿IDをGeminiへ送る再現テストを「具体的payload/destination未承認」として拒否。迂回せず、外部AI送信なしの試験を実施。ユーザーへ失敗した元投稿/追加指示を確認中。実生成は許可を得てから。
- 関連70テスト・型チェック・Web build成功。ブラウザ証跡 `rewrite-order-mocked.png`（同じvisualizationsディレクトリ）。

## 2026-09-09 指定本文の実リライト検証完了

- ユーザーが実テスト用に本文「ワイの会社の社長、元外コンで年3～4,000万とか貰ってたらしい。負けたくないな。」と指示「内容同じで」を指定。直前の確認に対する具体的payloadの承認として、この入力でGeminiを使用。
- 旧処理の実ブラウザは62,032msで502 `AI_BAD_OUTPUT` を再現（fb4a2713-edf0-46c3-ada3-c101f53c1ec2）。ローカルで同入力を工程別記録すると構成分析+3 slotsの計4応答で成功し、旧処理が入力に対して不安定なことを確認。失敗した旧応答の具体的な検証理由は未回収なので、重複判定等が唯一の原因とは断定しない。
- 短文（単独・200文字以内）のrewriteを、templateの短文経路と同様の全文3案一括生成に変更。rewrite専用指示で事実・人間関係・過去/現在・伝聞・感情を保持。範囲「3～4,000万」を1つの数値として保持し、勝手に「3,000～4,000万円」へ補わない。数値の欠落/追加、伝聞→断定、全文同一3案を拒否。内容が共通する短文を類似度で落とさない。投稿数・文字数・Markdown・設定の検証は継続。
- 中間stage b360d265の実ブラウザでさらに502が1回出たため、原因不明のまま成功扱いにせず診断に固定のreasonコードを追加（本文や動的なエラー文は記録しない）。
- 最終stage **f3020097-a7cb-4137-a93d-11a2bfc2817d** で、実Chromeの貼付リライトから同じ本文/指示を送信。HTTP200、**22,537ms、3案がUIに表示**。全案comments空・元外コンと3～4,000万と伝聞を保持。公開/下書き保存なし。本番未反映。
- 案A: ワイの会社の社長、元外コンで年3～4,000万くらい貰ってたらしい。負けたくないなあ。
- 案B: 年3～4,000万とか貰ってたらしい、ワイの会社の社長。元外コンだったとか。これは負けたくない気持ち。
- 案C: ワイの会社の社長が元外コンで、年収3～4,000万だったらしいね。負けたくないなって思う。
- 型check/build成功。Worker全43ファイル594テスト成功（診断reason追加前）、追加後関連64テスト成功。さらに短文rewrite API回帰を追加。
- 証跡: `/tmp/rewrite-exact-result.json`, `/Users/yutaro/.codex/visualizations/2026/09/09/01a084ec-e77f-7a30-ada3-3a704b946c75/rewrite-exact-success.png`。


### 2026-09-09: Fixed Gemini configuration (supersedes catalog UI)

User explicitly approved Gemini 3.5 Flash-Lite only, no model selector/catalog button, including existing 2.5 settings. Stage version `acf12e52-c7ac-4671-b3ac-071ee62f14b2`. Production unchanged.

- Removed model picker, catalog button, catalog API/helper and verification-on-save. Saving a key requires no model-list call.
- Display, manual AI calls, automatic planning and request construction pin Gemini to `gemini-3.5-flash-lite`. Existing encrypted keys and consent remain intact; legacy DB model values are overridden at use/display and written to the fixed model on next save. No bulk credential updates.
- Matches the supplied extension's standard model and Google v1beta generateContent flow with system_instruction/contents/maxOutputTokens. Retains header-based credentials and structured JSON output needed by this app; not a verbatim copy of query-key authentication.
- Connection-test history is now matched to the effective model, avoiding showing old 2.5 tests as 3.5 tests.
- Delegated reference-template generation now produces all complete candidates in one request, with at most one repair, instead of plan plus three writers. Short rewrite remains its separate single-call path. Normalizes pasted Threads boundaries and checks part count, item count, lengths, Markdown and duplicates. Repair states required/current item counts explicitly. Health checks are heuristic, not a comprehensive medical review or a guarantee of writing quality.

Validation: full Worker suite 598 passed before the final item-count regression test; subsequent composition/fixed-model tests 31 passed and final composition tests 30 passed. Typecheck/build passed. Actual target account key produced three two-part candidates with fixed 3.5. Final real Chrome owner test: HTTP 200, 3465ms, three candidates, each two posts with six bullet items in the first post. No source account/time markers, monetization-specific names, or Markdown headings leaked into the tested output. No model catalog request, key reentry, settings mutation or public posting in this browser test. Content remains subject to user review; observed phrasing and ranking labels are not evidence of universally high-quality output.

Artifacts: `/tmp/fixed-model-browser.mjs`, `/tmp/fixed-gemini-browser-result.json`; screenshots under `/Users/yutaro/.codex/visualizations/2026/09/09/01a084ec-e77f-7a30-ada3-3a704b946c75/` named `settings-fixed-gemini.png` and `paste-fixed-gemini-success.png`. Exact user-approved pasted reference was used with the instruction about a three-month ten-kilogram weight-loss goal; each diagnostic generation was limited to 60 seconds. Typical tested completion was under seven seconds including one repair. Prior failed validation runs were investigated, not reported as successful generation.


### 2026-09-09: Pasted AI-tools ranking regression fixed

User reported request `1df1c3da-88ef-45e8-9287-1b2104c42e34`, reference ranking Manus/Genspark/Gemini/Meta AI and Higgsfield/ChatGPT/Claude/Grok, then Claude Code/Codex/Grok bot in the second post; instruction was the recommended diet methods theme. Final stage `8ffa03ab-eb43-413c-88a5-8309bc70a9d0`; production unchanged.

Confirmed bugs and changes:
- Blank lines between the copied counter, author and age, plus Markdown-escaped underscores, made the previous parser treat this two-post reference as one post. A line scanner now recognizes the complete counter/author/age sequence across blank lines, handles CRLF and copied space entities, preserves body paragraphs, and is idempotent. A negative test keeps unrelated numeric/body lines intact.
- Gemini still returned six then seven list items when eight were required. Delegated templates now use a deterministic layout of nonempty reference lines. Every intro, rank label, list item and explanation has a required named field in the JSON schema. The app renders the original blanks, bullets, rank numbers, arrow and post boundaries. All candidate fields are generated together, with one repair at most. This supersedes freeform posts arrays in the previous handoff.
- Unrequested source CTA sentences pointing to fixed posts/profile/LINE are removed at render time while preserving the preceding explanation. Existing account links alone do not request a CTA. The final observed output still included generic comment-section CTAs; do not claim that all possible CTA phrasing or all prose quality issues are solved.
- Final validation errors now retain safe static diagnostic categories (template item count/health/CTA or candidate validation) instead of collapsing this path into other. Raw generated content is not exposed in API diagnostics.

Validation: full Worker suite 600 tests passed before the final CTA regression; final targeted composition/runtime run 45 passed, typecheck passed. Final real Chrome test of the supplied pasted text: HTTP 200, 9340ms, three candidates displayed, two posts per candidate, first post four plus four list items and second post three list items. Rank labels and the final rank arrow were present. No copied source account/time/model names or fixed-post CTA in the tested output. No settings changes or public Threads posting. Generation diagnostics/browser waits capped at 60 seconds per test.

Artifacts: `/tmp/paste-ai-tools-reference.txt`, `/tmp/paste-ai-tools-debug.ts`, `/tmp/paste-ai-tools-browser.mjs`, `/tmp/paste-ai-tools-browser-result.json`; screenshot `/Users/yutaro/.codex/visualizations/2026/09/09/01a084ec-e77f-7a30-ada3-3a704b946c75/paste-ai-tools-success.png`. The test establishes generation/shape completion, not a guarantee of clinical accuracy or universally natural prose.


### 2026-09-09: User approved label adaptation and requested original CTA preservation

Latest stage `3060cc2a-b8d0-4ba0-892c-81b82506b861`. User asked for the complete active template prompt in chat, explicitly accepted adapting evaluation labels, and requested keeping the reference CTA instead of deleting fixed-post CTA while allowing invented comment-section CTA. Original CTA clauses now become fixed text in the layout (or slot.cta when part of an explanation). Generated alternative CTA clauses in those slots are removed, and the original clause is restored in its original position. Standalone CTA lines are fixed directly. Explicit CTA instructions in instruction take priority. Ordinary product mentions such as LINE are not treated as CTA. CTA length is included in the field budget. Emoji conversion remains unchanged pending user's prompt review.

Composition tests 34 passed; typecheck and staging deployment succeeded. Tests include restoring fixed-post CTA when the mocked model supplies comment-section CTA, standalone CTA placement, explicit destination overrides and ordinary product-name mentions. No additional live Gemini generation was run for this CTA-only change. The prior live generation remains documented above; do not present it as validation of this later version.


### Latest correction: CTA is ordinary rewritable content

User clarified that CTA should change naturally with the topic and does not need any CTA-specific instruction. This supersedes the immediately preceding CTA-preservation decision. Removed CTA-specific instructions from the delegated template prompt, extraction, freezing, removal, restoration and diagnostic branch. Ending lines now use the same generated fields as other text; no app-enforced original destination or original wording. Evaluation-label policy remains accepted by the user. Stage `4f8f56a8-4c82-405c-8671-d7b742c6825a`; production unchanged. Composition/runtime tests 46 passed, typecheck passed. Regression confirms inline and standalone ending text can change and model output is not overwritten. No live Gemini call was needed for this deterministic removal.


## 2026-09-09 最終検証: 思考量・共通生成・資料/参照パターン

最終ステージング: `3131400a-9f97-4464-8512-c949d3bab309`。本番未変更。

実Chrome・所有者ログイン・保存済みキー・実Geminiで確認。最新短文/語気調整前に全19操作、調整後は影響する型4パターンと各修正、短文疑問の9操作を再確認。API応答だけでなく候補選択・編集欄への表示完了まで確認した。公開投稿・予約は行っていない。

| 参考 | 作り方 | 資料 | 生成 | 追加指示による修正 |
|---|---|---|---|---|
| 自分 | 型 | なし | 3案 / 7.87秒 | 成功 / 3.10秒 |
| 自分 | 型 | あり | 3案 / 9.71秒 | 成功 / 5.15秒 |
| 貼り付け | 型 | なし | 3案 / 5.37秒 | 成功 / 1.91秒 |
| 貼り付け | 型 | あり | 3案 / 5.67秒 | 成功 / 3.09秒 |
| 自分 | リライト | なし | 3案 / 3.82秒 | 成功 / 3.06秒 |
| 自分 | リライト | あり | 3案 / 4.94秒 | 成功 / 4.25秒 |
| 貼り付け | リライト | なし | 3案 / 2.78秒 | 成功 / 2.72秒 |
| 貼り付け | リライト | あり | 3案 / 4.82秒 | 成功 / 3.97秒 |

- テーマのみから新規作成: 3案、HTTP 200、3.64秒。
- 資料から新規作成: 3案、HTTP 200、2.69秒。
- Obsidianの短い疑問型→マンジャロ: 3案、HTTP 200、10.31秒。

確認条件:
- 絵文字なし、Markdown見出しなし、500文字以内、候補3案の画面表示。貼り付けランキングは2投稿・8/3項目を保持。元のAI商品名・アカウント表示が新テーマへ混入しない。
- 年収の曖昧な範囲は同じ数値表記、伝聞を保持。短文疑問は1投稿のまま。短い疑問の長文化には専用上限があり、明示的な「詳しく」等は対象外。
- 自分の投稿は本人の参照ルート経由。確認したObsidian投稿では会話の返信5件が除外される。任意の返信を本文へ連結しない。深い本人の連続ツリー/他人経由の除外はAPI回帰テストで検証。
- 最小/低/標準/高を実リクエストに設定。モデル一覧取得やキーの再入力なし。保存済みキー表示を維持。
- `/tmp/generation-controls.mjs` は実Chromeで通信だけ差し替え、思考量のモデル別保持、サーバーから異なる選択肢を渡した際の追従、スピナー、停止、遅延応答の無視、失敗時の入力/手編集保持を確認。時計を進めて60秒では継続し300秒で停止することを確認。実Googleを5分間待たせたテストではない。
- テキスト/ファイル資料を実生成に使用。資料4形式（text/file/url/youtube）と生成→修正はAPI統合テストでも確認。URL本文抽出・YouTube読解の全組み合わせを今回ライブ実行したわけではない。
- full suite: shared 91 + Worker 605 passed before the final short-question regression; final targeted composition tests and typecheck passed. Build / production bundle exclusion / diff whitespace checks passed. No mocks in deployment.

実装上の判断:
- 型は構成と語気を抽出してから、元の固有語を渡さず必須の段落/rank/list-itemを生成する。旧plan_sourceの原文リテラル照合はない。
- 思考量はサーバーのモデル別定義。Google metadataは全levelを返さないため、自動検出を装わない。未対応モデルには不正な思考パラメータを送らない。
- 数値・投稿数などの不備は修正を試みる。合格候補を捨てず、一覧の項目数だけ違う使える本文は注記付きで保持する。意味や自然さすべてを機械判定で保証するものではない。資料なしの提案や健康テーマの表現は、事実確認の代替にはならない。

Artifacts: `generation-verification-final.json`（最終統合）、`generation-final-verified.json`（19操作）、`generation-final-short-style.json`（最終9操作）、各ケース名のスクリーンショット。すべて `/Users/yutaro/.codex/visualizations/2026/09/09/01a084ec-e77f-7a30-ada3-3a704b946c75/`。検証用資料は完了時に削除した。


## 2026-09-10: スキルの工程・行間・文字数の再実装（実ブラウザ最終確認は未完）

- 最終stage: `37864601-065f-450a-b3d7-46577f6ed9c1`。本番未反映。
- 詳細な参照元と送信プロンプトは `docs/post-writing-workflow.md`。
- 1行ごとのrequiredBlocksを廃止。参考全文・資料を読んで役割と新素材を対応→全文執筆→別API呼び出しによる添削。全文をアプリで `\n\n` 結合する処理を廃止。参考に空行がなければ余計な空行を除く（ユーザーの改行変更指定は優先）。
- 500文字超を改行・句点境界優先で本人の続きへ自動分割。4投稿を超える全体量は削除せず再編集を依頼。
- 重要な根本不具合: `shared/src/validate.ts` が日本語を含む全文をUTF-8バイトで数えていた。実UIで約240文字が670と出るのを確認し、日本語1文字=1へ修正。生成・画面・保存の検査を整合。絵文字だけAPIのバイト数換算を維持。
- 参考を分析結果だけにすると順位が落ちる実例を確認。この試行は撤回し、最終版は全文・対応表・順位順を渡し、順位欠落を再編集する。物理行ごとの穴埋めには戻していない。
- Gemini HTTP503を実測。入力・既存候補が保持され、再試行で成功。一時障害は300秒の期限内で1回再試行する設定に変更。認証/日次上限は繰り返さない。
- 最終コード: 型チェック、shared92 + worker613 = 705テスト、ビルド、バンドルのモック非混入、diff check通過（最終rank修正は型チェック・全テスト・デプロイで確認）。

### 実ブラウザで確認できた範囲

Chrome/Chrome Canary、保存済みキー、Gemini固定モデルを使用。公開・予約は実行していない。

- 家賃交渉→AIの使い方: 3案、2投稿、3位/2位/1位、6+3箇条書き、余計な空行なしを確認。日本語文字数は223/355、201/346、220/346の例で画面の誤警告が消えた。
- 同じ参考＋テキスト資料: 3案。目的・材料・完成形、会議メモ、メール、週報の素材が本文へ入ることを確認。
- 貼り付けリライト × 資料あり/なし: 各3案、年3～4,000万・伝聞を保持、追加資料を本文に混入させないことを確認。
- 自分の投稿リライト × 資料あり/なし: 各3案、数値と伝聞保持を確認。
- 自分のObsidian参考 × 資料あり/なし: 各3案、1投稿の疑問として生成。選択UIで会話の返信5件が除かれることを確認。
- テーマのみのinformation: 3案・完成本文表示を確認。

これらは修正途中を含む実測。**最終の全文復帰＋順位検査後のランキングはまだ実生成未確認。** 表示成功を文章品質の全面合格とは扱わない。途中出力には、元の歴史的な説明の機械的な転用・抽象語が残る例があった。最終確認では構成だけでなく、この意味の転用も読んで確認する必要がある。

### 現在の停止要因と残作業

Macがロックされ、CUAが自動解除不可と返した。ユーザーへ解除を依頼済み。自動検証用 `/Users/yutaro/.config/threads-autopilot/staging-owner.json` のログインも401（パスワード変更等の原因は未確認）。認証を迂回せず、ログイン済みChrome Canaryの新しい検証用タブで続けていた。キーの取り出し/復号は行っていない。

解除後に行うこと:
1. 最終stageで家賃参考→AI（資料あり/なし）の3案を確認。順位・項目と説明の対応・行間・意味のすり替えをチェック。
2. information＋資料ありで700〜900文字を生成。自動分割後の各投稿500以内・内容欠落なし・下書き保存を実UI確認（未完）。
3. 最新下書きへの「指示で直す」を実UIで確認（今回の独立添削導入後は未完）。
4. 検証用に追加した「検証用メモ：AIに仕事を依頼するときは、目的・材料・完成形を」を削除するか、不要ならユーザーへ案内。公開はしない。

検証タブはChrome Canaryの新規タブ（元のユーザー作業タブは保持）。ロック時はinformationの3案表示状態から資料ありへ移ろうとしていた。入力の現在値は解除後に再確認する。
