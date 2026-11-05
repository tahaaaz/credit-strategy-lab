import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { axis, BandChip, ErrorBox, Fig, gbp, grid, Loading, num, pct, SERIES, Tip, useGet } from "../lib";

interface Kpis {
  accounts: number; total_balance: number; total_limit: number; utilisation: number;
  balance_weighted_pd: number; balance_weighted_apr: number; revenue: number; expected_loss: number;
  loss_rate: number; net_contribution: number; capital: number; raroc: number; roa: number;
}
export interface BandRow {
  risk_band: string; accounts: number; share_accounts: number; min_pd: number; max_pd: number; avg_pd: number;
  avg_score: number; balance: number; credit_limit: number; utilisation: number; apr: number; revenue: number;
  funding_cost: number; expected_loss: number; opex: number; net_contribution: number; raroc: number;
  share_loss_making: number;
}
interface Cell_ { util_band: string; risk_band: string; accounts: number; avg_pd: number; net_contribution: number; raroc: number }
interface Segment { dimension: string; segment: string; accounts: number; avg_pd: number; balance: number; loss_rate: number; net_contribution: number; raroc: number }
export interface PortfolioData {
  kpis: Kpis; bands: BandRow[]; matrix: Cell_[]; segments: Segment[];
  assumptions: { key: string; value: number; label: string; unit: string; description: string }[];
  scenarios: { name: string; label: string; pd_mult: number; lgd_add: number; cof_add: number; spend_mult: number; description: string }[];
}

const BANDS = ["A", "B", "C", "D", "E"];

/** Diverging colour around the hurdle: blue above, red below, grey at the hurdle. */
function rarocColor(r: number, hurdle: number) {
  const d = r - hurdle;
  const t = Math.min(1, Math.abs(d) / (d > 0 ? 1.2 : 0.6));
  const mix = (a: number[], b: number[]) => `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`;
  return d >= 0 ? mix([240, 239, 236], [28, 92, 171]) : mix([240, 239, 236], [208, 59, 59]);
}

