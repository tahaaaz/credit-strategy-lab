-- =====================================================================================
-- Credit Strategy Lab - Supabase / Postgres schema
-- Run once in the Supabase SQL editor (safe to re-run: everything is idempotent).
--
--   Tables     accounts, model_artifacts, assumptions, scenarios, simulation_runs
--   Views      v_portfolio_kpis, v_band_summary, v_util_risk_matrix, v_segment_summary
--   Functions  account_economics, cli_accounts, simulate_cli,
--              pricing_accounts, simulate_pricing, log_simulation_run
--
-- Design note: the strategy engines are set-based SQL that run next to the data, so a
-- full-book simulation is one round trip. The Netlify API layer validates inputs,
-- orchestrates scenario / sensitivity sweeps and writes the narrative.
-- =====================================================================================

-- ---------------------------------------------------------------- tables
create table if not exists public.accounts (
  account_id                text primary key,
  obs_date                  date not null,
  age                       int  not null check (age between 18 and 100),
  employment_status         text not null,
  housing_status            text not null,
  region                    text not null,
  annual_income             double precision not null check (annual_income > 0),
  months_on_book            int  not null check (months_on_book >= 0),
  bureau_score              int  not null check (bureau_score between 0 and 999),
  delinq_24m                int  not null,
  searches_6m               int  not null,
  credit_limit              double precision not null check (credit_limit > 0),
  balance                   double precision not null check (balance >= 0),
  utilisation               double precision not null,
  external_unsecured_debt   double precision not null,
  dti                       double precision not null,
  disposable_income_monthly double precision not null,
  revolver                  boolean not null,
  min_pay_only_3m           boolean not null,
  cash_advance_6m           boolean not null,
  monthly_spend             double precision not null,
  apr                       double precision not null check (apr between 0 and 60),
  score                     int  not null,
  pd_model                  double precision not null,
  pd_12m                    double precision not null check (pd_12m between 0 and 1),
  pd_challenger             double precision not null,
  risk_band                 text not null check (risk_band in ('A','B','C','D','E'))
);
create index if not exists accounts_risk_band_idx on public.accounts (risk_band);

