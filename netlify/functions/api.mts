// Credit Strategy Lab API (Netlify Functions v2) - a thin backend-for-frontend:
// validates input, calls the SQL strategy engines in Supabase, runs scenario / sensitivity
// sweeps, and adds the written recommendation.
import type { Config } from "@netlify/functions";
import { CLI_PARAMS, PRICING_PARAMS, sanitize, sanitizeScenario, SCENARIOS } from "../../shared/params.ts";
import { DbError, pool, rpc, select } from "./lib/db.ts";
import {
  analyseFrontier, cliInsights, pricingInsights,
  type CliResult, type FrontierPoint, type PricingResult,
} from "./lib/insights.ts";

const FRONTIER_PD = [0.01, 0.02, 0.03, 0.05, 0.075, 0.1];
const FRONTIER_INC = [0.1, 0.2, 0.3, 0.5, 0.75];

type Json = Record<string, unknown>;

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cache },
  });

async function readBody(req: Request): Promise<Json> {
  if (req.method !== "POST") return {};
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Json) : {};
  } catch {
    return {};
  }
}

async function context() {
  const [assumptions, scenarios] = await Promise.all([
    select<{ key: string; value: number }[]>("assumptions", "select=key,value"),
    select<{ name: string; pd_mult: number; lgd_add: number; cof_add: number }[]>("scenarios", "select=*"),
  ]);
  return { a: Object.fromEntries(assumptions.map((r) => [r.key, r.value])), scenarios };
}

function log(kind: string, params: unknown, summary: unknown) {
  // audit trail: best effort, never blocks or fails the user request
  return rpc("log_simulation_run", { kind, params, summary }).catch(() => undefined);
}

// ------------------------------------------------------------------ handlers
async function portfolio() {
  const [kpis, bands, matrix, segments, assumptions, scenarios] = await Promise.all([
    select<Json[]>("v_portfolio_kpis"),
    select<Json[]>("v_band_summary"),
    select<Json[]>("v_util_risk_matrix"),
    select<Json[]>("v_segment_summary"),
    select<Json[]>("assumptions", "select=*&order=key"),
    select<Json[]>("scenarios", "select=*&order=sort_order"),
  ]);
  return json({ kpis: kpis[0], bands, matrix, segments, assumptions, scenarios }, 200, "public, max-age=300");
}

async function model() {
  const rows = await select<{ key: string; payload: unknown }[]>("model_artifacts", "select=key,payload");
  return json(Object.fromEntries(rows.map((r) => [r.key, r.payload])), 200, "public, max-age=3600");
}

async function cli(body: Json) {
  const params = sanitize(body.params, CLI_PARAMS);
  const scenario = sanitizeScenario(body.scenario);
  const [result, ctx] = await Promise.all([
    rpc<CliResult>("simulate_cli", { p: { ...params, scenario } }),
    context(),
  ]);
  const insights = cliInsights(result, ctx.a.hurdle_rate ?? 0.15);
  await log("cli", { ...params, scenario }, result.summary);
  return json({ ...result, scenario, insights });
}

async function frontier(body: Json) {
  const params = sanitize(body.params, CLI_PARAMS);
  const scenario = sanitizeScenario(body.scenario);
  const grid = FRONTIER_PD.flatMap((max_pd) => FRONTIER_INC.map((increase_pct) => ({ max_pd, increase_pct })));
  const [results, ctx] = await Promise.all([
    pool(grid, 6, (g) => rpc<CliResult>("simulate_cli", { p: { ...params, ...g, scenario } })),
    context(),
  ]);
  const points: FrontierPoint[] = results.map((r, i) => ({
    ...grid[i],
    eligible: r.summary.eligible, total_increase: r.summary.total_increase ?? 0,
    d_net: r.summary.d_net ?? 0, d_el: r.summary.d_el ?? 0, d_revenue: r.summary.d_revenue ?? 0,
    d_raroc: r.summary.d_raroc,
  }));
  const elBudget = Math.min(1e6, Math.max(1e4, Number(body.el_budget) || 75_000));
  const analysed = analyseFrontier(points, ctx.a.hurdle_rate ?? 0.15, elBudget);
  await log("frontier", { ...params, scenario, el_budget: elBudget }, analysed.find((p) => p.recommended) ?? {});
  return json({ points: analysed, scenario, hurdle: ctx.a.hurdle_rate ?? 0.15, el_budget: elBudget });
}

