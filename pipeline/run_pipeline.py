"""End-to-end analytics pipeline.

    python pipeline/run_pipeline.py

1. Generate the three cohorts (development, out-of-time, current book)
2. Run data-quality controls
3. Fit a WoE logistic-regression scorecard (champion) and a gradient-boosting
   challenger, then validate both on test and out-of-time samples
4. Monitor stability (PSI) between development and the current book
5. Apply a post-model adjustment (PMA) for calibration drift seen out-of-time
6. Score the current book and export everything for Supabase
"""
from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score, roc_curve
from sklearn.model_selection import train_test_split

import data_quality
from config import (OUT_DIR, RAW_DIR, RISK_BANDS, SCORE_BASE, SCORE_BASE_ODDS,
                    SCORE_PDO, SEED, TEST_SIZE)
from generate_data import generate_all
from woe import fit_bins, woe_frame

NUMERIC = ["age", "annual_income", "months_on_book", "bureau_score", "delinq_24m",
           "searches_6m", "utilisation", "dti", "disposable_income_monthly", "credit_limit",
           "external_unsecured_debt", "monthly_spend"]
CATEGORICAL = ["employment_status", "housing_status", "region", "revolver",
               "min_pay_only_3m", "cash_advance_6m"]
LABELS = {
    "age": "Age", "annual_income": "Annual income", "months_on_book": "Months on book",
    "bureau_score": "Bureau score", "delinq_24m": "Delinquencies (24m)",
    "searches_6m": "Credit searches (6m)", "utilisation": "Utilisation", "dti": "Debt-to-income",
    "disposable_income_monthly": "Monthly disposable income", "credit_limit": "Credit limit",
    "external_unsecured_debt": "External unsecured debt", "monthly_spend": "Monthly spend",
    "employment_status": "Employment status", "housing_status": "Housing status",
    "region": "Region", "revolver": "Revolver flag", "min_pay_only_3m": "Min-pay only (3m)",
    "cash_advance_6m": "Cash advance (6m)",
}


# --------------------------------------------------------------------------- metrics
def ks_stat(y, p) -> float:
    fpr, tpr, _ = roc_curve(y, p)
    return float(np.max(tpr - fpr))


def summarise(y, p) -> dict:
    auc = roc_auc_score(y, p)
    return {"auc": round(auc, 4), "gini": round(2 * auc - 1, 4), "ks": round(ks_stat(y, p), 4),
            "brier": round(brier_score_loss(y, p), 5), "bad_rate": round(float(np.mean(y)), 4),
            "mean_pd": round(float(np.mean(p)), 4), "n": int(len(y))}


def roc_points(y, p, k=60) -> list[dict]:
    fpr, tpr, _ = roc_curve(y, p)
    idx = np.unique(np.linspace(0, len(fpr) - 1, k).astype(int))
    return [{"fpr": round(float(fpr[i]), 4), "tpr": round(float(tpr[i]), 4)} for i in idx]


def calibration(y, p, bins=10) -> list[dict]:
    d = pd.DataFrame({"y": y, "p": p})
    d["bin"] = pd.qcut(d["p"].rank(method="first"), bins, labels=False)
    g = d.groupby("bin").agg(predicted=("p", "mean"), actual=("y", "mean"), n=("y", "size"))
    return [{"decile": int(i) + 1, "predicted": round(r.predicted, 4), "actual": round(r.actual, 4),
             "n": int(r.n)} for i, r in g.iterrows()]


def gains_table(y, score, bins=10) -> list[dict]:
    """Deciles from riskiest (lowest score) to safest."""
    d = pd.DataFrame({"y": y, "s": score})
    d["decile"] = pd.qcut(d["s"].rank(method="first"), bins, labels=False) + 1
    g = d.groupby("decile").agg(min_score=("s", "min"), max_score=("s", "max"),
                                accounts=("y", "size"), bads=("y", "sum"))
    g["bad_rate"] = g["bads"] / g["accounts"]
    g["cum_bad_capture"] = g["bads"].cumsum() / g["bads"].sum()
    g["cum_accounts"] = g["accounts"].cumsum() / g["accounts"].sum()
    g["lift"] = g["bad_rate"] / (g["bads"].sum() / g["accounts"].sum())
    return [{k: (round(float(v), 4) if isinstance(v, float) else int(v)) for k, v in r.items()}
            | {"decile": int(i)} for i, r in g.iterrows()]


