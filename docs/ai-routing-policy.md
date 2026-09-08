# AI送信先制限（2026-09-08）

実装済み。ステージングへのmigration 0010適用はCloudflare API 7403（権限エラー）で失敗。デプロイ未実施。本番未変更。

- Gemini: gemini-2.5-flash。Google Cloudプロジェクトの課金有効を利用者に確認。アプリでは課金状況を検証していない。
- OpenRouter: anthropic/claude-sonnet-4.6。Amazon Bedrockの amazon-bedrock/us のみ。allow_fallbacks=false、require_parameters=true、data_collection=deny、zdr=true。対応経路が利用不能なら生成失敗とし、他社へ切り替えない。
- 米国固定は推論エンドポイントの指定。OpenRouterやAWSの全処理・サポート・再委託先を米国に限定する保証ではない。
- 既存キーは保持し、data_policy_version未確認時は生成・修正・自動生成を停止する。既存ユーザーの同意は推定しない。
- GeminiキーはURLでなくx-goog-api-keyヘッダーで送信。外部APIへのHTTPリダイレクトは禁止。
- Meta申告のAI処理先候補はGoogle、OpenRouter、Amazon Web Services。モデル名がAnthropicであることと、Anthropic直結への入力送信は区別する。契約主体と処理国の最終確認・フォーム反映は未完了。
- OpenRouterの公開ZDR一覧で当該Bedrock USエンドポイントを確認済み。実際の有料AI生成は未実施。

## 検証
型検査とビルド成功。全体実行は共有91件成功、Worker547件中546件成功（案内文の期待値1件のみ不一致）。期待値修正後、AutopilotとAI policyの52件成功。その他のテスト対象ロジックは再変更していない。

## 一次資料
- https://openrouter.ai/docs/guides/features/zdr
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://openrouter.ai/api/v1/endpoints/zdr
- https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html
- https://ai.google.dev/gemini-api/terms

再開時はD1権限を解決し、migration 0010 → staging deploy → 未確認設定のAPI拒否とUI表示を検証する。審査担当者に個人の有料AIキーを要求せず、Threads権限のデモは手動下書き経由で完了させる。
