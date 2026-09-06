# DECISIONS

実装中に決めたことを1行ずつ残す。日付つき。

---

## 2026-09-03 v1.0 → v1.1

`docs/spec-v1.0.md` に対する設計レビュー（`myCompany/.company/pm/tickets/2026-09-03-threads-autopilot-spec-review.md`）と、オーナーの判断3件を反映して `SPEC.md` を v1.1 に改訂した。

### 決定（オーナー、2026-09-03）

| 日付 | 決定 | 理由 |
|---|---|---|
| 2026-09-03 | 数字の履歴は **48h / 7d / 30d の3点だけ**保持する（1日1点×180日は廃止） | D1 は1DB 10GB が上限で、全買い手が相乗りする。日次スナップショットでは300本売った時点で上限に達する。採点に必要なのは48h時点の値だけ |
| 2026-09-03 | 学習は**がっつりやらない**。型と枠は独立に集計し、AIは学習・採点・選択に一切使わない。画面は事実（平均表示回数・いいね率・本数）を見せるだけ | 型×枠の128セルは1年運用しても1セル平均2.8本で、倍率が振れる。外れたときに商品の信頼を失う一点だから、予測を出さず集計を出す |
| 2026-09-03 | デザインは emilkowalski/skills の **apple-design スキル**を使う（`.claude/skills/apple-design/SKILL.md` に複製、出典URLをファイル先頭にコメント） | 動き・触感の判断基準を外部の定まった規範に置く。プロトタイプはレイアウトと文言の正、apple-design は動きの正、と役割を分ける |

### レビュー指摘の反映（対応表）

#### Blocker

| 項目 | 反映した節 | 要約 |
|---|---|---|
| B1 `posts` の主キーがテナント分離を壊す | §2.4, §4, §7, §8.4 | `posts` を `PRIMARY KEY(account_id, id)` に、`post_metrics_history` を `(account_id, post_id, checkpoint)` に変更。参照はすべて `(account_id, id)` の組で引く |
| B2 D1 クエリ数の予算が無い | §2.5, §3.1, §6.1, §8.1 | `budget` を subrequests / dbQueries / timeMs の三本立てにし、`MAX_DB_QUERIES=800` を env 化。超過は `state_json` 保存で持ち越し。upsert はマルチVALUESでまとめる |
| B3 承認/取消メールが SameSite=Strict で動かない | §5.3, §7.9, §9.5, §10.5 | Cookie 非依存の `GET|POST /a/:token` を新設。HMAC-SHA256 署名トークン（`qaction\|queue_id\|action\|expires`）、`queue.action_token_used_at` で1回失効。GETは確認画面・POSTで実行（メールのプリフェッチ対策） |
| B4 パスワードリセットが存在しない | §5.1, §5.3, §7, §10.5, §13 M1 | `POST /auth/forgot` / `POST /auth/reset` を M1 に追加。署名トークン30分・1回限り・成功で全セッション失効。`password_resets` テーブルとメールテンプレ `password_reset` を追加 |

#### 高

| 項目 | 反映した節 | 要約 |
|---|---|---|
| H1 予算設定が実測より2桁保守的 | §2.5, §3.1 | 制約表を実測値に差替え（subrequest Paid 10,000 / CPU 既定30s・最大5min / Cron 壁時計15min / D1クエリ Free 50・Paid 1,000 / 同時接続6 / Cron本数 Free 5・Paid 250）。`MAX_SUBREQUESTS=300`、`JOB_TIME_BUDGET_MS=20000` 維持。「本番はPaid必須」と明記 |
| H2 D1 単一DBが販売本数の上限になる | §2.5, §4, §8.4, §8.7, §9.2 | `post_metrics_history` を `checkpoint('48h'\|'7d'\|'30d')` 方式に変更（1投稿最大3行）。§8.7 の180日削除を撤廃し削除投稿分のみ掃除。§9.2 の7日後再採点（`scored7`）を撤廃して採点は48hの1回のみ。1,000本以上を狙う場合のシャーディング要件を §2.5 に注記 |
| H3 学習ループが統計的に成立しない粒度 | §4, §7.7, §9.1, §9.2, §9.3, §9.4, §10, §12.3, §16 | `learning.dim` から `hook_slot` を削除（hook / slot / length / source の4次元を独立集計）。`posterior`・`multiplier`・`k`・80/20ランダム探索を全廃。選択は「n≥10 の値を平均score上位から、直近3本と同じ型・枠は避けるローテーション」。応答は `{dim,value,n,avgScore,avgViews,likeRate}`、`n<10` は null。画面は型別・枠別の平均表示回数/いいね率/本数の表のみで `n<10` は「集計中（あと◯本）」。採点・集計にAIを使わない旨を §10 冒頭に明記 |
| H4 クリックの按分基準が運用実態と逆 | §2.3, §7.5, §8.5, §13 M2, §16 | 按分基準を「そのURLを含む投稿（root または child）の views」に変更（同一ツリー内の重複は max(views) で1回）。`normalizeUrl()` / `extractUrls()` を `shared/src/url.ts` に置いて抽出側と `link_url` 突合側で共用。正規化の手順を7ステップで明記。M2 完了条件に「実アカウントで clicks が投稿に紐づく」を追加 |
| H5 `auto_publish_text` × `reply_to_id` が未検証 | §3.1, §6.3, §8.3, §13 M1, §13 M4, §14 | コメント投稿を1ステップ方式（既定）と3ステップ方式（コンテナ作成→status→publish）の分岐で記述し、env `REPLY_TWO_STEP` で切替。`step` の解釈式（`i=floor((step-2)/3)`, `phase=(step-2)%3`）まで明記。`scripts/smoke.ts` を M1 で用意し、実行はトークン到着後 |

#### 中

| 項目 | 反映した節 | 要約 |
|---|---|---|
| M1 重複判定「80%一致」の定義が無い | §8.3, §9.6, §13 M1, §13 M4, §14 | 正規化（URL除去→空白除去→小文字化）後の文字 3-gram Jaccard ≥ 0.8 と定義。`shared/src/tags.ts` の `similarity(a,b)` として実装、`recycle` は除外 |
| M2 `percentile` を投稿ごとに引くと重い | §9.2 | `ap_score` の冒頭で分布を1回だけ取得し、ソート済み配列を二分探索で使い回す旨を明記 |
| M3 AIキー端末保存とオートパイロットが排他 | §7.6, §12.3 | 端末保存をONにする**前**に確認ダイアログを出す（トーストでの事後通知にしない）。`PUT /ai/settings` の応答に `autopilotAvailable` を含める |
| M4 モック判定の二重条件と本番混入 | §11, §13 M1 | `mock/` を `import.meta.env.DEV` ガードの内側に置き本番バンドルから除外。`/health` に `mock` フラグを追加し、本番では常に false |
| M5 退会（`DELETE /users/me`）が無い | §7.8, §13 M7 | 退会APIをパスワード再確認つきで追加（全データ削除・ライセンスは revoked）。README にプライバシーポリシーと特商法表記の置き場を書く要件を M7 完了条件に追加 |
| M6 ライセンス `revoked` の挙動が未定義 | §4, §5.1, §5.4, §7.7, §9.4, §9.6, §13 M1, §13 M6 | ログイン時（既存セッションも全削除）とジョブ実行時（`ap_plan`/`publish`）の両方で確認し、オートパイロットを停止。`licenses.revoked_at` と `POST /admin/licenses/:id/revoke` を追加 |
| M7 設計書 v0.2 と SPEC の不整合 | §0 | `docs/` は編集しない方針のため、SPEC §0 に「設計書と食い違ったらSPECが正。特に費用は月5ドル必須で、設計書の『0円』は誤り」を明記して吸収 |

#### 低・確認事項

| 項目 | 反映した節 | 要約 |
|---|---|---|
| `users.timezone` と `accounts.timezone` の二重定義 | §2.4, §4 | `users.timezone` を削除。timezone はアカウント単位のみ |
| `/export/:accountId.csv` の拡張子食い込み | §7.8 | `/export/:accountId?format=csv` に変更 |
| `login_attempts` / `sessions(user_id)` にインデックスが無い | §4 | `idx_login_attempts(email, at)` と `idx_sessions_user(user_id)` を追加（併せて `idx_password_resets_user`、`idx_posts_root` を account_id 込みに） |
| Cron Trigger はアカウント単位 Free 5 / Paid 250 | §2.5 | 制約表に行を追加（3本使用、増やす余地あり） |
| 外部fetch の同時接続は6本 | §2.5 | 制約表に行を追加。並列取得の上限として明記 |
| 接続直後は `delta=0` で画面が空に見える | §7.2, §12.3 | スナップショット1点のときは推移グラフの代わりに「明日から推移が出ます」を出す |
| D1 Time Travel の復旧方針 | §2.5, §13 M7 | 制約表に行を追加し、README に復旧方針を書くことを M7 完了条件に追加 |
| 本文500文字の数え方（文字数 vs UTF-8バイト） | §6.3, §14 | 確定するまでは「コードポイント数とUTF-8バイト数の厳しい方」で判定。`scripts/smoke.ts` の確認項目に追加 |

#### ビジネス構造への指摘

| 項目 | 反映した節 | 要約 |
|---|---|---|
| D1 10GB上限が販売本数の寿命になる | §1, §2.5, §8.4 | 履歴を3点に削って1桁減らし、1,000本以上を狙う場合のシャーディング要件を注記。想定販売本数はオーナー未確定として明示 |
| Metaアプリ作成15〜20分のサポート負荷 | 未反映（SPECの範囲外） | 技術仕様で減らせない項目。販売設計・サポート体制側の課題として `.company/pm/` 側で扱う。SPEC は §1 の「買い手が自分のMetaアプリでトークンを取得して貼る」前提を維持 |
| パスワード・再接続の個別対応 | §5.1, §8.6 | パスワードは B4 のセルフサービス化で解消。トークン再接続は既存の `needs_reauth` 通知＋設定画面からの再接続で吸収 |
| 「買い切り」の定義を期間つきにする | §1, §13 M7 | 「買い切り＝ホスティング込み◯年間」として販売時に明示する要件を §1 に追加（年数はオーナー確定待ち）。README への記載を M7 完了条件に |
| セルフホスト版を逃げ道として初期設計に残す | §15 | 「将来」から格上げし、構成を Worker + D1 + Resend だけに保って `wrangler deploy` でそのまま載る状態を崩さない、と明記 |

