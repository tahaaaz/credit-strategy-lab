import { useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { axis, ErrorBox, Fig, grid, Loading, num, pct, Rag, SERIES, Tip, useGet } from "../lib";

interface Metric { model: string; sample: string; auc: number; gini: number; ks: number; brier: number; bad_rate: number; mean_pd: number; n: number }
interface Artifacts {
  model_comparison: Metric[];
  roc: Record<string, { fpr: number; tpr: number }[]>;
  calibration: { test: Calib[]; oot: Calib[] };
  gains_table: { decile: number; min_score: number; max_score: number; accounts: number; bads: number; bad_rate: number; cum_bad_capture: number; lift: number }[];
  scorecard: { feature: string; label: string; bin: string; accounts: number; bad_rate: number; woe: number; points: number }[];
  information_value: { feature: string; label: string; iv: number; selected: boolean }[];
  gbm_importance: { feature: string; label: string; importance: number }[];
  psi: { score_psi: number; score_rag: string; oot_score_psi: number; score_bins: { bin: string; expected: number; actual: number; psi: number }[]; features: { feature: string; label: string; psi: number; rag: string }[] };
  score_distribution: { score: number; good: number; bad: number }[];
  pma: { factor: number; oot_actual: number; oot_predicted: number; rationale: string };
  dq_report: { cohort: string; check: string; status: string; detail: string }[];
  model_meta: { champion: string; challenger: string; samples: Record<string, number>; obs_dates: Record<string, string>; scaling: { base_score: number; base_odds: number; pdo: number }; features: { feature: string; label: string }[] };
}
interface Calib { decile: number; predicted: number; actual: number; n: number }

const SC = "Scorecard (WoE logistic)";
const GB = "Gradient boosting";
const SAMPLE_LABEL: Record<string, string> = { train: "Train", test: "Test", oot: "Out-of-time" };
const COHORT_LABEL: Record<string, string> = { development: "Development", out_of_time: "Out-of-time", current_book: "Current book" };

export default function Model() {
  const { data, error } = useGet<Artifacts>("model");
  const [feature, setFeature] = useState<string>("utilisation");
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading what="Loading model results" />;

  const m = (model: string, sample: string) => data.model_comparison.find((r) => r.model === model && r.sample === sample)!;
  const scTest = m(SC, "test"), scOot = m(SC, "oot"), gbTest = m(GB, "test"), gbTrain = m(GB, "train");
  const calib = data.calibration.test.map((t, i) => ({ decile: t.decile, predicted: t.predicted, test: t.actual, oot: data.calibration.oot[i]?.actual }));
  const bins = data.scorecard.filter((r) => r.feature === feature);
  const feats = [...new Set(data.scorecard.map((r) => r.feature))];
  const dqFails = data.dq_report.filter((d) => d.status !== "PASS");
  const top3 = data.gains_table.slice(0, 3).at(-1)!;

  return (
    <>
      <header className="page-head">
        <h1>Probability of default model</h1>
        <p className="statement">
          The scorecard ranks risk with a Gini of <Fig>{scTest.gini.toFixed(3)}</Fig> on unseen accounts and{" "}
          <Fig>{scOot.gini.toFixed(3)}</Fig> out of time. Gradient boosting reaches {gbTest.gini.toFixed(3)} on the same test set
          after scoring {gbTrain.gini.toFixed(3)} in training. That is overfitting with no lift, so the explainable scorecard stays champion.
        </p>
        <p className="lede">
          Trained on {num(data.model_meta.samples.train)} accounts observed {data.model_meta.obs_dates.development} with a 12-month
          default outcome (90+ days past due or charged off). Validated on a {num(data.model_meta.samples.test)}-account hold-out
          and a {num(data.model_meta.samples.oot)}-account out-of-time sample from {data.model_meta.obs_dates.out_of_time}.
        </p>
      </header>

      <section className="section">
        <h2>Champion and challenger</h2>
        <p className="sub">Discrimination (Gini, KS) and accuracy (Brier score, predicted vs actual bad rate) on each sample.</p>
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Model</th><th>Sample</th><th>Accounts</th><th>Gini</th><th>KS</th><th>AUC</th><th>Brier</th><th>Actual bad rate</th><th>Predicted PD</th></tr></thead>
            <tbody>
              {data.model_comparison.map((r) => (
                <tr key={r.model + r.sample}>
                  <td>{r.model === SC ? "Scorecard (champion)" : "Gradient boosting (challenger)"}</td>
                  <td>{SAMPLE_LABEL[r.sample]}</td><td>{num(r.n)}</td>
                  <td><b>{r.gini.toFixed(3)}</b></td><td>{r.ks.toFixed(3)}</td><td>{r.auc.toFixed(3)}</td>
                  <td>{r.brier.toFixed(4)}</td><td>{pct(r.bad_rate, 2)}</td><td>{pct(r.mean_pd, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section grid-2">
        <div className="panel">
          <h3>ROC curve, test sample</h3>
          <p className="note">The two curves overlap almost exactly: the extra complexity buys nothing.</p>
          <div className="legend">
            <span><i style={{ background: SERIES.s1 }} />Scorecard, Gini {scTest.gini.toFixed(3)}</span>
            <span><i style={{ background: SERIES.s2 }} />Gradient boosting, Gini {gbTest.gini.toFixed(3)}</span>
          </div>
          <div className="chart" style={{ height: 260 }}>
            <ResponsiveContainer>
              <LineChart margin={{ top: 6, right: 12, left: 0, bottom: 14 }}>
                <CartesianGrid {...grid} vertical />
                <XAxis dataKey="fpr" type="number" domain={[0, 1]} {...axis} tickFormatter={(v) => pct(v, 0)} label={{ value: "False positive rate", position: "insideBottom", offset: -8, fill: "#4a5465", fontSize: 12 }} />
                <YAxis type="number" domain={[0, 1]} {...axis} axisLine={false} tickFormatter={(v) => pct(v, 0)} width={44} />
                <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="#b9c0ca" strokeDasharray="4 3" />
                <Tooltip content={({ payload }) => payload?.[0] ? (
                  <Tip title={`False positive rate ${pct(payload[0].payload.fpr)}`} rows={[
                    { label: "True positive rate", value: pct(payload[0].payload.tpr) },
                  ]} />) : null} />
                <Line data={data.roc[SC]} dataKey="tpr" name="Scorecard" stroke={SERIES.s1} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line data={data.roc[GB]} dataKey="tpr" name="Gradient boosting" stroke={SERIES.s2} strokeWidth={2} dot={false} strokeDasharray="5 3" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel">
          <h3>Score separation, test sample</h3>
          <p className="note">Share of good and bad accounts at each score. Base {data.model_meta.scaling.base_score} points at {data.model_meta.scaling.base_odds}:1 odds, {data.model_meta.scaling.pdo} points to double the odds.</p>
          <div className="legend">
            <span><i style={{ background: SERIES.s1 }} />Goods</span>
            <span><i style={{ background: SERIES.s2 }} />Bads (defaulted)</span>
          </div>
          <div className="chart" style={{ height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={data.score_distribution} margin={{ top: 6, right: 12, left: 0, bottom: 14 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="score" {...axis} label={{ value: "Score", position: "insideBottom", offset: -8, fill: "#4a5465", fontSize: 12 }} />
                <YAxis {...axis} axisLine={false} tickFormatter={(v) => pct(v, 0)} width={44} />
                <Tooltip content={({ payload }) => payload?.[0] ? (
                  <Tip title={`Score ${payload[0].payload.score} to ${payload[0].payload.score + 19}`} rows={[
                    { label: "Goods", value: pct(payload[0].payload.good) },
                    { label: "Bads", value: pct(payload[0].payload.bad) },
                  ]} />) : null} />
                <Line dataKey="good" stroke={SERIES.s1} strokeWidth={2} dot={false} type="monotone" isAnimationActive={false} />
                <Line dataKey="bad" stroke={SERIES.s2} strokeWidth={2} dot={false} type="monotone" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className="section grid-2">
        <div className="panel">
          <h3>Calibration by PD decile</h3>
          <p className="note">
            Accurate on the test sample, but out of time the actual default rate ({pct(data.pma.oot_actual, 2)}) runs above
            prediction ({pct(data.pma.oot_predicted, 2)}). A post-model adjustment of ×{data.pma.factor.toFixed(3)} is applied to
            current-book PDs until the model is recalibrated.
          </p>
          <div className="legend">
            <span><i style={{ background: SERIES.ink3 }} />Predicted PD</span>
            <span><i className="dot" style={{ background: SERIES.s1 }} />Actual, test</span>
            <span><i className="dot" style={{ background: SERIES.s2 }} />Actual, out-of-time</span>
          </div>
          <div className="chart" style={{ height: 250 }}>
            <ResponsiveContainer>
              <LineChart data={calib} margin={{ top: 6, right: 12, left: 0, bottom: 14 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="decile" {...axis} label={{ value: "PD decile (1 = lowest risk)", position: "insideBottom", offset: -8, fill: "#4a5465", fontSize: 12 }} />
                <YAxis {...axis} axisLine={false} scale="log" domain={["auto", "auto"]} ticks={[0.001, 0.003, 0.01, 0.03, 0.1, 0.3]}
                  tickFormatter={(v) => pct(v, v < 0.01 ? 1 : 0)} width={44} allowDataOverflow />
                <Tooltip content={({ payload }) => payload?.[0] ? (
                  <Tip title={`Decile ${payload[0].payload.decile}`} rows={[
                    { label: "Predicted", value: pct(payload[0].payload.predicted, 2) },
                    { label: "Actual, test", value: pct(payload[0].payload.test, 2) },
                    { label: "Actual, out-of-time", value: pct(payload[0].payload.oot, 2) },
                  ]} />) : null} />
                <Line dataKey="predicted" stroke={SERIES.ink3} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line dataKey="test" stroke="none" dot={{ r: 4.5, fill: SERIES.s1, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
                <Line dataKey="oot" stroke="none" dot={{ r: 4.5, fill: SERIES.s2, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel table-wrap">
          <h3>Gains table, test sample</h3>
          <p className="note">The riskiest 30% of accounts by score capture {pct(top3.cum_bad_capture, 0)} of all defaults.</p>
          <table>
            <thead><tr><th>Decile</th><th>Score range</th><th>Accounts</th><th>Bad rate</th><th>Lift</th><th>Defaults captured</th></tr></thead>
            <tbody>
              {data.gains_table.map((g) => (
                <tr key={g.decile}>
                  <td>{g.decile}</td><td>{g.min_score} to {g.max_score}</td><td>{num(g.accounts)}</td>
                  <td>{pct(g.bad_rate)}</td><td>{g.lift.toFixed(2)}×</td>
                  <td>
                    <div className="inline-bar">{pct(g.cum_bad_capture, 0)}
                      <span className="track"><span className="fill" style={{ width: `${g.cum_bad_capture * 100}%`, background: SERIES.s1 }} /></span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <h2>Scorecard</h2>
        <p className="sub">
          Each characteristic is binned so the bad rate moves in one direction, then converted to Weight of Evidence.
          Characteristics are kept when they show real predictive power (information value of 0.02 or more), are not
          highly correlated (|r| below 0.7) and have an intuitive sign. Choose one to see its points.
        </p>
        <div className="grid-2">
          <div className="panel">
            <h3>Information value</h3>
            <p className="note">Blue bars are in the scorecard; dark blue is the one shown on the right. Grey bars were tested and dropped.</p>
            <div className="chart" style={{ height: 470 }}>
              <ResponsiveContainer>
                <BarChart data={data.information_value} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}
                  onClick={(e) => { const f = (e?.activePayload?.[0]?.payload as { feature: string; selected: boolean } | undefined); if (f?.selected) setFeature(f.feature); }}>
                  <CartesianGrid stroke="#e6e9ee" horizontal={false} />
                  <XAxis type="number" dataKey="iv" domain={[0, (max: number) => Math.ceil(max * 2) / 2]} tickCount={5} {...axis} tickFormatter={(v) => Number(v).toFixed(1)} />
                  <YAxis type="category" dataKey="label" {...axis} width={168} interval={0} />
                  <Tooltip cursor={{ fill: "#f0f2f5" }} content={({ payload }) => payload?.[0] ? (
                    <Tip title={payload[0].payload.label} rows={[
                      { label: "Information value", value: payload[0].payload.iv.toFixed(3) },
                      { label: "In scorecard", value: payload[0].payload.selected ? "Yes" : "No" },
                    ]} />) : null} />
                  <Bar dataKey="iv" radius={[0, 4, 4, 0]} maxBarSize={16} style={{ cursor: "pointer" }}>
                    {data.information_value.map((r) => (
                      <Cell key={r.feature} fill={!r.selected ? "#c3c9d2" : r.feature === feature ? "#0d366b" : SERIES.s1} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="panel table-wrap">
            <h3>
              Points for{" "}
              <select className="inline" value={feature} onChange={(e) => setFeature(e.target.value)} aria-label="Scorecard characteristic">
                {feats.map((f) => <option key={f} value={f}>{data.scorecard.find((r) => r.feature === f)!.label}</option>)}
              </select>
            </h3>
            <p className="note">Higher points mean lower risk. A customer's score is the sum of their points across all {feats.length} characteristics.</p>
            <table>
              <thead><tr><th>Attribute</th><th>Accounts</th><th>Bad rate</th><th>WoE</th><th>Points</th></tr></thead>
              <tbody>
                {bins.map((b) => {
                  const lo = Math.min(...bins.map((x) => x.points)), hi = Math.max(...bins.map((x) => x.points));
                  return (
                    <tr key={b.bin}>
                      <td className="l">{b.bin}</td><td>{num(b.accounts)}</td><td>{pct(b.bad_rate)}</td><td>{b.woe.toFixed(3)}</td>
                      <td>
                        <div className="inline-bar"><b>{b.points}</b>
                          <span className="track"><span className="fill" style={{ width: `${hi === lo ? 100 : ((b.points - lo) / (hi - lo)) * 92 + 8}%`, background: SERIES.s1 }} /></span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Stability monitoring</h2>
        <p className="sub">
          Population stability index (PSI) from development to the current book. Below 0.10 is stable, 0.10 to 0.25 needs
          monitoring, above 0.25 needs action. The score PSI is {data.psi.score_psi.toFixed(3)} (<Rag value={data.psi.score_rag} />),
          but utilisation and credit searches are drifting up. Customers are using more of their limits and applying for more credit elsewhere.
        </p>
        <div className="grid-2">
          <div className="panel">
            <h3>Score distribution: development vs current book</h3>
            <div className="legend" style={{ marginTop: 8 }}>
              <span><i style={{ background: SERIES.ink3 }} />Development</span>
              <span><i style={{ background: SERIES.s1 }} />Current book</span>
            </div>
            <div className="chart" style={{ height: 250 }}>
              <ResponsiveContainer>
                <BarChart data={data.psi.score_bins} barGap={2} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...grid} />
                  <XAxis dataKey="bin" {...axis} interval={0} angle={-35} textAnchor="end" height={52} tick={{ fill: "#4a5465", fontSize: 11 }} />
                  <YAxis {...axis} axisLine={false} tickFormatter={(v) => pct(v, 0)} width={40} />
                  <Tooltip cursor={{ fill: "#f0f2f5" }} content={({ payload }) => payload?.[0] ? (
                    <Tip title={`Score ${payload[0].payload.bin}`} rows={[
                      { label: "Development", value: pct(payload[0].payload.expected) },
                      { label: "Current book", value: pct(payload[0].payload.actual) },
                      { label: "PSI contribution", value: payload[0].payload.psi.toFixed(4) },
                    ]} />) : null} />
                  <Bar dataKey="expected" fill="#b9c0ca" radius={[4, 4, 0, 0]} maxBarSize={18} />
                  <Bar dataKey="actual" fill={SERIES.s1} radius={[4, 4, 0, 0]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="panel table-wrap">
            <h3>Characteristic stability</h3>
            <table>
              <thead><tr><th>Characteristic</th><th>PSI</th><th>Status</th></tr></thead>
              <tbody>
                {data.psi.features.map((f) => (
                  <tr key={f.feature}><td>{f.label}</td><td>{f.psi.toFixed(4)}</td><td><Rag value={f.rag} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Data quality controls</h2>
        <p className="sub">
          {data.dq_report.length} automated checks run on every cohort before training. Any failure stops the pipeline.
          {dqFails.length ? ` ${dqFails.length} warnings were raised and reviewed:` : " All checks passed."}
        </p>
        <div className="panel table-wrap">
          {dqFails.length > 0 && <table>
            <thead><tr><th>Cohort</th><th className="l">Check</th><th className="l">Result</th><th>Status</th></tr></thead>
            <tbody>
              {dqFails.map((d, i) => (
                <tr key={i}><td>{COHORT_LABEL[d.cohort]}</td><td className="l">{d.check}</td><td className="l">{d.detail}</td><td><Rag value={d.status} /></td></tr>
              ))}
            </tbody>
          </table>}
          <details style={{ marginTop: dqFails.length ? 12 : 0 }}>
            <summary style={{ cursor: "pointer", color: "var(--ink-2)", fontSize: 14 }}>
              Show the {data.dq_report.length - dqFails.length} checks that passed
            </summary>
            <table style={{ marginTop: 8 }}>
              <tbody>
                {data.dq_report.filter((d) => d.status === "PASS").map((d, i) => (
                  <tr key={i}><td>{COHORT_LABEL[d.cohort]}</td><td className="l">{d.check}</td><td className="l">{d.detail}</td><td><Rag value={d.status} /></td></tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      </section>
    </>
  );
}
