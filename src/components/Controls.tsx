import type { ParamSpec, Scenario } from "../../shared/params.ts";
import { SCENARIOS } from "../../shared/params.ts";

type Values = Record<string, number | boolean>;

export function fmtParam(s: ParamSpec, v: number | boolean): string {
  if (typeof v === "boolean") return v ? "On" : "Off";
  switch (s.format) {
    case "pct": return `${(v * 100).toFixed(s.step < 0.01 ? 1 : 0)}%`;
    case "pp": return s.key === "apr_cap" ? `${v.toFixed(1)}%` : `${v > 0 ? "+" : ""}${v.toFixed(1)}pp`;
    case "gbp": return `£${v.toLocaleString("en-GB")}`;
    case "months": return `${v} months`;
    case "ratio": return v.toFixed(2);
    default: return String(v);
  }
}

const SCENARIO_LABEL: Record<Scenario, string> = { base: "Base", mild: "Mild", severe: "Severe" };

export default function Controls({ specs, values, onChange, scenario, onScenario, onReset }: {
  specs: ParamSpec[]; values: Values; onChange: (v: Values) => void;
  scenario: Scenario; onScenario: (s: Scenario) => void; onReset: () => void;
}) {
  const groups = [...new Set(specs.map((s) => s.group))];
  return (
    <form className="panel controls" onSubmit={(e) => e.preventDefault()} aria-label="Strategy settings">
      <fieldset>
        <legend>Economic scenario</legend>
        <div className="seg" role="group" aria-label="Economic scenario">
          {SCENARIOS.map((s) => (
            <button key={s} type="button" aria-pressed={scenario === s} onClick={() => onScenario(s)}>{SCENARIO_LABEL[s]}</button>
          ))}
        </div>
      </fieldset>
      {groups.map((g) => (
        <fieldset key={g}>
          <legend>{g}</legend>
          {specs.filter((s) => s.group === g).map((s) =>
            s.format === "bool" ? (
              <label key={s.key} className="toggle ctl" title={s.help}>
                <input type="checkbox" checked={Boolean(values[s.key])} onChange={(e) => onChange({ ...values, [s.key]: e.target.checked })} />
                <span>{s.label}</span>
              </label>
            ) : (
              <div key={s.key} className="ctl" title={s.help}>
                <label htmlFor={`p-${s.key}`}>{s.label}<output htmlFor={`p-${s.key}`}>{fmtParam(s, values[s.key])}</output></label>
                <input id={`p-${s.key}`} type="range" min={s.min} max={s.max} step={s.step} value={Number(values[s.key])}
                  onChange={(e) => onChange({ ...values, [s.key]: Number(e.target.value) })} />
              </div>
            ),
          )}
        </fieldset>
      ))}
      <button type="button" className="btn-quiet" onClick={onReset}>Reset to defaults</button>
    </form>
  );
}
