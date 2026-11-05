# Credit Strategy Lab

**Credit limit and pricing decisions for a UK credit card portfolio**, with a PD scorecard, risk-reward economics, policy simulation, stress testing and model monitoring. It runs end to end on Python, SQL (Postgres/Supabase), a serverless API and a React front end.

**Live demo:** _add your Netlify URL here_

> All customer data is synthetic: 30,000 simulated accounts generated to behave like a real card book. No real customer data is used.

---

## The business question

A card issuer wants to grow profitably without taking risk it can't afford. Two levers matter most:

1. **Credit limit increases (CLI).** Who gets more credit, how much, and is it affordable for them?
2. **Risk-based re-pricing.** Which customers' APR should change, and what does that do to attrition, losses and conduct risk?

This project answers both with the workflow a decision analyst in unsecured lending would follow: build and validate a PD model, put every account on a risk-adjusted P&L, then simulate strategies under base and stress scenarios before recommending one.

## Headline findings (synthetic book, base case)

| | |
|---|---|
| **Portfolio** | £84m of balances returning **72% RAROC**. Band E holds 16% of accounts but **59% of expected loss**, and returns 26% against 145% in band D. |
| **Low-risk transactors** | 46% of band A accounts lose money. They pay in full, so interchange doesn't cover servicing and funding. Growth should target engaged revolvers instead. |
| **PD model** | The WoE scorecard reaches Gini **0.756** (test) and 0.750 (out-of-time). Gradient boosting scores 0.840 in training but only 0.755 on test: overfitting with no lift, so the explainable scorecard stays champion. |
| **Monitoring** | Score PSI is stable (0.03), but **utilisation (0.14) and credit searches (0.11) are amber**. Out-of-time defaults run 7% above prediction, so a **×1.074 post-model adjustment** is applied. |
| **Limit strategy** | The default policy offers 6,119 customers an average £1.8k, worth **+£389k a year at 58% RAROC**, but it needs £116k of extra expected loss. With an expected-loss budget of £75k, the frontier recommends **PD ≤ 2%, +30% of limit: +£322k for £68k of expected loss.** |
| **Stress** | Under severe stress (PD ×1.9, LGD +6pp, funding +150bp) the same policy still earns +£218k at 36% RAROC, above the 15% hurdle. |
| **Sensitivity** | The result is most exposed to **balance build** (how much new headroom customers draw). It should be measured with a champion/challenger test before full rollout. |
| **Pricing** | A blanket +2pp loses **£160k** because bands A and B are price-sensitive (adverse selection). Protecting persistent-debt and delinquent customers costs **£123k a year**: the measurable cost of Consumer Duty outcomes. |

## How this maps to the Decision Analyst role

| Job requirement | Where it is in this project |
|---|---|
| Strong data skills in SAS, SQL & Python | Python pipeline (`pipeline/`); strategy engines in SQL (`supabase/schema.sql`: CTE chains, window functions, `GROUPING SETS`, set-returning functions, RLS); SAS port of the scorecard (`sas/pd_scorecard.sas`) |
| Predictive statistical models, ML & risk-reward models | WoE logistic scorecard vs gradient boosting; account-level RAROC model (revenue − funding − PD×LGD×EAD − opex) |
| Pricing and limit strategies in unsecured lending | CLI simulator with policy waterfall, affordability and response modelling; APR re-pricing with elasticity, adverse selection and payment shock |
| Sensitivity analysis and scenario planning | Tornado sensitivity on 6 drivers; base / mild / severe macro scenarios; efficient-frontier search over 30 policies |
| Monitoring existing models | Gini/KS on test and out-of-time samples, decile calibration, score and characteristic PSI with RAG status, post-model adjustment |
| Data quality control procedures | 48 automated DQ checks that stop the pipeline on failure (`pipeline/data_quality.py`); SQL invariant tests (`supabase/tests.sql`) |
| Risk & controls, affordability policy | FCA CONC 5.2A affordability tests; CONC 6.7 persistent-debt protection; input validation on every API call; audit trail of every simulation run |
| Story-telling for senior stakeholders | Every page opens with a one-sentence finding that updates live, and each strategy writes its own plain-English recommendation |

## Architecture

```
Python pipeline (pandas, scikit-learn)                Supabase Postgres
  generate cohorts -> data-quality checks    seed       accounts, model_artifacts, assumptions, scenarios
  WoE scorecard + gradient boosting         ------>     views: KPIs, band summary, util x risk matrix, segments
  Gini / KS / calibration / PSI / PMA                   functions: account_economics, cli_accounts, simulate_cli,
                                                                   pricing_accounts, simulate_pricing
                                                        audit: simulation_runs (row-level security)
                                                                  ^ REST / RPC
React + Recharts  --/api/*-->  Netlify Function (TypeScript): validates and clamps inputs, runs the
                               frontier grid, sensitivity and stress sweeps, writes the insights
                               + daily scheduled keep-alive so the free Supabase project never pauses
```

