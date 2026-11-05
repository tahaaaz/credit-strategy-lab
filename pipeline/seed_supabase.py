"""Load the pipeline outputs into Supabase through its REST API (standard library only).

    export SUPABASE_URL=https://<project>.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=<service role key>   # Settings -> API (keep secret)
    python pipeline/seed_supabase.py

Run supabase/schema.sql in the SQL editor first. Re-running is safe (upserts).
"""
from __future__ import annotations

import csv
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROCESSED = ROOT / "data" / "processed"
BATCH = 1000

INT_COLS = {"age", "months_on_book", "bureau_score", "delinq_24m", "searches_6m", "score"}
BOOL_COLS = {"revolver", "min_pay_only_3m", "cash_advance_6m"}
TEXT_COLS = {"account_id", "obs_date", "employment_status", "housing_status", "region", "risk_band"}


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"Missing environment variable {name}. See the README 'Deploy' section.")
    return v


URL = env("SUPABASE_URL").rstrip("/")
KEY = env("SUPABASE_SERVICE_ROLE_KEY")


def post(table: str, rows: list[dict]) -> None:
    req = urllib.request.Request(
        f"{URL}/rest/v1/{table}",
        data=json.dumps(rows).encode(),
        method="POST",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"Upload to {table} failed ({e.code}): {e.read().decode()[:500]}")


def coerce(row: dict) -> dict:
    out = {}
    for k, v in row.items():
        if k in TEXT_COLS:
            out[k] = v
        elif k in BOOL_COLS:
            out[k] = v.strip().lower() == "true"
        elif k in INT_COLS:
            out[k] = int(float(v))
        else:
            out[k] = float(v)
    return out


def main() -> None:
    with open(PROCESSED / "accounts.csv", newline="") as f:
        rows = [coerce(r) for r in csv.DictReader(f)]
    for i in range(0, len(rows), BATCH):
        post("accounts", rows[i:i + BATCH])
        print(f"\raccounts: {min(i + BATCH, len(rows)):,}/{len(rows):,}", end="", flush=True)
    print()

    artifacts = json.loads((PROCESSED / "model_artifacts.json").read_text())
    post("model_artifacts", [{"key": k, "payload": v} for k, v in artifacts.items()])
    print(f"model_artifacts: {len(artifacts)} keys")
    print("Seed complete.")


if __name__ == "__main__":
    main()
