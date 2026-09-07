-- One bounded row per Cron. No account data, job bodies or exception text.
CREATE TABLE scheduler_health (
  cron TEXT PRIMARY KEY,
  latest_run_id TEXT NOT NULL,
  last_scheduled_at TEXT NOT NULL,
  last_started_at TEXT NOT NULL,
  last_finished_at TEXT,
  last_succeeded_at TEXT,
  last_failed_at TEXT,
  last_status TEXT NOT NULL CHECK(last_status IN ('started','success','error','paused'))
);