#### デザイン方針

| 項目 | 反映した節 | 要約 |
|---|---|---|
| プロトタイプと apple-design の役割分担 | §0, §12.5 | プロトタイプ＝レイアウト・トークン・文言・操作の流れの正。apple-design＝動き・触感・タイポの正 |
| spring / pointer-down / 中断可能 / 速度引き継ぎ | §12.5 | 適用箇所（Sheet, Drawer, Tabs, Toast, 行展開, スワイプ）ごとに、pointer-downでの反応・1:1追従・presentation値からの再開・速度引き継ぎ・運動量投影・ラバーバンドを規定 |
| `transform` / `opacity` のみアニメーション | §12.5 | `height`/`top`/`width` は動かさない。`will-change` は直前だけ |
| spring パラメータ | §12.5 | 既定 `bounce:0 / duration:0.35`、Sheet・Drawer `bounce:0.2 / duration:0.3`、弾いたとき `bounce:0.2 / duration:0.4` ＋ velocity 引き継ぎ。`web/src/lib/motion.ts` にプリセット化 |
| reduced-motion 等の環境設定 | §12.2, §12.5 | `prefers-reduced-motion` はクロスフェード化・オーバーシュート全廃、`prefers-reduced-transparency` は不透明化、`prefers-contrast` は輪郭線追加 |
| タイポグラフィ | §12.5 | 大見出し `letter-spacing:-0.02em`・本文 0、行間はサイズと逆相関、システムフォント維持、余白は rem/em |
| 依存追加 | §2.2, §2.3 | `motion` を web に追加。`web/src/lib/motion.ts` を構成に追加 |

### v1.1 で新たに決めたこと（レビューに無いが実装が迷う箇所）

| 日付 | 決定 | 理由 |
|---|---|---|
| 2026-09-03 | パスワードリセットは `users` への列追加ではなく `password_resets` テーブルで持つ | jti・使用済み・期限を1行で表現でき、複数発行と一括無効化がそのまま書ける |
| 2026-09-03 | `/a/:token` は GET が確認画面、POST で実行（トークン消費は POST のみ） | メールクライアントのリンクプリフェッチで取消が誤爆するのを防ぐ。Cookie は読まないので SameSite=Strict の影響を受けない |
| 2026-09-03 | 署名トークンは `purpose` を payload に含め、`pwreset` と `qaction` で1つの `signToken`/`verifyToken` を共用する | 実装を1本にして、検証漏れの箇所を作らない |
| 2026-09-03 | `learning` に `views_sum` と `like_rate_sum` を追加する | 画面が平均表示回数といいね率を出すため。score から逆算できない |
| 2026-09-03 | コメント投稿の方式切替は env `REPLY_TWO_STEP` で行い、`step` は毎回 env を読んで解釈する | H5 の結果が出るまで両方式を残す。切替時は `publishing` のキューが無いことを確認する |
| 2026-09-03 | `docs/prototype.jsx` は未着。届くまでプロトタイプ準拠の実装（M3以降の画面）に着手しない | レイアウト・文言の正が無い状態で画面を作ると作り直しになる |
| 2026-09-04 | 上記の但し書きを訂正: M1 も無傷ではない。`tokens.css` の移植と `seed-demo`（プロトタイプの `makeAccount()` 移植）は M1 スコープかつプロトタイプ依存なので、**暫定版で作って M3 の最初に差し替える**（§0-3・§11・§12.2・§13 M1/M3） | 2026-09-03 の記載「M1・M2 はサーバー側のみで影響しない」は誤り。§11 と §12.2 が両方ともプロトタイプ準拠と定義されており、M1 の完了条件と矛盾していた |

### v1.0 から変更した節

§0（同梱ファイル・進め方）、§1（ビジネス制約）、§2.2（motion 追加）、§2.3（url.ts / smoke.ts / motion.ts / docs / .claude 追加）、§2.4（決めごと）、§2.5（制約表を実測値に）、§3.1（vars）、§3.2（SESSION_SECRET の用途）、§4（スキーマ）、§5.1（forgot/reset）、§5.3（署名トークン・新設）、§5.4（管理API＋ライセンス revoked）、§6.1（budget三本立て）、§6.3（文字数の数え方・併用未検証の注記）、§7 冒頭、§7.1、§7.2、§7.3、§7.4、§7.5、§7.6、§7.7、§7.8、§7.9（新設）、§8.1、§8.3、§8.4、§8.5、§8.7、§9 冒頭、§9.1、§9.2、§9.3、§9.4、§9.5、§9.6、§10 冒頭、§10.3、§10.5、§11、§12.1、§12.2、§12.3、§12.5（新設）、§13（M1〜M7 全部）、§14、§15、§16。

変更していない節: §2.1、§5.2、§6.2、§8.2、§8.6、§10.1、§10.2、§10.4、§12.4。

---

## 2026-09-04 検証指摘の反映

v1.1 の独立検証で、要求項目は全件反映されていたが、v1.1 で新しく入った記述どうしの矛盾と未定義が8件見つかった。すべて SPEC.md に反映済み。

| # | 項目 | 反映した節 | 要約 |
|---|---|---|---|
| 1 | 「prototype 欠落は M1 に影響しない」が成立していない（§11 の `seed-demo` と §12.2 の `tokens.css` は両方ともプロトタイプ準拠かつ M1 スコープ） | §0（同梱ファイル・進め方3）, §11, §12.2, §13 M1, §13 M3 | M1 は暫定版（最小 CSS 変数 / 固定ダミーデータ20本）で進め、M3 の最初にプロトタイプ準拠へ差し替える。M1 完了条件から prototype 依存を外し、M3 完了条件に「暫定 `tokens.css` が残っていない」を追加 |
| 2 | 採点に使う数字の時点が未定義（`posts` の現在値か 48h 時点か） | §9.2, §7.7, §12.3 | 採点・`learning` への加算・percentile の分布のすべてを `post_metrics_history` の `checkpoint='48h'` 行で行う。48h 行が無い投稿は採点せず次回日次で拾う。分布の母数10本未満は採点を見送る。`carry`/`ctr` は比率なので現在値を使う旨も明記。画面の文言を「ホームの最新値とは一致しません」に更新 |
| 3 | 3ステップ方式 phase 1 の IN_PROGRESS 再試行回数のカウンタ置き場が未定義 | §4（`queue`）, §8.3 | `queue.container_polls INTEGER NOT NULL DEFAULT 0` を追加。step 1 と phase 1 で共用し、`container_id` を取り直すたびに0に戻す。`attempts`（ジョブ失敗のバックオフ用）とは兼用しない |
| 4 | 回数制限（forgot 10分3回 / `/a/*` 1分20回）の保存先が §4 に無い | §4, §5.1, §7.9, §8.7, §13 M1 | `login_attempts` を汎用の `rate_events(key, at)` ＋ `idx_rate_events(key, at)` に置き換え、キー形式（`login:<email>` / `forgot:<email>` / `action:<ip>`）と数える対象を §5.1 に表で例示。`cleanup` の対象も差し替え、M1 完了条件にテストを追加 |
| 5 | `DELETE /users/me` の削除対象に `notifications` / `password_resets` が無い | §7.8 | 「§7.1 の全削除（アカウントごと）＋ `user_id` を持つ全テーブル＋ `rate_events`」を表で列挙。`licenses` は行を残して revoked、`users` 行は削除 |
| 6 | `learning.dim='slot'` の `value` 形式が未定義 | §9.1, §9.3, §12.3, §7.7 | `<daytype>-<slot>` 形式（`weekday-21` / `weekend-12`）と全 dim の value 形式を表で定義。画面では「平日 21時台」と表示 |
| 7 | 画面の「いいね率」の定義が無い | §7.7, §9.2, §12.3 | `likeRate` = `like_rate_sum / n`（投稿ごとのいいね率の平均であって、いいね合計÷表示回数合計ではない）と1行定義 |
| 8 | 軽微4点 | §2.3, §2.5, §6.3, §7.9 | `docs/` 一覧の `prototype.jsx` に「（未着）」を追記。§7.9 の処理順で `publishing\|done` 判定を状態遷移の前（3番目）に移動し、`cancelled\|failed` の分岐も追加。§6.3 に「`docs/threads-api.md` §3-6 は併用前提だが公式の明記が無いため未検証扱い」を追記。§2.5 に Threads API の `4800 × インプレッション数` 制限を1行追加 |

通読時にあわせて直したもの: §5.1 の署名トークン参照が `§5.4` になっていたのを `§5.3` に訂正。`rate_events` の記録対象（ログインは失敗のみ、成功で消す）を明記。

---

以後の追記ルール: 1決定1行、日付つき。
- 2026-09-04 再検証の指摘3件を反映: §3.2 の署名トークン参照を §5.3 に / §7.1 の削除対象に `click_weeks_done` を追加 / §7.7・§9.2 の「すべて48h時点」を `avgScore` の `carry`・`ctr` 例外つきに限定。§7.9 の `cancelled|failed` 文言も訂正

## M1 実装で決めたこと