create table if not exists public.model_artifacts (
  key        text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.assumptions (
  key         text primary key,
  value       double precision not null,
  label       text not null,
  unit        text not null,
  description text not null
);

create table if not exists public.scenarios (
  name        text primary key,
  label       text not null,
  pd_mult     double precision not null,
  lgd_add     double precision not null,
  cof_add     double precision not null,
  spend_mult  double precision not null,
  sort_order  int not null,
  description text not null
);

create table if not exists public.simulation_runs (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind       text not null,
  params     jsonb not null,
  summary    jsonb not null
);

insert into public.assumptions (key, value, label, unit, description) values
  ('lgd',               0.85,   'Loss given default',        'ratio', 'Share of exposure lost on default (unsecured cards)'),
  ('ccf',               0.65,   'Credit conversion factor',  'ratio', 'Share of undrawn limit expected to be drawn by default'),
  ('cost_of_funds',     0.0475, 'Cost of funds',             'rate',  'Annual funding cost on drawn balances'),
  ('interchange_rate',  0.003,  'Interchange',               'rate',  'Interchange earned on retail spend (IFR cap 0.3%)'),
  ('opex_per_account',  30,     'Servicing cost',            'GBP',   'Annual operating cost per account'),
  ('capital_ratio',     0.105,  'Capital ratio',             'ratio', 'Capital held against risk-weighted assets'),
  ('risk_weight',       0.75,   'Risk weight',               'ratio', 'Retail exposure risk weight'),
  ('late_fee',          12,     'Late fee',                  'GBP',   'Fee per missed payment (UK cap)'),
  ('hurdle_rate',       0.15,   'RAROC hurdle',              'rate',  'Minimum return on allocated capital'),
  ('rs_revolver',       0.85,   'Interest-bearing share (revolvers)',   'ratio', 'Share of balance accruing interest for revolvers'),
  ('rs_transactor',     0.10,   'Interest-bearing share (transactors)', 'ratio', 'Share of balance accruing interest for transactors'),
  ('repayment_rate',    0.03,   'Stressed repayment rate',   'ratio', 'Monthly repayment assumed on unsecured debt in affordability tests')
on conflict (key) do update set value = excluded.value, label = excluded.label,
  unit = excluded.unit, description = excluded.description;

insert into public.scenarios (name, label, pd_mult, lgd_add, cof_add, spend_mult, sort_order, description) values
  ('base',   'Base case',        1.00, 0.00, 0.000, 1.00, 1, 'Current model PDs (including post-model adjustment) and funding costs'),
  ('mild',   'Mild downturn',    1.35, 0.03, 0.005, 0.95, 2, 'Unemployment +1.5pp: PD x1.35, LGD +3pp, funding +50bp, spend -5%'),
  ('severe', 'Severe stress',    1.90, 0.06, 0.015, 0.85, 3, 'Stress-test style shock: PD x1.9, LGD +6pp, funding +150bp, spend -15%')
on conflict (name) do update set label = excluded.label, pd_mult = excluded.pd_mult,
  lgd_add = excluded.lgd_add, cof_add = excluded.cof_add, spend_mult = excluded.spend_mult,
  sort_order = excluded.sort_order, description = excluded.description;

-- ---------------------------------------------------------------- parameters
-- Merge order (later wins): assumptions table -> scenario shocks -> caller overrides
create or replace function public._params(p jsonb default '{}')
returns jsonb language sql stable as $$
  select (select jsonb_object_agg(key, to_jsonb(value)) from public.assumptions)
      || coalesce(
           (select jsonb_build_object('pd_mult', pd_mult, 'lgd_add', lgd_add, 'cof_add', cof_add,
                                      'spend_mult', spend_mult)
              from public.scenarios where name = coalesce(p->>'scenario', 'base')),
           '{"pd_mult":1,"lgd_add":0,"cof_add":0,"spend_mult":1}'::jsonb)
      || coalesce(p, '{}'::jsonb);
$$;

-- ---------------------------------------------------------------- account economics
-- Annual risk-adjusted contribution per account:
--   revenue  = interest + interchange + fees
--   net      = revenue - funding cost - expected loss (PD x LGD x EAD) - opex
--   RAROC    = net / (capital ratio x risk weight x EAD)
create or replace function public.account_economics(p jsonb default '{}')
returns table (
  account_id text, risk_band text, score int, pd double precision, balance double precision,
  credit_limit double precision, apr double precision, utilisation double precision,
  ead double precision, interest_income double precision, interchange double precision,
  fee_income double precision, revenue double precision, funding_cost double precision,
  expected_loss double precision, opex double precision, net_contribution double precision,
  capital double precision, raroc double precision
) language sql stable as $$
  with k as materialized (select public._params(p) as j),
  c as materialized (
    select (j->>'lgd')::float8 + (j->>'lgd_add')::float8           as lgd,
           (j->>'ccf')::float8                                      as ccf,
           (j->>'cost_of_funds')::float8 + (j->>'cof_add')::float8  as cof,
           (j->>'interchange_rate')::float8                         as ic,
           (j->>'opex_per_account')::float8                         as opex,
           (j->>'capital_ratio')::float8 * (j->>'risk_weight')::float8 as cap,
           (j->>'late_fee')::float8                                 as fee,
           (j->>'rs_revolver')::float8                              as rs_rev,
           (j->>'rs_transactor')::float8                            as rs_tr,
           (j->>'pd_mult')::float8                                  as pd_mult,
           (j->>'spend_mult')::float8                               as spend_mult
    from k
  ),
  e as (
    select a.account_id, a.risk_band, a.score, a.balance, a.credit_limit, a.apr, a.utilisation,
           least(a.pd_12m * c.pd_mult, 0.99)                                          as pd,
           a.balance + c.ccf * greatest(a.credit_limit - a.balance, 0)                as ead,
           a.balance * a.apr / 100 * case when a.revolver then c.rs_rev else c.rs_tr end as interest_income,
           a.monthly_spend * 12 * c.spend_mult * c.ic                                 as interchange,
           a.balance * c.cof                                                          as funding_cost,
           c.lgd, c.opex, c.cap, c.fee
    from public.accounts a cross join c
  )
  select e.account_id, e.risk_band, e.score, e.pd, e.balance, e.credit_limit, e.apr, e.utilisation,
         e.ead, e.interest_income, e.interchange,
         e.fee * 12 * (0.01 + 0.6 * e.pd)                                             as fee_income,
         e.interest_income + e.interchange + e.fee * 12 * (0.01 + 0.6 * e.pd)          as revenue,
         e.funding_cost,
         e.pd * e.lgd * e.ead                                                          as expected_loss,
         e.opex,
         e.interest_income + e.interchange + e.fee * 12 * (0.01 + 0.6 * e.pd)
           - e.funding_cost - e.pd * e.lgd * e.ead - e.opex                            as net_contribution,
         e.cap * e.ead                                                                 as capital,
         (e.interest_income + e.interchange + e.fee * 12 * (0.01 + 0.6 * e.pd)
           - e.funding_cost - e.pd * e.lgd * e.ead - e.opex) / nullif(e.cap * e.ead, 0) as raroc
  from e;
$$;

-- ---------------------------------------------------------------- portfolio views
create or replace view public.v_portfolio_kpis with (security_invoker = true) as
select count(*)                                              as accounts,
       sum(balance)                                          as total_balance,
       sum(credit_limit)                                     as total_limit,
       sum(balance) / sum(credit_limit)                      as utilisation,
       sum(pd * balance) / nullif(sum(balance), 0)           as balance_weighted_pd,
       avg(pd)                                               as avg_pd,
       sum(apr * balance) / nullif(sum(balance), 0)          as balance_weighted_apr,
       sum(revenue)                                          as revenue,
       sum(expected_loss)                                    as expected_loss,
       sum(expected_loss) / nullif(sum(balance), 0)          as loss_rate,
       sum(net_contribution)                                 as net_contribution,
       sum(capital)                                          as capital,
       sum(net_contribution) / nullif(sum(capital), 0)       as raroc,
       sum(net_contribution) / nullif(sum(balance), 0)       as roa,
       avg(score)                                            as avg_score
from public.account_economics('{}');

create or replace view public.v_band_summary with (security_invoker = true) as
select risk_band,
       count(*)                                              as accounts,
       count(*)::float8 / sum(count(*)) over ()              as share_accounts,
       min(pd)                                               as min_pd,
       max(pd)                                               as max_pd,
       avg(pd)                                               as avg_pd,
       avg(score)                                            as avg_score,
       sum(balance)                                          as balance,
       sum(credit_limit)                                     as credit_limit,
       sum(balance) / sum(credit_limit)                      as utilisation,
       sum(apr * balance) / nullif(sum(balance), 0)          as apr,
       sum(revenue)                                          as revenue,
       sum(funding_cost)                                     as funding_cost,
       sum(expected_loss)                                    as expected_loss,
       sum(opex)                                             as opex,
       sum(net_contribution)                                 as net_contribution,
       sum(net_contribution) / nullif(sum(capital), 0)       as raroc,
       avg((net_contribution < 0)::int)                      as share_loss_making
from public.account_economics('{}')
group by risk_band
order by risk_band;

create or replace view public.v_util_risk_matrix with (security_invoker = true) as
select case when utilisation < 0.30 then '1. <30%'
            when utilisation < 0.60 then '2. 30-60%'
            when utilisation < 0.80 then '3. 60-80%'
            when utilisation < 0.95 then '4. 80-95%'
            else '5. 95%+' end                               as util_band,
       risk_band,
       count(*)                                              as accounts,
       avg(pd)                                               as avg_pd,
       sum(net_contribution)                                 as net_contribution,
       sum(net_contribution) / nullif(sum(capital), 0)       as raroc
from public.account_economics('{}')
group by 1, 2
order by 1, 2;

-- One query, five segmentations: GROUPING SETS keeps the scan to a single pass
create or replace view public.v_segment_summary with (security_invoker = true) as
with x as (
  select a.employment_status, a.housing_status, a.region,
         case when a.age < 25 then '18-24' when a.age < 35 then '25-34' when a.age < 50 then '35-49'
              when a.age < 65 then '50-64' else '65+' end            as age_band,
         case when a.months_on_book < 12 then '0-11m' when a.months_on_book < 36 then '12-35m'
              when a.months_on_book < 84 then '36-83m' else '84m+' end as mob_band,
         e.pd, e.balance, e.net_contribution, e.capital, e.expected_loss
  from public.accounts a join public.account_economics('{}') e using (account_id)
)
select case when grouping(employment_status) = 0 then 'Employment'
            when grouping(housing_status) = 0 then 'Housing'
            when grouping(region) = 0 then 'Region'
            when grouping(age_band) = 0 then 'Age band'
            else 'Months on book' end                                  as dimension,
       coalesce(employment_status, housing_status, region, age_band, mob_band) as segment,
       count(*)                                                        as accounts,
       avg(pd)                                                         as avg_pd,
       sum(balance)                                                    as balance,
       sum(expected_loss) / nullif(sum(balance), 0)                    as loss_rate,
       sum(net_contribution)                                           as net_contribution,
       sum(net_contribution) / nullif(sum(capital), 0)                 as raroc
from x
group by grouping sets ((employment_status), (housing_status), (region), (age_band), (mob_band))
order by 1, 2;

-- ---------------------------------------------------------------- credit limit increase engine
-- Each account is passed through a sequential policy waterfall (first failing rule is
-- recorded). Eligible accounts receive an increase; their response is modelled with
--   balance build  : share of new headroom drawn, higher for high-utilisation customers
--   risk elasticity: PD uplift proportional to the relative size of the increase
create or replace function public.cli_accounts(p jsonb default '{}')
returns table (
  account_id text, risk_band text, decision text, increase double precision,
  d_balance double precision, d_revenue double precision, d_funding double precision,
  d_el double precision, d_capital double precision, d_net double precision, d_ead double precision
) language sql stable as $$
  with k as materialized (select public._params(p) as j),
  c as materialized (
    select coalesce((j->>'max_pd')::float8, 0.05)          as k_max_pd,
           coalesce((j->>'min_util')::float8, 0.30)        as k_min_util,
           coalesce((j->>'min_mob')::float8, 6)            as k_min_mob,
           coalesce((j->>'max_delinq')::float8, 0)         as k_max_delinq,
           coalesce((j->>'exclude_min_pay')::boolean, true) as k_excl_minpay,
           coalesce((j->>'increase_pct')::float8, 0.30)    as k_inc_pct,
           coalesce((j->>'min_increase')::float8, 250)     as k_min_inc,
           coalesce((j->>'max_increase')::float8, 3000)    as k_max_inc,
           coalesce((j->>'max_limit')::float8, 15000)      as k_max_limit,
           coalesce((j->>'max_dti')::float8, 0.60)         as k_max_dti,
           coalesce((j->>'min_disposable')::float8, 150)   as k_min_disp,
           coalesce((j->>'balance_build')::float8, 0.35)   as k_build,
           coalesce((j->>'risk_elasticity')::float8, 0.30) as k_risk_el,
           (j->>'lgd')::float8 + (j->>'lgd_add')::float8          as k_lgd,
           (j->>'ccf')::float8                                     as k_ccf,
           (j->>'cost_of_funds')::float8 + (j->>'cof_add')::float8 as k_cof,
           (j->>'capital_ratio')::float8 * (j->>'risk_weight')::float8 as k_cap,
           (j->>'late_fee')::float8                                as k_fee,
           (j->>'rs_revolver')::float8                             as k_rs_rev,
           (j->>'rs_transactor')::float8                           as k_rs_tr,
           (j->>'repayment_rate')::float8                          as k_repay,
           (j->>'pd_mult')::float8                                 as k_pd_mult
    from k
  ),
  b as (
    select a.*, c.*,
           least(a.pd_12m * c.k_pd_mult, 0.99) as pd0,
           greatest(0, least(c.k_max_inc, greatest(c.k_min_inc, round(a.credit_limit * c.k_inc_pct / 50) * 50),
                             c.k_max_limit - a.credit_limit)) as inc
    from public.accounts a cross join c
  ),
  d as (
    select b.*,
      case
        when b.pd0 > b.k_max_pd                              then '1. PD above cut-off'
        when b.utilisation < b.k_min_util                    then '2. Utilisation below minimum'
        when b.months_on_book < b.k_min_mob                  then '3. Months on book below minimum'
        when b.delinq_24m > b.k_max_delinq                   then '4. Recent delinquency'
        when b.k_excl_minpay and b.min_pay_only_3m           then '5. Persistent minimum payments'
        when b.inc < b.k_min_inc                             then '6. At maximum limit'
        when (b.credit_limit + b.inc + b.external_unsecured_debt) / b.annual_income > b.k_max_dti
                                                             then '7. Affordability: debt-to-income'
        when b.disposable_income_monthly - b.k_repay * (b.credit_limit + b.inc - b.balance) < b.k_min_disp
                                                             then '8. Affordability: disposable income'
        else 'Eligible'
      end as decision
    from b
  ),
  r as (
    select d.*,
           d.inc * d.k_build * least(1.0, 0.4 + d.utilisation)                    as db,
           least(0.99, d.pd0 * (1 + d.k_risk_el * d.inc / d.credit_limit))        as pd1,
           case when d.revolver then d.k_rs_rev else d.k_rs_tr end                as rs,
           d.balance + d.k_ccf * greatest(d.credit_limit - d.balance, 0)          as ead0
    from d where d.decision = 'Eligible'
  ),
  s as (
    select r.*,
           (r.balance + r.db) + r.k_ccf * greatest(r.credit_limit + r.inc - r.balance - r.db, 0) as ead1
    from r
  )
  select s.account_id, s.risk_band, s.decision, s.inc,
         s.db,
         s.db * s.apr / 100 * s.rs + s.k_fee * 12 * 0.6 * (s.pd1 - s.pd0),
         s.db * s.k_cof,
         s.pd1 * s.k_lgd * s.ead1 - s.pd0 * s.k_lgd * s.ead0,
         s.k_cap * (s.ead1 - s.ead0),
         s.db * s.apr / 100 * s.rs + s.k_fee * 12 * 0.6 * (s.pd1 - s.pd0)
           - s.db * s.k_cof - (s.pd1 * s.k_lgd * s.ead1 - s.pd0 * s.k_lgd * s.ead0),
         s.ead1 - s.ead0
  from s
  union all
  select d.account_id, d.risk_band, d.decision, 0, 0, 0, 0, 0, 0, 0, 0
  from d where d.decision <> 'Eligible';
$$;

create or replace function public.simulate_cli(p jsonb default '{}')
returns jsonb language sql stable as $$
  with x as (select * from public.cli_accounts(p)),
  tot as (
    select count(*)                                         as accounts,
           count(*) filter (where decision = 'Eligible')    as eligible,
           sum(increase)                                    as total_increase,
           sum(d_balance)                                   as d_balance,
           sum(d_revenue)                                   as d_revenue,
           sum(d_funding)                                   as d_funding,
           sum(d_el)                                        as d_el,
           sum(d_net)                                       as d_net,
           sum(d_capital)                                   as d_capital,
           sum(d_ead)                                       as d_ead,
           count(*) filter (where decision = 'Eligible' and d_net < 0) as eligible_loss_making
    from x
  ),
  band as (
    select risk_band,
           count(*)                                         as accounts,
           count(*) filter (where decision = 'Eligible')    as eligible,
           sum(increase)                                    as total_increase,
           sum(d_balance)                                   as d_balance,
           sum(d_revenue)                                   as d_revenue,
           sum(d_el)                                        as d_el,
           sum(d_net)                                       as d_net,
           sum(d_net) / nullif(sum(d_capital), 0)           as d_raroc
    from x group by risk_band
  ),
  wf as (select decision, count(*) as accounts from x group by decision)
  select jsonb_build_object(
    'summary', (select jsonb_build_object(
        'accounts', accounts, 'eligible', eligible,
        'eligible_rate', eligible::float8 / nullif(accounts, 0),
        'total_increase', total_increase, 'avg_increase', total_increase / nullif(eligible, 0),
        'd_balance', d_balance, 'd_revenue', d_revenue, 'd_funding', d_funding, 'd_el', d_el,
        'd_net', d_net, 'd_capital', d_capital, 'd_ead', d_ead,
        'd_raroc', d_net / nullif(d_capital, 0),
        'loss_to_revenue', d_el / nullif(d_revenue, 0),
        'eligible_loss_making', eligible_loss_making) from tot),
    'by_band',   (select jsonb_agg(to_jsonb(band) order by risk_band) from band),
    'waterfall', (select jsonb_agg(to_jsonb(wf) order by decision) from wf),
    'params',    public._params(p)
  );
$$;

-- ---------------------------------------------------------------- APR re-pricing engine
-- Risk-based re-pricing by band. Each account's full annual contribution (interest,
-- interchange, fees, funding, expected loss, opex) is compared before and after, weighted
-- by the probability the customer stays:
--   price elasticity : attrition rises with an APR increase; low-risk customers are the most
--                      rate-sensitive (outside options) -> adverse selection. Transactors
--                      barely notice APR, so their elasticity is scaled down.
--   payment shock    : PD uplift proportional to the relative APR increase
--   customer protection: persistent-debt and recently-delinquent customers are excluded
--                      from increases (FCA CONC 6.7 persistent debt / Consumer Duty)
create or replace function public.pricing_accounts(p jsonb default '{}')
returns table (
  account_id text, risk_band text, status text, balance double precision,
  apr_old double precision, apr_new double precision, attrition_delta double precision,
  d_balance double precision, d_revenue double precision, d_el double precision,
  d_funding double precision, d_net double precision
) language sql stable as $$
  with k as materialized (select public._params(p) as j),
  c as materialized (
    select coalesce((j->>'delta_a')::float8, 0.0) as da, coalesce((j->>'delta_b')::float8, 0.0) as db_,
           coalesce((j->>'delta_c')::float8, 1.0) as dc, coalesce((j->>'delta_d')::float8, 2.0) as dd,
           coalesce((j->>'delta_e')::float8, 3.0) as de,
           coalesce((j->>'elasticity_a')::float8, 0.060) as ea, coalesce((j->>'elasticity_b')::float8, 0.045) as eb,
           coalesce((j->>'elasticity_c')::float8, 0.030) as ec, coalesce((j->>'elasticity_d')::float8, 0.020) as ed,
           coalesce((j->>'elasticity_e')::float8, 0.012) as ee,
           coalesce((j->>'base_attrition')::float8, 0.08)   as base_attr,
           coalesce((j->>'paydown_per_pp')::float8, 0.01)   as paydown,
           coalesce((j->>'growth_per_pp')::float8, 0.02)    as growth,
           coalesce((j->>'payment_shock')::float8, 0.5)     as shock,
           coalesce((j->>'apr_cap')::float8, 39.9)          as apr_cap,
           coalesce((j->>'exclude_persistent')::boolean, true) as excl_persist,
           coalesce((j->>'exclude_delinquent')::boolean, true) as excl_delinq,
           (j->>'lgd')::float8 + (j->>'lgd_add')::float8          as lgd,
           (j->>'ccf')::float8                                     as ccf,
           (j->>'cost_of_funds')::float8 + (j->>'cof_add')::float8 as cof,
           (j->>'interchange_rate')::float8 * (j->>'spend_mult')::float8 as ic,
           (j->>'opex_per_account')::float8                        as opex,
           (j->>'late_fee')::float8                                as fee,
           (j->>'rs_revolver')::float8 as rs_rev, (j->>'rs_transactor')::float8 as rs_tr,
           (j->>'pd_mult')::float8 as pd_mult
    from k
  ),
  b as (
    select a.account_id, a.risk_band, a.apr, a.balance, a.credit_limit, a.monthly_spend, a.revolver,
           least(a.pd_12m * c.pd_mult, 0.99) as pd0,
           case when a.revolver then c.rs_rev else c.rs_tr end as rs,
           case a.risk_band when 'A' then c.da when 'B' then c.db_ when 'C' then c.dc
                            when 'D' then c.dd else c.de end as req,
           case a.risk_band when 'A' then c.ea when 'B' then c.eb when 'C' then c.ec
                            when 'D' then c.ed else c.ee end * case when a.revolver then 1.0 else 0.3 end as el,
           (c.excl_persist and a.min_pay_only_3m) or (c.excl_delinq and a.delinq_24m > 0) as protected,
           c.*
    from public.accounts a cross join c
  ),
  d as (
    select b.*,
           case when b.req > 0 and b.protected then 'Excluded (customer protection)'
                when b.req = 0 then 'No change'
                when b.req > 0 then 'Increase' else 'Decrease' end as status,
           case when b.req > 0 and b.protected then b.apr
                else greatest(0, least(b.apr + b.req, greatest(b.apr_cap, b.apr))) end as apr1
    from b
  ),
  e as (
    select d.*,
           case when d.apr1 > d.apr then least(0.9, d.base_attr + d.el * (d.apr1 - d.apr))
                when d.apr1 < d.apr then greatest(0.01, d.base_attr + 0.5 * d.el * (d.apr1 - d.apr))
                else d.base_attr end as attr1,
           case when not d.revolver then 1.0          -- transactors clear their balance anyway
                when d.apr1 > d.apr then 1 - d.paydown * (d.apr1 - d.apr)
                else 1 + d.growth * (d.apr - d.apr1) end as bal_f,
           least(0.99, d.pd0 * (1 + d.shock * greatest(d.apr1 - d.apr, 0) / nullif(d.apr, 0))) as pd1
    from d
  ),
  f as (  -- expected (retention-weighted) annual economics before (0) and after (1)
    select e.*,
           (1 - e.base_attr) * e.balance                                   as bal0,
           (1 - e.attr1) * e.balance * e.bal_f                             as bal1,
           (1 - e.base_attr) * (e.balance * e.apr / 100 * e.rs + e.monthly_spend * 12 * e.ic
                                + e.fee * 12 * (0.01 + 0.6 * e.pd0))       as rev0,
           (1 - e.attr1) * (e.balance * e.bal_f * e.apr1 / 100 * e.rs + e.monthly_spend * 12 * e.ic
                            + e.fee * 12 * (0.01 + 0.6 * e.pd1))           as rev1,
           (1 - e.base_attr) * e.pd0 * e.lgd
             * (e.balance + e.ccf * greatest(e.credit_limit - e.balance, 0))  as el0,
           (1 - e.attr1) * e.pd1 * e.lgd
             * (e.balance * e.bal_f + e.ccf * greatest(e.credit_limit - e.balance * e.bal_f, 0)) as el1
    from e
  )
  select f.account_id, f.risk_band, f.status, f.balance, f.apr, f.apr1, f.attr1 - f.base_attr,
         f.bal1 - f.bal0,
         f.rev1 - f.rev0,
         f.el1 - f.el0,
         (f.bal1 - f.bal0) * f.cof,
         (f.rev1 - f.rev0) - (f.el1 - f.el0) - (f.bal1 - f.bal0) * f.cof
           + (f.attr1 - f.base_attr) * f.opex   -- closed accounts stop incurring opex
  from f;
