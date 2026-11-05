import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { defaults, PRICING_PARAMS, type Scenario } from "../../shared/params.ts";
import Controls from "../components/Controls";
import {
  axis, BandChip, ErrorBox, Fig, gainLoss, gbp, grid, Insights, num, pct, SERIES, signedGbp, Tip, usePost, type Insight,
} from "../lib";

interface Band {
  risk_band: string; accounts: number; increased: number; decreased: number; excluded: number; apr_old: number;
  apr_new: number; attrition_delta: number; d_balance: number; d_revenue: number; d_el: number; d_funding: number; d_net: number;
}
interface PricingResponse {
  summary: { accounts: number; increased: number; decreased: number; excluded: number; extra_attriters: number;
    d_balance: number; d_revenue: number; d_el: number; d_funding: number; d_net: number };
  by_band: Band[]; insights: Insight[];
}
const SCEN_LABEL: Record<string, string> = { base: "base case", mild: "mild downturn", severe: "severe stress" };
type Values = Record<string, number | boolean>;

export default function Pricing() {
  const [params, setParams] = useState<Values>(() => defaults(PRICING_PARAMS));
  const [scenario, setScenario] = useState<Scenario>("base");
  const protectedOn = Boolean(params.exclude_persistent) || Boolean(params.exclude_delinquent);

  const run = usePost<PricingResponse>("pricing", { params, scenario });
  const unprotected = usePost<PricingResponse>("pricing", {
    params: { ...params, exclude_persistent: false, exclude_delinquent: false }, scenario,
  }, 600);
  const s = run.data?.summary;
  const protectionCost = protectedOn && unprotected.data && s ? unprotected.data.summary.d_net - s.d_net : null;

  return (
    <>
      <header className="page-head">
        <h1>Risk-based re-pricing, {SCEN_LABEL[scenario]}</h1>
        {run.error ? <ErrorBox message={run.error} /> : !s ? (
          <p className="statement loading">Re-pricing the book…</p>
        ) : (
          <p className={`statement${run.loading ? " busy" : ""}`} aria-live="polite">
            Raising the APR for <Fig>{num(s.increased)}</Fig> customers
            {s.decreased > 0 && <> and cutting it for <Fig>{num(s.decreased)}</Fig></>}{" "}
            <Fig>{gainLoss(s.d_net)}</Fig> a year of contribution, with <Fig>{num(Math.max(0, s.extra_attriters))}</Fig> more customers expected to leave.
            {protectionCost != null && protectionCost > 0 && (
              <> Protecting <Fig>{num(s.excluded)}</Fig> customers in financial difficulty gives up <Fig>{gbp(protectionCost)}</Fig> a year.</>
            )}
          </p>
        )}
        <p className="lede">
          Each account's full annual contribution is compared before and after the change, weighted by the chance the customer stays.
          Low-risk revolvers are the most price-sensitive. An across-the-board increase pushes out the best customers first and
          leaves a riskier book (adverse selection).
        </p>
      </header>

      <div className="bench">
        <Controls specs={PRICING_PARAMS} values={params} onChange={setParams} scenario={scenario} onScenario={setScenario}
          onReset={() => { setParams(defaults(PRICING_PARAMS)); setScenario("base"); }} />

        <div className={run.loading && run.data ? "busy" : undefined}>
          {s && run.data && (
            <>
              <dl className="ledger">
                <div><dt>Re-priced</dt><dd>{num(s.increased + s.decreased)}<small>{num(s.increased)} up, {num(s.decreased)} down</small></dd></div>
                <div><dt>Protected</dt><dd>{num(s.excluded)}<small>kept on current APR</small></dd></div>
                <div><dt>Revenue change</dt><dd>{signedGbp(s.d_revenue)}<small>{signedGbp(s.d_balance)} balances</small></dd></div>
                <div><dt>Expected loss change</dt><dd>{signedGbp(s.d_el)}<small>incl. payment shock</small></dd></div>
                <div><dt>Net contribution</dt><dd className={s.d_net < 0 ? "negv" : undefined}>{signedGbp(s.d_net)}<small>per year</small></dd></div>
              </dl>

              <section className="section">
                <h2>What the numbers say</h2>
                <Insights items={run.data.insights} />
              </section>

              <section className="section">
                <h2>By risk band</h2>
                <div className="panel table-wrap">
                  <table>
                    <thead>
                      <tr><th>Band</th><th>Accounts</th><th>APR before</th><th>APR after</th><th>Protected</th><th>Attrition</th>
                        <th>Balances</th><th>Revenue</th><th>Exp. loss</th><th>Net</th></tr>
                    </thead>
                    <tbody>
                      {run.data.by_band.map((b) => (
                        <tr key={b.risk_band}>
                          <td><BandChip band={b.risk_band} /></td>
                          <td>{num(b.accounts)}</td>
                          <td>{b.apr_old.toFixed(1)}%</td>
                          <td>{b.apr_new.toFixed(1)}%</td>
                          <td>{num(b.excluded)}</td>
                          <td>{b.attrition_delta >= 0 ? "+" : ""}{pct(b.attrition_delta)}</td>
                          <td>{signedGbp(b.d_balance)}</td>
                          <td>{signedGbp(b.d_revenue)}</td>
                          <td>{signedGbp(b.d_el)}</td>
                          <td className={b.d_net < 0 ? "negv" : undefined}><b>{signedGbp(b.d_net)}</b></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="section grid-2">
                <div className="panel">
                  <h3>Net contribution change by band</h3>
                  <p className="note">Blue bands gain value, red bands lose it.</p>
                  <div className="chart" style={{ height: 250 }}>
                    <ResponsiveContainer>
                      <BarChart data={run.data.by_band} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid {...grid} />
                        <XAxis dataKey="risk_band" {...axis} tickFormatter={(v) => `Band ${v}`} />
                        <YAxis {...axis} axisLine={false} tickFormatter={(v) => signedGbp(v)} width={60} />
                        <ReferenceLine y={0} stroke="#16202e" />
                        <Tooltip cursor={{ fill: "#f0f2f5" }} content={({ payload }) => payload?.[0] ? (
                          <Tip title={`Band ${payload[0].payload.risk_band}`} rows={[
                            { label: "Revenue", value: signedGbp(payload[0].payload.d_revenue) },
                            { label: "Expected loss", value: signedGbp(payload[0].payload.d_el) },
                            { label: "Funding", value: signedGbp(payload[0].payload.d_funding) },
                            { label: "Net", value: signedGbp(payload[0].payload.d_net) },
                          ]} />) : null} />
                        <Bar dataKey="d_net" radius={4} maxBarSize={36}>
                          {run.data.by_band.map((b) => <Cell key={b.risk_band} fill={b.d_net < 0 ? SERIES.neg : SERIES.s1} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div className="panel">
                  <h3>Things to try</h3>
                  <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--ink-2)", fontSize: 14 }}>
                    <li style={{ marginBottom: 8 }}>Set every band to +2pp. Bands A and B lose more in attrition than they gain in margin.</li>
                    <li style={{ marginBottom: 8 }}>Cut band A by 1pp. It keeps good customers, but the lost margin on existing balances is bigger than the retention gain.</li>
                    <li style={{ marginBottom: 8 }}>Turn off customer protection to see the revenue it gives up. That is the cost of the Consumer Duty outcome.</li>
                    <li>Switch to severe stress. Re-pricing high-risk bands is worth more when PDs rise.</li>
                  </ul>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
