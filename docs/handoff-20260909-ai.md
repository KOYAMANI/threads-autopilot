# Threads Autopilot 引き継ぎ（2026-09-09・最新）

このメモから再開する。過去の全履歴は `docs/threads-autopilot-knowledge.md`。同書は追記形式のため、古い本文と最新追記が矛盾する場合は日付の新しい記録を優先する。特に「Geminiは課金必須」「ステージングは5プロフィールだけ投稿可能」「通常オーナーは投稿不可」は現在の仕様ではない。

## 再開時の目的と完了条件

ユーザーは、Geminiキーを替えても生成が失敗し、曖昧なエラーと設定画面から原因や保存状態が分からないことを問題としている。次を実装し、ステージングの実ブラウザで確かめる。

1. **実キーで投稿生成を最後まで成功させる。** 接続確認だけの成功を、投稿生成の成功として報告しない。今回の最新検証は接続確認までで、3候補生成はまだ未検証。
2. **エラーを原因別に説明する。** 上限到達、認証・権限、モデル、通信・タイムアウト、アプリ側の生成結果検証、原因不明を区別する。分からない原因をキー不正と断定しない。トーストだけで消さず、診断情報をユーザーが確認・共有できるようにする。秘密や入力本文を漏らさない。
3. **AIキーの登録済み状態を明確にする。** 保存後はプロバイダー・モデル・保存済み表示・接続確認結果を表示し、「キーを変更」から編集できる構成にする。キーの再表示は不要。現状は空欄フォームが常に見えるため登録失敗に見える。
4. **利用上限の確認導線を設定に用意する。** Google側の上限・残量と、このアプリの呼び出し記録を混同しない。取得できない残量は推測しない。以前Googleから返った「無料枠20回/日」は、その時の当該プロジェクト・モデルに対する実測で、全ユーザー一律の保証値ではない。
5. **Google Sheets連携の管理者設定を整理する。** 現在はGoogle OAuthクライアント設定がなく、ボタンは無効。設定なしでボタンだけ有効にしても接続できない。必要な設定・担当・戻り先を明確にし、設定可能なら進める。D1が正本、スプシは閲覧・集計の一方向同期という合意を維持。
6. **質問からの継続を確認する。** 素材不足なら短い質問はしてよい。「回答する」「全部任せる」のどちらでも生成へ進める。ユーザーは質問自体を禁止していない。

ユーザーは運営によるAI費用負担（月1万円程度）にも言及したが、課金開始や請求設定変更の承認ではない。無料プラン・利用者自身のキーを現状の前提とする。

## 作業場所・稼働環境

- リポジトリ：`/Users/yutaro/Projects/threads-autopilot`
- GitHub：`git@github.com:KOYAMANI/threads-autopilot.git`（非公開）
- ブランチ：`codex/staging-foundation`
- 最新コードコミット：`4aa014b` / `Fix composition failures observed with live Gemini responses`（push済み）
- ステージング：`https://threads-autopilot-staging.yama-threads-apps.workers.dev`
- 最新ステージング版：`60fe6033-8881-47a5-a069-b7f8ec88d602`
- 本番：`https://threads-autopilot.yama-threads-apps.workers.dev`。今回のAI修正はステージングのみ。
- Cloudflare account：`983c65a0c3fccb8c1a40ac8ca7e8c3d4`
- Stage D1：`dcce5294-b2de-4c72-9a81-5dc6f6d2e00a`
- Prod D1：`89935cef-db44-49c9-b0aa-50cc8105a786`。テスト先を取り違えない。
- この引き継ぎ作成前のgit状態は、既存の未追跡 `docs/screenshots/security-google-settings.png` のみ。勝手に削除・追加しない。
- Node：`/opt/homebrew/bin/node`。シェル実行は `login:false`、npmでは `PATH=/opt/homebrew/bin:$PATH` を使う。
- Codexの作業CWDは別のmyCompany worktree。アプリrepoの変更は必要に応じて権限昇格で行う。

## 最新の実証結果（重要）

**今回の最新検証：新しく保存されたオーナーのキーで、実ブラウザから設定画面の「保存した設定で接続確認」を押し、HTTP 200を確認。モデル `gemini-2.5-flash`、所要8711ms。** 検証プロセスは終了済み。公開投稿はしていない。

- 実行スクリプト：`/tmp/live-ai-ui-check.mjs`
- スクリーンショット：`/tmp/live-ai-ui-check.png`
- これ以後、最新要望に対するコード変更はまだしていない。新キーによる3候補生成をまだ試していない。