- 2026-09-04 wrangler は SPEC §2.2 の 3.x ではなく **4.129.0** を使う — npm の最新安定版が 4.x で、3.x は保守終了。`d1 migrations apply` / `dev` / `deploy --dry-run` の使い方は変わらない
- 2026-09-04 テストランナーは `@cloudflare/vitest-pool-workers` 0.22 + vitest 4.1 — D1 を workerd 上で本物として動かせるので `better-sqlite3` のアダプタは書かない。0.22 で API が変わっており、`defineWorkersConfig` ではなく `cloudflareTest()` プラグインを `defineConfig` の `plugins` に入れる
- 2026-09-04 モックの DEV ガードは `import.meta.env.DEV` ではなく esbuild の `define`（`__DEV__`）で行う — wrangler は `import.meta.env` を注入しないため。`wrangler.toml` の `[define] __DEV__ = "false"`（本番安全側）を既定にし、`npm run dev:worker` が `--define __DEV__:true`、`worker/vitest.config.ts` が `define: { __DEV__: "true" }` で上書きする
  - **訂正（2026-09-05、独立検証の指摘1）**: 当初この行に書いた「`wrangler deploy --dry-run` に mock の識別子が残らないことを確認済み」は、確認になっていなかった。M1 では `call()` がどこからも呼ばれておらず、mock が消えていたのは「未使用だったから」であって DEV ガードの効果ではない。`call()` を到達可能にして測り直したところ、`if (DEV && ...)`（`env.ts` のクロスモジュール定数）や `if (shouldUseMock(env, token))`（関数経由）では esbuild が枝を落とさず、mock 実装が丸ごとバンドルに入っていた（7KB → 22KB、mock 由来の識別子27件）
  - 対策: (a) 分岐に **`__DEV__` を識別子のまま直接書く**（`if (__DEV__ && env.THREADS_MOCK === "1" && token.startsWith("THAAdemo"))`）。宣言は `worker/src/globals.d.ts`。(b) 枝の中でもモック側の名前を1つも書かない — `mock/threads.ts` に `callMock` を**デフォルトエクスポート**で置き、`(await import("../mock/threads")).default(...)` で呼ぶ。名前で呼ぶと、消えた枝の中にその名前だけが文字列として残る。(c) エラー整形もモック側に寄せるため、`ThreadsError` / `ThreadsApiError` / `threadsReason` を `lib/threads-error.ts` に分離して両方から import する（`lib/threads.ts` は従来どおり再エクスポート）
  - 回帰確認は `scripts/check-bundle.sh`（`npm run check:bundle`）。`call()` を到達可能にした一時エントリでビルドし、mock 由来の識別子10種が0件であることを見る。`call()` 自体がバンドルに無い（＝検査が無意味な）状態も検出して止まる。`env.ts` の `DEV` は `/api/health` の `mock` フラグなど**実行時**の判定にだけ残す
- 2026-09-05 `POST /api/admin/licenses` は1文25行に分けて `db.batch()` で流す — D1（SQLite）の1文あたりのバインド変数は100個までで、licenses の INSERT は1行4個。`count>=26` を1文にすると `D1_ERROR: too many SQL variables` で 500 になっていた（独立検証の指摘2）
- 2026-09-05 `buildUpsertChunks` の1文あたりの行数は列数から決める（`min(50, floor(100 / 列数))`、2列=50行 / 3列=33行 / 5列=20行）— SPEC §8.1 の「1クエリ50行まで」は D1 のバインド上限100と矛盾しており、3列以上では50行が通らない。M2 の同期 upsert（`posts` は20列超）が全滅するのを防ぐ。呼び出し側が大きい `chunkSize` を渡しても上限で切り詰める（独立検証の指摘3）
- 2026-09-05 `RESEND_API_KEY` 未設定時のダミー送信（本文の全文出力と `outbox` への蓄積）は `DEV` の内側だけで行う — 本文にはパスワード再設定の有効なワンタイムトークンが入るため。本番ビルドでは `to=<伏せたメール> template=…` だけを error ログに出し、`ok:false` を返す。`outbox` も200件で頭を捨てる。`redact()` のクエリパターンに `reset` を追加（独立検証の指摘4）
  - ただし DEV のダミー送信は本文を `redact()` に通さずそのまま出す。ここが開発時の唯一の配送経路で、リセットリンクを踏めないと forgot → reset の手動確認（docs/qa.md 5-2）ができないため
- 2026-09-05 `POST /api/auth/login` はユーザーが存在しないときも固定のダミー hash/salt に対して `verifyPassword()` を1回回す — PBKDF2 100,000回ぶんの応答時間の差（実測 4ms 対 18ms）でメールアドレスの登録有無が分かってしまうため。`POST /api/auth/forgot` も不在時に `signToken` + `sha256Hex` を空回しして時間を揃える（独立検証の指摘5）
- 2026-09-05 `POST /api/auth/register` の `EMAIL_TAKEN`（409）は**仕様判断として残す** — 登録画面で「そのメールは登録済み」と出さないと買い手が詰まる。メールアドレスの存在が分かる経路にはなるが、`forgot`（常に `ok:true`）と `login`（時間も含めて一定）で漏らさない方を優先し、register だけ利便性を取る。SELECT と INSERT の間の競合は `users.email` の UNIQUE 違反を捕まえて同じ 409 にする
- 2026-09-04 `rateLimit()` の置き場は SPEC §5.1 が言う `lib/session.ts` ではなく **`lib/rate.ts`** に分けた — セッションと回数制限は依存関係が無く、`/a/*`（§7.9）からセッションを読まずに使うため。関数は `rateAllow`（数えるだけ。ログイン失敗のように「失敗時だけ記録する」用途）と `rateHit`（記録してから判定。forgot / action のように全件を数える用途）の2本に分けた
- 2026-09-04 `similarity()` は SPEC §8.3 が言う `shared/src/tags.ts` 本体ではなく `shared/src/similarity.ts` に置き、`tags.ts` から再エクスポートする — `tags.ts`（分類）と重複判定は用途が別。§8.3 の import パスはそのまま使える
- 2026-09-04 `validatePost()` は `shared/src/validate.ts` に置く（SPEC は置き場を明記していない）— web と worker の両方から呼ぶため shared に置く必要がある
- 2026-09-04 本文長は「コードポイント数と UTF-8 バイト数の厳しい方」（SPEC §6.3 のとおり）。`scripts/smoke.ts` の項目4で実測してから確定する
- 2026-09-04 `/api/health` は `{ok, version, mock}` を素の形で返す（`{ok:true,data}` で包まない）— SPEC §7.8 の記載どおり。web の `api/client.ts` は `data` の有無で両方を受ける
- 2026-09-04 `/api/*` の認証ミドルウェアはルーティングより先に走るので、未認証の未知パスは 404 ではなく 401 を返す — パスの存在有無を未認証者に漏らさないため
- 2026-09-04 `wrangler.toml` の `database_id` はローカル開発用のダミー UUID（`00000000-…`）を置く — `--local` は Miniflare のファイルを使うため参照されない。本番は `wrangler d1 create` で得た ID に差し替える
- 2026-09-04 `scripts/seed-demo.ts` はスクリプト内で SQL を組み立て、`wrangler d1 execute --file` に渡す方式にする — Worker を起動せずに投入でき、`--local` / `--remote` を同じコードで切り替えられる。冒頭で対象行を DELETE してから INSERT するので何度実行しても同じ状態になる
- 2026-09-04 seed のデモユーザーのパスワードは `password1234` 固定（PBKDF2 の salt も 0x00..0x0f 固定）— 決定的にするため。デモ専用の値で本番では使わない
- 2026-09-04 seed の `accounts.token_enc` は、`ENC_KEY` が env か `.dev.vars` にあるときだけ実際に暗号化して入れる（無ければ `SEED_NO_ENC_KEY`）。決定的な SQL にするため IV は固定にした — 平文は `THAAdemo_seed` というモック用の文字列1つだけで、実トークンではない
- 2026-09-04 `web/src/styles/tokens.css` は暫定版（SPEC §12.2）。プロトタイプ冒頭の CSS 変数（`--bg` 〜 `--r`）と font-family・max-width 430px だけを写し、Login が読める最小限の部品クラスを足した。M3 の最初にプロトタイプの `CSS` 定数で丸ごと置き換える
- 2026-09-04 Login のボタンは `:active` の `transform: scale(0.97)`（90ms）で pointer-down に反応させ、`prefers-reduced-motion: reduce` では transform を止めて opacity だけにする（apple-design SKILL.md の「Respond on pointer-down」「reduced-motion はクロスフェード」）。spring（`motion`）の導入は M3
- 2026-09-04 `/reset` ルートは `/login?reset=<token>` と同じ画面を出し、`?reset=` と `?token=` の両方を受ける — メールのリンク（SPEC §5.1）は `/login?reset=` のままにする
- 2026-09-04 `POST /api/auth/register` はライセンスを `UPDATE ... WHERE status='unused'` で押さえ、`changes=0` なら作った `users` 行を消して `LICENSE_INVALID` にする — 同じキーでの同時登録を1本に絞るため（D1 にトランザクションが無い前提の書き方）

## M2 実装で決めたこと

