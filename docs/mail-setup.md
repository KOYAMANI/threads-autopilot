# 本番メール設定

送信元: `Threads オートパイロット <info@yama-threads.com>`（ユーザー指定）。
Resendは `yutaro.koyama93@gmail.com` のGoogleログインで初期設定を実施。
ドメインID: `d285837a-77c0-490a-98da-f0ebf5de05d8`、リージョンTokyo。

## DNS認証レコード（2026-09-07）

編集先はお名前.com Navi → お名前メール → yama-threads.comの契約 → ログイン → ドメイン → DNS。
通常のレンタルサーバー契約側にはこのドメインがないため、そこで追加しない。

| 種別 | 名前 | 値 |
|---|---|---|
| TXT | resend._domainkey | p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC3TfkaNnYqw44AMUVTyJFl/4KgGZJAfg/xuOwOJndivI3c4Dwk2Rvb/6LGJZzD3FxrR3t3V6ql6R1GcAPXXy/csJDyOr6CmQXxS7erf4hCZ0/SQke610QhZFn33KaympGfOyWo0vXLNrwIjxI2vJ0N1PlpsCKij4xPCIRWBmB0ZQIDAQAB |
| CNAME | rsend | rsend-apne1.forge.rmta.net |
| CNAME | send | send.forge.rmta.net |

上記はResend画面で指定された公開DNS用の値（秘密鍵ではない）。TXTの引用符は入力不要。TTLは提供元の標準値を利用する。
既存の同名TXT/CNAMEは公開DNS照会で見つからなかった。保存前にDNS管理画面でも確認する。

維持する既存設定:

- NS: ns-rs1.gmoserver.jp / ns-rs2.gmoserver.jp
- MX: 10 mail1015.onamae.ne.jp
- ルートTXT: v=spf1 include:_spf.onamae.ne.jp ~all

ResendのReceivingはオフ。任意のDMARC設定は既存送信への影響を別途検討し、今回必須3件に含めない。
DNS保存後に公開DNSの一致とResendのVerified表示を確認する。
その後、このドメインの送信だけに限定したAPIキーを作成し、Cloudflare WorkerのRESEND_API_KEY Secretへ登録する。
実メール送信は未実施。送信元設定を入力済みでも、ドメイン認証の成功を確認してから本番公開する。

## 最新の進捗（2026-09-07 完了）

必須3件（DKIM TXT、rsend CNAME、send CNAME）はお名前メールのDNS管理画面で保存済み。既存のMX・SPF・DKIMは維持した。権威DNS ns-rs1.gmoserver.jp と公開リゾルバー 1.1.1.1 の両方から値の一致を確認し、Resendのドメイン表示が Verified（Domain verified / ready to send emails）になったことを確認済み。

`threads-autopilot-production` キーを Sending access、yama-threads.com ドメイン限定で作成した。キーIDは `736dd506-77b7-4561-b1ff-3a4de0830623`。秘密値を出力せず、UIのコピー・貼り付けでCloudflare Workerの `RESEND_API_KEY`（Secret型）へ登録済み。ブラウザのパスワード保存は行わず、作業後クリップボードを公開URLへ置き換えた。

Wranglerで4つのSecret名を確認し、`npm run deploy:production` の事前チェックと本番デプロイが成功した。実メールの配送テストは未実施。ドメイン認証・Secret登録済みであることと、受信箱への実際の到着を確認したことは区別する。
