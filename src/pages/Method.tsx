import { ErrorBox, Loading, num, pct, useGet } from "../lib";
import type { PortfolioData } from "./Portfolio";

interface Run { id: number; created_at: string; kind: string; params: Record<string, unknown>; summary: Record<string, unknown> }

const KIND: Record<string, string> = {
  cli: "Limit strategy", pricing: "Re-pricing", frontier: "Frontier search", sensitivity: "Sensitivity", scenarios: "Stress test",
};

function fmtAssumption(v: number, unit: string) {
  if (unit === "GBP") return `£${num(v)}`;
  if (unit === "rate") return pct(v, 2);
  return v < 1 ? pct(v, 1) : String(v);
}

export default function Method() {
  const { data, error } = useGet<PortfolioData>("portfolio");
  const runs = useGet<Run[]>("runs");

  return (
    <>
      <header className="page-head">
        <h1>Method, assumptions and controls</h1>
        <p className="statement">
          Every number on this site comes from a model you can trace: synthetic data, a validated scorecard,
          explicit economics and stated behavioural assumptions, all kept in the database.
        </p>
      </header>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="prose">
          <h3>Data</h3>
          <p>
            Three cohorts of simulated UK credit card accounts: development (Dec 2023), out-of-time (Jun 2024) and the
            current book (Sep 2025). A hidden "true quality" factor drives noisy bureau and behavioural signals, and default
            depends on non-linear effects and interactions, so the models have to learn risk from imperfect data. Later cohorts
            drift: incomes rise with inflation, utilisation and credit searches creep up, and the macro environment worsens.
          </p>
          <h3>Probability of default</h3>
          <p>
            The champion is a Weight-of-Evidence logistic regression scorecard with monotonic coarse classing, information-value
            screening, a collinearity filter and sign checks. It is scaled to 600 points at 50:1 odds with 20 points to double
            the odds. The challenger is a histogram gradient-boosting model. Both are validated on a hold-out sample and an
            out-of-time sample for discrimination (Gini, KS), calibration (decile plots, Brier score) and stability (PSI).
            Out-of-time defaults run above prediction, so a multiplicative post-model adjustment is applied to current PDs.
          </p>
          <h3>Account economics</h3>
          <p>
            Revenue = interest on the interest-bearing balance + interchange + fees. Net contribution = revenue − funding cost −
            expected loss − servicing cost. Expected loss = PD × LGD × EAD, where EAD = balance + CCF × undrawn limit.
            RAROC = net contribution ÷ (capital ratio × risk weight × EAD).
          </p>
          <h3>Credit limit increases</h3>
          <p>
            Each account passes a sequential policy: risk (PD cut-off, delinquency), behaviour (utilisation, tenure, persistent
            minimum payments) and affordability (post-increase debt-to-income, and disposable income after repaying a fully drawn
            new limit at 3% a month, in line with FCA CONC 5.2A creditworthiness rules). Eligible customers draw part of their new
            headroom (balance build), and PD rises with the relative size of the increase (risk elasticity).
          </p>
          <h3>Re-pricing</h3>
          <p>
            APR changes by risk band. Attrition responds to price, most strongly for low-risk revolvers. PD rises with payment
            shock. Customers in persistent debt or recent arrears are protected from increases.
          </p>
          <h3>Limitations</h3>
          <ul>
            <li>The horizon is 12 months. Lifetime value, and the future revenue lost when a customer leaves, are not discounted in.</li>
            <li>Behavioural responses (balance build, elasticity) are assumptions. In practice they would be measured with a champion/challenger test before rollout.</li>
            <li>Capital is a simplified standardised-approach proxy, not an IRB calculation.</li>
            <li>The data is synthetic. The methods carry over to real data, but these specific results do not.</li>
          </ul>
        </div>

        <div>
          {error ? <ErrorBox message={error} /> : !data ? <Loading /> : (
            <>
              <div className="panel table-wrap">
                <h3>Economic assumptions</h3>
                <p className="note">Stored in the <code>assumptions</code> table and read by every simulation.</p>
                <table>
                  <tbody>
                    {data.assumptions.map((a) => (
                      <tr key={a.key} title={a.description}>
                        <td className="l">{a.label}<div style={{ fontSize: 12, color: "var(--ink-3)", whiteSpace: "normal" }}>{a.description}</div></td>
                        <td>{fmtAssumption(a.value, a.unit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="panel table-wrap" style={{ marginTop: 20 }}>
                <h3>Stress scenarios</h3>
                <table>
                  <thead><tr><th>Scenario</th><th>PD</th><th>LGD</th><th>Funding</th><th>Spend</th></tr></thead>
                  <tbody>
                    {data.scenarios.map((s) => (
                      <tr key={s.name} title={s.description}>
                        <td>{s.label}</td><td>×{s.pd_mult.toFixed(2)}</td><td>+{(s.lgd_add * 100).toFixed(0)}pp</td>
                        <td>+{(s.cof_add * 1e4).toFixed(0)}bp</td><td>×{s.spend_mult.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      <section className="section">
        <h2>How it is built</h2>
        <p className="sub">
          Python builds the data and models offline. Postgres holds the book and runs the strategy engines as set-based SQL
          next to the data. A serverless API checks every input, runs scenario and sensitivity sweeps, and writes the recommendations.
        </p>
        <pre className="arch">{`Python pipeline (pandas, scikit-learn)                  Supabase Postgres
  generate cohorts -> data quality checks     seed       accounts, model_artifacts, assumptions, scenarios
  WoE scorecard + gradient boosting          ------>     views: portfolio KPIs, band summary, segments (GROUPING SETS)
  Gini / KS / calibration / PSI / PMA                    functions: account_economics, simulate_cli, simulate_pricing
                                                         audit: simulation_runs (row-level security)
                                                                   ^
                                                                   | REST / RPC
React + Recharts (this site)   --/api-->   Netlify Function: validate inputs, frontier grid,
                                           sensitivity sweep, stress scenarios, written insights`}</pre>
      </section>

      <section className="section">
        <h2>Audit trail</h2>
        <p className="sub">Every simulation run is logged with its parameters and result, the record a strategy change would need for sign-off.</p>
        <div className="panel table-wrap">
          {runs.error ? <ErrorBox message={runs.error} /> : !runs.data ? <Loading /> : runs.data.length === 0 ? (
            <p className="note" style={{ margin: 0 }}>No runs yet. Run a strategy on the limit or pricing page and it will appear here.</p>
          ) : (
            <table>
              <thead><tr><th>Time (UTC)</th><th className="l">Run</th><th className="l">Scenario</th><th>Net contribution</th></tr></thead>
              <tbody>
                {runs.data.map((r) => {
                  const net = (r.summary.d_net ?? r.summary.base_net) as number | undefined;
                  return (
                    <tr key={r.id}>
                      <td>{r.created_at.slice(0, 19).replace("T", " ")}</td>
                      <td className="l">{KIND[r.kind] ?? r.kind}</td>
                      <td className="l">{String(r.params.scenario ?? "all")}</td>
                      <td>{typeof net === "number" ? `£${num(net)}` : "n/a"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}
