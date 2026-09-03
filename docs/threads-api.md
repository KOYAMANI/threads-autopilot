# Threads API 全エンドポイント整理（2026年8月時点）

出典: Meta for Developers 公式ドキュメント（developers.facebook.com/documentation/threads）
ベースURL: `https://graph.threads.com/v1.0/` または `https://graph.threads.net/v1.0/`（どちらでも可）

---

## 0. 全体像（できること／できないこと）

| 分類 | できる | できない（API未提供） |
|---|---|---|
| 読む | 自分の投稿・返信・メンション、投稿ごとの数字、アカウント全体の数字、URLごとのクリック数 | 他人の投稿ごとの数字、保存数、プロフィール遷移数、投稿ごとのクリック数、フォロワー一覧 |
| 書く | 投稿（テキスト/画像/動画/カルーセル）、返信、引用、リポスト、削除、返信の非表示、承認待ち返信の管理 | DM送信（DM APIなし）、いいね、フォロー/フォロー解除、投稿の編集 |
| 探す | 公開投稿のキーワード/タグ検索、公開プロフィールの取得 ※要App Review | フォロワーの検索、DMの読み取り |
| 通知 | Webhook（返信・メンション・公開・削除） ※要App Review＋ビジネス認証 | — |

---

## 1. 認証（トークン）

| メソッド / パス | 用途 | 備考 |
|---|---|---|
| `GET https://threads.net/oauth/authorize` | 認可画面へ誘導 | `client_id`, `redirect_uri`, `scope`, `response_type=code` |
| `POST /oauth/access_token` | 認可コード → 短期トークン（約1時間） | 2026-08-12から `token_type` も返る |
| `GET /access_token?grant_type=th_exchange_token` | 短期 → 長期トークン（60日） | `client_secret` が必要 |
| `GET /refresh_access_token?grant_type=th_refresh_token` | 長期トークンの延長 | 発行から24時間以上経過が条件。期限切れ前に呼ぶ |
| `GET /debug_token` | トークンの有効期限・権限を確認 | 2025-06追加 |
| App Access Token | アプリ単位のトークン | oEmbed等で使用（oEmbedは2026-03からトークン不要に） |

**配布型ツール（GAS等）での現実解:** 買い手が自分のMetaアプリを作り「Threadsテスター」として自分を登録 → ダッシュボードの「アクセストークンを生成」で取得。OAuthフロー不要。

---

## 2. 権限（スコープ）一覧

| 権限 | 何ができるか | Standard Access（自分のアプリ内）で使えるか |
|---|---|---|
| `threads_basic` | 全ての呼び出しの前提。プロフィール・自分の投稿取得 | ○ |
| `threads_content_publish` | 投稿・返信・引用・リポストの作成 | ○ |
| `threads_manage_insights` | インサイト取得（投稿・アカウント・クリック） | ○ |
| `threads_read_replies` | 返信の読み取り | ○ |
| `threads_manage_replies` | 返信の非表示/表示、返信制御、承認待ち管理 | ○ |
| `threads_manage_mentions` | メンションされた投稿の取得 | ○ |
| `threads_delete` | 投稿削除 | ○ |
| `threads_location_tagging` | 位置情報タグ | ○ |
| `threads_share_to_instagram` | InstagramストーリーズへのクロスシェアA | ○ |
| `threads_keyword_search` | 公開投稿のキーワード検索 | **× App Review（Advanced Access）が必要** |
| `threads_profile_discovery` | 他人の公開プロフィール・投稿の取得 | **× App Review が必要** |
| Webhooks | リアルタイム通知 | **× Advanced Access＋ビジネス認証が必要** |

→ 「自分のアカウントに対する読み書き」はテスター登録だけで全部使える。「他人のデータ」「リアルタイム通知」は審査が要るので、配布型ツールでは事実上使えない。

---

## 3. 投稿（Publishing）

### 3-1. `POST /{user-id}/threads` — メディアコンテナ作成

