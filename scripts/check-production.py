#!/usr/bin/env python3
"""Check deployment targets without printing secrets. Requires Python 3.11+."""
import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent

def validate(config):
    errors = []
    variables = config.get("vars", {})
    origin = urlparse(variables.get("APP_ORIGIN", ""))
    hostname = origin.hostname or ""
    if origin.scheme != "https" or not hostname or hostname in ("localhost", "127.0.0.1", "::1") or hostname.endswith(".example.com") or "example" in hostname.split(".") or origin.path not in ("", "/") or origin.query or origin.fragment or origin.username:
        errors.append("APP_ORIGIN: set the actual production HTTPS origin")
    databases = [d for d in config.get("d1_databases", []) if d.get("binding") == "DB"]
    if len(databases) != 1 or not re.fullmatch(r"[0-9a-fA-F-]{36}", databases[0].get("database_id", "")) or databases[0].get("database_id") == "00000000-0000-0000-0000-000000000000":
        errors.append("DB: set the actual production D1 database ID")
    if config.get("define", {}).get("__DEV__") != "false" or any(variables.get(key) != "0" for key in ("THREADS_MOCK", "AI_MOCK")):
        errors.append("Build: disable development and API mocks")
    if variables.get("MAINTENANCE_MODE") != "0":
        errors.append("Maintenance mode is enabled; use the documented recovery workflow")
    sender = variables.get("MAIL_FROM", "")
    if not sender or not re.search(r"@[^\s<>]+\.[^\s<>]+", sender) or "example.com" in sender or "resend.dev" in sender:
        errors.append("MAIL_FROM: set a sender on a verified Resend domain")
    producers = config.get("queues", {}).get("producers", [])
    consumers = config.get("queues", {}).get("consumers", [])
    queue = next((p.get("queue") for p in producers if p.get("binding") == "JOB_QUEUE"), None)
    if not queue or not any(c.get("queue") == queue for c in consumers):
        errors.append("Queue: JOB_QUEUE requires a matching consumer")
    if variables.get("WORKERS_PLAN") == "free":
        if any(c.get("max_batch_size") != 1 or c.get("max_concurrency") != 1 for c in consumers):
            errors.append("Free pilot: queue batch size and concurrency must both be 1")
        for name, limit in (("MAX_DB_QUERIES", 32), ("MAX_SUBREQUESTS", 20)):
            try:
                if not 1 <= int(variables.get(name, "0")) <= limit: raise ValueError()
            except (ValueError, TypeError): errors.append(f"Free pilot: {name} must be between 1 and {limit}")
    return errors

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote", action="store_true", help="also verify deployed secret names (requires wrangler login)")
    args = parser.parse_args()
    path = ROOT / "wrangler.production.toml"
    config = tomllib.loads(path.read_text())
    errors = validate(config)
    if not errors and args.remote:
        command = [str(ROOT / "node_modules/.bin/wrangler"), "secret", "list", "--config", str(path)]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=55)
        try:
            if result.returncode: raise ValueError()
            names = {s["name"] for s in json.loads(result.stdout)}
            required = {"ENC_KEY", "SESSION_SECRET", "ADMIN_SECRET", "RESEND_API_KEY"}
            if config.get("vars", {}).get("THREADS_APP_ID"): required.add("THREADS_APP_SECRET")
            if config.get("vars", {}).get("GOOGLE_CLIENT_ID"): required.add("GOOGLE_CLIENT_SECRET")
            if config.get("vars", {}).get("VAPID_PUBLIC_KEY"): required.add("VAPID_PRIVATE_KEY")
            errors += [f"Worker Secret missing: {name}" for name in sorted(required - names)]
        except (ValueError, TypeError, KeyError):
            errors.append("Cannot inspect production secrets; complete wrangler login and provision the Worker")
    for error in errors: print("BLOCKED: " + error, file=sys.stderr)
    if errors: return 1
    print("Production targets checked. Plan, domain verification, secret backup and live smoke tests still require operational verification.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