前の実テストでは、接続確認は成功したが、3候補生成が約54秒後に `AI_BAD_OUTPUT` で失敗した。直接Geminiを呼んで、次を再現・修正した。

1. AIが提案した食材などを「入力素材に必ず存在する事実」と誤認した検証。
2. AIが返す `intro_A` などの大文字入りslot IDを拒否する正規表現。
3. 必須slotの欠落。Geminiの構造化出力スキーマで全slotをrequiredにし、案別の入力を分離、投稿全体の文字数予算を調整した。

その後、GoogleはHTTP 429、`GenerateRequestsPerDayPerProjectPerModel-FreeTier`、`quotaValue:20` を返したため、最終修正後の3候補生成は確認できなかった。最新キーの接続成功により再検証可能になった可能性はあるが、残量・別プロジェクトかどうかは未確認。同じ日次上限を繰り返しリトライしない。

直前の自動検証は型検査・Webビルド・AI関連61テスト成功。ただしモックの成功は実Gemini生成成功の代わりにならない。

## 主な修正入口・原因候補

### 生成

- `worker/src/lib/composition.ts`：構成分析→案別writer→文字数・anchor・重複検証。3案で複数回のAPI呼び出しが走る（修復もあり）。
- `readCompositionPlan` は、素材外のanchorを除く処理が **delegateかつrewrite以外に限定** されている。通常のaskモードでは、一般的な提案がanchorに入ると依然「素材にない情報が構成分析に含まれました」で落ちる可能性がある。最新ユーザー報告と一致する候補だが、現時点では新しい失敗の再現未実施。
- 固定すべきユーザーの事実と、AIの一般的提案の扱いを整理する。本人の実績・体験・健康効果を捏造してよいという変更にしない。rewriteの情報保持を壊さない。
- `compose` は「全部任せる／お任せ」をdelegateとして検出。会話のユーザー回答を素材に追加し、AI側の質問を事実として扱わない。
- `worker/src/routes/ai.ts`：`/settings`・`/test`・`/generate`・`/revise`。設定summaryに保存時刻や最終テスト結果は現在含まれない。

### エラーと設定UI

- `worker/src/lib/ai.ts`：`AiError`（code/message/raw/retryable）、実HTTP呼び出し、429日次上限の一部分類。
- 実workerdのRequestが `redirect:error` を拒否する問題は修正済み。`manual` + 3xx拒否を維持し、キー付きリクエストを任意URLへ転送しない。
- `worker/src/app.ts`：onErrorでAiErrorをAPIエラーへ変換。現在は詳細分類・リクエストIDが不足。
- `shared/src/types.ts`：`ApiErrorBody` にはoptional detailがある。
- `web/src/api/client.ts`：フロントのApiErrorは現状code/statusだけ。detailを引き継がない。通信失敗を電波の問題と断定する文言も改善候補。
- `web/src/api/ai.ts`：保存後はquery invalidateのみ。保存結果を即座にcacheへ反映する改善候補。
- `web/src/screens/Settings.tsx`：`AiKeyCard` が常に空欄編集フォーム。成功・失敗は主にtoast。`GoogleSheetCard` は未設定警告と無効ボタン。
- `web/src/screens/Create.tsx`：生成エラーはtoast。失敗時も元の素材・下書き・質問への回答を保持し、再試行できるようにする。
- `web/src/components/GenerationChat.tsx`：質問・回答・全部任せるの既存UI。

### Google

- `worker/src/lib/google.ts`、`worker/src/routes/google.ts` が入口。
- Stage/Prodのローカルsecret管理ファイルにGOOGLE項目なし。stageのGOOGLE_CLIENT_IDも空欄。OAuthクライアントの作成・Secret・同意画面等が必要。
- ステージングは本番の全定期処理を動かしていない。「約1時間で同期」という表示が現在のstageの動作に合うか確認が必要。

## テストの再利用

```sh
PATH=/opt/homebrew/bin:$PATH npm run typecheck
PATH=/opt/homebrew/bin:$PATH npm -w worker test -- test/composition.test.ts test/ai-routes.test.ts test/ai-runtime.test.ts test/ai-policy.test.ts
PATH=/opt/homebrew/bin:$PATH npm run build
PATH=/opt/homebrew/bin:$PATH npm run deploy:staging
```