| パラメータ | 内容 |
|---|---|
| `media_type` | **必須** `TEXT` / `IMAGE` / `VIDEO` / `CAROUSEL` |
| `text` | 本文（500文字上限。絵文字はUTF-8バイト数で数える） |
| `image_url` / `video_url` | 画像・動画は公開URLで渡す（ファイル直接アップロード不可） |
| `children` | カルーセル用。2〜20個の子コンテナID |
| `is_carousel_item` | 子コンテナ作成時に `true` |
| `reply_to_id` | **返信として投稿**（ツリーの2投稿目以降はこれ） |
| `reply_control` | 誰が返信できるか: `everyone` / `accounts_you_follow` / `mentioned_only` / `parent_post_author_only` / `followers_only` |
| `quote_post_id` | 引用投稿 |
| `link_attachment` | リンクカードを付ける |
| `topic_tag` | トピックタグ（`.` と `&` は不可） |
| `poll_attachment` | アンケート |
| `gif_attachment` | GIF（GIPHYのみ。Tenorは2026-03廃止） |
| `text_attachment` | テキスト添付（長文用） |
| `is_spoiler_media` / `text_entities` | ネタバレ表示 |
| `is_ghost_post` | ゴーストポスト（24時間で自動アーカイブ） |
| `enable_reply_approvals` | **返信承認制**にする（2026-02追加） |
| `alt_text` | 代替テキスト（1,000文字まで） |
| `allowlisted_country_codes` | 表示国を制限 |
| `location_id` | 位置情報タグ |
| `crossreshare_to_ig` / `crossreshare_to_ig_dark_mode` | Instagramストーリーズへ同時投稿 |
| `auto_publish_text` | **テキスト投稿はこれを付けると1ステップで公開**（publishステップ不要） |

### 3-2. `POST /{user-id}/threads_publish` — コンテナを公開
`creation_id` にコンテナIDを渡す。画像・動画はコンテナ作成後、処理完了を待ってから呼ぶ（推奨30秒程度待つか、下のstatusで確認）。

### 3-3. `GET /{container-id}?fields=status,error_message` — コンテナの状態確認
`status` は `IN_PROGRESS` / `FINISHED` / `ERROR` / `EXPIRED` / `PUBLISHED`。

### 3-4. その他
| メソッド / パス | 用途 |
|---|---|
| `POST /{media-id}/repost` | リポスト |
| `DELETE /{media-id}` | 削除（100件/24h） |
| `GET /{user-id}/threads_publishing_limit` | 残りクォータ確認（`quota_usage`, `reply_quota_usage`, `delete_quota_usage`, `location_search_quota_usage`） |

### 3-5. 制限
- 投稿: **250件/24時間**（カルーセルは1件扱い）
- 返信: **1,000件/24時間**
- 削除: 100件/24時間
- 本文: 500文字
- **1投稿にリンクは5つまで**（超えると `THREADS_API__LINK_LIMIT_EXCEEDED`）
- 画像: JPEG/PNG、8MB、幅320〜1440px
- 動画: MP4/MOV、5分以内、1GB以内

### 3-6. ツリー投稿の作り方（重要）
```
1. POST /threads  media_type=TEXT&text=本文&auto_publish_text=true  → 1投稿目のID
2. POST /threads  media_type=TEXT&text=リンク付きコメント&reply_to_id=<1投稿目のID>&auto_publish_text=true
3. （必要なら）reply_to_id=<2投稿目のID> で3投稿目
```
Threadsアフィリの定番「本文は投稿、リンクはコメント欄」がAPIで完全に再現できる。

---

## 4. 投稿の取得（Media Retrieval / User）

### 4-1. `GET /{user-id}/threads` — 自分の投稿一覧
- パラメータ: `fields`, `since`, `until`, `limit`（最大100）, `before` / `after`（カーソル）
- **返信（ツリーの2投稿目以降）はここに含まれない** → `GET /me/replies` で別途取る
- 他人のリポスト（`REPOST_FACADE`）は含まれるが数字は空

