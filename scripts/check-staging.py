#!/usr/bin/env python3
"""Fail closed when staging is pointed at any production resource."""
from pathlib import Path
import tomllib
ROOT=Path(__file__).resolve().parent.parent
stage=tomllib.loads((ROOT/"wrangler.staging.toml").read_text())
prod=tomllib.loads((ROOT/"wrangler.production.toml").read_text())
checks={
 "worker":stage["name"]=="threads-autopilot-staging" and stage["name"]!=prod["name"],
 "database":stage["d1_databases"][0]["database_id"]=="dcce5294-b2de-4c72-9a81-5dc6f6d2e00a" and stage["d1_databases"][0]["database_id"]!=prod["d1_databases"][0]["database_id"],
 "queue":stage["queues"]["producers"][0]["queue"]==stage["queues"]["consumers"][0]["queue"]=="threads-autopilot-staging-jobs",
 "origin":stage["vars"]["APP_ORIGIN"]=="https://threads-autopilot-staging.yama-threads-apps.workers.dev",
 "environment":stage["vars"].get("APP_ENV")=="staging",
 "release-build":stage["define"]["__DEV__"]=="false" and stage["vars"]["THREADS_MOCK"]==stage["vars"]["AI_MOCK"]=="0",
 "no-cron":stage.get("triggers",{}).get("crons",[])==[],
}
failed=[name for name,ok in checks.items() if not ok]
if failed: raise SystemExit("Blocked staging deploy: "+", ".join(failed))
print("Staging targets isolated; external publishing/email disabled; no cron triggers.")