def psi(expected: pd.Series, actual: pd.Series) -> tuple[float, list[dict]]:
    e = expected.value_counts(normalize=True)
    a = actual.value_counts(normalize=True)
    idx = e.index.union(a.index)
    e, a = e.reindex(idx).fillna(1e-4).clip(lower=1e-4), a.reindex(idx).fillna(1e-4).clip(lower=1e-4)
    contrib = (a - e) * np.log(a / e)
    rows = [{"bin": str(i), "expected": round(float(e[i]), 4), "actual": round(float(a[i]), 4),
             "psi": round(float(contrib[i]), 5)} for i in idx]
    return float(contrib.sum()), rows


def rag(v: float) -> str:
    return "GREEN" if v < 0.10 else ("AMBER" if v < 0.25 else "RED")


# --------------------------------------------------------------------------- scorecard
FACTOR = SCORE_PDO / np.log(2)
OFFSET = SCORE_BASE - FACTOR * np.log(SCORE_BASE_ODDS)


def select_features(specs, X_woe_train, y) -> list[str]:
    ranked = sorted([f for f in specs if specs[f].iv >= 0.02], key=lambda f: -specs[f].iv)
    chosen: list[str] = []
    for f in ranked:  # drop highly collinear characteristics, keeping the higher IV one
        if all(abs(np.corrcoef(X_woe_train[f], X_woe_train[c])[0, 1]) < 0.70 for c in chosen):
            chosen.append(f)
    while True:  # every WoE coefficient must be negative (positive = counter-intuitive)
        lr = LogisticRegression(C=1e6, max_iter=2000).fit(X_woe_train[chosen], y)
        pos = [f for f, b in zip(chosen, lr.coef_[0]) if b >= 0]
        if not pos:
            return chosen
        chosen.remove(pos[0])


def scorecard_points(specs, features, lr) -> list[dict]:
    n = len(features)
    b0 = lr.intercept_[0]
    rows = []
    for f, b in zip(features, lr.coef_[0]):
        for _, r in specs[f].table.iterrows():
            pts = -(b * r["woe"] + b0 / n) * FACTOR + OFFSET / n
            rows.append({"feature": f, "label": LABELS[f], "bin": r["bin"], "accounts": int(r["accounts"]),
                         "bad_rate": round(float(r["bad_rate"]), 4), "woe": round(float(r["woe"]), 4),
                         "points": int(round(pts)), "coefficient": round(float(b), 4)})
    return rows


def to_score(pd_bad: np.ndarray) -> np.ndarray:
    pd_bad = np.clip(pd_bad, 1e-6, 1 - 1e-6)
    return np.round(OFFSET + FACTOR * np.log((1 - pd_bad) / pd_bad)).astype(int)


def band(pd_: np.ndarray) -> np.ndarray:
    edges = [b[1] for b in RISK_BANDS[:-1]]
    return np.array([b[0] for b in RISK_BANDS])[np.searchsorted(edges, pd_, side="right")]