**Why the SQL does the heavy lifting:** a full-book simulation is a set-based calculation over 30k accounts, so it runs inside Postgres, next to the data, in about 100 ms. The API layer stays thin: validation, orchestration and narrative.

## Repository layout

```
pipeline/            Python: data generation, DQ checks, WoE binning, model training & validation, Supabase seed
supabase/schema.sql  Tables, views, strategy engines, RLS policies (idempotent, run in the SQL editor)
supabase/tests.sql   Invariant tests for the strategy engines
netlify/functions/   API (api.mts) and scheduled keep-alive (keepalive.mts)
shared/params.ts     Strategy parameter specs, shared by API validation and UI controls
src/                 React front end (Portfolio, Risk model, Limit strategy, Pricing strategy, Method)
sas/                 SAS reference implementation of the scorecard
scripts/             Local dev servers (API runner, PostgREST-compatible shim for local Postgres)
tests/               Unit tests for validation and recommendation logic
data/processed/      Model outputs loaded into Supabase (accounts.csv, model_artifacts.json)
```

## Deploy

### 1. Supabase (database and strategy engines)

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste the whole of `supabase/schema.sql` and click **Run**.
3. In **Project Settings → API**, copy the **Project URL**, the **anon public** key and the **service_role** key.
4. Load the data (Python 3.9+, no packages needed):

   ```bash
   export SUPABASE_URL="https://YOUR-PROJECT.supabase.co"
   export SUPABASE_SERVICE_ROLE_KEY="YOUR-SERVICE-ROLE-KEY"   # keep this secret, never commit it
   python pipeline/seed_supabase.py
   ```

   On Windows PowerShell use `$env:SUPABASE_URL="..."` instead of `export`.
5. Optional: paste `supabase/tests.sql` into the SQL editor. It should report *All strategy-engine tests passed*.

### 2. Netlify (front end and API)

1. **Add new site → Import an existing project →** pick this GitHub repo. The build settings come from `netlify.toml`.
2. **Site configuration → Environment variables**, add:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_ANON_KEY` | your anon public key |
   | `VITE_REPO_URL` | optional, link to this repo shown in the sidebar |

3. **Deploy.** Check `https://YOUR-SITE.netlify.app/api/health`, which should return `{"ok":true}`.

The service-role key is only used locally for seeding. The site and API only ever use the anon key, and RLS limits it to reading and running the simulation functions.

## Run locally

```bash
npm install
# terminal 1: API against your Supabase project
SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run dev:api
# terminal 2: front end on http://localhost:5173 (proxies /api)
npm run dev
```

No Supabase project? Point the API at local Postgres instead: run `schema.sql` locally (create `anon` and `authenticated` roles first), then `LOCAL_DATABASE_URL=postgres://... npm run dev:pg-rest`, and use `SUPABASE_URL=http://localhost:54321` for the API and the seed script.

Rebuild the data and models: `pip install -r pipeline/requirements.txt && python pipeline/run_pipeline.py`. It is fully reproducible from a fixed seed.

Tests: `npm test` (API logic) and `psql -f supabase/tests.sql` (SQL engines).

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/portfolio` | KPIs, band summary, utilisation × risk matrix, segments, assumptions, scenarios |
| GET | `/api/model` | Model validation, scorecard, PSI, data-quality report |
| POST | `/api/cli` | Run a limit-increase policy: `{ params, scenario }` |
| POST | `/api/cli/frontier` | Grid search over PD cut-off × increase size, with `el_budget` |
| POST | `/api/cli/sensitivity` | Tornado on 6 drivers |
| POST | `/api/cli/scenarios` | Same policy under base / mild / severe |
| POST | `/api/pricing` | Run a re-pricing strategy |
| GET | `/api/runs` | Audit trail of recent runs |

## Limitations and next steps

- The horizon is 12 months. A lifetime-value view would add the future revenue lost when a customer leaves.
- Balance build and price elasticity are assumptions. In practice they would be estimated from past CLI and re-pricing test cells.
- Capital is a standardised-approach proxy, not IRB.
- Next steps: roll-rate / vintage analysis and an IFRS 9 stage view, uplift modelling to target CLI on incremental response rather than eligibility, and a scheduled monitoring report.
