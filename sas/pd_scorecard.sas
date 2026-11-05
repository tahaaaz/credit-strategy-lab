/* =============================================================================
   PD scorecard: SAS equivalent of pipeline/run_pipeline.py (reference port)
   Shows the same workflow in SAS for teams that run production models there.
   Input: data/raw/development_and_oot.csv.gz (unzip first) from the Python pipeline.
   Note: written as a reference and not executed in this repo's CI.
   ========================================================================== */

proc import datafile="development_and_oot.csv" out=work.raw dbms=csv replace;
  guessingrows=max;
run;

data work.dev work.oot;
  set work.raw;
  if cohort = 'development' then output work.dev;
  else if cohort = 'out_of_time' then output work.oot;
run;

/* --- 1. train / test split, stratified on the outcome --------------------- */
proc surveyselect data=work.dev out=work.dev_split samprate=0.7 seed=20251105 outall method=srs;
  strata default_12m;
run;

data work.train work.test;
  set work.dev_split;
  if selected then output work.train; else output work.test;
run;

/* --- 2. fine classing into deciles, then WoE per bin ----------------------- */
%macro woe(var);
  proc rank data=work.train out=work.r_&var groups=8 ties=low;
    var &var; ranks bin_&var;
  run;
  proc sql;
    create table work.woe_&var as
    select bin_&var, min(&var) as lo, max(&var) as hi, count(*) as n,
           sum(default_12m) as bads, calculated n - calculated bads as goods,
           log( (calculated goods / (select count(*) - sum(default_12m) from work.train))
              / (calculated bads  / (select sum(default_12m) from work.train)) ) as woe
    from work.r_&var group by bin_&var;
  quit;
%mend;

%woe(bureau_score); %woe(utilisation); %woe(dti); %woe(searches_6m); %woe(credit_limit);

/* --- 3. logistic regression with stepwise selection ------------------------ */
proc logistic data=work.train descending outmodel=work.pd_model;
  class min_pay_only_3m revolver cash_advance_6m employment_status / param=ref;
  model default_12m = bureau_score utilisation dti delinq_24m searches_6m credit_limit
                      monthly_spend age external_unsecured_debt
                      min_pay_only_3m revolver cash_advance_6m employment_status
        / selection=stepwise slentry=0.05 slstay=0.05;
  score data=work.test out=work.test_scored;
  score data=work.oot  out=work.oot_scored;
run;

/* --- 4. validation: Gini = 2*AUC - 1, KS from the score distributions -------- */
%macro validate(ds);
  proc logistic data=&ds descending;
    model default_12m = p_1 / nofit;
    roc 'model' p_1;
    ods output ROCAssociation=work.auc_&ds;
  run;
  proc npar1way data=&ds edf noprint;
    class default_12m; var p_1;
    output out=work.ks_&ds edf;
  run;
%mend;
%validate(work.test_scored);
%validate(work.oot_scored);

/* --- 5. calibration: predicted vs actual by PD decile ---------------------- */
proc rank data=work.oot_scored out=work.oot_dec groups=10; var p_1; ranks decile; run;
proc means data=work.oot_dec noprint nway;
  class decile; var p_1 default_12m;
  output out=work.calibration mean(p_1)=predicted mean(default_12m)=actual;
run;
