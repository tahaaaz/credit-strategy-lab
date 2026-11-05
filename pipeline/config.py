"""Central configuration for the Credit Strategy Lab analytics pipeline.

All monetary values are GBP. Rates are annual unless stated otherwise.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"          # large intermediate files (git-ignored)
OUT_DIR = DATA_DIR / "processed"    # files loaded into Supabase (committed)

SEED = 20251105

# Three cohorts, mirroring a real model-development set-up:
#   development  -> train / test split (observation Dec-2023, 12m outcome window)
#   out-of-time  -> OOT validation   (observation Jun-2024, 12m outcome window)
#   current book -> strategy target  (observation Sep-2025, no outcome yet)
COHORTS = {
    "development": {"n": 60_000, "obs_date": "2023-12-31", "macro_shift": 0.00,
                    "income_growth": 1.00, "util_shift": 0.00, "search_shift": 0.00},
    "out_of_time": {"n": 25_000, "obs_date": "2024-06-30", "macro_shift": 0.12,
                    "income_growth": 1.03, "util_shift": 0.02, "search_shift": 0.05},
    "current_book": {"n": 30_000, "obs_date": "2025-09-30", "macro_shift": 0.15,
                     "income_growth": 1.10, "util_shift": 0.11, "search_shift": 0.35},
}

TEST_SIZE = 0.30

# Risk bands on 12-month PD (upper bounds, exclusive)
RISK_BANDS = [("A", 0.01), ("B", 0.025), ("C", 0.05), ("D", 0.10), ("E", 1.01)]

# Scorecard scaling: 600 points at 50:1 good:bad odds, 20 points to double the odds
SCORE_BASE, SCORE_BASE_ODDS, SCORE_PDO = 600, 50, 20

# Baseline economics (overridable per simulation in the database/API)
ECONOMICS = {
    "lgd": 0.85,                 # loss given default, unsecured cards
    "ccf": 0.65,                 # credit conversion factor on undrawn limit
    "cost_of_funds": 0.0475,     # annual funding cost on drawn balance
    "interchange_rate": 0.003,   # UK consumer debit/credit cap (IFR) 0.3%
    "opex_per_account": 30.0,    # annual servicing cost
    "capital_ratio": 0.105,      # capital held against RWA
    "risk_weight": 0.75,         # retail exposure risk weight
    "late_fee": 12.0,            # UK card late fee cap
    "hurdle_rate": 0.15,         # RAROC hurdle
}
