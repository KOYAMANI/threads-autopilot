/**
 * 監査ログ（`audit_log`、SPEC §4 / §7.8）。
 *
 * 記録するのは「あとで説明を求められる操作」だけ。SPEC §13 M7 が挙げる要所に揃える:
 * 登録・ログイン・キー変更・退会・承認/取消・オートパイロットの ON/OFF、
 * それにアカウントの接続と削除、ライセンスの発行と失効。
 *
 * **秘密は入れない**。キーやトークンそのものは書かず、「変えた」という事実と
 * 差し障りのない識別子（アカウントID・キューID・プロバイダ名）だけを `detail` に置く。
 * メールアドレスは退会のときだけ SHA-256 のハッシュで残す（平文は残さない。SPEC §7.8）。
 */
import type { Db } from "./db";

/** 記録する操作の名前。増やすときはここに足す（表記ゆれを防ぐため）。 */
export type AuditAction =
  | "register"
  | "login"
  | "logout"
  | "password_reset"
  | "ai_key_change"
  | "account_connect"
  | "account_delete"
  | "account_refresh_token"
  | "queue.approve"
  | "queue.cancel"
  | "queue.approve.email"
  | "queue.cancel.email"
  | "autopilot.on"
  | "autopilot.off"
  | "user_delete"
  | "export"
  | "license_issue"
  | "license_revoke";

/**
 * 1件記録する。**失敗しても呼び出し元の処理は止めない** — 監査の書き込みが
 * こけたせいで、買い手の操作そのものが 500 になるほうが困る。
 */
export async function audit(
  db: Db,
  userId: string | null,
  action: AuditAction,
  detail?: Record<string, unknown>,
  now = new Date(),
): Promise<void> {
  try {
    await db.run(
      "INSERT INTO audit_log (id, user_id, at, action, detail) VALUES (?,?,?,?,?)",
      crypto.randomUUID(),
      userId,
      now.toISOString(),
      action,
      detail === undefined ? null : JSON.stringify(detail),
    );
  } catch {
    /* 監査の書き込み失敗で操作を巻き戻さない */
  }
}
