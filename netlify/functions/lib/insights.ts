// Turns simulation output into the plain-English recommendation a decision analyst would
// write for a strategy paper. Deterministic rules, so every statement is traceable.

export interface CliSummary {
  accounts: number; eligible: number; eligible_rate: number; total_increase: number;
  avg_increase: number | null; d_balance: number; d_revenue: number; d_funding: number;
  d_el: number; d_net: number; d_capital: number; d_ead: number; d_raroc: number | null;
  loss_to_revenue: number | null; eligible_loss_making: number;
}
export interface CliBand {
  risk_band: string; accounts: number; eligible: number; total_increase: number;
  d_balance: number; d_revenue: number; d_el: number; d_net: number; d_raroc: number | null;
}
export interface CliResult {
  summary: CliSummary; by_band: CliBand[]; waterfall: { decision: string; accounts: number }[];
  params: Record<string, unknown>;
}
export interface PricingBand {
  risk_band: string; accounts: number; increased: number; decreased: number; excluded: number;
  apr_old: number; apr_new: number; attrition_delta: number; d_balance: number;
  d_revenue: number; d_el: number; d_funding: number; d_net: number;
}
export interface PricingResult {
  summary: { accounts: number; increased: number; decreased: number; excluded: number;
    extra_attriters: number; d_balance: number; d_revenue: number; d_el: number;
    d_funding: number; d_net: number };
  by_band: PricingBand[];
  params: Record<string, unknown>;
}
export interface Insight { tone: "positive" | "warning" | "negative" | "neutral"; title: string; detail: string }
export interface FrontierPoint {
  max_pd: number; increase_pct: number; eligible: number; total_increase: number;
  d_net: number; d_el: number; d_revenue: number; d_raroc: number | null;
  efficient?: boolean; recommended?: boolean;
}

const gbp = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `£${(a / 1e6).toFixed(2)}m` : a >= 1e3 ? `£${(a / 1e3).toFixed(0)}k` : `£${a.toFixed(0)}`;
  return v < 0 ? `-${s}` : s;
};
const pct = (v: number | null | undefined, d = 1) => (v == null ? "n/a" : `${(v * 100).toFixed(d)}%`);
const n = (v: number) => Math.round(v).toLocaleString("en-GB");

export function cliInsights(r: CliResult, hurdle: number): Insight[] {
  const s = r.summary;
  const out: Insight[] = [];
  if (!s.eligible) {
    return [{ tone: "warning", title: "No eligible accounts",
      detail: "The policy is so tight that no account qualifies. Relax the PD cut-off or the affordability rules." }];
  }
  const raroc = s.d_raroc ?? 0;
  out.push({
    tone: s.d_net > 0 && raroc >= hurdle ? "positive" : s.d_net > 0 ? "warning" : "negative",
    title: `${s.d_net >= 0 ? "+" : ""}${gbp(s.d_net)} incremental 12-month contribution`,
    detail: `${n(s.eligible)} accounts (${pct(s.eligible_rate)}) receive an average ${gbp(s.avg_increase ?? 0)} increase. ` +
      `That adds ${gbp(s.d_balance)} of balances and ${gbp(s.d_revenue)} of revenue against ${gbp(s.d_el)} of extra expected loss. ` +
      `Incremental RAROC is ${pct(raroc)} against a ${pct(hurdle, 0)} hurdle.`,
  });
  const weak = r.by_band.filter((b) => b.eligible > 0 && (b.d_net < 0 || (b.d_raroc ?? 0) < hurdle));
  if (weak.length) {
    out.push({ tone: "warning", title: `Band ${weak.map((b) => b.risk_band).join(", ")} below hurdle`,
      detail: weak.map((b) => `Band ${b.risk_band}: ${gbp(b.d_net)} net, RAROC ${pct(b.d_raroc)}`).join("; ") +
        ". Consider tightening the PD cut-off or giving these bands a smaller increase." });
  }
  if ((s.loss_to_revenue ?? 0) > 0.35) {
    out.push({ tone: "warning", title: `Loss-to-revenue of ${pct(s.loss_to_revenue)}`,
      detail: "More than a third of incremental revenue is eaten by expected loss, so the strategy is sensitive to a downturn. Check the stress scenarios." });
  }
  const excl = r.waterfall.filter((w) => w.decision !== "Eligible").sort((a, b) => b.accounts - a.accounts)[0];
  if (excl) {
    out.push({ tone: "neutral", title: `Largest exclusion: ${excl.decision.replace(/^\d+\.\s*/, "")}`,
      detail: `${n(excl.accounts)} accounts (${pct(excl.accounts / s.accounts)} of the book) stop at this rule.` });
  }
  const aff = r.waterfall.filter((w) => w.decision.includes("Affordability")).reduce((a, w) => a + w.accounts, 0);
  if (aff > 0) {
    out.push({ tone: "neutral", title: `${n(aff)} accounts declined on affordability`,
      detail: "These customers pass the risk rules but would not be able to repay a fully-drawn higher limit, so they are excluded under the creditworthiness rules (CONC 5.2A)." });
  }
  return out;
}

export function pricingInsights(r: PricingResult): Insight[] {
  const s = r.summary;
  const out: Insight[] = [{
    tone: s.d_net > 0 ? "positive" : "negative",
    title: `${s.d_net >= 0 ? "+" : ""}${gbp(s.d_net)} net contribution impact`,
    detail: `${n(s.increased)} accounts re-priced up and ${n(s.decreased)} down. Revenue changes by ${gbp(s.d_revenue)}, ` +
      `expected loss by ${gbp(s.d_el)}, and an extra ${n(s.extra_attriters)} customers are expected to leave.`,
  }];
  const destroyers = r.by_band.filter((b) => (b.increased > 0 || b.decreased > 0) && b.d_net < 0);
  if (destroyers.length) {
    out.push({ tone: "warning", title: `Value lost in band ${destroyers.map((b) => b.risk_band).join(", ")}`,
      detail: destroyers.map((b) => `Band ${b.risk_band}: ${gbp(b.d_net)} (attrition +${pct(b.attrition_delta)})`).join("; ") +
        ". Price elasticity outweighs the margin gain, so lower-risk customers are most likely to leave (adverse selection)." });
  }
  if (s.excluded > 0) {
    out.push({ tone: "neutral", title: `${n(s.excluded)} customers protected from increases`,
      detail: "Persistent-debt and recently delinquent customers keep their current rate. Use the toggle to see the revenue this protection gives up. That number is the cost of good customer outcomes under Consumer Duty." });
  }
  return out;
}

/**
 * Mark the efficient frontier (no other point earns more for less expected loss) and
 * recommend the most profitable point that clears the RAROC hurdle and stays within the
 * incremental expected-loss budget (risk appetite).
 */
export function analyseFrontier(points: FrontierPoint[], hurdle: number, elBudget = Infinity): FrontierPoint[] {
  const pts = points.map((p) => ({ ...p }));
  for (const p of pts) {
    p.efficient = !pts.some((q) => q !== p && q.d_net >= p.d_net && q.d_el <= p.d_el && (q.d_net > p.d_net || q.d_el < p.d_el));
  }
  const ok = pts.filter((p) => p.d_net > 0 && (p.d_raroc ?? 0) >= hurdle && p.d_el <= elBudget);
  const best = ok.sort((a, b) => b.d_net - a.d_net)[0];
  if (best) best.recommended = true;
  return pts.sort((a, b) => a.max_pd - b.max_pd || a.increase_pct - b.increase_pct);
}