- `/tmp/live-ai-ui-check.mjs`：オーナーでブラウザログイン→保存済み設定でAI接続確認→ログアウト。接続確認もAPI枠を消費するため無駄に反復しない。
- `/tmp/test-live-generation.mjs`：オーナーでAPIログイン→ランキング型参考＋「ダイエットのおすすめ食事。全部任せる」で3候補生成→ログアウト。結果 `/tmp/live-generation-result.json`。これはAPIテストでありUIの生成操作テストではない。
- `/tmp/live-compose-debug.ts`：自分のDB行だけのキーをメモリで復号し、実compose→Geminiで生成を調べる。キーを表示・保存しない。生成応答のみ `/tmp/live-compose-response-N.json` 等へ保存。
- Playwright：`/Users/yutaro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs`
- Chrome：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- 最終的に実ブラウザの「作る」で、3案の完成、案ごとの違い、質問→回答/任せる→完成、保存済み状態の再読み込み、永続的なエラー表示を確認する。必要以上の生成を繰り返して無料枠を消費しない。

## 合意済みの仕様・運用

- D1がデータの正本。Google Sheetsは希望者が閲覧・集計するための一方向同期。
- 無料Cloudflareから開始、初期10名程度。1000名の性能や無損失は実測・復元検証なしに保証しない。
- `STAGING_ALL_USERS_PUBLISHING=1`：有効なライセンスの全利用者が、自分で所有確認したThreadsアカウントへ手動公開・予約可能。旧5プロフィール・個別招待キーの許可制限をこのモードでは使わない。ユーザー間の所有者チェックは維持。
- StageのCronは最大3アカウント/tickの手動予約処理。Autopilotとメールは停止中。公開先のThreadsは実アカウントなので、今回のAI検証では公開ボタンを押す必要なし。
- Metaアプリのテスター招待・承認・権限は別の制約。アプリ内で全員投稿可能にしても、未審査のMeta OAuthを誰でも使えるようにはならない。
- 生成は「型を参考」「リライト」。自分の投稿または他人のツリー全文を参考にする。情報素材は別欄で渡す。
- 質問からのチャット継続は実装済み。ユーザーが禁止したのは行き止まりであって、必要な質問ではない。

## 既存ナレッジ・Meta審査

- 全体：`/Users/yutaro/Projects/threads-autopilot/docs/threads-autopilot-knowledge.md`
- 事業側の同内容記録：`/Users/yutaro/Projects/myCompany/.company/secretary/notes/2026-09-08-threads-autopilot-architecture-meta-review-beta.md`
- Meta申請経過：`docs/meta-review-progress-20260908.md`
- 審査操作手順：`docs/meta-reviewer-runbook.md`
- 録画：`docs/meta-recording-guide.md`
- 通知URL：`docs/meta-callbacks.md`
- AI処理経路：`docs/ai-routing-policy.md`
- セキュリティ：`docs/production-security.md`

Meta App ID `1584346690092191`、Threads OAuth App ID `924086796982144`、申請ID `1584686080058252`、事業者 `yama_skill`。過去の申請状況は上記記録を読む。今回のターンではMetaの最新審査状態を見ていないため、「承認済み」等と推測しない。無料Geminiを許可する変更が以前の課金キー限定の審査説明に影響する点も記録済み。

## 秘密情報の所在（値はこの文書に記載しない）

- ローカル管理：`/Users/yutaro/.config/threads-autopilot/`
- 所有者テスト用ログイン：同ディレクトリ `staging-owner.json`。ユーザー本人の実接続テストに使用許可済み。
- Stage/Prod secrets：同ディレクトリ `staging-secrets.json` / `production-secrets.json`。
- AIキーはサーバーD1で暗号化保存。キー変更後は現在の保存済み設定を使う。昔の別キーを使って「今回成功した」としない。
- 招待キーの一括ファイル：`/Users/yutaro/.codex/visualizations/2026/09/06/01a07718-f664-7e42-9e94-fb75b08fd315/staging-access-keys.md`
- パスワード引き渡し用ファイル：同ディレクトリ `staging-owner-login.md`。
- これらは秘密情報を含む。Gitに追加せず、ログや公開スクリーンショットに出さない。学生のキーを無断で実テストに使わない。

## 次の担当者への報告ルール

ユーザーは「テスト済み」の曖昧さに強い不満を持っている。毎回、実API/モック、設定確認/生成完了、ローカル/ステージング/本番を区別して報告する。実生成が未完了なら未完了と明記し、根拠のないエラー分類・残量・完了宣言をしない。既存の入力や機密情報を保護しながら、実際の生成完了まで進める。


## 2026-09-09 続行後の更新（この節が優先）

実ブラウザで投稿生成完了まで確認済み。詳細は [verification-20260909-ai.md](verification-20260909-ai.md)。最新ステージング版 `d29b3634-d3cc-4f04-a77e-4867277e0702`。