- 2026-09-05 ジョブ台帳（`jobs` テーブル）の読み書きは **作業用とは別の予算** で数える（`lib/jobs.ts` の `JOB_BOOKKEEPING_QUERIES=150`）— 作業予算（`MAX_DB_QUERIES` 既定800）が尽きた**あとに** `state_json` を保存できないと再開できないため。SPEC §2.5 / §8.1 が「Paid の実測上限は1呼び出し1,000クエリ、既定800は余裕を200残した値」としており、150はその200の内側に収まる
- 2026-09-05 `BudgetExceeded` はジョブの失敗として数えない（`attempts` を増やさず `next_run_at=now` の pending に戻す）— 予算切れは「続きがある」であって異常ではないため。指数バックオフ（1,2,4,8分・5回）は本当の失敗にだけ効かせる
- 2026-09-05 `runJobs()` は1回の実行で最大50ジョブまで（`MAX_JOBS_PER_RUN`）— SPEC に上限の記載がないので暴走ガードとして入れる。時間予算が先に当たるのが通常
- 2026-09-05 ハンドラ未実装のジョブ種別（`publish` は M4、`ap_*` は M6）は `done` にして流す — キューの先頭で詰まって後続のジョブが永久に走らなくなるのを防ぐ
- 2026-09-05 週1のジョブ（`insights_old` / `demographics` / `token_refresh`）は **UTC 日曜** に投入する（`WEEKLY_UTC_DAY=0`）— SPEC §8.2 は「週1」としか書いていないので曜日を固定する。日次 cron（18:00 UTC）の中で判定する
- 2026-09-05 `buildUpsertChunks` の更新指定に式を渡せるようにした（`{column, expr}`）— `full_sync` が採点済みの `tags_json`（`scored`）や既存の数字を潰さないために `CASE WHEN posts.tags_json='{}' THEN excluded.tags_json ELSE posts.tags_json END` のような式が要る。文字列だけの従来の指定はそのまま使える
- 2026-09-05 `full_sync` の upsert が上書きするのは本文・permalink・メディア・投稿日時・`root_id`・`is_reply`・`deleted`・（未設定時のみ）`tags_json` だけ。`views` などの数字・`clicks`・`metrics_fetched_at`・`source`・`queue_id` は触らない（SPEC §8.4「既存の数字は保持」の具体化）
- 2026-09-05 `insights_*` の履歴チェックポイントは「初回取得なら**いま入っている帯だけ**、2回目以降は前回の経過 < しきい値 <= 今回の経過を満たすもの」で判定する（`crossedCheckpoints()`）— SPEC §8.4 の「初めて超えた取得時に1行だけ」と「30日を超えて初めて取得した投稿は 48h と 7d を埋めない」を1つの規則にまとめたもの
- 2026-09-05 `insights_*` の再開は `state_json.pending`（`[id, posted_at, 前回の metrics_fetched_at]` の配列）で行う。1件処理しきってから配列の先頭を落とすので、予算切れで途中終了しても取りこぼさない。1回の投入で拾う上限は200件（`MAX_TARGETS`）
- 2026-09-05 `click_weeks.url` には **正規化後**のURLを入れ、同じ週の中で正規化が衝突するURLは合算してから1行にする — 生のURLのまま入れると、1文の `ON CONFLICT DO UPDATE` が同じ行を二度触ってエラーになる。合算してから `MAX(excluded.clicks, click_weeks.clicks)` を当てるので「前回より小さい値が来たら前回を残す」（SPEC §8.5）は保たれる
- 2026-09-05 クリックの按分は `shared/src/clicks.ts` の `allocateClicks()` に純関数として置き、`clicks` ジョブ（`posts.clicks` の更新）とダッシュボード（`links` と `unassignedClicks`）の両方から同じ関数を呼ぶ — 2か所で別々に按分すると数字がずれるため
- 2026-09-05 `follower_snapshots.date` は **アカウントの timezone** の当日を使う（`daily_views.date` は API の `end_time` すなわち UTC 日付のまま）— 日次 cron は 18:00 UTC = 03:00 JST に走るので、UTC 日付だと日本の買い手には前日として記録されてしまう
- 2026-09-05 `demographics` は M2 では `breakdown=age` の1本だけ取る — SPEC §6.3 が例示するのが age のみ。テーブルは `(account_id, breakdown)` が主キーなので、後から増やしても壊れない
- 2026-09-05 `POST /accounts` で同じ Threads アカウント（`(user_id, threads_user_id)` が一致）を再接続したときは、新規作成せず**トークンを差し替えて `status='ok'` に戻す**（応答は 200、新規は 201）— `needs_reauth` からの「つなぎ直し」（SPEC §6.2 の文言）が通る唯一の経路だから。3件上限にも数えない
- 2026-09-05 `POST /accounts` の `app_secret` は長期化の試行にだけ使い、保存しない。長期化に失敗しても接続自体は成立させ、短期トークンのまま保存して応答に `secretIgnored:true` を返す — トークンが有効なのに App Secret の入力ミスだけで接続そのものを失敗させない
- 2026-09-05 `GET /accounts/:id/sync` の `progress` / `total` は**ページ数**で返す（`total=30` = threads 15ページ + replies 15ページ）— SPEC §7.1 が単位を定めていないため。投稿数だと分母が同期しないと決まらず、進捗バーにならない
- 2026-09-05 Threads API の失敗（`ThreadsApiError`）は Hono の `onError` で `{code:'THREADS_ERROR', message: threadsReason(e)}` の 502 に変える — 日本語の理由＋原文（`#code message`）を1か所で組み立てる（SPEC §2.4 / §6.2）
- 2026-09-05 `wrangler.toml` の `run_worker_first` に `/__scheduled` を足した — `wrangler dev --test-scheduled` が注入する cron 手動実行の入口が、静的アセット側に取られて Worker まで届かなかったため（`docs/qa.md` M2-2）。本番では `--test-scheduled` の middleware が無く `index.ts` が ASSETS へそのまま渡すので、挙動は追加前と変わらない
- 2026-09-05 `mock/threads.ts` はトークンに `expired` を含むとき code 190 を投げる — `needs_reauth` の経路（SPEC §6.1 / §8.6）をモックだけでテストするため
- 2026-09-05 `scripts/check-bundle.sh` は本番エントリ（`worker/src/index.ts`）と一時エントリの**両方**を検査する — M2 でジョブが `call()` を呼ぶようになり、本番エントリ自体が到達可能な検査対象になった。一時エントリは、将来その経路が切れてもガードの効きを測り続けるための保険として残す

## M2 独立検証（2026-09-06）

- 2026-09-06 code 190 の**通知**（メール）は M2 では出さない。`markNeedsReauth()` で `accounts.status='needs_reauth'` にし、ジョブを `failed` で止めるところまでが M2 の範囲 — SPEC §13 M1 が「メール（`lib/email.ts`）は `password_reset` テンプレだけ先行実装」、§13 M6 が「メール通知」と定めており、`needs_reauth` テンプレは §10.5 の名前だけ確定済み。SPEC §6.1 の「190 は…通知」はテンプレ実装と同時（M6）に繋ぐ
- 2026-09-06 `CLICK_FLOOR_SEC = 1712991600` の実際の時刻は **2024-04-13T07:00:00Z**（コメントの「T00:00:00Z」は誤り）。値は SPEC §8.5 が指定するものをそのまま使い、動かさない — 週の境界がどこであれ「固定起点から7日刻み」という性質（＝二重計上しない）は変わらないため。コメントだけ訂正した
- 2026-09-06 「他人の accountId は触れない」テストを、アカウントIDを取る**全14ルート**（dashboard / diagnose / sync GET・POST / refresh-token / PATCH / posts 一覧・詳細・repost / links 4本 / DELETE）に広げた — 元は DELETE と dashboard の2本だけで、新しいルートを足したときに `loadOwnedAccount()` の付け忘れを検出できなかった。復号トークンが応答に出ないことのテストも足した

## M3 実装で決めたこと

- 2026-09-06 **`docs/prototype.jsx` は消失し、再提供の見込みがない**。SPEC §0-3 の「プロトタイプを分解して実装する」は実行できないので、UI の正本を次のように置き換える。SPEC §13 M3 の完了条件「暫定 `tokens.css` がリポジトリに残っていない」は「**暫定注記が残っていない**」と読み替える
  - レイアウト・画面構成・文言 … `docs/design-v0.2.md` §3（3-1〜3-7）と SPEC §12.1〜12.3
  - CSS トークン … `web/src/styles/tokens.css`（M1 の暫定版を正式版に昇格。変数名・色・430px 中央寄せ・システムフォントはそのまま引き継ぎ、M3 で必要になった分＝影・半透明レイヤー・クロムの高さ・角丸の段階を足した）
  - 動き・触感・タイポ … `.claude/skills/apple-design/SKILL.md` と SPEC §12.5
  - デモデータ … `scripts/seed-demo.ts` の現行の固定データ（`makeAccount()` 移植は行わない）
- 2026-09-06 `web/vite.config.ts` の proxy キーを `"/a"` から **`"^/a/"`（正規表現）** に直した — 素の文字列キーは前方一致なので `/app/*`（SPEC §12.1 のアプリ本体）まで Worker に流れ、開発中なのに `web/dist` のビルド済み資産が返っていた。M1・M2 は `/app/*` に中身が無かったので表面化していなかった。`/api` も `"^/api(/|$)"` に揃えた
- 2026-09-06 spring の数値は `web/src/lib/motion.ts` のプリセットにだけ置き、画面から直接書かない（SPEC §12.5）。`as const satisfies Transition` にしてあるのは、コンポーネントの `transition` 属性と `animate(motionValue, …)` の第3引数の両方に同じ値をそのまま渡せるようにするため
- 2026-09-06 Drawer / Sheet はドラッグを離したとき、`project()`（`current + (v/1000)·d/(1−d)`, `d=0.998`）で求めた**投影点**が閾値を越えたかで開閉を決め、越えなければ離した速度を初速にして元の位置へ戻す（apple-design §5・§6）。境界の外は `dragElastic` のラバーバンドに任せる
- 2026-09-06 行の展開（ツリーの各段）は `transform` と `opacity` だけを動かし、**高さはアニメーションしない**（SPEC §12.5「`height` / `top` / `width` は動かさない」）。開いた瞬間に高さが決まり、中身が上から降りてくる
- 2026-09-06 タブの切り替えは「前の画面の退場を待たない」cross-fade にした（`AnimatePresence mode="wait"` を使わない）— 退場を挟むとタップから新画面までに固定の待ち時間が入り、apple-design §1「kill latency」に反するため
- 2026-09-06 行の操作（リライト / これを型にして作る / リポスト / Threads で開く）は行の「⋯」から開く**シート**に置き、行タップは各段の数字の展開に割り当てた — どちらも1タップで届く。展開パネルにも「リライト」「これを型にして作る」を残す
- 2026-09-06 Create へ渡す下敷きは `location.state.preset = { mode: 'template' | 'rewrite', postId, text }`（SPEC §12.3 の `location.state.preset`）。受け口は `web/src/screens/Placeholder.tsx` の `Create`（本実装は M5）
- 2026-09-06 Connect の初回同期は**終わるまで足止めしない**。進捗バーと一緒に「ホームへ」を常に出す — 取り込みは5分ごとの cron ジョブで進む（SPEC §8.2）ので、待たせると最大5分の空白になる。design-v0.2 §3-1 の「初回同期は裏で進み、進捗バーを出す」に合わせた
- 2026-09-06 ApBar は `GET /accounts/:id/autopilot/next`（SPEC §7.7）が M6 なので、いまはプレースホルダの文言だけを出す。M6 で `next` を読んで差し替える
- 2026-09-06 アイコンは SPEC §2.2 が挙げる `lucide-react` を入れず、`web/src/components/Icons.tsx` のインライン SVG 9個で足りる範囲に留めた — 依存を1つ減らし、`currentColor` と `stroke-width` を揃えるため。必要になったら差し替えられる
- 2026-09-06 `web/dist` の JS が約 750KB（gzip 225KB）になっている。ほとんどが recharts。SPA なので初回だけの読み込みだが、M7 の仕上げで `manualChunks` による分割を検討する

