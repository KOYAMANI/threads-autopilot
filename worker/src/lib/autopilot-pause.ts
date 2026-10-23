import type { Env } from "../env";

/**
 * オートパイロット（自動作成と自動投稿）を動かしてよいか。`AUTOPILOT_RUNNING=1` のときだけ動く。
 * 画面の入口を閉じても裏の処理が動き続けていたので、本番とステージングでは設定しない（DECISIONS 2026-10-23）。
 */
export function autopilotRunning(env: Env): boolean {
  return env.AUTOPILOT_RUNNING === "1";
}

export const AUTOPILOT_PAUSED_MESSAGE = "自動作成は停止中です";
