"""Weight-of-Evidence binning for a traditional credit scorecard.

Numeric characteristics are fine-classed into quantile bins and then coarse-classed by
merging adjacent bins until the bad rate is monotonic (the standard requirement for a
scorecard to be explainable to Risk and model-validation teams). Categorical
characteristics are grouped by category, with small groups pooled into "Other".

Convention: WoE = ln(%good / %bad), so a higher WoE means lower risk.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

EPS = 0.5  # Laplace-style adjustment to avoid log(0)


@dataclass
class BinSpec:
    feature: str
    kind: str                         # "numeric" | "categorical"
    edges: list[float] = field(default_factory=list)     # numeric upper edges
    groups: dict[str, str] = field(default_factory=dict)  # categorical value -> group
    table: pd.DataFrame | None = None
    iv: float = 0.0

    def labels(self) -> list[str]:
        if self.kind == "categorical":
            return sorted(set(self.groups.values()))
        lab, lo = [], -np.inf
        for hi in self.edges:
            lab.append(_fmt_range(lo, hi))
            lo = hi
        return lab

    def assign(self, s: pd.Series) -> pd.Series:
        if self.kind == "categorical":
            return s.astype(str).map(self.groups).fillna("Other")
        idx = np.searchsorted(np.array(self.edges[:-1]), s.to_numpy(), side="left")
        return pd.Series(np.array(self.labels())[idx], index=s.index)

    def transform(self, s: pd.Series) -> pd.Series:
        woe = self.table.set_index("bin")["woe"]
        return self.assign(s).map(woe).fillna(0.0).astype(float)


def _fmt_range(lo, hi) -> str:
    def f(x):
        if np.isinf(x):
            return "inf"
        return f"{x:,.4g}"
    if np.isinf(lo):
        return f"<= {f(hi)}"
    if np.isinf(hi):
        return f"> {f(lo)}"
    return f"({f(lo)}, {f(hi)}]"


def _woe_table(bins: pd.Series, y: pd.Series, order: list[str]) -> pd.DataFrame:
    t = pd.DataFrame({"bin": bins, "bad": y}).groupby("bin", observed=True)["bad"].agg(["count", "sum"])
    t = t.reindex(order).fillna(0)
    t.columns = ["accounts", "bads"]
    t["goods"] = t["accounts"] - t["bads"]
    tg, tb = t["goods"].sum(), t["bads"].sum()
    pg = (t["goods"] + EPS) / (tg + EPS * len(t))
    pb = (t["bads"] + EPS) / (tb + EPS * len(t))
    t["bad_rate"] = t["bads"] / t["accounts"].clip(lower=1)
    t["woe"] = np.log(pg / pb)
    t["iv"] = (pg - pb) * t["woe"]
    t["pct_accounts"] = t["accounts"] / t["accounts"].sum()
    return t.reset_index()


def fit_numeric(x: pd.Series, y: pd.Series, max_bins: int = 8, min_pct: float = 0.04) -> BinSpec:
    qs = np.unique(np.nanquantile(x, np.linspace(0, 1, max_bins + 1)[1:-1]))
    edges = list(qs) + [np.inf]

    def stats(edges_):
        idx = np.searchsorted(np.array(edges_[:-1]), x.to_numpy(), side="left")
        g = pd.DataFrame({"b": idx, "y": y.to_numpy()}).groupby("b")["y"].agg(["mean", "count"])
        return g.reindex(range(len(edges_))).fillna(0)

    # 1) merge bins that are too small
    while len(edges) > 2:
        g = stats(edges)
        small = g.index[g["count"] < min_pct * len(x)]
        if len(small) == 0:
            break
        i = int(small[0])
        drop = i if i < len(edges) - 1 else i - 1
        edges.pop(drop)
    # 2) enforce a monotonic bad rate (direction set by overall correlation)
    direction = np.sign(np.corrcoef(x.fillna(x.median()), y)[0, 1]) or 1.0
    while len(edges) > 2:
        g = stats(edges)["mean"].to_numpy()
        diffs = np.diff(g) * direction
        bad = np.where(diffs < 0)[0]
        if len(bad) == 0:
            break
        edges.pop(int(bad[0]))
    spec = BinSpec(feature=x.name, kind="numeric", edges=edges)
    spec.table = _woe_table(spec.assign(x), y, spec.labels())
    spec.iv = float(spec.table["iv"].sum())
    return spec


def fit_categorical(x: pd.Series, y: pd.Series, min_pct: float = 0.03) -> BinSpec:
    share = x.astype(str).value_counts(normalize=True)
    groups = {k: (k if v >= min_pct else "Other") for k, v in share.items()}
    spec = BinSpec(feature=x.name, kind="categorical", groups=groups)
    spec.table = _woe_table(spec.assign(x), y, spec.labels())
    spec.iv = float(spec.table["iv"].sum())
    return spec


def fit_bins(df: pd.DataFrame, y: pd.Series, numeric: list[str], categorical: list[str]) -> dict[str, BinSpec]:
    specs = {c: fit_numeric(df[c].astype(float), y) for c in numeric}
    specs.update({c: fit_categorical(df[c], y) for c in categorical})
    return specs


def woe_frame(df: pd.DataFrame, specs: dict[str, BinSpec], features: list[str]) -> pd.DataFrame:
    return pd.DataFrame({f: specs[f].transform(df[f]) for f in features}, index=df.index)