## M4 実装で決めたこと

- 2026-09-06 コンテナ待ちの上限で失敗にするとき、`container_polls` に**上限値そのもの**（10）を書いてから `failed` にする（引き継ぎ時の実装は9のまま残っていた）— SPEC §8.3 が「IN_PROGRESS なら container_polls+=1 …（10回で failed）」としており、「10回見た結果の失敗」が行に残らないと、あとから原因を読み解けない。step 1（画像）と phase 1（3ステップ方式のコメント）の両方で揃えた
- 2026-09-06 5分ごとの cron は「`runJobs()` のみ」（SPEC §8.2）だが、`publish` を積む入口が他に無いので `enqueueForCron()` の5分の枝で `enqueuePendingPublishes()` を呼ぶ。出番のあるキュー（`scheduled` で時刻到来、または途中まで進んだ `publishing`）を持つアカウントにだけ積む — 同じ `type+account_id` は重複投入されない（§8.1）ので publish は常に1本になり、2本が並走して `publishing` の行を両方が拾いコメントを二重投稿する事故が起きない
- 2026-09-06 `publish` ジョブは1回の実行の最後に自分を積み直さない。続きは次の5分の cron が拾う — 積み直すと「1本だけ」の保証が崩れる。代わりに、予約が入った・早まったとき（`POST /queue`, `PATCH`, `approve`, `publish-now`）はルート側から `enqueuePublish()` で前倒しし、待たせない
- 2026-09-06 手動のキュー（`source='manual'`）では `validatePost()` を `linkPlacement:'body'` で呼ぶ。本文にリンクを置くこと自体は許し、見るのは空・500文字・リンク5本・NGワードだけにする — 「リンクはコメントに置く」（`link_placement`）はオートパイロットの設定（SPEC §9.6）であって、手で書いた投稿に押し付けるものではない。M6 で AP 経由のキューにだけ `linkPlacement` を効かせる
- 2026-09-06 **`validatePost()` のリンク本数は「重複を除いた数」**（`extractUrls()` が重複を除くため。SPEC §8.5）。一方 Threads（とモック）は本文中の出現回数で数える。同じURLを2回書くと画面は通って投稿時に `LINK_LIMIT_EXCEEDED` で失敗する。どちらが正かは実 API でしか決まらないので、`scripts/smoke.ts`（SPEC §14）の確認項目として残し、M4 では実装を変えない — 失敗しても `failed` に日本語＋原文が残って作り直せる（壊れない側の食い違い）。`docs/qa.md` M4-3 に、失敗タブの確認材料としての作り方も書いた
- 2026-09-06 `mock/threads.ts` に「自分が発番したはずの ID を、消えていたら作り直す」`ensureKnownPost()` を足した — モックの投稿はメモリ（Worker の isolate）にしか無い（SPEC §11）。`wrangler dev` はファイル変更やアイドルで isolate を捨てるので、コメントを120秒後に出すツリー投稿（§8.3）は次の cron で `reply_to_id not found` になる。実 API では起こらないモックだけの偽の失敗なので埋め戻す。埋め戻すのは `<user_id>` ＋4桁以上の数字という**このストアの発番規則に合う ID だけ**なので、`reply_to_id` を渡し忘れた実装の間違いはこれまでどおり検出できる
- 2026-09-06 `queue` の直前チェック（SPEC §8.3）で「1日の投稿上限」は `queue` の `done|publishing` の件数で数え、「投稿間隔」は `posts` の `source<>'external'` の最新 `posted_at` で見る — 上限は「このアプリが今日出した本数」、間隔は「実際に出た時刻」が知りたいものなので、見る先が違う
- 2026-09-06 画面のタブ「予約 / 下書き / 投稿済 / 失敗」（design-v0.2 §3-5）に7つの `queue.status` を割り当てる: 予約＝`scheduled|pending_approval|publishing`、下書き＝`draft`、投稿済＝`done`、失敗＝`failed|cancelled` — `publishing` と `pending_approval` に独立したタブを与えると、いま出ようとしているものが見つからなくなる。行のタグで状態は区別できる
- 2026-09-06 「数字を見る」は行の展開に割り当てる（投稿詳細画面は作らない）— SPEC §12.1 に投稿詳細のルートが無く、ホームの行展開と同じ操作にすると学ぶことが増えない。操作シートの「数字を見る」はその行を開いてシートを閉じる
- 2026-09-06 失敗の表示は、開いたパネルで日本語の理由から「（Threadsからの返答: …）」を落とし、原文を「Threads からの返答: …」の行に分けて出す — `threadsReason()`（SPEC §6.2）が理由の末尾に原文を足すので、そのまま出すと `error` と `error_raw` で同じ文字列が二度並ぶ
- 2026-09-06 日時の入力（`datetime-local`）は端末のタイムゾーンではなく**アカウントの timezone** の壁時計として読む（`web/src/lib/format.ts` の `fromDateTimeLocal`）。そのために `shared/src/slot.ts` の `zonedHourToUtcMs` を分つきの `zonedTimeToUtcMs` に分け、時だけの版はその薄い包みにした — SPEC §2.4 が「表示はアカウントの timezone」としており、入力もそこに合わせないと海外から触ったときに1日ずれる
- 2026-09-06 `approve_deadline` の残り時間は client で 30 秒ごとに数え直す（SPEC §12.3）。サーバーに聞き直さない
- 2026-09-06 Create（作る）は M4 では「本文＋コメント①②③ → 下書き保存 / キューに入れる」までを作る。箱1（過去投稿の picker）・箱2（参考情報）・3案生成は M5 — キューの3経路を人が触って確かめられる最小の入口が要るため。`components/PostFields.tsx` と `components/ScheduleSheet.tsx` に切り出して、キューの編集・日時変更と同じ部品を使う
- 2026-09-06 cron の手動実行は `--test-scheduled` 無しの `wrangler dev` でも叩ける `/cdn-cgi/handler/scheduled?cron=…` を使う（`docs/qa.md` M4-0）— `/__scheduled` は `--test-scheduled` が注入する middleware が無いと Worker の未知パスとして SPA の HTML に落ちる。既に起動している開発サーバーを止めずに確認できる
- 2026-09-06 `worker/test/accounts.test.ts` の「`POST /sync` は重複投入せず…」で、ジョブを回す `now` を `max(NOW, Date.now())` にした — `POST /sync` は**ルート経由**なので `next_run_at` を実時計で書くのに対し、`runJobs` には固定の `NOW`（`2026-09-06T00:00:00Z`）を渡していた。実時間がその瞬間を追い越した時点（＝2026-09-06 00:00 UTC 以降）から「まだ期限が来ていない」と判定されて必ず落ちる、時計依存のテストになっていた。M4 の作業中に日付が変わって顕在化した。ルート経由で積んだジョブを回すテストは、両方の遅い方を使う

## M4 独立検証（2026-09-06）