$$;

create or replace function public.simulate_pricing(p jsonb default '{}')
returns jsonb language sql stable as $$
  with x as (select * from public.pricing_accounts(p)),
  band as (
    select risk_band,
           count(*)                                                as accounts,
           count(*) filter (where status = 'Increase')             as increased,
           count(*) filter (where status = 'Decrease')             as decreased,
           count(*) filter (where status like 'Excluded%')         as excluded,
           sum(balance * apr_old) / nullif(sum(balance), 0)        as apr_old,
           sum(balance * apr_new) / nullif(sum(balance), 0)        as apr_new,
           avg(attrition_delta)                                    as attrition_delta,
           sum(d_balance) as d_balance, sum(d_revenue) as d_revenue, sum(d_el) as d_el,
           sum(d_funding) as d_funding, sum(d_net) as d_net
    from x
    group by risk_band
  )
  select jsonb_build_object(
    'summary', (select jsonb_build_object(
        'accounts', sum(accounts), 'increased', sum(increased), 'decreased', sum(decreased),
        'excluded', sum(excluded), 'extra_attriters', sum(attrition_delta * accounts),
        'd_balance', sum(d_balance), 'd_revenue', sum(d_revenue), 'd_el', sum(d_el),
        'd_funding', sum(d_funding), 'd_net', sum(d_net)) from band),
    'by_band', (select jsonb_agg(to_jsonb(band) order by risk_band) from band),
    'params',  public._params(p)
  );
