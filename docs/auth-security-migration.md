# 認証情報の保存形式変更

## 変更内容

新規セッションは32バイトのランダムな Cookie 値を発行し、D1 `sessions.id` にはその SHA-256 ダイジェストだけを保存する。OAuth state と Push の `session_id` は、この内部 ID を参照する。Cookie は従来どおり HttpOnly / Secure / SameSite=Strict、有効期間30日。

旧形式の UUID Cookie は新コードでは受け付けない。一括で DB や Push 登録を削除せず、旧行は既存の期限切れクリーンアップに任せる。旧行が残っていることは旧 Cookie が認証に使えることを意味しない。Push 送信も新形式の有効セッションに限定する。利用者は更新後に再ログインし、必要な端末で Push を再登録する。

パスワードは従来の PBKDF2-SHA256（100,000回・16バイトのランダム salt）に、専用の `PASSWORD_PEPPER` を鍵にした HMAC-SHA256 を追加した。DB には `pbkdf2-sha256$100000$hmac-sha256$v1$` と最終ダイジェストを保存する。PBKDF2 の中間出力や pepper は保存・返却しない。

既存のパスワードはそのまま使える。旧ハッシュは成功したログインでのみ、既存 PBKDF2 出力を利用して追加の重い KDF 計算なしに新形式へ移行する。更新条件に元のハッシュと salt を含めるため、並行したパスワード変更を上書きしない。セッション発行も検証したパスワードがまだ現在の値であることを D1 の単一 INSERT で確認する。新規登録・PW変更・再設定は初めから新形式で保存する。

## Secret とリリース手順

1. ローカル・ステージング・本番それぞれに、暗号学的乱数32バイト以上から独立した `PASSWORD_PEPPER` を生成する。
2. Cloudflare Secret に登録する。`ENC_KEY` や `SESSION_SECRET` は流用しない。D1・Git・フロントエンド環境変数には保存しない。
3. Secret の外部バックアップを既存の暗号化キーと同様に保管する。D1 のバックアップだけでは新パスワード照合を復旧できない。
4. ステージングにリリースし、既存PWログイン・設定のPW変更・再ログインを確認する。本番では次回アクセス時に再ログインが必要になる。
5. 旧セッション照合コードへのロールバックを避ける。旧 DB 行が残る期間に旧コードへ戻すと旧 Cookie を再び受け付け、pepper 付き PW を読めなくなる。緊急修正時も新しい認証コードを維持する。

SQL スキーマ変更や一括データ削除は不要。PWのpepperを単純に変更すると既存PWが照合できなくなる。漏洩・紛失時は新secretを用意し、既存のメールによるPW再設定を利用する。PW reset の署名は引き続き `SESSION_SECRET` で行う。

## 保証の範囲

新形式へ移行したハッシュは、D1だけが漏洩した場合のオフライン推測に対する追加保護を持つ。未ログインの旧ハッシュ、以前のDBバックアップにはその保護がない。DBとpepperの両方が漏洩した場合やWorker自体が侵害された場合まで防げるものではない。

PBKDF2 の反復回数は100,000回のまま。既存の無料環境のKDF負荷を増やさずDB漏洩耐性を改善する判断であり、OWASPが示すPBKDF2-SHA256の600,000回に相当するとは主張しない。現行Cloudflare Web Crypto公式ページには100,000回というハード上限の記載を確認できないため、その上限を保証の根拠にはしていない。より強いKDFや外部の認証サービスへの移行は、対象プランでのCPU計測と合わせて評価する。

参考: [OWASP Password Storage（post-hashing peppers / work factor）](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)、[Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。

## 検証

`npm run typecheck` および認証・Cookie・PW変更・Google/Threads OAuth・関連セキュリティの9テストファイル97ケースを通過。旧PWの固定ベクトル、失敗ログイン時の未変更、成功時の自動移行、旧PW変更・再設定、DBから漏れたセッションIDの利用拒否、既存UUID Cookie拒否、OAuth FK、失効、並行PW変更後のセッション発行拒否を含む。

実Threads投稿や実メール配送は行っていない。本番でのCPU使用量、実ブラウザの認証導線、デプロイ後のCronは別の運用確認事項。
