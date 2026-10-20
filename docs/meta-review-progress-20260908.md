# Meta審査 続行記録（2026-09-08）

> 最新状態：2026-09-08 19:38 JSTに提出済み・審査中を確認。5権限テスト、動画、同意、Googleの推定注記付き申告が完了。以下は提出前の経過ログ。最新の構成と生徒ベータ運用は [ナレッジ](threads-autopilot-knowledge.md) を参照。

## フォーム
アプリID1584346690092191、申請下書き1584686080058252。未提出。
- 審査専用ログインの添付保存を再確認。
- OpenRouter, Inc. / ITソリューション・クラウド処理 / アメリカ合衆国を追加して保存。
  根拠: https://trust.openrouter.ai/ の公開Subprocessors一覧（ブラウザDOMで18社、LocationはすべてUnited States）。推論提供者は全一覧を利用せず、実装でBedrock USだけへ固定。
- Amazon Web Services, Inc. (Amazon Bedrock via OpenRouter) / ITソリューション・クラウド処理 / アメリカ合衆国を追加し保存。
  米国は実装で固定した推論経路の国。リモートサポートを含む全処理国の最終確認は残る。これをUS限定データ所在の保証として提出しない。
- Googleは未入力。Gemini有料規約のリンク先DPAはGCP一般DPAとは別。DPAから参照される公開SubprocessorsページにはRCSとWorkspaceの案内だけで、Gemini固有の処理国を確定できなかった。
  https://ai.google.dev/gemini-api/terms
  https://business.safety.google/processorterms/
  https://business.safety.google/subprocessors/
- 日本の請求先に関するGoogle契約主体表はGoogle Cloud Japan G.K.、脚注にGoogle Asia Pacific Pte. Ltd.および関連会社の定義。請求先所在地と処理国は区別する。
  https://cloud.google.com/terms/google-entity

## UI・公開確認
利用者がChrome Canaryで審査専用ログインへ切り替えたことを画面メールアドレスと審査用バナーで確認。
1. 作る → 下書き・プレビューへ直接本文入力 → 続き1件追加 → 下書き保存。
2. 下書き・予約 → 下書き → この投稿の操作 → 今すぐ投稿 → 対象@yama_threads.subと本文を確認 → この内容で今すぐ投稿。
3. queue ID 831861f0-ebf2-4d70-9893-4c56f68b9886。03:57:06Z開始、04:01:00Zにdone。result IDs: 18227248534323951, 17946709005328614。
4. 公開プロフィールのDOMで本文・続き・URL一致を確認。
   root https://www.threads.com/@yama_threads.sub/post/DdAxh5Dm33U
   reply https://www.threads.com/@yama_threads.sub/post/DdAx4nwmxCq
5. 公開直後はqueue.metrics.permalink=null。finishQueueが次のfull_syncへURL取得を委ねているため、アプリのThreadsで開くリンクはすぐ出ない。審査手順を誤記しない。

## 予約テスト（完了）
queue ID bec9ce23-f36f-498d-b2ab-032e689dc243。
UIで13:04 JST予約 → 04:04:54Zに実行され、既定のminGapMin=30でfailed。タイマー未実行ではない。
審査専用account 0ec0fd92-0294-46ed-b61b-15050977d3c6だけ、元のminGapMinキーが存在しないことを確認後、minGapMin=1を一時追加。
UIの失敗 → この投稿の操作 → 日時を変える → 13:15 JSTへ再予約。
13:15:58 JSTにdone。result ID 18221326807317407。公開プロフィールで本文・URLを照合: https://www.threads.com/@yama_threads.sub/post/DdAzmPyG3Ts 。
後始末完了: 値が1のときだけminGapMinをjson_removeし、キーが存在しないことを再確認。既定30分へ復帰。通常ownerの予約は変更なし。
アナリティクスの今すぐ同期を操作し、今回の3件のpermalinkがD1へ保存されたことを確認。審査担当者向けフォームの操作手順と実行結果URLも更新し、自動保存済みを確認。

## 権限と動画
返信管理の公式ページはPOST返信にthreads_manage_replies、GET返信にthreads_read_repliesを要求。create-repliesは本人ルートへのreply_to_idを説明。現時点で必要権限を削除しない。
https://developers.facebook.com/documentation/threads/retrieve-and-manage-replies
https://developers.facebook.com/documentation/threads/retrieve-and-manage-replies/create-replies
QuickTime起動と収録操作がタイムアウト・無反応。Screenshotアプリも起動タイムアウト。録画成功・添付は未確認。画面動画を捏造せず、必要ならユーザーに実画面の収録を依頼する。