export default function Portfolio() {
  const { data, error } = useGet<PortfolioData>("portfolio");
  const [dim, setDim] = useState("Employment");
  const hurdle = data?.assumptions.find((a) => a.key === "hurdle_rate")?.value ?? 0.15;

  const segs = useMemo(
    () => (data?.segments ?? []).filter((s) => s.dimension === dim).sort((a, b) => b.raroc - a.raroc),
    [data, dim],
  );
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading what="Loading portfolio" />;

  const { kpis: k, bands } = data;
  const e = bands.find((b) => b.risk_band === "E")!;
  const best = [...bands].sort((a, b) => b.raroc - a.raroc)[0];
  const elShareE = e.expected_loss / k.expected_loss;
  const maxNet = Math.max(...bands.map((b) => Math.abs(b.net_contribution)));
  const maxRaroc = Math.max(...bands.map((b) => b.raroc), hurdle);
  const dims = [...new Set(data.segments.map((s) => s.dimension))];
  const utilBands = [...new Set(data.matrix.map((m) => m.util_band))];

  return (
    <>
      <header className="page-head">
        <h1>Portfolio overview, 30 September 2025</h1>
        <p className="statement">
          The book returns <Fig>{pct(k.raroc, 0)}</Fig> on capital. Band E holds{" "}
          <Fig>{pct(e.accounts / k.accounts, 0)}</Fig> of accounts but{" "}
          <Fig>{pct(elShareE, 0)}</Fig> of expected loss. It returns <Fig>{pct(e.raroc, 1)}</Fig> on capital
          {e.raroc < hurdle ? `, below the ${pct(hurdle, 0)} hurdle` : ""}, against <Fig>{pct(best.raroc, 0)}</Fig> in band {best.risk_band}.
        </p>
        <p className="lede">
          Annual risk-adjusted economics for every account. Revenue is interest, interchange and fees.
          Costs are funding, expected loss (PD × LGD × EAD) and servicing. These economics feed the limit and pricing strategy pages.
        </p>
      </header>

      <dl className="ledger">
        <div><dt>Accounts</dt><dd>{num(k.accounts)}<small>{gbp(k.total_limit)} of limits</small></dd></div>
        <div><dt>Balances</dt><dd>{gbp(k.total_balance)}<small>{pct(k.utilisation)} utilised</small></dd></div>
        <div><dt>Revenue</dt><dd>{gbp(k.revenue)}<small>{pct(k.balance_weighted_apr / 100)} average APR</small></dd></div>
        <div><dt>Expected loss</dt><dd>{gbp(k.expected_loss)}<small>{pct(k.loss_rate)} of balances</small></dd></div>
        <div><dt>Net contribution</dt><dd>{gbp(k.net_contribution)}<small>{pct(k.roa)} return on assets</small></dd></div>
        <div><dt>RAROC</dt><dd>{pct(k.raroc)}<small>hurdle {pct(hurdle, 0)}</small></dd></div>
      </dl>

      <section className="section">
        <h2>Risk-reward by risk band</h2>
        <p className="sub">Bands are cut on the 12-month PD from the scorecard, including the post-model adjustment. Band A is lowest risk.</p>
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Band</th><th>PD range</th><th>Accounts</th><th>Balances</th><th>Util.</th><th>APR</th>
                <th>Revenue</th><th>Exp. loss</th><th>Net contribution</th><th>RAROC vs hurdle</th><th>Loss-making accts</th>
              </tr>
            </thead>
            <tbody>
              {bands.map((b) => (
                <tr key={b.risk_band}>
                  <td><BandChip band={b.risk_band} /></td>
                  <td>{pct(b.min_pd)} to {pct(b.max_pd)}</td>
                  <td>{num(b.accounts)}</td>
                  <td>{gbp(b.balance)}</td>
                  <td>{pct(b.utilisation, 0)}</td>
                  <td>{b.apr.toFixed(1)}%</td>
                  <td>{gbp(b.revenue)}</td>
                  <td>{gbp(b.expected_loss)}</td>
                  <td>
                    <div className="inline-bar">
                      {gbp(b.net_contribution)}
                      <span className="track"><span className="fill" style={{ width: `${(Math.abs(b.net_contribution) / maxNet) * 100}%`, background: b.net_contribution >= 0 ? SERIES.s1 : SERIES.neg }} /></span>
                    </div>
                  </td>
                  <td>
                    <div className="inline-bar">
                      <span className={b.raroc < hurdle ? "negv" : undefined}>{pct(b.raroc, 0)}</span>
                      <span className="track" title={`Hurdle ${pct(hurdle, 0)}`}>
                        <span className="fill" style={{ width: `${(Math.max(0, b.raroc) / maxRaroc) * 100}%`, background: b.raroc < hurdle ? SERIES.neg : SERIES.s1 }} />
                        <span style={{ position: "absolute", top: -3, bottom: -3, width: 2, background: "#16202e", left: `${(hurdle / maxRaroc) * 100}%` }} />
                      </span>
                    </div>
                  </td>
                  <td>{pct(b.share_loss_making, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section grid-2">
        <div className="panel">
          <h3>Where the profit comes from</h3>
          <p className="note">Annual revenue, expected loss and net contribution by band.</p>
          <div className="legend">
            <span><i style={{ background: SERIES.s1 }} />Revenue</span>
            <span><i style={{ background: SERIES.s2 }} />Expected loss</span>
            <span><i style={{ background: SERIES.s3 }} />Net contribution</span>
          </div>
          <div className="chart" style={{ height: 270 }}>
            <ResponsiveContainer>
              <BarChart data={bands} barGap={2} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="risk_band" {...axis} tickFormatter={(v) => `Band ${v}`} />
                <YAxis {...axis} axisLine={false} tickFormatter={(v) => gbp(v)} width={56} />
                <Tooltip cursor={{ fill: "#f0f2f5" }} content={({ payload }) => payload?.[0] ? (
                  <Tip title={`Band ${payload[0].payload.risk_band}`} rows={[
                    { label: "Revenue", value: gbp(payload[0].payload.revenue) },
                    { label: "Funding cost", value: gbp(payload[0].payload.funding_cost) },
                    { label: "Expected loss", value: gbp(payload[0].payload.expected_loss) },
                    { label: "Servicing", value: gbp(payload[0].payload.opex) },
                    { label: "Net contribution", value: gbp(payload[0].payload.net_contribution) },
                  ]} />) : null} />
                <Bar dataKey="revenue" fill={SERIES.s1} radius={[4, 4, 0, 0]} maxBarSize={22} />
                <Bar dataKey="expected_loss" fill={SERIES.s2} radius={[4, 4, 0, 0]} maxBarSize={22} />
                <Bar dataKey="net_contribution" fill={SERIES.s3} radius={[4, 4, 0, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel">
          <h3>RAROC by utilisation and risk band</h3>
          <p className="note">Blue cells beat the {pct(hurdle, 0)} hurdle, red cells destroy value. High-utilisation, high-risk customers are where losses concentrate.</p>
          <div className="heat" style={{ gridTemplateColumns: `76px repeat(${BANDS.length}, 1fr)` }} role="table" aria-label="RAROC by utilisation band and risk band">
            <div />
            {BANDS.map((b) => <div key={b} className="hdr">Band {b}</div>)}
            {utilBands.map((u) => (
              <div key={u} style={{ display: "contents" }} role="row">
                <div className="rowh">{u.replace(/^\d\.\s*/, "")}</div>
                {BANDS.map((b) => {
                  const c = data.matrix.find((m) => m.util_band === u && m.risk_band === b);
                  if (!c) return <div key={b} className="cell" style={{ background: "#f6f7f9", color: "#6b7484" }}>no accounts</div>;
                  const bg = rarocColor(c.raroc, hurdle);
                  const dark = Math.abs(c.raroc - hurdle) > (c.raroc > hurdle ? 0.6 : 0.3);
                  return (
                    <div key={b} className="cell" style={{ background: bg, color: dark ? "#fff" : "#16202e" }}
                      title={`${num(c.accounts)} accounts, PD ${pct(c.avg_pd)}, net ${gbp(c.net_contribution)}`}>
                      <b>{pct(c.raroc, 0)}</b>
                      <span style={{ opacity: 0.8 }}>{num(c.accounts)}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Segment returns</h2>
        <p className="sub">
          RAROC by customer segment, sorted, with the hurdle marked. Segment by{" "}
          <select className="inline" value={dim} onChange={(e) => setDim(e.target.value)} aria-label="Segment dimension">
            {dims.map((d) => <option key={d}>{d}</option>)}
          </select>
        </p>
        <div className="panel">
          <div className="chart" style={{ height: Math.max(180, segs.length * 34 + 30) }}>
            <ResponsiveContainer>
              <BarChart data={segs} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="#e6e9ee" horizontal={false} />
                <XAxis type="number" {...axis} tickFormatter={(v) => pct(v, 0)} />
                <YAxis type="category" dataKey="segment" {...axis} width={140} />
                <ReferenceLine x={hurdle} stroke="#16202e" strokeDasharray="4 3" label={{ value: "Hurdle", position: "top", fill: "#4a5465", fontSize: 12 }} />
                <Tooltip cursor={{ fill: "#f0f2f5" }} content={({ payload }) => payload?.[0] ? (
                  <Tip title={payload[0].payload.segment} rows={[
                    { label: "Accounts", value: num(payload[0].payload.accounts) },
                    { label: "Average PD", value: pct(payload[0].payload.avg_pd) },
                    { label: "Loss rate", value: pct(payload[0].payload.loss_rate) },
                    { label: "Net contribution", value: gbp(payload[0].payload.net_contribution) },
                    { label: "RAROC", value: pct(payload[0].payload.raroc) },
                  ]} />) : null} />
                <Bar dataKey="raroc" radius={[0, 4, 4, 0]} maxBarSize={18}>
                  {segs.map((s) => <Cell key={s.segment} fill={s.raroc < hurdle ? SERIES.neg : SERIES.s1} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>
    </>
  );
}
