import { betaPublishingActive } from "./staging-beta-policy";
/** Arrival/dispatch evidence, not a claim that asynchronous account jobs finished. */
import { reviewPublishingActive } from "./staging-review-policy";
import type { Env } from "../env";
import { createBudget } from "./budget";
import { createDb, type Db } from "./db";

export const SCHEDULER_MONITOR_DB_QUERIES = 3;
const MINUTELY = "* * * * *";
const PRODUCTION_CRONS = [MINUTELY, "0 * * * *", "0 18 * * *"] as const;
export type SchedulerOutcome = "success" | "error" | "paused";

type SchedulerRow = {
  cron: string;
  last_scheduled_at: string;
  last_started_at: string;
  last_finished_at: string | null;
  last_succeeded_at: string | null;
  last_failed_at: string | null;
  last_status: "started" | SchedulerOutcome;
};

/** Reserve start + finish + at most one failed-record retry. Free Cron work has
 * 8 work + 37 bookkeeping + 3 health = 48 D1 operations, leaving 2 queue calls. */
export function createSchedulerHealthDb(env: Env): Db {
  return createDb(env.DB, createBudget({ dbQueries: SCHEDULER_MONITOR_DB_QUERIES, subrequests: 0 }));
}

export async function recordSchedulerStart(db: Db, cron: string, runId: string, scheduledAt: Date, now = new Date()): Promise<void> {
  await db.run(`INSERT INTO scheduler_health(cron,latest_run_id,last_scheduled_at,last_started_at,last_status)
    VALUES (?,?,?,?,'started') ON CONFLICT(cron) DO UPDATE SET
      latest_run_id=excluded.latest_run_id,last_scheduled_at=excluded.last_scheduled_at,
      last_started_at=excluded.last_started_at,last_finished_at=NULL,last_status='started'
    WHERE excluded.last_started_at>=scheduler_health.last_started_at`,
    cron, runId, scheduledAt.toISOString(), now.toISOString());
}

export async function recordSchedulerFinish(db: Db, cron: string, runId: string, outcome: SchedulerOutcome, now = new Date()): Promise<void> {
  const at = now.toISOString();
  // An older invocation finishing late must not overwrite the current run's state.
  // Keep the most recent success/failure evidence even if invocations overlap.
  await db.run(`UPDATE scheduler_health SET
    last_finished_at=CASE WHEN latest_run_id=? THEN ? ELSE last_finished_at END,
    last_status=CASE WHEN latest_run_id=? THEN ? ELSE last_status END,
    last_succeeded_at=CASE WHEN ?='success' THEN MAX(COALESCE(last_succeeded_at,''),?) ELSE last_succeeded_at END,
    last_failed_at=CASE WHEN ?='error' THEN MAX(COALESCE(last_failed_at,''),?) ELSE last_failed_at END
    WHERE cron=?`, runId, at, runId, outcome, outcome, at, outcome, at, cron);
}

export async function readSchedulerStatus(db: Db, env: Env, now = new Date()) {
  const rows = await db.all<SchedulerRow>(`SELECT cron,last_scheduled_at,last_started_at,last_finished_at,
    last_succeeded_at,last_failed_at,last_status FROM scheduler_health ORDER BY cron LIMIT 10`);
  const expected = env.APP_ENV === "staging" ? [MINUTELY] : [...PRODUCTION_CRONS];
  return {
    environment: env.APP_ENV ?? "local",
    mode: env.APP_ENV === "staging" ? ((reviewPublishingActive(env, now.getTime()) || betaPublishingActive(env, now.getTime())) ? "review_publish_only" : "trigger_monitor_only") : "job_dispatch",
    checkedAt: now.toISOString(),
    maintenance: env.MAINTENANCE_MODE === "1",
    // Only known fixed fields/Crons. Never return IDs, provider errors or job data.
    triggers: expected.map(cron => {
      const row = rows.find(item => item.cron === cron);
      const maxAgeMs = (cron === MINUTELY ? 5 * 60 : cron === "0 * * * *" ? 90 * 60 : 26 * 3600) * 1000;
      return {
        cron,
        status: row?.last_status ?? "not_observed",
        stale: !row || now.getTime() - Date.parse(row.last_started_at) > maxAgeMs,
        lastScheduledAt: row?.last_scheduled_at ?? null,
        lastStartedAt: row?.last_started_at ?? null,
        lastFinishedAt: row?.last_finished_at ?? null,
        lastSucceededAt: row?.last_succeeded_at ?? null,
        lastFailedAt: row?.last_failed_at ?? null,
      };
    }),
  };
}