### 4-2. `GET /{media-id}` — 投稿1件の詳細
取れるフィールド:
`id, media_product_type, media_type, media_url, permalink, owner, username, text, timestamp, shortcode, thumbnail_url, children, is_quote_post, alt_text, link_attachment_url, has_replies, is_reply, is_reply_owned_by_me, root_post, replied_to, hide_status, reply_audience, quoted_post, reposted_post, gif_url, poll_attachment, topic_tag, is_spoiler_media, text_entities, text_attachment, location_id`

`media_type` の値: `TEXT_POST` / `IMAGE` / `VIDEO` / `CAROUSEL_ALBUM` / `AUDIO` / `REPOST_FACADE`

### 4-3. `GET /{user-id}?fields=...` — プロフィール
`id, username, name, threads_profile_picture_url, threads_biography, is_verified`

### 4-4. `GET /{user-id}/mentions` — 自分がメンションされた投稿
`threads_manage_mentions` 権限。他人が自分を@した投稿を一覧で取れる。

### 4-5. 公開プロフィールの取得（要 App Review）
| パス | 用途 |
|---|---|
| `GET /profile_lookup?username=xxx` | 他人の公開プロフィール |
| `GET /profile_posts?username=xxx` | 他人の公開投稿一覧 |
※ 対象アカウントのフォロワーが100人以上必要（2025-11に1,000→100に緩和）

### 4-6. `GET /keyword_search` — 公開投稿検索（要 App Review）
- `q`（必須）, `search_type`（`TOP`/`RECENT`）, `search_mode`（`KEYWORD`/`TAG`）, `media_type`, `since`, `until`, `limit`, `author_username`
- 500回/7日

---

## 5. 返信の取得・管理（Reply Management）

| メソッド / パス | 用途 | 備考 |
|---|---|---|
| `GET /{media-id}/replies` | その投稿への**直接の返信**一覧 | `reverse` で並び順切替 |
| `GET /{media-id}/conversation` | その投稿への**全返信（ネスト含む）を平坦化** | ツリー全体を一気に取れる |
| `GET /me/replies` | **自分が書いた返信**の全一覧 | ツリー投稿の2投稿目以降はここから拾う |
| `POST /{reply-id}/manage_reply` | `hide=true/false` で返信を非表示/再表示 | 他人の返信に対して |
| 承認待ち返信の取得・承認/無視 | `enable_reply_approvals=true` で作った投稿の返信を管理 | 2026-02追加。Reply Approvalsセクション参照 |

返信オブジェクトで取れる主なフィールド:
`id, text, username, permalink, timestamp, media_type, media_url, shortcode, thumbnail_url, children, is_quote_post, has_replies, root_post, replied_to, is_reply, is_reply_owned_by_me, hide_status, reply_audience, is_verified, profile_picture_url`

`hide_status` の値: `NOT_HUSHED` / `UNHUSHED` / `HIDDEN` / `COVERED` / `BLOCKED` / `RESTRICTED`

**`is_reply_owned_by_me`** で「自分の返信か他人の返信か」を判別できる → 「未返信のコメント」の抽出が可能。

---

## 6. インサイト（Insights）

### 6-1. `GET /{media-id}/insights?metric=...` — 投稿ごと
| メトリクス | 内容 |
|---|---|
| `views` | 表示回数（開発中扱い） |
| `likes` | いいね |
| `replies` | 返信数（ルート投稿なら全返信、返信なら直接返信のみ） |
| `reposts` | リポスト数 |
| `quotes` | 引用数 |
| `shares` | シェア数（開発中扱い） |

※ **`clicks` は投稿単位では取れない**。リポスト（REPOST_FACADE）は空配列。ネストした返信の数字は含まない。

