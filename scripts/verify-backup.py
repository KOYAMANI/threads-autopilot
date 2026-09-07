#!/usr/bin/env python3
"""Verify a trusted D1 SQL export by restoring to isolated in-memory SQLite.
No restored row values are printed and no source database is modified.
"""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("export", type=Path)
parser.add_argument("--migrations", type=Path, help="also rehearse unapplied migrations on the restored copy")
args = parser.parse_args()
export = args.export.resolve()
checksum_file = export.parent / "SHA256SUMS"
if not checksum_file.exists():
    raise SystemExit("Missing SHA256SUMS")
expected = checksum_file.read_text().split()[0]
if hashlib.sha256(export.read_bytes()).hexdigest() != expected:
    raise SystemExit("Backup checksum mismatch")
connection = sqlite3.connect(":memory:")
# An export should never attach another database or access extensions.
def authorize(action, arg1, arg2, database, source):
    if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION and arg2 == "load_extension":
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK
connection.set_authorizer(authorize)
connection.executescript(export.read_text())
def verify():
    if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise SystemExit("Restored database failed integrity check")
    if connection.execute("PRAGMA foreign_key_check").fetchone():
        raise SystemExit("Restored database has foreign key violations")
verify()
report = {"checksum": "ok", "restoreIntegrity": "ok"}
if args.migrations:
    applied = {row[0] for row in connection.execute("SELECT name FROM d1_migrations")}
    pending = sorted(path for path in args.migrations.glob("*.sql") if path.name not in applied)
    for path in pending:
        connection.executescript(path.read_text())
    verify()
    report["rehearsedMigrations"] = [path.name for path in pending]
    report["migratedIntegrity"] = "ok"
print(json.dumps(report))