- 2026-09-06 `PATCH /queue/:qid` で step を 0 に戻すのは **`result_ids` が空のときだけ**にした。root が公開済みの `failed` 行（コメント段で落ちた行）を本文修正すると step 0 が root をもう1本作り、SPEC §8.3 の二重投稿防止が破れていた。あわせて `publish` の step 0 に「`result_ids` があれば root を作り直さず、投稿済みコメント数から続きの step を計算して再開する」最後の関門を置いた — step を戻す経路が今後増えても、ジョブ側で止まる
- 2026-09-06 投稿間隔（`minGapMin`）は `posts` の最新 `posted_at` に加えて、**まだコメントを出している最中の行**（`queue.status='publishing'` かつ `result_ids` が空でない行の `updated_at`）も見る。`posts` は `done` になって初めて入るので、ツリーの1本目が出た直後に別の予約がすり抜けていた（ブラウザ確認で再現）
- 2026-09-06 コンテナの `error_message` を `error_raw` に入れるときは `redact()` を通す。あわせて `redact()` に実トークンの形（`THAA…`）を足した（従来は `THAAdemo`＝モック用と `THQ` だけで、実運用のトークンが素通りしていた）
- 2026-09-06 `.sheet` に `max-height: calc(100dvh - 2.5rem)` と縦方向の flex を入れ、中身は `.sheet-body`（`overflow-y:auto` / `touch-action: pan-y`）でスクロールさせる — 編集シートは本文＋コメント3つで 800px 近くなり、表示高 700px 程度の端末では見出しと本文が画面の外に出ていた。シート自体のドラッグ（`touch-action: none`）は残す
- 2026-09-06 シートを弾いて閉じたときは、離した速度を**退場の spring**（`flickWith()`）に渡す（SPEC §12.5「弾いて閉じたとき … ＋ 離した速度を `velocity` に渡す」）。従来は戻す側にだけ velocity が渡り、閉じる側は速度なしの `SPRING_GESTURE` だった
- 2026-09-06 キューの操作シートの「承認」は `pending_approval` に加えて **`scheduled` ＋ `approve_deadline` あり**でも出す（SPEC §7.4 の approve は「`pending_approval`→`scheduled`、または `approve_deadline` を消す」の2形。取消可モードは後者）。行を出すのは M6 だが、画面側の経路は先に開けておく
- 2026-09-06 SPEC §12.5 が挙げる「キューのスワイプ操作」は**実装しない**。操作は行の「⋯」から開くシートに集約する（DECISIONS 2026-09-06 の M3 の項と同じ判断）— スワイプは隠れた操作で、初見の買い手には届かない。シートなら全操作が1画面に並ぶ
- 2026-09-06 `tokens.css` の固定時間 CSS transition（`:active` の押し込み・色の変化）は SPEC §12.5 の「指で触れる要素に固定時間の transition を使わない」の例外として残す。掴んで途中で反転できる動き（Sheet / Drawer / 行展開）はすべて spring で、CSS transition が残るのは「押した瞬間に返して離したら戻る」一方向の反応だけ（apple-design §1 のサンプルと同じ形）

## M5 実装で決めたこと

- 2026-09-06 Create の `originPostId` は、`pickMode` によらず**選んだ投稿の先頭**を入れる（SPEC §9.4-5 の「`origin_post_id`(文体見本の先頭)」と同じ意味）— 引き継いだ実装は `pickMode === 'rewrite' ? picks[0] : picks[0]` と両枝が同じ三項演算になっていて、モードで意味が変わるように読めた。型でもリライトでも「どの投稿から作ったか」を1本だけ残す
- 2026-09-06 箱1（PostPicker）の「リライト元にする」は選択を**1本に強制**する（`pickMode` を切り替えた時点で `picks.slice(0,1)`、以後は押すたびに入れ替え）— SPEC §10.2 が「リライト元: picks の本文（1本目）」としており、2本目以降は黙って捨てられる。捨てるくらいなら選ばせない
- 2026-09-06 箱2（SourceAdder）の**ファイルはブラウザで読んで `content` として送る**（SPEC §10.4）。拡張子（.txt / .md）と 2MB の判定も送信前にブラウザで行い、サーバーには本文しか渡さない — ファイルそのものを Worker に送る口を作らない
- 2026-09-06 参考情報は追加すると**その場で選択状態になる**。プールに残るのは仕様（オートパイロットのネタ源。design-v0.2 §3-4）だが、いま足したものを使いたいのが普通なので、選び直しの一手を省く
- 2026-09-06 「指示で直す」は、画面で手直しした本文・コメントを `candidate` に載せ替えてから送る — AI に「いまの姿」を見せないと、直した内容が次の修正で巻き戻る。会話履歴は案ごと（`candidate.key`）に持ち、`{user: 指示, assistant: 直後の本文}` を積む
- 2026-09-06 キー未設定の判定（`keyReady`）は「サーバー保存なら `hasKey`、端末保存なら `localStorage.aiKey` があるか」の2本立てにし、満たさないときは**生成ボタンを出さずに**設定への導線に差し替える（design-v0.2 §3-4「キー未設定なら生成ボタンの代わりに設定誘導」）— 押せるボタンを出してエラーで返すより、押す前に行き先を見せる
- 2026-09-06 設定の「キーをこの端末にだけ保存」は、**スイッチを押した時点でシートを出し、OK を押すまで保存も `localStorage` への書き込みもしない**（SPEC §12.3「トーストでの事後通知にはしない」）。OK のときだけ `PUT /ai/settings` に `storeOnServer=false` を送り、キー本体はリクエストに載せない。サーバー保存に戻したら `localStorage.aiKey` を消す — 端末とサーバーの両方にキーが残る状態を作らない
- 2026-09-06 `AI_MOCK=1` の `mock/ai.ts` が「指示」を読むとき、空行までで切るようにした（`instructionOf()`）— `buildRevisePrompt()` は `# 指示` の後ろに見出しの無い一文（「この1案だけを直して…」）を足すので、`# ` 区切りだけを見ていた元の実装はプロンプトの定型文まで指示として拾い、画面の確認が読めなくなっていた。あわせて直す前の注記行を落として（`stripMockNote()`）、何度直しても本文が積み上がらないようにした。モックだけの修正で、実プロバイダの経路には触れていない
- 2026-09-06 `scripts/check-bundle.sh` のマーカーに `THREADS_MOCK` / `AI_MOCK` という**env の名前は入れない**（入れると必ず落ちる）— `shouldUseMock()` と `mockAvailable()`（`/api/health` の表示用）は `DEV` 経由で書いてあり、本番バンドルにも関数ごと残る。残るのは名前と `false` 判定だけでモックの実装ではない。見たいのは「モックの中身が入っていないこと」なので、判定は `mock/*.ts` にしか無い識別子で行う（スクリプトにも理由を書いた）
- 2026-09-06 M5 の画面確認は `AI_MOCK=1` の worker に対して行い、**実キー・実 URL への fetch は一切していない**。Gemini / OpenRouter の実キーでの JSON 出力、YouTube URL の Gemini 経路（`file_data`）、記事URLの本文抽出は `docs/qa.md` M5-5 に手順として残し、キーが用意できた時点で行う — SPEC §13 M5 の完了条件のうち「実キーで手動確認」の2項目は、この時点では未実施

## M5 独立検証（2026-09-06）

- 2026-09-06 参考情報の `url` 型に **SSRF の穴があった**ので塞いだ。`extractUrlSource()` は
  ユーザーが入れた URL をそのまま `fetch` していたので、`http://127.0.0.1:8787/api/…` や
  `http://169.254.169.254/`（クラウドのメタデータ）を渡すと Worker から内部に取りに行けた。
  `assertFetchableUrl()` を入口に置き、非 HTTP スキーム（`file:` / `data:` など）・
  `localhost`・`.local` / `.internal`・ループバック / 私設 / リンクローカル / CGNAT /
  マルチキャストの IPv4・IPv6（`::1` / `fc00::/7` / `fe80::/10` / IPv4 射影）を弾く。
  Workers からは名前解決の結果が見えないので、**URL の形で判定できる範囲を全部**落とす方針
- 2026-09-06 リダイレクトは `redirect: "follow"` をやめ、`"manual"` で自分で追って
  1ホップごとに `assertFetchableUrl()` をかける（上限3ホップ）— `follow` のままだと、
  公開URLから 302 で `localhost` に飛ばされたときに気づけない。入口だけの検査は検査にならない
- 2026-09-06 M5 の他の採点項目（§10.1 のリクエスト形とリトライ、§10.2 の見本3本・
  3,000/9,000字・YouTube の `file_data`、§7.6 の `storeOnServer=false` でキーが残らないこと、
  §10.4 の `<article>`/`<main>` 優先、`AI_MOCK` の DEV ガード）はすべて PASS。
  テストが薄かった3点（`topTemplates` の型の重複回避、2MB での打ち切り、10秒の signal）に
  テストを足した

## M6 実装で決めたこと（2026-09-06）

- 2026-09-06 `/a/:token` の判定順を SPEC §7.9 の 3 → 4 → 5 から **3 → 5 → 4** に変えた。
  仕様書どおりだと、自分で取り消した直後に同じリンクをもう一度踏んだとき、行が
  `cancelled` なので 4 に当たって「すでに取り消されたか、投稿に失敗しています」になる。
  SPEC §13 M6 の完了条件は「同じトークンは2回目で**すでに完了しています**になる」と
  定めているので、消費済み（`action_token_used_at`）の判定を先に置いた。3（`publishing|done`）を
  最優先にする理由——もう出てしまったことを伝え、遷移も消費もしない——は変えていない
- 2026-09-06 `neededCount()` が差し引く在庫は「24時間以内に予定された自動下書き」ではなく
  **未消化の自動下書き全部**にした（SPEC §9.4-2 の文言どおり）。24時間で切ると、枠が埋まって
  先の日に置かれた下書きを数え落とし、毎時それを無視してもう1本作って先へ先へ積み上がる
  （ブラウザ確認で実際に踏んだ）。本数の抑えは `daily_limit`（枠の側）と在庫の両方で効かせる
- 2026-09-06 `JOB_BOOKKEEPING_QUERIES` を 150 → **190**、`MAX_JOBS_PER_RUN` を 50 → **40** に。
  毎時の cron が投入するジョブがアカウントあたり1本から3本（`insights_recent` / `ap_plan` /
  `ap_notify`）に増え、`runJobs` のループだけで台帳の予算（1本あたり3クエリ × 50 = 150）を
  使い切って **cron 全体が `BudgetExceeded` で落ちていた**。あわせて、台帳側の予算切れは
  `runJobs` の中で「打ち切って次回」に倒し、`enqueueForCron` でも投げないようにした——
  ここで throw すると、その呼び出しですでに終わらせたジョブの結果まで巻き添えで捨てることになる
- 2026-09-06 `ap_score` は `learning` の4次元を **1クエリのマルチ VALUES ＋ ON CONFLICT** で
  まとめて積む（SPEC §8.1「ループ内で1行ずつ書かない」）。分布はジョブの冒頭で1回だけ作り、
  投稿ごとには二分探索で順位を引く（`percentile`）
