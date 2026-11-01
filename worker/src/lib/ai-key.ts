/**
 * サーバーに保存された AI キーを1か所で解決する（SPEC §10.1「キーの所在」）。
 * ジョブ（`note_write`）とルート（`/notes`）で共用する。復号した値は生成に渡すだけで、
 * ログにもレスポンスにも出さない（SPEC §5.2）。
 */
import type { AiProvider } from "@tap/shared";
import type { Env } from "../env";
import { AiError, resolveModel } from "./ai";
import { decrypt } from "./crypto";
import type { Db } from "./db";

export type ResolvedAiKey = { provider: AiProvider; model: string; apiKey: string };

export async function resolveServerKey(env: Env, db: Db, userId: string): Promise<ResolvedAiKey> {
  const row = await db.first<{ provider: string; key_enc: string | null; model: string | null; store_on_server: number }>(
    "SELECT provider, key_enc, model, store_on_server FROM ai_settings WHERE user_id=?",
    userId,
  );
  if (!row || !row.store_on_server || !row.key_enc) {
    throw new AiError("AI_KEY_REQUIRED", "AIキーが設定されていません。設定から登録してください");
  }
  return {
    provider: "gemini",
    model: resolveModel(row.model),
    apiKey: await decrypt(row.key_enc, env.ENC_KEY),
  };
}