追加要望により通常UIはおまかせ生成へ変更。参考は本文だけに固定せず、返信先IDをたどって本人同士の連続投稿を使い、他人への返信になったところで切る。migration 0012はステージングのみ適用済み。Gemini地域拒否に対してステージングの配置ヒントを日本付近に設定し、同じ保存済みキーで3案の実生成が6.7秒で成功。キー保存済みUIも保存後・再読み込み後とも確認済み。SheetsはOAuth未登録で未接続。

## 最新追記: 2026-09-09 本人のツリーを分析画面にも適用

ユーザーの追加依頼を実装済み。Stage `f7855630-596c-4b23-96bd-ef77f3718642`、migration 0013 stage適用済み。`worker/src/lib/reference-thread.ts` の `resolveOwnTree` / `advanceOwnTree` が直接返信APIで本人の最古の続きを再帰的に確認。旧root_id一括グループを表示・AI入力に使わず、root `own_thread_json` の完了済みチェーンを共有する。分析の行展開と参考選択で取得再開（1ページ/リクエスト、完了時1時間キャッシュ）。例の「心に刻み込まれてます」はAPI上本人の直接返信なので残し、「とりあえず全部を…」は除外。実Chromeで分析2投稿とAI参考2投稿の一致確認、590 Worker tests成功。詳細は `docs/verification-20260909-ai.md` 末尾。本番未反映。既存の未コミット変更・ユーザーのknowledge.md編集を保持している。

### リライトエラー追加対応

最新stage `a2cd81e8-30d5-4610-89fb-d6ea8fb2e335`。Home presetのツリー確認が終わる前に生成できる競合を修正。Createは生成前にも全参考の確認完了を待つ。参考未確認等を422の具体的エラーに分離し、ai_error auditへ安全な診断IDを保存。実Chromeで遅延reference→完了後generate1回の順序検証成功（生成APIはモック、Gemini送信なし）。ユーザー報告の実入力は未入手で原因はまだ確定していない。こちらで選んだ実投稿のGemini送信はauto-reviewが拒否したため、実生成の再現はユーザーに元投稿と送信許可を確認してから。詳細はverification末尾。

### 指定本文のGeminiリライトまで確認済み

ユーザーが本文「ワイの会社の社長、元外コンで年3～4,000万とか貰ってたらしい。負けたくないな。」と「内容同じで」を指定したため、承認済みの入力で実テストを再開。旧処理の502を再現し、短文rewriteを全文3案の一括生成に変更。最終stage `f3020097-a7cb-4137-a93d-11a2bfc2817d` で実ChromeからHTTP200・22,537ms・3案UI表示を確認。全案単独、数字/元外コン/伝聞を保持。前節の「実生成は未承認・未確認」はこの指定入力について解消済み。詳細と限界はverification末尾。


### Latest default model update (2026-09-09)
User requested gemini-3.5-flash-lite as default. Shared defaults and new-setting catalog preselection updated. Existing saved models remain unchanged. Stage version c48ea70b-0a32-4029-b76b-0fc5de397f48; production unchanged. Typecheck, 40 related tests, build and diff check passed. Dynamic catalog UI verified in real Chrome with 16 models and selection without reentering key (not saved). Target saved key returned 404 for 2.5 Flash: no longer available to new users. Extension-style request also returned same 404 in 829ms. Supplied extension defaults to 3.5 Flash-Lite. Exact pasted-reference generation with new model and 60-second behavior remain unverified; sending the specified reference/instruction was authorized by user.


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


### 2026-09-09: Model-scoped thinking, unified generation and 300-second operations

Supersedes previous 60-second, slot/blueprint and emoji-preservation designs. User authorized implementation and all own/pasted, template/rewrite and source/no-source generation tests.

