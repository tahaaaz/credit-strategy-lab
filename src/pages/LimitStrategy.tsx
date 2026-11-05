import { useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Scatter,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { CLI_PARAMS, defaults, type Scenario } from "../../shared/params.ts";
import Controls from "../components/Controls";
import {
  axis, BandChip, ErrorBox, Fig, gainLoss, gbp, grid, Insights, Loading, num, pct, SERIES, signedGbp, Tip, usePost,
  type Insight,
} from "../lib";

interface Summary {
  accounts: number; eligible: number; eligible_rate: number; total_increase: number; avg_increase: number | null;
  d_balance: number; d_revenue: number; d_funding: number; d_el: number; d_net: number; d_capital: number;
  d_raroc: number | null; loss_to_revenue: number | null; eligible_loss_making: number;
}
interface Band { risk_band: string; accounts: number; eligible: number; total_increase: number; d_balance: number; d_revenue: number; d_el: number; d_net: number; d_raroc: number | null }
interface CliResponse { summary: Summary; by_band: Band[]; waterfall: { decision: string; accounts: number }[]; insights: Insight[] }
interface Point { max_pd: number; increase_pct: number; eligible: number; total_increase: number; d_net: number; d_el: number; d_raroc: number | null; efficient: boolean; recommended?: boolean }
interface FrontierResponse { points: Point[]; hurdle: number; el_budget: number }
interface Driver { key: string; label: string; base: number; low: number; high: number; low_net: number; high_net: number }
interface SensResponse { base_net: number; drivers: Driver[] }
interface ScenResponse { scenarios: { scenario: Scenario; summary: Summary }[] }

const SCEN_LABEL: Record<string, string> = { base: "Base case", mild: "Mild downturn", severe: "Severe stress" };
type Values = Record<string, number | boolean>;

export default function LimitStrategy() {
  const [params, setParams] = useState<Values>(() => defaults(CLI_PARAMS));
  const [scenario, setScenario] = useState<Scenario>("base");
  const [elBudget, setElBudget] = useState(75_000);

  const { max_pd: _a, increase_pct: _b, ...gridless } = params;
  const cli = usePost<CliResponse>("cli", { params, scenario });
  const frontier = usePost<FrontierResponse>("cli/frontier", { params: gridless, scenario, el_budget: elBudget }, 700);
  const sens = usePost<SensResponse>("cli/sensitivity", { params, scenario }, 900);
  const scen = usePost<ScenResponse>("cli/scenarios", { params }, 900);

  const s = cli.data?.summary;
  const rec = frontier.data?.points.find((p) => p.recommended);

  return (
    <>
      <header className="page-head">
        <h1>Credit limit increase strategy, {SCEN_LABEL[scenario].toLowerCase()}</h1>
        {cli.error ? <ErrorBox message={cli.error} /> : !s ? (
          <p className="statement loading">Running the policy across the book…</p>
        ) : s.eligible === 0 ? (
          <p className="statement">No account passes this policy. Relax the PD cut-off or the affordability rules to find customers to offer more credit.</p>
        ) : (
          <p className={`statement${cli.loading ? " busy" : ""}`} aria-live="polite">
            Offer <Fig>{num(s.eligible)}</Fig> customers an average <Fig>{gbp(s.avg_increase)}</Fig> more credit.
            Over 12 months that <Fig>{gainLoss(s.d_net)}</Fig> of contribution at <Fig>{pct(s.d_raroc, 0)}</Fig> RAROC,
            after <Fig>{gbp(s.d_el)}</Fig> of extra expected loss.
          </p>
        )}
      </header>

      <div className="bench">
        <Controls specs={CLI_PARAMS} values={params} onChange={setParams} scenario={scenario} onScenario={setScenario}
          onReset={() => { setParams(defaults(CLI_PARAMS)); setScenario("base"); }} />

        <div className={cli.loading && cli.data ? "busy" : undefined}>
          {s && (
            <>
              <dl className="ledger">
                <div><dt>Eligible</dt><dd>{num(s.eligible)}<small>{pct(s.eligible_rate)} of the book</small></dd></div>
                <div><dt>New credit lines</dt><dd>{gbp(s.total_increase)}<small>{gbp(s.d_balance)} expected drawn</small></dd></div>
                <div><dt>Extra revenue</dt><dd>{gbp(s.d_revenue)}<small>{gbp(s.d_funding)} funding cost</small></dd></div>
                <div><dt>Extra expected loss</dt><dd>{gbp(s.d_el)}<small>{pct(s.loss_to_revenue, 0)} of extra revenue</small></dd></div>
                <div><dt>Net contribution</dt><dd className={s.d_net < 0 ? "negv" : undefined}>{signedGbp(s.d_net)}<small>RAROC {pct(s.d_raroc, 0)}</small></dd></div>
              </dl>

              <section className="section">
                <h2>What the numbers say</h2>
                <Insights items={cli.data!.insights} />
              </section>

              <section className="section grid-2">
                <PolicyFunnel waterfall={cli.data!.waterfall} total={s.accounts} />
                <div className="panel table-wrap">
                  <h3>Impact by risk band</h3>
                  <p className="note">Incremental 12-month economics of the accounts offered an increase.</p>
                  <table>
                    <thead><tr><th>Band</th><th>Offered</th><th>New credit</th><th>Net</th><th>RAROC</th></tr></thead>
                    <tbody>
                      {cli.data!.by_band.map((b) => (
                        <tr key={b.risk_band}>
                          <td><BandChip band={b.risk_band} /></td>
                          <td>{num(b.eligible)}</td>
                          <td>{gbp(b.total_increase)}</td>
                          <td className={b.d_net < 0 ? "negv" : undefined}>{b.eligible ? signedGbp(b.d_net) : "none"}</td>
                          <td>{b.eligible ? pct(b.d_raroc, 0) : "none"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          <section className="section">
            <h2>Efficient frontier</h2>
            <p className="sub">
              Thirty policies tested: six PD cut-offs × five increase sizes, with the other settings as chosen. A policy is on the
              frontier when no other earns more for less expected loss. The recommendation is the most profitable policy that clears
              the RAROC hurdle and keeps extra expected loss within the risk appetite of{" "}
              <select className="inline" value={elBudget} onChange={(e) => setElBudget(Number(e.target.value))} aria-label="Expected loss budget">
                {[25_000, 50_000, 75_000, 100_000, 150_000, 250_000].map((v) => <option key={v} value={v}>{gbp(v)}</option>)}
              </select>.
            </p>
            {frontier.error ? <ErrorBox message={frontier.error} /> : !frontier.data ? <Loading what="Testing 30 policies" /> : (
              <div className={`panel${frontier.loading ? " busy" : ""}`}>
                <Frontier data={frontier.data} current={params} />
                {rec ? (
                  <p style={{ margin: "12px 0 0", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <span>
                      Recommended: PD cut-off <b>{pct(rec.max_pd, 1)}</b>, increase <b>{pct(rec.increase_pct, 0)}</b> of limit,
                      for {signedGbp(rec.d_net)} at {pct(rec.d_raroc, 0)} RAROC.
                    </span>
                    <button type="button" className="btn-quiet" onClick={() => setParams({ ...params, max_pd: rec.max_pd, increase_pct: rec.increase_pct })}>
                      Use this policy
                    </button>
                  </p>
                ) : <p className="note" style={{ margin: "12px 0 0" }}>No policy clears both the hurdle and the risk appetite. Raise the budget or loosen the other settings.</p>}
              </div>
            )}
          </section>

          <section className="section">
            <div className="panel">
              <h3>What could move the answer</h3>
              <p className="note">Change in net contribution when one assumption moves and everything else holds.</p>
              {sens.error ? <ErrorBox message={sens.error} /> : !sens.data ? <Loading /> : <Tornado data={sens.data} busy={sens.loading} />}
            </div>
            <div className="panel" style={{ marginTop: 20 }}>
              <h3>Under stress</h3>
              <p className="note">The same policy run under each economic scenario.</p>
              {scen.error ? <ErrorBox message={scen.error} /> : !scen.data ? <Loading /> : (
                <div className={`table-wrap${scen.loading ? " busy" : ""}`}>
                  <table>
                    <thead><tr><th>Scenario</th><th>Offered</th><th>Exp. loss</th><th>Net</th><th>RAROC</th></tr></thead>
                    <tbody>
                      {scen.data.scenarios.map((r) => (
                        <tr key={r.scenario} style={r.scenario === scenario ? { fontWeight: 600 } : undefined}>
                          <td>{SCEN_LABEL[r.scenario]}</td>
                          <td>{num(r.summary.eligible)}</td>
                          <td>{gbp(r.summary.d_el)}</td>
                          <td className={r.summary.d_net < 0 ? "negv" : undefined}>{signedGbp(r.summary.d_net)}</td>
                          <td>{pct(r.summary.d_raroc, 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="note" style={{ marginTop: 12 }}>
                    Under stress, higher PDs push more customers over the cut-off, so the policy tightens on its own.
                    Fewer customers qualify, and those who do still clear the hurdle.
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function PolicyFunnel({ waterfall, total }: { waterfall: { decision: string; accounts: number }[]; total: number }) {
  const rules = waterfall.filter((w) => w.decision !== "Eligible").sort((a, b) => a.decision.localeCompare(b.decision));
  const eligible = waterfall.find((w) => w.decision === "Eligible")?.accounts ?? 0;
  let remaining = total;
  return (
    <div className="panel table-wrap">
      <h3>Policy rules, applied in order</h3>
      <p className="note">Each account stops at the first rule it fails. Bars show the accounts still in play.</p>
      <table>
        <tbody>
          <tr><td className="l">All accounts</td><td>{num(total)}</td><td style={{ width: "40%" }}><Track v={1} /></td></tr>
          {rules.map((r) => {
            remaining -= r.accounts;
            return (
              <tr key={r.decision}>
                <td className="l" style={{ whiteSpace: "normal" }}>{r.decision}</td>
                <td style={{ color: "var(--ink-2)" }}>−{num(r.accounts)}</td>
                <td><Track v={remaining / total} /></td>
              </tr>
            );
          })}
          <tr><td className="l"><b>Offered an increase</b></td><td><b>{num(eligible)}</b></td><td><Track v={eligible / total} strong /></td></tr>
        </tbody>
      </table>
    </div>
  );
}

function Track({ v, strong }: { v: number; strong?: boolean }) {
  return (
    <span className="track" style={{ display: "block", width: "100%", minWidth: 80, height: 8, background: "var(--rule-soft)", borderRadius: 2, position: "relative" }}>
      <span className="fill" style={{ position: "absolute", inset: 0, width: `${Math.max(0.5, v * 100)}%`, background: strong ? "#0d366b" : SERIES.s1, borderRadius: "0 2px 2px 0" }} />
    </span>
  );
}

function Frontier({ data, current }: { data: FrontierResponse; current: Values }) {
  const pts = data.points.map((p) => ({ ...p, x: p.d_el, y: p.d_net }));
  const eff = pts.filter((p) => p.efficient).sort((a, b) => a.x - b.x);
  const rec = pts.filter((p) => p.recommended);
  const cur = pts.filter((p) => Math.abs(p.max_pd - Number(current.max_pd)) < 1e-9 && Math.abs(p.increase_pct - Number(current.increase_pct)) < 1e-9);
  const others = pts.filter((p) => !p.efficient);
  const tip = ({ payload }: { payload?: { payload?: unknown }[] }) => {
    const p = payload?.[0]?.payload as Point | undefined;
    return p ? <Tip title={`PD cut-off ${pct(p.max_pd, 1)}, increase ${pct(p.increase_pct, 0)}`} rows={[
      { label: "Offered", value: num(p.eligible) },
      { label: "Extra expected loss", value: gbp(p.d_el) },
      { label: "Net contribution", value: signedGbp(p.d_net) },
      { label: "RAROC", value: pct(p.d_raroc, 0) },
      { label: "On frontier", value: p.efficient ? "Yes" : "No" },
    ]} /> : null;
  };
  return (
    <>
      <div className="legend">
        <span><i className="dot" style={{ background: SERIES.s1 }} />On the frontier</span>
        <span><i className="dot" style={{ background: "#b9c0ca" }} />Dominated</span>
        <span><i className="dot" style={{ background: SERIES.s2 }} />Recommended</span>
        <span><i className="dot" style={{ background: "#fff", boxShadow: "inset 0 0 0 2px #16202e" }} />Your current policy</span>
        <span><i style={{ background: "#16202e" }} />Risk appetite</span>
      </div>
      <div className="chart" style={{ height: 320 }}>
        <ResponsiveContainer>
          <ComposedChart margin={{ top: 10, right: 20, left: 4, bottom: 18 }}>
            <CartesianGrid stroke="#e6e9ee" />
            <XAxis type="number" dataKey="x" {...axis} tickFormatter={(v) => gbp(v)} name="Expected loss"
              label={{ value: "Extra expected loss", position: "insideBottom", offset: -10, fill: "#4a5465", fontSize: 12 }} domain={[0, "auto"]} />
            <YAxis type="number" dataKey="y" {...axis} axisLine={false} tickFormatter={(v) => gbp(v)} width={60} name="Net" />
            <ReferenceLine x={data.el_budget} stroke="#16202e" strokeDasharray="4 3" />
            <ReferenceLine y={0} stroke="#b9c0ca" />
            <Tooltip content={tip} cursor={{ strokeDasharray: "3 3" }} />
            <Line data={eff} dataKey="y" stroke={SERIES.s1} strokeWidth={2} dot={false} isAnimationActive={false} legendType="none" tooltipType="none" />
            <Scatter data={others} fill="#b9c0ca" isAnimationActive={false} shape="circle" />
            <Scatter data={eff} fill={SERIES.s1} isAnimationActive={false} />
            <Scatter data={rec} isAnimationActive={false} shape={(p: { cx?: number; cy?: number }) => (
              <circle cx={p.cx} cy={p.cy} r={8} fill={SERIES.s2} stroke="#fff" strokeWidth={2} />)} />
            <Scatter data={cur} isAnimationActive={false} shape={(p: { cx?: number; cy?: number }) => (
              <circle cx={p.cx} cy={p.cy} r={11} fill="none" stroke="#16202e" strokeWidth={2} />)} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

function Tornado({ data, busy }: { data: SensResponse; busy: boolean }) {
  const rows = data.drivers.map((d) => ({ label: d.label, low: d.low_net - data.base_net, high: d.high_net - data.base_net, d }));
  return (
    <div className={busy ? "busy" : undefined}>
      <div className="legend">
        <span><i style={{ background: SERIES.s1 }} />Assumption lower</span>
        <span><i style={{ background: SERIES.s2 }} />Assumption higher</span>
      </div>
      <div className="chart" style={{ height: 260 }}>
        <ResponsiveContainer>
          <BarChart data={rows} layout="vertical" stackOffset="sign" margin={{ top: 4, right: 16, left: 4, bottom: 0 }}>
            <CartesianGrid stroke="#e6e9ee" horizontal={false} />
            <XAxis type="number" {...axis} tickFormatter={(v) => signedGbp(v)} />
            <YAxis type="category" dataKey="label" {...axis} width={170} interval={0} tick={{ fill: "#4a5465", fontSize: 12 }} />
            <ReferenceLine x={0} stroke="#16202e" />
            <Tooltip cursor={{ fill: "#f0f2f5" }} content={({ payload }) => {
              const r = payload?.[0]?.payload as (typeof rows)[number] | undefined;
              return r ? <Tip title={r.label} rows={[
                { label: "Lower: net", value: signedGbp(r.d.low_net) },
                { label: "Higher: net", value: signedGbp(r.d.high_net) },
                { label: "Base: net", value: signedGbp(data.base_net) },
              ]} /> : null;
            }} />
            <Bar dataKey="low" stackId="t" fill={SERIES.s1} maxBarSize={18} radius={2}>
              {rows.map((r) => <Cell key={r.label} fill={SERIES.s1} />)}
            </Bar>
            <Bar dataKey="high" stackId="t" fill={SERIES.s2} maxBarSize={18} radius={2} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="note" style={{ marginTop: 8 }}>
        Base case {signedGbp(data.base_net)}. The result is most exposed to {data.drivers[0].label.replace(/\s*\(.*\)/, "").toLowerCase()}.
        {["balance_build", "risk_elasticity"].includes(data.drivers[0].key)
          ? " That is a behavioural assumption, so test it with a champion/challenger trial on a sample of customers before full rollout."
          : " Monitor it monthly against plan once the strategy is live."}
      </p>
    </div>
  );
}