$$;

-- ---------------------------------------------------------------- audit trail
create or replace function public.log_simulation_run(kind text, params jsonb, summary jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if kind not in ('cli', 'pricing', 'frontier', 'sensitivity', 'scenarios') then
    raise exception 'invalid kind';
  end if;
  if pg_column_size(params) > 8000 or pg_column_size(summary) > 16000 then
    raise exception 'payload too large';
  end if;
  insert into public.simulation_runs (kind, params, summary) values (kind, params, summary);
  delete from public.simulation_runs
   where id < (select coalesce(max(id), 0) - 1000 from public.simulation_runs);
end $$;

create or replace view public.v_recent_runs with (security_invoker = false) as
select id, created_at, kind, params, summary from public.simulation_runs order by id desc limit 25;

-- ---------------------------------------------------------------- security
alter table public.accounts        enable row level security;
alter table public.model_artifacts enable row level security;
alter table public.assumptions     enable row level security;
alter table public.scenarios       enable row level security;
alter table public.simulation_runs enable row level security;

do $$
declare t text;
begin
  foreach t in array array['accounts', 'model_artifacts', 'assumptions', 'scenarios'] loop
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

grant usage on schema public to anon, authenticated;
grant select on public.accounts, public.model_artifacts, public.assumptions, public.scenarios,
               public.v_portfolio_kpis, public.v_band_summary, public.v_util_risk_matrix,
               public.v_segment_summary, public.v_recent_runs to anon, authenticated;
revoke all on public.simulation_runs from anon, authenticated;
grant execute on function public._params(jsonb), public.account_economics(jsonb),
                          public.cli_accounts(jsonb), public.simulate_cli(jsonb),
                          public.pricing_accounts(jsonb), public.simulate_pricing(jsonb),
                          public.log_simulation_run(text, jsonb, jsonb) to anon, authenticated;
