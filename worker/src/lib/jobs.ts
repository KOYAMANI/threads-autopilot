/**
 * ジョブ実行の入口（SPEC §8.1）。本体は M2 で実装する。
 * M1 では scheduled ハンドラから呼べる空実装だけ置く。
 */
import type { Env } from "../env";
import { budgetFromEnv, type Budget } from "./budget";
import { createDb, type Db } from "./db";

export type JobContext = { env: Env; db: Db; budget: Budget; now: Date };

export function createJobContext(env: Env, now = new Date()): JobContext {
  const budget = budgetFromEnv(env);
  return { env, db: createDb(env.DB, budget), budget, now };
}

/**
 * 期限到来のジョブを優先度順に処理する。
 * M2 で jobs テーブルの取り出し・ステップ実行・持ち越しを実装する（SPEC §8.1〜§8.7）。
 */
export async function runJobs(_ctx: JobContext): Promise<{ processed: number }> {
  // M2 で実装。いまは何もしないで返す。
  return { processed: 0 };
}

/**
 * cron に応じてジョブを投入する（SPEC §8.2）。M2 で実装。
 */
export async function enqueueForCron(_ctx: JobContext, _cron: string): Promise<void> {
  // M2 で実装。
}
