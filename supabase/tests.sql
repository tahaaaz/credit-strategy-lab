-- Invariant tests for the SQL strategy engines. Run after seeding:
--   psql "$DATABASE_URL" -f supabase/tests.sql      (or paste into the SQL editor)
-- Each block raises an exception if an invariant is broken.
do $$
declare r jsonb; n int; bad int;
begin
  -- 1. the policy waterfall accounts for every account exactly once
  r := public.simulate_cli('{}');
  select sum((w->>'accounts')::int) into n from jsonb_array_elements(r->'waterfall') w;
  if n <> (select count(*) from public.accounts) then raise exception 'waterfall % <> book', n; end if;

  -- 2. no eligible account breaches the PD cut-off, utilisation floor or limit cap
  select count(*) into bad from public.cli_accounts('{"max_pd":0.03,"min_util":0.4,"max_limit":8000}') c
    join public.accounts a using (account_id)
   where c.decision = 'Eligible'
     and (a.pd_12m > 0.03 or a.utilisation < 0.4 or a.credit_limit + c.increase > 8000);
  if bad > 0 then raise exception '% eligible accounts breach policy', bad; end if;

  -- 3. stress lowers or holds eligibility and lowers contribution
  if (public.simulate_cli('{"scenario":"severe"}')->'summary'->>'eligible')::int
     > (r->'summary'->>'eligible')::int then raise exception 'stress increased eligibility'; end if;
  if (public.simulate_cli('{"scenario":"severe"}')->'summary'->>'d_net')::float8
     >= (r->'summary'->>'d_net')::float8 then raise exception 'stress did not reduce contribution'; end if;

  -- 4. protected customers never receive an APR increase
  select count(*) into bad from public.pricing_accounts('{"delta_a":3,"delta_b":3,"delta_c":3,"delta_d":3,"delta_e":3}') p
    join public.accounts a using (account_id)
   where (a.min_pay_only_3m or a.delinq_24m > 0) and p.apr_new > p.apr_old;
  if bad > 0 then raise exception '% protected customers re-priced up', bad; end if;

  -- 5. zero price change means zero impact
  if abs((public.simulate_pricing('{"delta_a":0,"delta_b":0,"delta_c":0,"delta_d":0,"delta_e":0}')->'summary'->>'d_net')::float8) > 1e-6
    then raise exception 'no-change pricing has non-zero impact'; end if;

  -- 6. portfolio view reconciles to account-level economics
  if abs((select net_contribution from public.v_portfolio_kpis)
         - (select sum(net_contribution) from public.v_band_summary)) > 1
    then raise exception 'band summary does not reconcile'; end if;

  raise notice 'All strategy-engine tests passed';
end $$;
