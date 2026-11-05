// Strategy parameter definitions shared by the API (validation) and the UI (controls).
// Every value the browser sends is clamped to these ranges before it reaches the database.

export type ParamFormat = "pct" | "pp" | "gbp" | "num" | "months" | "ratio" | "bool";

export interface ParamSpec {
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  default: number | boolean;
  format: ParamFormat;
  help: string;
}

export const CLI_PARAMS: ParamSpec[] = [
  { key: "max_pd", label: "Max 12m PD", group: "Eligibility", min: 0.005, max: 0.2, step: 0.005, default: 0.05, format: "pct",
    help: "Accounts with a (stressed) PD above this cut-off are not offered an increase." },
  { key: "min_util", label: "Min utilisation", group: "Eligibility", min: 0, max: 0.9, step: 0.05, default: 0.3, format: "pct",
    help: "Low-utilisation customers rarely use extra limit, so the increase only adds undrawn exposure." },
  { key: "min_mob", label: "Min months on book", group: "Eligibility", min: 0, max: 36, step: 1, default: 6, format: "months",
    help: "Minimum account tenure before a limit increase can be offered." },
  { key: "max_delinq", label: "Max delinquencies (24m)", group: "Eligibility", min: 0, max: 3, step: 1, default: 0, format: "num",
    help: "Maximum number of delinquency events on the bureau in the last 24 months." },
  { key: "exclude_min_pay", label: "Exclude persistent min-payers", group: "Eligibility", min: 0, max: 1, step: 1, default: true, format: "bool",
    help: "Customers paying only the minimum for 3 months are showing signs of financial strain (CONC 6.7)." },
  { key: "increase_pct", label: "Increase size", group: "Offer", min: 0.05, max: 1, step: 0.05, default: 0.3, format: "pct",
    help: "Increase as a percentage of the current limit, rounded to the nearest £50." },
  { key: "min_increase", label: "Min increase", group: "Offer", min: 50, max: 1000, step: 50, default: 250, format: "gbp",
    help: "Increases smaller than this are not worth the operational cost and customer contact." },
  { key: "max_increase", label: "Max increase", group: "Offer", min: 500, max: 10000, step: 250, default: 3000, format: "gbp",
    help: "Cap on any single increase." },
  { key: "max_limit", label: "Max total limit", group: "Offer", min: 2000, max: 30000, step: 500, default: 15000, format: "gbp",
    help: "No account can exceed this credit limit after the increase." },
  { key: "max_dti", label: "Max post-increase DTI", group: "Affordability", min: 0.2, max: 1.5, step: 0.05, default: 0.6, format: "ratio",
    help: "Total unsecured debt (assuming the new limit is fully drawn) divided by gross income." },
  { key: "min_disposable", label: "Min disposable income", group: "Affordability", min: 0, max: 1000, step: 25, default: 150, format: "gbp",
    help: "Monthly disposable income that must remain after repaying a fully-drawn new limit at 3% a month." },
  { key: "balance_build", label: "Balance build", group: "Response assumptions", min: 0.05, max: 0.8, step: 0.05, default: 0.35, format: "pct",
    help: "Share of the new headroom a fully-utilised customer is expected to draw within 12 months." },
  { key: "risk_elasticity", label: "Risk elasticity", group: "Response assumptions", min: 0, max: 1.5, step: 0.05, default: 0.3, format: "num",
    help: "PD uplift per 100% limit increase (0.3 means a 50% increase lifts PD by 15% relative)." },
];

export const PRICING_PARAMS: ParamSpec[] = [
  ...(["a", "b", "c", "d", "e"] as const).map((b, i): ParamSpec => ({
    key: `delta_${b}`, label: `Band ${b.toUpperCase()} APR change`, group: "APR change by risk band",
    min: -5, max: 5, step: 0.5, default: [0, 0, 1, 2, 3][i], format: "pp",
    help: `Change in purchase APR (percentage points) for risk band ${b.toUpperCase()}.`,
  })),
  { key: "exclude_persistent", label: "Protect persistent-debt customers", group: "Customer protection", min: 0, max: 1, step: 1, default: true, format: "bool",
    help: "No APR increases for customers paying only the minimum (FCA persistent debt rules)." },
  { key: "exclude_delinquent", label: "Protect recently delinquent", group: "Customer protection", min: 0, max: 1, step: 1, default: true, format: "bool",
    help: "No APR increases for customers with a delinquency in the last 24 months." },
  { key: "apr_cap", label: "APR ceiling", group: "Customer protection", min: 25, max: 49.9, step: 0.5, default: 39.9, format: "pp",
    help: "Maximum APR after re-pricing." },
  { key: "base_attrition", label: "Base attrition", group: "Response assumptions", min: 0.02, max: 0.2, step: 0.01, default: 0.08, format: "pct",
    help: "Annual closure / balance-transfer-out rate with no price change." },
  { key: "elasticity_a", label: "Elasticity band A", group: "Response assumptions", min: 0, max: 0.15, step: 0.005, default: 0.06, format: "pct",
    help: "Extra attrition per +1pp APR for band A revolvers. Low-risk customers have the most alternatives." },
  { key: "elasticity_e", label: "Elasticity band E", group: "Response assumptions", min: 0, max: 0.15, step: 0.005, default: 0.012, format: "pct",
    help: "Extra attrition per +1pp APR for band E revolvers." },
  { key: "payment_shock", label: "Payment shock", group: "Response assumptions", min: 0, max: 2, step: 0.1, default: 0.5, format: "num",
    help: "PD uplift per relative APR increase (0.5 means +10% APR lifts PD 5% relative)." },
];

export const SCENARIOS = ["base", "mild", "severe"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function defaults(specs: ParamSpec[]): Record<string, number | boolean> {
  return Object.fromEntries(specs.map((s) => [s.key, s.default]));
}

/** Clamp and type-check user input against the specs; unknown keys are dropped. */
export function sanitize(input: unknown, specs: ParamSpec[]): Record<string, number | boolean> {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Record<string, number | boolean> = {};
  for (const s of specs) {
    const v = src[s.key];
    if (s.format === "bool") {
      out[s.key] = typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : (s.default as boolean);
      continue;
    }
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    out[s.key] = Number.isFinite(n) ? Math.min(s.max, Math.max(s.min, n)) : (s.default as number);
  }
  return out;
}

export function sanitizeScenario(v: unknown): Scenario {
  return (SCENARIOS as readonly string[]).includes(v as string) ? (v as Scenario) : "base";
}
