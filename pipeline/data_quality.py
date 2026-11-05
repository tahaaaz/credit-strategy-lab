"""Data-quality control checks run before any model is trained.

Every check returns a record (check, cohort, status, detail) so the results can be
stored, reviewed and shown on the dashboard - a lightweight version of the DQ controls
a model-risk / data-governance framework would expect.
"""
from __future__ import annotations

import pandas as pd

RANGE_RULES = {
    "age": (18, 100),
    "annual_income": (1, 1_000_000),
    "months_on_book": (0, 600),
    "bureau_score": (0, 999),
    "utilisation": (0, 1.10),
    "credit_limit": (100, 50_000),
    "apr": (0, 40),
    "delinq_24m": (0, 24),
    "searches_6m": (0, 50),
}
CRITICAL_FIELDS = ["account_id", "annual_income", "credit_limit", "balance", "bureau_score", "apr"]


def run_checks(df: pd.DataFrame, cohort: str) -> list[dict]:
    out: list[dict] = []

    def add(check, ok, detail, severity="error"):
        out.append({"cohort": cohort, "check": check,
                    "status": "PASS" if ok else ("FAIL" if severity == "error" else "WARN"),
                    "detail": detail})

    add("Row count > 0", len(df) > 0, f"{len(df):,} rows")
    dup = int(df["account_id"].duplicated().sum())
    add("Unique account_id", dup == 0, f"{dup} duplicates")

    nulls = {c: int(df[c].isna().sum()) for c in CRITICAL_FIELDS}
    add("No nulls in critical fields", sum(nulls.values()) == 0,
        ", ".join(f"{k}={v}" for k, v in nulls.items() if v) or "0 nulls")

    for col, (lo, hi) in RANGE_RULES.items():
        bad = int(((df[col] < lo) | (df[col] > hi)).sum())
        add(f"Range {col} in [{lo}, {hi}]", bad == 0, f"{bad} out of range")

    over = int((df["balance"] > df["credit_limit"] * 1.10).sum())
    add("Balance <= 110% of limit", over == 0, f"{over} accounts")

    recon = (df["balance"] / df["credit_limit"] - df["utilisation"]).abs().gt(0.01).sum()
    add("Utilisation reconciles to balance/limit", int(recon) == 0, f"{int(recon)} mismatches")

    neg_disp = float((df["disposable_income_monthly"] < 0).mean())
    add("Negative disposable income share < 25%", neg_disp < 0.25,
        f"{neg_disp:.1%} of accounts", severity="warn")

    if df["default_12m"].notna().any():
        dr = float(df["default_12m"].mean())
        add("Default rate within expected 1%-10%", 0.01 <= dr <= 0.10, f"{dr:.2%}", severity="warn")
    else:
        add("Outcome window not yet matured", True, "no performance - strategy scoring only")
    return out
