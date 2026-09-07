# ステージング専用Threadsアカウントの初回接続

初回のOAuth接続では、まだ数値のThreadsユーザーIDが分からないため、`STAGING_THREADS_USER_ID` が空の場合に限り `STAGING_THREADS_USERNAME` を照合できる。今回の指定は `yama_threads.sub`。

- 入力されたユーザー名ではなく、アクセストークンで取得したThreadsのプロフィールのユーザー名を完全一致で照合する。前後の空白、先頭の `@`、大文字小文字だけを正規化する。
- IDとユーザー名が両方未設定なら、Threads APIを呼ぶ前に409で拒否する。プロフィールが不一致なら、アカウント・トークン・同期ジョブを保存する前に403で拒否する。
- `STAGING_THREADS_USER_ID` が設定されていればIDのみで判断する。ユーザー名が一致しても別IDは接続できない。

## 接続後の固定

1. 指定したテストアカウントでステージングのOAuth接続を完了する。
2. 保存されたアカウントの `threads_user_id` を確認し、`wrangler.staging.toml` の `STAGING_THREADS_USER_ID` に数値IDを設定する。
3. `STAGING_THREADS_USERNAME` を空にし、ステージングへ再デプロイする。

ユーザー名は変更・再利用される可能性があるため、名前での照合は初回接続のための一時設定とする。ID固定後は同じテストアカウントが改名しても接続できる。

この設定は投稿許可ではない。ステージングのThreads POST/DELETE拒否、メール送信停止、Cronの監視専用動作はそのまま維持する。本番設定への追加は不要。

## Bootstrap completed (2026-09-08 JST)

The browser OAuth flow authenticated `yama_threads.sub` as Threads user `28121200714239994`. Staging now pins that immutable ID and clears the username fallback. Initial synchronization completed with 445 posts and the profile avatar present. The stage remains unable to publish or send email.