- 2026-09-06 `ap_plan` の生成は**引き直しを1回まで**（`MAX_GENERATE_ATTEMPTS=2`）。
  `validatePost`（NGワード・500文字・`link_placement`）か重複判定（3-gram Jaccard 0.8）に
  落ちたら、落ちた理由を指示に添えてもう一度だけ引く。それでもダメなら失敗として数える——
  無限に引き直すと、買い手のAIキーの残高を静かに削ることになる
- 2026-09-06 リンクは AI に本文へ書かせず、`link_placement='comment'` のとき
  **サーバー側でコメント①の末尾に足す**。プロンプトにも「本文にURLを書かない」と入れているが、
  守られなかったときに `validatePost` で弾いて引き直すより、確実に置ける側に寄せた
- 2026-09-06 `markNeedsReauth()` は **状態が変わった回だけ**メールを送る
  （`WHERE status='ok'` の `changes` を見る）。毎時のジョブが同じ 190 を踏むたびに
  同じメールが飛ぶのを防ぐ。あわせてその場で `autopilot.enabled=0` にする（SPEC §9.6）
- 2026-09-06 `publish` の `validatePost` は、**AP 経由のキューにだけ** `link_placement` と
  `ng_words` を効かせる（`source='autopilot'` で `autopilot` の行を読む）。手で書いた投稿は
  M4 の判断（DECISIONS 2026-09-06）どおり `linkPlacement:'body'` のまま——
  「リンクはコメントに置く」はオートパイロットの設定であって、手で書いた投稿への押し付けではない
- 2026-09-06 ApBar の1行（「次は 9/11 21:00。9/11 17:00 まで取り消せます」）は
  **サーバー側で組み立てて** `GET /autopilot/next` の `summary` で返す。アカウントの
  timezone で作る必要があり（SPEC §2.4）、端末の時計で作ると海外から触ったときにずれる
- 2026-09-06 **Web Push の実送信は M7 に送る**。M6 で作ったのは購読の登録・解除
  （`POST/DELETE /push/subscribe`、`push_subscriptions` に暗号化して保存）と、設定画面の
  スイッチ（許可が下りなければ設定を変えない）まで。実送信には VAPID の ES256 JWT 署名と
  ペイロードの aes128gcm 暗号化（HKDF ＋ ECDH）が要り、`web-push` は Node 前提で
  Workers にそのまま載らないので自前実装になる。M6 の通知はメール（§10.5）で完結しており、
  Push が無くても承認・取消・失敗・停止はすべて届く。鍵の作り方は `.dev.vars.example` に書いた
- 2026-09-06 PWA のアイコンは `scripts/make-icons.mjs` が **Node の zlib だけで PNG を書く**。
  `sharp` / `rsvg` / `puppeteer` のような画像変換の依存を1つも足さないため。紙飛行機は
  `components/Icons.tsx` の `PlaneIcon` と同じ形を多角形として置き、4x のスーパーサンプリングでならす
- 2026-09-06 Service Worker は **`runtimeCaching` を1つも置かない**。静的資産15件の
  precache と SPA のナビゲーションフォールバックだけで、フォールバックからは `/api/*` と
  `/a/*` を除外する（SPEC §12.4「APIはキャッシュしない」）。数字とキューが古いまま見えると、
  取り消したはずの投稿が残って見えるなどの誤解が起きる。`/a/*` は Worker が HTML を返す
  経路なので、SW に横取りされるとログイン不要の導線が壊れる
- 2026-09-06 `mock/ai.ts` の内部関数を全部 `mock` 始まりに揃えた。`sourceTitle` が
  `jobs/plan.ts` のプロパティ名とぶつかり、`check-bundle.sh` が本番バンドルで2件見つけて
  **モックが混入していないのに落ちていた**。マーカーは「モックにしか無い」ことで意味を持つので、
  名前の側で衝突しないようにする
- 2026-09-06 スクリーンショットは `scripts/shots.mjs`（ヘッドレス Chrome を CDP で直接動かす）。
  puppeteer / playwright を依存に足さないため。ログインはページ内の `fetch` で済ませる——
  セッション Cookie は `SameSite=Strict` かつ HttpOnly なので、外から注入するより
  同一オリジンで取らせるほうが確実

## M6 独立検証（2026-09-06）

SPEC §13 M6・§5.3・§7.7・§7.9・§9・§10.5・§12.3 Autopilot・§12.4 に対して、実装者とは別の
コンテキストで採点した。**FAIL は0件**。直したのは検証中に見つけた別件の1つだけ（下）。

- 採点（§9.2）… `jobs/score.ts` に AI 呼び出しは無い（`lib/ai.ts` を import していない）。
  48h チェックポイント行のみを使い、分布も 48h 断面。母数10未満は `scored` を付けずに見送る。
  `learning` は4次元を1クエリのマルチ VALUES で積み、`views_sum` / `like_rate_sum` を持つ
- 計画（§9.3 / §9.4）… `n>=10` の枠と型だけを「実績あり」とし、無ければ既定枠と既定順。
  直近3本のローテーション、`quiet_hours`、`daily_limit`、`minGapMin`、ネタ源の7日再使用なし、
  `consecutive_failures` 3で停止、`needs_reauth` とライセンス `revoked` は計画しない、日割り（`postsForDay`）
- `/a/:token`（§5.3 / §7.9）… HMAC-SHA256・定数時間比較・期限・`purpose` 一致。
  GET は消費しない。`publishing|done` は遷移も消費もしない。消費は
  `WHERE action_token_used_at IS NULL` の条件付き UPDATE の `changes` で見る。
  `rate_events` の `action:<ip>` で1分20回。HTML は投稿本文を一切出さない（テンプレは固定文言のみ）ので、
  そもそも XSS の入口が無い。`esc()` も通してある
- 通知（§9.5 / §10.5）… 3方式の通知タイミング、テンプレ7種、本文にアプリのリンク。
  `ap_draft` に入る秘密は `qaction` のワンタイム URL だけで、これは仕様どおり（§7.9）
- ログ… `redact()` / `redactObject()` / `redactEmail()` が入っており、トークンを出す経路は無い。
  `[email:dummy]` の本文出力だけは DEV ビルド限定で、本番（`__DEV__=false`）では枝ごと通らない
- 画面（§12.3 / §12.4）… Autopilot の学習表が `n<10` で「集計中（あと◯本）」、`n>=10` で数値。
  48h の注記あり。ApBar が承認方式ごとの1行を出す。Queue の操作シートに承認/取消。
  SW は `runtimeCaching` を置かず、`navigateFallbackDenylist` で `/api/*` と `/a/*` を外す

**検証中に直したもの（M6 の FAIL ではない）**

- 2026-09-06 `ACCOUNT_COLORS` の先頭を `#4f7cff` から `#2748e8`（アクセント色そのもの）に変え、
  使用中の色との比較を大文字小文字を無視する形にした。`seed-demo` が作るアカウントの色が
  `#2748E8` で、`find(x => used.includes(x))` の素の一致だと「使っていない色」と判定され、
  2件目に**見分けの付かない青**が割り当たっていた（M7 のブラウザ確認で3件並べて気づいた）

---

## M7 実装で決めたこと（2026-09-06）

- 2026-09-06 `DELETE /users/me` の削除順は「アカウントの子テーブル → `accounts` →
  `user_id` を持つ6テーブル → `rate_events` のキー付き行 → `licenses` を revoked →
  `users`」に固定した。対象の列挙は `lib/accounts.ts` の `ACCOUNT_CHILD_TABLES` と
  `routes/users.ts` の `USER_TABLES` の2つだけに置き、テストがその定数を回して
  「1件も残っていない」ことを見る。将来テーブルが増えたとき、定数に足し忘れれば
  テストが素通りしてしまうが、SQL を手で並べるよりは消し残しに気づきやすい
- 2026-09-06 CSV は **UTF-8 BOM ＋ CRLF**。BOM を付けないと日本語 Windows の Excel が
  Shift_JIS と誤認して全部化ける。買い手が最初に開くのはほぼ Excel なので、
  「BOM を嫌う道具もある」より「Excel で開ける」を優先した。
  あわせて `= + - @` で始まるセルの前に `'` を1つ足す（表計算ソフトが式として実行するのを防ぐ）。
  テストは `Response.text()` ではなく**バイト列**で BOM を見る — `text()` は仕様上
  先頭の BOM を落とすので、text で見ると「付けていない」のと区別が付かない
- 2026-09-06 `GET /export/:accountId` の上限は 5,000 行。D1 と CPU を守るためで、
  超えたぶんは古い順に落ちる。全部要る買い手が出たら分割ダウンロードを足す
- 2026-09-06 ライセンスは**末尾4桁と状態だけ**返す（`GET /users/me/license`）。
  キー全体は購入時のメールにあり、画面に出す理由が無い。出せば肩越しに見られる経路が増える
- 2026-09-06 `/ai/test` `/ai/generate` `/ai/revise` に **1分10回**の制限を足した
  （`rate_events` のキー `ai:<user_id>`）。SPEC に窓の指定は無いが、この3つは
  1リクエスト = 買い手の AI キーの課金1回になる。画面から出せるのは「3案」ボタンの
  連打くらいなので手が滑った程度では当たらず、スクリプトで回されたら止まる値にした。
  設定の読み書き（`/ai/settings`）は課金しないので対象外
- 2026-09-06 監査ログは `lib/audit.ts` に1本化し、**書き込みに失敗しても操作を巻き戻さない**
  （try/catch で握る）。監査が書けなかったせいで買い手の操作そのものが 500 になるほうが困る。
  記録するのは SPEC §13 M7 の要所（登録・ログイン・キー変更・退会・承認/取消・AP ON/OFF）に、
  アカウントの接続と削除・書き出し・ライセンスの発行と失効を足したもの。
  `detail` に秘密は入れない（`ai_key_change` は provider と storeOnServer だけ、
  `user_delete` はメールの SHA-256 だけ）
