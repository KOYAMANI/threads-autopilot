#!/usr/bin/env python3
"""Fail closed when staging is pointed at any production resource."""
from pathlib import Path
import tomllib
ROOT=Path(__file__).resolve().parent.parent
stage=tomllib.loads((ROOT/"wrangler.staging.toml").read_text())
prod=tomllib.loads((ROOT/"wrangler.production.toml").read_text())
checks={
 "bindings":len(stage.get("d1_databases",[]))==1 and stage["d1_databases"][0]["binding"]=="DB" and len(stage["queues"]["producers"])==len(stage["queues"]["consumers"])==1 and stage["queues"]["producers"][0]["binding"]=="JOB_QUEUE",
 "paid-plan":stage["vars"].get("WORKERS_PLAN")=="paid", # Workers Paid since 2026-10-21; Free cannot run the daily sweep (D1 read cap)
 "worker":stage["name"]=="threads-autopilot-staging" and stage["name"]!=prod["name"],
 "database":stage["d1_databases"][0]["database_id"]=="f826a56b-58fb-4d0d-a20b-4dd2807d3292" and stage["d1_databases"][0]["database_id"]!=prod["d1_databases"][0]["database_id"],
 "queue":stage["queues"]["producers"][0]["queue"]==stage["queues"]["consumers"][0]["queue"]=="threads-autopilot-staging-jobs",
 "origin":stage["vars"]["APP_ORIGIN"]=="https://threads-autopilot-staging.yama-threads-apps.workers.dev",
 "environment":stage["vars"].get("APP_ENV")=="staging",
 "release-build":stage["define"]["__DEV__"]=="false" and stage["vars"]["THREADS_MOCK"]==stage["vars"]["AI_MOCK"]=="0",
 # Minutely dispatch + the 03:00 JST daily sweep only; the hourly cron stays production-only (DECISIONS 2026-10-21).
 "staging-crons":stage.get("triggers",{}).get("crons",[])==["* * * * *", "0 18 * * *"],
}
failed=[name for name,ok in checks.items() if not ok]
if failed: raise SystemExit("Blocked staging deploy: "+", ".join(failed))
print("Staging targets isolated; external publishing/email disabled; minutely + daily cron triggers only.")
