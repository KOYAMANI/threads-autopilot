#!/usr/bin/env bash
# Export only; never restores or modifies the source DB. Store output on an encrypted volume.
set -euo pipefail
umask 077
if [ "$#" -ne 2 ] || { [ "$1" != "--local" ] && [ "$1" != "--remote" ]; }; then
  echo "Usage: bash scripts/backup-d1.sh --local|--remote /absolute/private/backup-directory" >&2
  exit 2
fi
case "$2" in /*) ;; *) echo "Backup directory must be absolute" >&2; exit 2;; esac
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
mkdir -p "$2"
backup_root="$(cd "$2" && pwd -P)"
case "$backup_root/" in "$project_dir/"*) echo "Choose a backup directory outside the project" >&2; exit 2;; esac
backup_dir="$(mktemp -d "$backup_root/d1-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
cd "$project_dir"
config="wrangler.toml"
if [ "$1" = "--remote" ]; then config="wrangler.production.toml"; fi
npx --no-install wrangler d1 export threads-autopilot "$1" --config "$config" --output "$backup_dir/database.sql"
test -s "$backup_dir/database.sql"
chmod 600 "$backup_dir/database.sql"
shasum -a 256 "$backup_dir/database.sql" > "$backup_dir/SHA256SUMS"
python3 scripts/verify-backup.py "$backup_dir/database.sql"
echo "Backup: $backup_dir (contains personal data; keep private and encrypted at rest)"
