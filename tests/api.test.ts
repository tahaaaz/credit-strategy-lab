import assert from "node:assert/strict";
import { test } from "node:test";
import { CLI_PARAMS, PRICING_PARAMS, defaults, sanitize, sanitizeScenario } from "../shared/params.ts";
import { analyseFrontier, cliInsights, pricingInsights, type CliResult, type FrontierPoint } from "../netlify/functions/lib/insights.ts";

test("sanitize clamps, coerces and drops unknown keys", () => {
  const p = sanitize({ max_pd: 5, increase_pct: "0.4", min_mob: "abc", exclude_min_pay: "false", evil: "drop table" }, CLI_PARAMS);
  assert.equal(p.max_pd, 0.2);            // clamped to max
  assert.equal(p.increase_pct, 0.4);      // string -> number
  assert.equal(p.min_mob, 6);             // invalid -> default
  assert.equal(p.exclude_min_pay, false); // string -> boolean
  assert.ok(!("evil" in p));
  assert.deepEqual(sanitize(null, PRICING_PARAMS), defaults(PRICING_PARAMS));
});

test("scenario whitelist", () => {
  assert.equal(sanitizeScenario("severe"), "severe");
  assert.equal(sanitizeScenario("'; drop"), "base");
});

test("every default lies inside its own range", () => {
  for (const s of [...CLI_PARAMS, ...PRICING_PARAMS]) {
    if (s.format === "bool") continue;
    assert.ok((s.default as number) >= s.min && (s.default as number) <= s.max, s.key);
  }
});

const pt = (max_pd: number, increase_pct: number, d_net: number, d_el: number, d_raroc: number): FrontierPoint =>
  ({ max_pd, increase_pct, eligible: 1, total_increase: 1, d_net, d_el, d_revenue: d_net + d_el, d_raroc });

test("frontier marks dominated points and respects hurdle + loss budget", () => {
  const pts = analyseFrontier([
    pt(0.01, 0.1, 100, 10, 0.5),
    pt(0.02, 0.1, 90, 20, 0.5),   // dominated: less profit, more loss
    pt(0.05, 0.3, 300, 60, 0.4),
    pt(0.10, 0.5, 400, 150, 0.1), // most profitable but below hurdle
  ], 0.15, 100);
  assert.equal(pts.find((p) => p.max_pd === 0.02)!.efficient, false);
  assert.equal(pts.find((p) => p.max_pd === 0.10)!.efficient, true);
  assert.deepEqual(pts.filter((p) => p.recommended).map((p) => p.max_pd), [0.05]);
  assert.equal(analyseFrontier(pts, 0.15, 50).find((p) => p.recommended)!.max_pd, 0.01);
});

test("cli insights flag bands below hurdle", () => {
  const r: CliResult = {
    summary: { accounts: 100, eligible: 10, eligible_rate: 0.1, total_increase: 10000, avg_increase: 1000,
      d_balance: 5000, d_revenue: 1000, d_funding: 200, d_el: 500, d_net: 300, d_capital: 1000, d_ead: 8000,
      d_raroc: 0.3, loss_to_revenue: 0.5, eligible_loss_making: 2 },
    by_band: [{ risk_band: "D", accounts: 10, eligible: 5, total_increase: 5000, d_balance: 1, d_revenue: 1, d_el: 2, d_net: -50, d_raroc: -0.1 }],
    waterfall: [{ decision: "1. PD above cut-off", accounts: 60 }, { decision: "8. Affordability: disposable income", accounts: 30 }, { decision: "Eligible", accounts: 10 }],
    params: {},
  };
  const titles = cliInsights(r, 0.15).map((i) => i.title).join(" | ");
  assert.match(titles, /Band D below hurdle/);
  assert.match(titles, /Loss-to-revenue/);
  assert.match(titles, /30 accounts declined on affordability/);
  assert.equal(cliInsights({ ...r, summary: { ...r.summary, eligible: 0 } }, 0.15)[0].title, "No eligible accounts");
});

test("pricing insights call out adverse selection", () => {
  const ins = pricingInsights({
    summary: { accounts: 10, increased: 5, decreased: 0, excluded: 2, extra_attriters: 1, d_balance: -10, d_revenue: -5, d_el: -1, d_funding: -1, d_net: -3 },
    by_band: [{ risk_band: "A", accounts: 5, increased: 5, decreased: 0, excluded: 0, apr_old: 22, apr_new: 24, attrition_delta: 0.1, d_balance: -10, d_revenue: -5, d_el: -1, d_funding: -1, d_net: -3 }],
    params: {},
  });
  assert.equal(ins[0].tone, "negative");
  assert.match(ins[1].title, /band A/);
});