# --------------------------------------------------------------------------- main
def main():
    t0 = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    cohorts = generate_all()
    for c in cohorts.values():
        for col in ["revolver", "min_pay_only_3m", "cash_advance_6m"]:
            c[col] = c[col].map({True: "Y", False: "N"})

    # ---- 1. data quality
    dq = [r for name, df in cohorts.items() for r in data_quality.run_checks(df, name)]
    fails = [r for r in dq if r["status"] == "FAIL"]
    if fails:
        raise SystemExit(f"Data-quality failures, stopping: {fails}")
    print(f"DQ: {len(dq)} checks, {sum(r['status'] == 'WARN' for r in dq)} warnings")

    dev, oot, cur = cohorts["development"], cohorts["out_of_time"], cohorts["current_book"]
    train, test = train_test_split(dev, test_size=TEST_SIZE, random_state=SEED, stratify=dev["default_12m"])
    ytr, yte, yoot = train["default_12m"].astype(int), test["default_12m"].astype(int), oot["default_12m"].astype(int)

    # ---- 2. scorecard (champion)
    specs = fit_bins(train, ytr, NUMERIC, CATEGORICAL)
    all_feats = NUMERIC + CATEGORICAL
    Wtr = woe_frame(train, specs, all_feats)
    feats = select_features(specs, Wtr, ytr)
    lr = LogisticRegression(C=1e6, max_iter=2000).fit(Wtr[feats], ytr)
    sc = lambda df: lr.predict_proba(woe_frame(df, specs, feats))[:, 1]
    p_sc = {"train": sc(train), "test": sc(test), "oot": sc(oot)}
    print("Scorecard features:", feats)

    # ---- 3. gradient boosting (challenger)
    def gbm_frame(df):
        X = df[all_feats].copy()
        for c in CATEGORICAL:
            X[c] = pd.Categorical(X[c], categories=sorted(dev[c].unique()))
        return X
    gbm = HistGradientBoostingClassifier(learning_rate=0.05, max_iter=400, max_leaf_nodes=24,
                                         min_samples_leaf=80, l2_regularization=1.0,
                                         categorical_features="from_dtype", early_stopping=True,
                                         validation_fraction=0.15, random_state=SEED)
    gbm.fit(gbm_frame(train), ytr)
    p_gb = {"train": gbm.predict_proba(gbm_frame(train))[:, 1],
            "test": gbm.predict_proba(gbm_frame(test))[:, 1],
            "oot": gbm.predict_proba(gbm_frame(oot))[:, 1]}

    ys = {"train": ytr, "test": yte, "oot": yoot}
    comparison = [{"model": name, "sample": s, **summarise(ys[s], preds[s])}
                  for name, preds in [("Scorecard (WoE logistic)", p_sc), ("Gradient boosting", p_gb)]
                  for s in ["train", "test", "oot"]]
    for r in comparison:
        print(f"  {r['model']:26s} {r['sample']:5s} gini={r['gini']:.3f} ks={r['ks']:.3f} "
              f"bad={r['bad_rate']:.3%} pd={r['mean_pd']:.3%}")

    imp = permutation_importance(gbm, gbm_frame(test).iloc[:8000], yte.iloc[:8000], scoring="roc_auc",
                                 n_repeats=3, random_state=SEED)
    gbm_importance = sorted([{"feature": f, "label": LABELS[f], "importance": round(float(v), 5)}
                             for f, v in zip(all_feats, imp.importances_mean)], key=lambda r: -r["importance"])

    # ---- 4. post-model adjustment from out-of-time calibration drift
    pma = float(np.clip(yoot.mean() / p_sc["oot"].mean(), 1.0, 1.5))
    print(f"PMA (OOT actual / predicted) = {pma:.3f}")

    # ---- 5. score current book + stability monitoring
    cur = cur.copy()
    cur["pd_model"] = sc(cur)
    cur["pd_12m"] = np.clip(cur["pd_model"] * pma, 0.0005, 0.95)
    cur["pd_challenger"] = gbm.predict_proba(gbm_frame(cur))[:, 1]
    cur["score"] = to_score(cur["pd_model"].to_numpy())
    cur["risk_band"] = band(cur["pd_12m"].to_numpy())

    dev_score = pd.Series(to_score(sc(dev)))
    score_edges = np.unique(np.quantile(dev_score, np.linspace(0, 1, 11)[1:-1]))
    e = [int(x) for x in score_edges]
    score_labels = [f"< {e[0]}"] + [f"{a}-{b - 1}" for a, b in zip(e[:-1], e[1:])] + [f">= {e[-1]}"]
    cut = lambda s: pd.Series(np.searchsorted(score_edges, np.asarray(s), side="right")).map(
        dict(enumerate(score_labels)))
    psi_score_val, psi_score_rows = psi(cut(dev_score), cut(cur["score"]))
    order = {lab: i for i, lab in enumerate(score_labels)}
    psi_score_rows.sort(key=lambda r: order[r["bin"]])
    psi_oot_val, _ = psi(cut(dev_score), cut(pd.Series(to_score(p_sc["oot"]))))
    psi_features = []
    for f in feats:
        v, _ = psi(specs[f].assign(dev[f]), specs[f].assign(cur[f]))
        psi_features.append({"feature": f, "label": LABELS[f], "psi": round(v, 4), "rag": rag(v)})
    psi_features.sort(key=lambda r: -r["psi"])
    print(f"PSI score dev->current = {psi_score_val:.4f} ({rag(psi_score_val)})")

    # score distribution by good/bad on test (for the separation chart)
    s_test = to_score(p_sc["test"])
    hist_edges = np.arange(440, 760, 20)
    def hist(mask):
        h, _ = np.histogram(s_test[mask], bins=hist_edges)
        return h / max(h.sum(), 1)
    score_dist = [{"score": int(hist_edges[i]), "good": round(float(g), 4), "bad": round(float(b), 4)}
                  for i, (g, b) in enumerate(zip(hist((yte == 0).to_numpy()), hist((yte == 1).to_numpy())))]

    # ---- 6. export
    artifacts = {
        "model_comparison": comparison,
        "roc": {"Scorecard (WoE logistic)": roc_points(yte, p_sc["test"]),
                "Gradient boosting": roc_points(yte, p_gb["test"])},
        "calibration": {"test": calibration(yte, p_sc["test"]), "oot": calibration(yoot, p_sc["oot"])},
        "gains_table": gains_table(yte.to_numpy(), s_test),
        "scorecard": scorecard_points(specs, feats, lr),
        "information_value": sorted([{"feature": f, "label": LABELS[f], "iv": round(specs[f].iv, 4),
                                      "selected": f in feats} for f in all_feats], key=lambda r: -r["iv"]),
        "gbm_importance": gbm_importance,
        "psi": {"score_psi": round(psi_score_val, 4), "score_rag": rag(psi_score_val),
                "oot_score_psi": round(psi_oot_val, 4), "score_bins": psi_score_rows,
                "features": psi_features},
        "score_distribution": score_dist,
        "pma": {"factor": round(pma, 4), "oot_actual": round(float(yoot.mean()), 4),
                "oot_predicted": round(float(p_sc["oot"].mean()), 4),
                "rationale": "Out-of-time default rate exceeds model prediction (macro deterioration); "
                             "a multiplicative post-model adjustment is applied to current-book PDs "
                             "pending a full recalibration."},
        "dq_report": dq,
        "model_meta": {"champion": "Scorecard (WoE logistic)", "challenger": "Gradient boosting",
                       "features": [{"feature": f, "label": LABELS[f]} for f in feats],
                       "scaling": {"base_score": SCORE_BASE, "base_odds": SCORE_BASE_ODDS, "pdo": SCORE_PDO},
                       "samples": {"train": int(len(train)), "test": int(len(test)), "oot": int(len(oot)),
                                   "current_book": int(len(cur))},
                       "obs_dates": {k: v["obs_date"].iloc[0] for k, v in cohorts.items()},
                       "generated_at": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds")},
    }
    (OUT_DIR / "model_artifacts.json").write_text(json.dumps(artifacts, indent=1, default=float))

    cols = ["account_id", "obs_date", "age", "employment_status", "housing_status", "region",
            "annual_income", "months_on_book", "bureau_score", "delinq_24m", "searches_6m",
            "credit_limit", "balance", "utilisation", "external_unsecured_debt", "dti",
            "disposable_income_monthly", "revolver", "min_pay_only_3m", "cash_advance_6m",
            "monthly_spend", "apr", "score", "pd_model", "pd_12m", "pd_challenger", "risk_band"]
    out = cur[cols].copy()
    for c in ["revolver", "min_pay_only_3m", "cash_advance_6m"]:
        out[c] = out[c].eq("Y")
    for c in ["pd_model", "pd_12m", "pd_challenger"]:
        out[c] = out[c].round(6)
    out.to_csv(OUT_DIR / "accounts.csv", index=False)
    pd.concat([dev, oot]).to_csv(RAW_DIR / "development_and_oot.csv.gz", index=False)
    print(out.groupby("risk_band").agg(n=("account_id", "size"), pd=("pd_12m", "mean"), bal=("balance", "sum")))
    print(f"Done in {time.time() - t0:.1f}s -> {OUT_DIR}")


if __name__ == "__main__":
    main()