- 2026-09-06 `daily_digest` は **`account_id` を持たないジョブ**にして毎時1本だけ積む。
  `digest_hour` は買い手ごと、timezone はアカウントごと（SPEC §2.4）なので、
  ジョブの中で「その買い手の先頭アカウントの timezone でいまが `digest_hour` か」を見る。
  二重送信は `notifications.last_digest_date`（マイグレーション `0002_m7.sql` で追加）で止め、
  **印を先に立ててからメールを送る** — 送信が失敗した日に何度も送り直すより、
  1日ぶん落とすほうが害が小さい
- 2026-09-06 ダイジェストは**メールだけ**で Push を出さない。急いで知る必要がなく、
  毎朝ロック画面に通知が出るのは邪魔になる。Push は承認・取消・失敗（＝すぐ知りたいもの）だけ

### Web Push の実送信（M6 から送っていた宿題）

- 2026-09-06 **M7 で実装した**（`worker/src/lib/webpush.ts`、外部ライブラリなし）。
  RFC 8292 の VAPID（ES256 JWT）と RFC 8291 の `aes128gcm` を WebCrypto だけで書いた。
  `web-push` は node の crypto 前提で Workers にそのまま載らない
- 鍵導出は `crypto.subtle` の HKDF（`deriveBits`）。RFC 8291 の3箇所の導出はいずれも
  Extract と Expand をセットで使い、Extract 単体の PRK を取り出す場面が無いので、
  HMAC で手書きせずに済む。長さは常に32バイト以下（SHA-256 の1ラウンド）で、
  超える用途が出たら気づけるよう assert を置いた
- ES256 の署名は `crypto.subtle.sign` が返す **raw r‖s（64バイト）をそのまま** base64url に
  する。JWT の ES256 はこの形。`web-push` が DER を剥がしているのは node crypto の都合
- `@cloudflare/workers-types` が ECDH の `deriveBits` の `public` を `$public` と綴っており、
  素直に書くと型エラーになる。`ecdhAlgorithm()` ヘルパ1箇所にキャストを閉じ込めた
- **Push に承認/取消のワンタイム URL は入れない**。通知はロック画面にも出るし、
  押すだけで確定できるリンクを通知の中に置く必要が無い。Push はアプリのキュー画面へ
  誘導するだけにして、実際の操作はアプリかメールのリンクで行わせる
- 404/410 が返った購読は**その場で行を消す**（RFC 8030 §7.3）。それ以外の失敗は
  `push_subscriptions.fail_count` を数え、5回続いたら送信の対象から外す（`0002_m7.sql`）
- `VAPID_SUBJECT`（RFC 8292 の `sub`）は `mailto:` か `https:` でなければならない。
  空なら `APP_ORIGIN` で代用するが、開発の `http://localhost:5173` はどちらでもないので、
  **有効な連絡先が無いときは送らない**（例外にしない。メールは別経路で届く）
- Service Worker の `push` / `notificationclick` ハンドラは `web/public/push-sw.js` に置き、
  `vite-plugin-pwa` の `workbox.importScripts` で生成 SW に足す。`injectManifest` に
  切り替えると precache の面倒を全部こちらで持つことになり、ハンドラ2つのために払う代償として重すぎる
- テストは**暗号の往復と JWT の形まで**。実際の Push サービス（FCM / Mozilla / Apple）へは送らない。
  受理されるかどうかは README「既知の制限」#8 に残した

### チャンク分け（M6 から送っていた宿題）

- 2026-09-06 `manualChunks` で recharts（＋ d3-*）を `charts` に、react / react-dom / scheduler を
  `react` に分け、あわせてログイン後の画面を `React.lazy` にした。
  ログイン画面を出すだけでホームのグラフのコード（gzip 108KB）まで落とすのを避けるため。
  結果、初回 JS は `index` 66.4KB + `react` 46.0KB = **約112KB（gzip）**。ホームに入って
  `charts` を足しても約224KB で、300KB の目安の内側

### 画面まわり

- 2026-09-06 CSV のダウンロードは `<a href>` の直踏みではなく **`fetch` → Blob → `a.download`**。
  Cookie 付きの GET でも、iOS Safari が `Content-Disposition` のファイル名を拾い損ねることがある。
  `URL.revokeObjectURL` は10秒待ってから呼ぶ（すぐ消すと Safari がダウンロードを始める前に落ちる）
- 2026-09-06 退会は「確認シート ＋ パスワードの再入力」の二段。セッションが盗まれていても
  一発でデータを消せないようにする（SPEC §7.8 の「パスワード再確認」の実装）。
  成功後は `window.location.href = "/login"` で読み込み直す — 認証はもう無いので、
  React Query のキャッシュを持ち越さない
- 2026-09-06 診断は「押したら走る」ミューテーションにして、開いた時点で1回だけ自動実行する。
  6段のうち後半は実際に Threads API を叩くので、画面を開くたびに毎回走らせない

---

## M7 独立検証（2026-09-06）

SPEC §5.4・§7.1・§7.8・§8.7・§12.3 Settings・§13 M7・§15 に対して、実装者とは別の
コンテキストで採点した。**採点11項目のうち FAIL は1件**（監査ログ）。直したものは下記。

- ビルド… `typecheck` / `test`（shared 85・worker 376）/ `build` / `check:bundle`（モック0件、
  本番エントリと一時エントリの両方）/ `wrangler deploy --dry-run` すべて成功。
  初回 JS は `index` 66.4KB + `react` 46.0KB = 112.4KB（gzip）で目安 300KB の内側
- 複数アカウント… 3アカウント × 3リソース（dashboard の投稿と表示回数 / queue / autopilot の設定）で
  分離を確認。4件目は `ACCOUNT_LIMIT`
- 退会… 削除順は「子テーブル → `accounts` → `user_id` の6テーブル → `rate_events` →
  `licenses` を revoked（`user_id=NULL`）→ `users`」。スキーマに `FOREIGN KEY` は1つも無いので
  外部キー違反は起こり得ないが、順序自体は子から親で安全。`ACCOUNT_CHILD_TABLES` は
  SPEC §7.1 の13テーブル（`click_weeks_done` を含む）と一致
- CSV… 実際に `GET /api/export/:id` を叩いて確認。先頭3バイト `EF BB BF`、CRLF、21列、
  `= + - @`（＋タブ・CR）始まりに `'` を足す、他人の accountId は 404、上限は
  `ORDER BY posted_at DESC LIMIT 5000`（超過分は古い順に落ちる。買い手への通知は無い）
- Web Push… **RFC 8291 §5 の公式テストベクタで独立に検証した**。既存の webpush.test.ts は
  自前の暗号化と自前の復号の往復なので、`info` 文字列やヘッダの並びを両方同じように
  間違えていても通ってしまう。RFC の暗号文をそのまま復号できることを見る1本を足した
  （`worker/test/webpush-rfc8291-vector.test.ts`）。VAPID の `aud`（endpoint の origin）・
  `exp`（12時間 ≤ 24時間）・`sub`（mailto:/https: を強制）、`vapid t=…, k=…`、
  404/410 での購読削除、Push 本文にワンタイム URL を入れないことも確認
- レート制限… `/ai/generate|revise|test` は `rate_events` の `ai:<user_id>` で1分10回。11回目が 429
- セキュリティ… `accountId` を取る29ルートすべてが `loadOwnedAccount` を通る。
  `sources` は `WHERE id=? AND user_id=?`。`console.*` は全て `redact()` / `redactEmail()` 経由
  （`[email:dummy]` の全文出力だけは `!DEV` で先に return するので本番では到達しない）。
  `dangerouslySetInnerHTML` は0件。`index.ts` が D1 に触らせるのは `/api/*` と `/a/*` だけ。
  `.dev.vars` は `.gitignore` 済みで、履歴に実キーは無い（`THAA` / `sk-` / `AIza` / `re_` の
  ヒットは `redact.ts` のパターンとモック用の `THAAdemo` だけ）

**FAIL と修正**

- 2026-09-06 **監査ログの `account_connect` と `license_issue` が実装されていなかった**。
  `docs/qa.md` M7-7 の表と DECISIONS「M7 実装で決めたこと」は「アカウントの接続」「ライセンスの発行」も
  記録すると書いており、`AuditAction` 型にも名前があるのに、書き込む側が無かった
  （買い手の手元で QA チェックリストを上から追うと、この行だけ空になる）。
  `POST /accounts` と `POST /admin/licenses` に追加し、テストで表の `action` を全件見るようにした。
  `license_issue` の `detail` にキー本体は入れない — 監査ログを読める経路がそのまま在庫の流出になるため

**検証中に直したもの（M7 の FAIL ではない）**

- 2026-09-06 `wrangler.toml` の `[vars]` に `MAIL_FROM` が無かった。README「本番へのデプロイ」の
  `[vars]` の表には載っているので、手順どおりに読むと「書き換える行が無い」。行を足したうえで、
  `lib/email.ts` の既定値の判定を `??` から「空文字も未設定として扱う」に変えた
  （`[vars]` は値を空文字で持つので、`??` だと空の差出人がそのまま Resend に行く）
- 2026-09-06 `audit_log.detail` の形を JSON にそろえた。`account_delete` と `license_revoke` だけが
  生の ID 文字列を入れており、`SELECT detail` を読むときに形が混ざっていた

**残していること（FAIL ではないが把握しておく）**

- `AuditAction` の `logout` と `account_refresh_token` は定義だけで書き込みが無い。
  どちらも SPEC §13 M7 の要所にも qa.md の表にも無いので足していない
- 退会は `audit_log` の過去行（その買い手の `login` / `export` 等）を消さない。SPEC §7.8 の
  削除対象の表に `audit_log` は入っておらず、残る行に PII は無い（`login` は UA だけ）
- CSV の 5,000 行上限に達したことは買い手に伝わらない。DECISIONS 済みの判断なので変えていない