- Fixed Gemini `gemini-3.5-flash-lite` remains. No model catalog/button or key-change picker was restored. Thinking choices are returned by `/api/ai/capabilities`, backed by a versioned model/provider registry. Google Models metadata does not expose supported thinking levels; the registry is explicit rather than guessing from model names. Unknown models omit unsupported controls. Gemini 3.5 uses `thinkingLevel`; the registry includes a 2.5 `thinkingBudget` adapter for future use/tests, without enabling model selection. Browser remembers a preference per provider/model. Default is medium.
- Manual generate/revise and automatic planner use the common full-post composition prompt plus curated writing knowledge in `worker/src/lib/post-writing-knowledge.ts`. Sources of the writing knowledge are recorded in that file. It is a reviewed extraction of general writing principles and feedback, not loading every private member document or an account-specific persona into every request. No runtime dependency on the local myCompany checkout.
- Uniform no-emoji output; medal ranks become text. No CTA-specific extraction/freeze/remove/restore rules. Original full tree remains the reference for initial generation; revision uses the current edited draft and sources, without reintroducing the original reference's topic.
- Template generation first abstracts the transferable structure and tone (including supplementary style references), then writes all candidates as required paragraph/rank/list blocks. The writer never receives the original subject or original phrasing. A schema with required candidate keys avoids empty/missing candidate arrays. Rewrite/information/revise write full posts directly. Each writing operation has at most one repair, under the same 300-second deadline. Good candidates survive repair failure. Exact duplicates are not counted twice. List-count differences get one repair, then an explicit editorial note with usable drafts rather than discarding all text. Part count, 500-character limit, Markdown labels, NG words, URL constraints and rewrite number/hearsay checks remain. Short rewrites may differ only slightly. No ratio-based length/similarity or narrow plan-source literal checks. The final block schema preserves paragraph order and list count without freezing the reference prose or requiring literal source-anchor matches.
- Selected stored source bodies are passed in full up to an aggregate 60,000 characters; missing/unowned/unreadable sources fail explicitly. Source upload's existing per-source 50,000-character storage limit remains. Gemini YouTube input is passed as video; providers that cannot read the selected video require its transcript.
- Both generation and revision have a 300-second shared provider-call/repair deadline, browser AbortController, elapsed time, spinner, stop button and sequence guards. Inputs/current candidates remain on failure, cancellation or timeout. A browser disconnect may not guarantee immediate termination of computation already running at Google; no further app-side repair is started after the deadline.
- Gemini output allowance raised to 32,768 tokens including thinking; default temperature left to provider. Thought parts excluded from post text; output-token exhaustion gets a specific category.

Live testing found and corrected: list-count-only failures discarded usable drafts; negative instruction “追加せず” accidentally disabled all number/hearsay validation; revisions reintroduced the old reference's theme. Generic schema/missing-output errors now include actionable reasons. Number spellings and hearsay are sent explicitly, alongside the whole original.

Official implementation references: https://ai.google.dev/api/models and https://ai.google.dev/gemini-api/docs/generate-content/thinking .

Browser harnesses: `/tmp/generation-matrix.mjs`, `/tmp/generation-controls.mjs`. Artifacts are in `/Users/yutaro/.codex/visualizations/2026/09/09/01a084ec-e77f-7a30-ada3-3a704b946c75/`. Real tests use the logged-in owner's saved server key through the app; do not reuse student keys. Temporary validation sources are removed in finally. No public posting is part of these tests.

An attempted direct D1-key decryption diagnostic was rejected by automatic approval review. It was not executed or bypassed; continued through the authenticated application. This does not block ordinary app-based tests.


Final stage `3131400a-9f97-4464-8512-c949d3bab309`. Live 19-operation matrix completed; after the final short-question/tone adjustment, all affected template paths and revisions plus the short-question regression completed again (9 operations). See `docs/verification-20260909-ai.md` for case-level evidence and limits. Short questions (single reference <=120 chars) have a reference-scaled cap with a 100-char floor; explicit requests for detail bypass it. This is specific to short questions, not a universal rewrite-length ratio. Temporary validation sources deleted; no public posting.


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


## 2026-09-10: モバイルでSTAGING注意書きが操作を覆う問題

- ユーザーのiPhone画像で注意書きが作成・予約シートの下部に重なることを確認。
- `EnvironmentNotice` をapp内では `Shell` のスクロール本文先頭へ移動。app外のログイン等ではroot側に表示。注意書きのfixed/bottom/right/z-indexを廃止し通常フローへ。注意文自体は維持。
- 型チェック・ビルド・diff check通過。ステージング `e9c2ce25-6ad2-49b7-a82f-bec085517c44` へ反映。実機操作はMacロック継続のため未確認。
- スマホは未保存の本文を控えてから再読み込みする。先のAI最終確認・保存検証の未完項目は引き続き残る。


## 2026-09-10: Mobile textarea sizing

Added AutoTextarea for PostFields (Create and Queue editing), Create reference/instruction/revision inputs, and SourceAdder. Recalculate height for controlled value changes, width changes via ResizeObserver, and font loading. Post bodies and replies grow without a height cap; reference materials cap at 60dvh. Mobile font size is 16px. Native textarea selection and IME are retained.

Typecheck, build, and diff check passed. Deployed staging e4a7edc8-12ca-4e78-aa5f-7e80e0ea3db7. The supplied video was inspected; live mobile interaction remains unverified because the Mac is locked. Earlier AI verification items remain pending.
