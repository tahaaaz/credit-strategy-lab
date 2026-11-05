"""Synthetic UK credit-card portfolio generator.

The data-generating process is built around an unobserved "true quality" factor `q`.
Observable bureau and behavioural attributes are noisy, partly non-linear functions of
`q`, and the 12-month default flag is drawn from a logit that also contains non-linear
terms and interactions. A model therefore has to *learn* risk from imperfect signals,
which is what makes the scorecard vs. gradient-boosting comparison meaningful.

Cohorts can drift (income inflation, utilisation creep, more credit searches, a worse
macro environment) so the out-of-time and current-book samples show realistic
population shift and calibration drift for monitoring (PSI) analysis.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from config import COHORTS, SEED

REGIONS = ["London", "South East", "South West", "East of England", "West Midlands",
           "East Midlands", "Yorkshire", "North West", "North East", "Wales", "Scotland",
           "Northern Ireland"]
EMPLOYMENT = ["Employed", "Self-employed", "Retired", "Student", "Unemployed"]
EMP_P = [0.66, 0.13, 0.12, 0.05, 0.04]
EMP_MEDIAN_INCOME = {"Employed": 34_000, "Self-employed": 31_000, "Retired": 21_000,
                     "Student": 9_500, "Unemployed": 8_000}
APR_TIERS = np.array([21.9, 24.9, 29.9, 34.9])


def _sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def generate_cohort(name: str, rng: np.random.Generator) -> pd.DataFrame:
    cfg = COHORTS[name]
    n = cfg["n"]
    q = rng.standard_normal(n)  # latent customer quality (higher = safer)

    age = np.clip(rng.normal(42, 13, n) + 3 * q, 18, 85).round().astype(int)
    emp = rng.choice(EMPLOYMENT, size=n, p=EMP_P)
    emp = np.where(age >= 67, rng.choice(["Retired", "Employed"], n, p=[0.85, 0.15]), emp)
    emp = np.where((age <= 23) & (rng.random(n) < 0.35), "Student", emp)
    # unemployment is concentrated in weaker latent quality
    emp = np.where((q < -1.2) & (rng.random(n) < 0.08), "Unemployed", emp)

    med = np.vectorize(EMP_MEDIAN_INCOME.get)(emp)
    income = med * np.exp(rng.normal(0, 0.42, n) + 0.12 * q) * cfg["income_growth"]
    income = np.clip(income, 4_000, 400_000).round(-2)

    housing = np.select(
        [age < 25, age < 35, age < 55],
        [rng.choice(["Renter", "Living with parents", "Mortgage"], n, p=[0.45, 0.45, 0.10]),
         rng.choice(["Renter", "Mortgage", "Living with parents"], n, p=[0.50, 0.40, 0.10]),
         rng.choice(["Mortgage", "Renter", "Owner outright"], n, p=[0.60, 0.28, 0.12])],
        rng.choice(["Owner outright", "Mortgage", "Renter"], n, p=[0.55, 0.25, 0.20]),
    )
    region = rng.choice(REGIONS, n)
    months_on_book = np.clip(rng.exponential(46, n), 3, 240).round().astype(int)

    bureau_score = np.clip(820 + 80 * q + rng.normal(0, 45, n), 300, 999).round().astype(int)
    delinq_24m = rng.poisson(np.exp(-1.7 - 0.95 * q))
    searches_6m = rng.poisson(np.exp(-0.25 - 0.30 * q + 0.25 * (age < 30) + cfg["search_shift"]))

    limit = income * 0.16 * np.exp(0.30 * q + rng.normal(0, 0.35, n))
    limit = np.clip(np.round(limit / 50) * 50, 250, 15_000)

    util_mean = np.clip(_sigmoid(-0.35 - 0.95 * q) + cfg["util_shift"], 0.02, 0.97)
    conc = 3.0
    utilisation = rng.beta(util_mean * conc, (1 - util_mean) * conc)
    overlimit = rng.random(n) < 0.015 * (q < -1)
    utilisation = np.where(overlimit, rng.uniform(1.0, 1.08, n), utilisation)
    balance = (limit * utilisation).round(2)

    external_debt = (income * 0.10 * np.exp(-0.45 * q + rng.normal(0, 0.6, n))).round(-1)
    revolver = rng.random(n) < _sigmoid(0.2 + 2.2 * utilisation - 0.6 * q)
    min_pay_only_3m = rng.random(n) < _sigmoid(-2.4 + 2.2 * utilisation - 0.9 * q)
    cash_advance_6m = rng.random(n) < _sigmoid(-2.9 - 0.75 * q)
    monthly_spend = (income / 12 * 0.07 * np.exp(0.20 * q + rng.normal(0, 0.5, n))).round(2)

    # APR set by risk-based pricing at origination (on the *bureau* view at the time)
    tier = np.digitize(-(bureau_score + rng.normal(0, 30, n)), [-900, -830, -760])
    apr = APR_TIERS[tier]

    # Affordability: estimated monthly disposable income after tax, essentials,
    # housing and existing unsecured debt servicing (3% of balance per month)
    net_monthly = income * np.where(income > 50_270, 0.68, 0.78) / 12
    housing_cost = np.vectorize({"Renter": 750, "Mortgage": 700, "Owner outright": 100,
                                 "Living with parents": 150}.get)(housing)
    essentials = 350 + 0.06 * net_monthly
    debt_service = 0.03 * (balance + external_debt)
    disposable = (net_monthly - housing_cost - essentials - debt_service).round(2)
    dti = ((balance + external_debt) / income).round(4)

    # ---- outcome: 12-month default (90+ DPD or charge-off) -----------------------
    logit = (
        -4.70
        - 1.05 * q
        + 1.9 * np.maximum(utilisation - 0.55, 0) ** 1.3
        + 0.65 * (utilisation > 0.95)
        + 0.30 * np.minimum(delinq_24m, 4)
        + 0.10 * np.minimum(searches_6m, 6)
        + 0.55 * min_pay_only_3m
        + 0.45 * cash_advance_6m
        + 0.90 * np.maximum(dti - 0.45, 0)
        + 0.35 * (disposable < 150)
        + 0.40 * ((age < 26) & (utilisation > 0.8))
        - 0.18 * np.log(months_on_book / 12 + 1)
        + 0.30 * (emp == "Unemployed")
        + cfg["macro_shift"]
    )
    default_12m = rng.random(n) < _sigmoid(logit)

    df = pd.DataFrame({
        "account_id": [f"{name[:3].upper()}{i:06d}" for i in range(n)],
        "cohort": name,
        "obs_date": cfg["obs_date"],
        "age": age,
        "employment_status": emp,
        "housing_status": housing,
        "region": region,
        "annual_income": income,
        "months_on_book": months_on_book,
        "bureau_score": bureau_score,
        "delinq_24m": delinq_24m,
        "searches_6m": searches_6m,
        "credit_limit": limit,
        "balance": balance,
        "utilisation": utilisation.round(4),
        "external_unsecured_debt": external_debt,
        "dti": dti,
        "disposable_income_monthly": disposable,
        "revolver": revolver,
        "min_pay_only_3m": min_pay_only_3m,
        "cash_advance_6m": cash_advance_6m,
        "monthly_spend": monthly_spend,
        "apr": apr,
        "default_12m": default_12m.astype(int),
    })
    if name == "current_book":
        df["default_12m"] = np.nan  # outcome not yet observed
    return df


def generate_all() -> dict[str, pd.DataFrame]:
    rng = np.random.default_rng(SEED)
    return {name: generate_cohort(name, rng) for name in COHORTS}


if __name__ == "__main__":
    for k, v in generate_all().items():
        dr = v["default_12m"].astype(float).mean()
        print(f"{k:13s} n={len(v):6d} default_rate={dr:.4f} util={v.utilisation.mean():.3f}")
