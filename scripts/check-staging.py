#!/usr/bin/env python3
"""Fail closed when staging is pointed at any production resource."""
from pathlib import Path
import tomllib
import re
from datetime import datetime, timezone
ROOT=Path(__file__).resolve().parent.parent
stage=tomllib.loads((ROOT/"wrangler.staging.toml").read_text())
prod=tomllib.loads((ROOT/"wrangler.production.toml").read_text())
checks={
 "bindings":len(stage.get("d1_databases",[]))==1 and stage["d1_databases"][0]["binding"]=="DB" and len(stage["queues"]["producers"])==len(stage["queues"]["consumers"])==1 and stage["queues"]["producers"][0]["binding"]=="JOB_QUEUE",
 "free-plan":stage["vars"].get("WORKERS_PLAN")=="free",
 "worker":stage["name"]=="threads-autopilot-staging" and stage["name"]!=prod["name"],
 "database":stage["d1_databases"][0]["database_id"]=="dcce5294-b2de-4c72-9a81-5dc6f6d2e00a" and stage["d1_databases"][0]["database_id"]!=prod["d1_databases"][0]["database_id"],
 "queue":stage["queues"]["producers"][0]["queue"]==stage["queues"]["consumers"][0]["queue"]=="threads-autopilot-staging-jobs",
 "origin":stage["vars"]["APP_ORIGIN"]=="https://threads-autopilot-staging.yama-threads-apps.workers.dev",
 "environment":stage["vars"].get("APP_ENV")=="staging",
 "release-build":stage["define"]["__DEV__"]=="false" and stage["vars"]["THREADS_MOCK"]==stage["vars"]["AI_MOCK"]=="0",
 "single-staging-cron":stage.get("triggers",{}).get("crons",[])==["* * * * *"],
}
review_enabled=stage["vars"].get("STAGING_REVIEW_PUBLISHING")=="1"
all_users=stage["vars"].get("STAGING_ALL_USERS_PUBLISHING")=="1"
if review_enabled and not all_users:
    try:
        expiry=datetime.fromisoformat(stage["vars"].get("STAGING_REVIEW_UNTIL", "").replace("Z", "+00:00"))
        valid_expiry=expiry.tzinfo is not None and expiry>datetime.now(timezone.utc)
    except ValueError:
        valid_expiry=False
    checks["review-scope"]=bool(re.fullmatch(r"[a-f0-9-]{36}",stage["vars"].get("STAGING_REVIEW_USER_ID", ""))) and bool(re.fullmatch(r"\d+",stage["vars"].get("STAGING_THREADS_USER_ID", ""))) and valid_expiry
failed=[name for name,ok in checks.items() if not ok]
if failed: raise SystemExit("Blocked staging deploy: "+", ".join(failed))
print("Staging targets isolated; email disabled; all active logins can manually publish/schedule their own connected profiles." if all_users else "Staging targets isolated; email disabled; "+("publishing restricted to the dedicated reviewer and pinned profile until configured expiry." if review_enabled else "publishing disabled; Cron monitors trigger arrival only."))

if not all_users and stage["vars"].get("STAGING_BETA_PUBLISHING")=="1":
    expiry=datetime.fromisoformat(stage["vars"].get("STAGING_BETA_UNTIL", "").replace("Z", "+00:00"))
    if expiry.tzinfo is None or expiry<=datetime.now(timezone.utc):
        raise SystemExit("Blocked staging deploy: invalid/expired beta scope")
    print("Student manual publishing requires BOTH a granted active license and an OAuth/token-verified pinned profile. Autopilot stays disabled.")