async function sensitivity(body: Json) {
  const params = sanitize(body.params, CLI_PARAMS);
  const scenario = sanitizeScenario(body.scenario);
  const { a, scenarios } = await context();
  const sc = scenarios.find((s) => s.name === scenario) ?? { pd_mult: 1, lgd_add: 0, cof_add: 0 };
  const p = params as Record<string, number>;
  const drivers = [
    { key: "pd_mult", label: "PD level (±20%)", base: sc.pd_mult, low: sc.pd_mult * 0.8, high: sc.pd_mult * 1.2 },
    { key: "lgd", label: "LGD (±10%)", base: a.lgd, low: a.lgd * 0.9, high: Math.min(1, a.lgd * 1.1) },
    { key: "cost_of_funds", label: "Cost of funds (±100bp)", base: a.cost_of_funds, low: a.cost_of_funds - 0.01, high: a.cost_of_funds + 0.01 },
    { key: "ccf", label: "Credit conversion factor (±20%)", base: a.ccf, low: a.ccf * 0.8, high: Math.min(1, a.ccf * 1.2) },
    { key: "balance_build", label: "Balance build (±30%)", base: p.balance_build, low: p.balance_build * 0.7, high: p.balance_build * 1.3 },
    { key: "risk_elasticity", label: "Risk elasticity (±50%)", base: p.risk_elasticity, low: p.risk_elasticity * 0.5, high: p.risk_elasticity * 1.5 },
  ];
  const runs = [{ key: "_base", value: 0 }, ...drivers.flatMap((d) => [
    { key: d.key, value: d.low }, { key: d.key, value: d.high },
  ])];
  const results = await pool(runs, 6, (r) =>
    rpc<CliResult>("simulate_cli", { p: { ...params, scenario, ...(r.key === "_base" ? {} : { [r.key]: r.value }) } }),
  );
  const baseNet = results[0].summary.d_net ?? 0;
  const bars = drivers.map((d, i) => ({
    ...d,
    low_net: results[1 + 2 * i].summary.d_net ?? 0,
    high_net: results[2 + 2 * i].summary.d_net ?? 0,
  })).sort((x, y) => Math.abs(y.high_net - y.low_net) - Math.abs(x.high_net - x.low_net));
  await log("sensitivity", { ...params, scenario }, { base_net: baseNet });
  return json({ base_net: baseNet, drivers: bars, scenario });
}

async function scenarioRun(body: Json) {
  const params = sanitize(body.params, CLI_PARAMS);
  const results = await Promise.all(SCENARIOS.map((s) => rpc<CliResult>("simulate_cli", { p: { ...params, scenario: s } })));
  const out = SCENARIOS.map((s, i) => ({ scenario: s, summary: results[i].summary, by_band: results[i].by_band }));
  await log("scenarios", params, out.map((o) => ({ scenario: o.scenario, d_net: o.summary.d_net })));
  return json({ scenarios: out });
}

async function pricing(body: Json) {
  const params = sanitize(body.params, PRICING_PARAMS);
  const scenario = sanitizeScenario(body.scenario);
  const result = await rpc<PricingResult>("simulate_pricing", { p: { ...params, scenario } });
  await log("pricing", { ...params, scenario }, result.summary);
  return json({ ...result, scenario, insights: pricingInsights(result) });
}

async function health() {
  try {
    await select("scenarios", "select=name&limit=1");
    return json({ ok: true, database: "connected" });
  } catch (e) {
    return json({ ok: false, database: (e as Error).message }, 503);
  }
}

// ------------------------------------------------------------------ router
const routes: Record<string, (body: Json) => Promise<Response>> = {
  "GET /api/health": health,
  "GET /api/portfolio": portfolio,
  "GET /api/model": model,
  "GET /api/params": async () => json({ cli: CLI_PARAMS, pricing: PRICING_PARAMS, scenarios: SCENARIOS }, 200, "public, max-age=3600"),
  "GET /api/runs": async () => json(await select("v_recent_runs")),
  "POST /api/cli": cli,
  "POST /api/cli/frontier": frontier,
  "POST /api/cli/sensitivity": sensitivity,
  "POST /api/cli/scenarios": scenarioRun,
  "POST /api/pricing": pricing,
};

export default async (req: Request) => {
  const path = new URL(req.url).pathname.replace(/\/$/, "");
  const handler = routes[`${req.method} ${path}`];
  if (!handler) return json({ error: `No route for ${req.method} ${path}` }, 404);
  try {
    return await handler(await readBody(req));
  } catch (e) {
    const status = e instanceof DbError ? e.status : 500;
    console.error(e);
    return json({ error: (e as Error).message }, status);
  }
};

export const config: Config = { path: "/api/*" };