### 6-2. `GET /{user-id}/threads_insights?metric=...&since=&until=` — アカウント単位
| メトリクス | 型 | 内容 |
|---|---|---|
| `views` | 時系列（日別） | プロフィール全体の表示回数 |
| `likes` / `replies` / `reposts` / `quotes` | 合計値 | 期間内の合計 |
| `clicks` | **URL別合計** (`link_total_values`) | **シェアしたURLごとのクリック数** |
| `followers_count` | 合計値 | 現在のフォロワー数（since/until不可） |
| `follower_demographics` | 合計値 | `breakdown=country/city/age/gender`。フォロワー100人以上必要 |

制約:
- `since`/`until` 省略時は「昨日〜今日」の2日分だけ
- 最古は Unix `1712991600`（2024-04-13）
- 長期間をまとめて頼むと古い側しか返らないことがある → 週単位で区切る（既存ツールが実測済み）

---

## 7. Webhooks（要 Advanced Access）

| トピック | フィールド | 内容 | 必要権限 |
|---|---|---|---|
| moderate | `replies` | 自分の投稿への返信 | `threads_basic`, `threads_read_replies` |
| moderate | `delete` | 自分の投稿の削除 | `threads_basic`, `threads_delete` |
| interaction | `mentions` | 自分へのメンション | `threads_basic`, `threads_manage_mentions` |
| interaction | `publish` | 自分の投稿の公開 | `threads_basic` |

条件: App Review通過（Advanced Access）＋接続ビジネスの認証。非公開アカウントの投稿では発火しない。
→ **配布型ツールでは非現実的。GASの時間トリガーでポーリングする方が確実。**

---

## 8. その他

| 機能 | パス / URL | 備考 |
|---|---|---|
| 位置情報検索 | `GET /location_search?q=...` | 500回/24h |
| 位置情報取得 | `GET /{location-id}` | |
| oEmbed | `GET /oembed?url=...` | 2026-03からトークン不要 |
| Web Intents | `https://www.threads.net/intent/post?text=...` | 投稿画面を開くだけ（API不要）。`tag`, `reply_control`, 返信・引用用パラメータも追加済 |
| | `https://www.threads.net/intent/follow?username=...` | フォロー画面を開く |

---

## 9. API呼び出し回数の制限
```
24時間あたりの呼び出し上限 = 4800 × インプレッション数
```
インプレッション数 = 過去24時間にそのアカウントのコンテンツが表示された回数（最低10として計算）。
→ 表示回数が少ないアカウントほど上限が低い（最低 48,000回/日）。普通の運用では当たらないが、投稿数千件を毎時全件取得するような設計は避ける。

---

## 10. 主な変更履歴（ツール設計に影響するもの）

| 日付 | 内容 |
|---|---|
| 2026-03-25 | Instagramストーリーズへのクロスシェア |
| 2026-03-03 | oEmbedがトークン不要に |
| 2026-02-27 | GIFはGIPHYのみ（Tenor廃止） |
| 2026-02-13 | **返信承認制＋承認待ち返信の管理** |
| 2026-01-30 | Instagram未連携アカウントでも `followers_count` / `follower_demographics` 取得可 |
| 2026-01-20 | キーワード検索を投稿者名で絞り込み可 |
| 2025-12-22 | **1投稿のリンク5つ上限** |
| 2025-12-15 | ゴーストポスト |
| 2025-11-20 | プロフィール発見のフォロワー条件 1,000→100 |
| 2025-09-23 | Instagram未連携アカウントでもAPI利用可 |
| 2025-08-15 | publish Webhook |
| 2025-07-14 | プロフィール発見、トピックタグ、タグ検索 |
| 2025-07-02 | **`clicks` メトリクス追加** |
| 2025-06-04 | `auto_publish_text`、`debug_token` |
| 2025-04-14 | アンケート |
| 2025-03-06 | 投稿削除 |
| 2024-12-09 | キーワード検索、メンション、oEmbed |
| 2024-10-09 | 引用・リポスト |
| 2024-08-05 | `GET /me/replies` |
| 2024-06-18 | 一般公開 |
