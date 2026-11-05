import { useEffect, useRef, useState, type ReactNode } from "react";

// ---------------------------------------------------------------- formatting
export const gbp = (v: number | null | undefined, digits?: number): string => {
  if (v == null || !Number.isFinite(v)) return "n/a";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e6) return `${sign}£${(a / 1e6).toFixed(digits ?? 1)}m`;
  if (a >= 1e4) return `${sign}£${(a / 1e3).toFixed(digits ?? 0)}k`;
  if (a >= 1e3) return `${sign}£${(a / 1e3).toFixed(digits ?? 1)}k`;
  return `${sign}£${a.toFixed(0)}`;
};
/** For prose: "adds £200k" / "loses £40k". */
export const gainLoss = (v: number | null | undefined, gain = "adds", loss = "loses") =>
  v != null && v < 0 ? `${loss} ${gbp(-v)}` : `${gain} ${gbp(v)}`;
export const signedGbp = (v: number | null | undefined) => (v != null && v > 0 ? "+" : "") + gbp(v);
export const pct = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(Number(v)) ? "n/a" : `${(Number(v) * 100).toFixed(d)}%`;
export const num = (v: number | null | undefined, d = 0) =>
  v == null || !Number.isFinite(Number(v)) ? "n/a"
    : Number(v).toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d });

export const BAND_COLOR: Record<string, string> = {
  A: "var(--band-a)", B: "var(--band-b)", C: "var(--band-c)", D: "var(--band-d)", E: "var(--band-e)",
};
export const BAND_HEX: Record<string, string> = {
  A: "#86b6ef", B: "#5598e7", C: "#2a78d6", D: "#1c5cab", E: "#0d366b",
};
export const SERIES = { s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a", neg: "#e34948", ink3: "#6b7484", rule: "#d6dbe2" };

// ---------------------------------------------------------------- data fetching
export class ApiError extends Error {}

export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({ error: `Unexpected response (${res.status})` }));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const cache = new Map<string, Promise<unknown>>();

/** GET with an in-memory cache shared across pages. */
export function useGet<T>(path: string) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let live = true;
    if (!cache.has(path)) cache.set(path, api<T>(path).catch((e) => { cache.delete(path); throw e; }));
    (cache.get(path) as Promise<T>).then(
      (data) => live && setState({ data }),
      (e: Error) => live && setState({ error: e.message }),
    );
    return () => { live = false; };
  }, [path]);
  return state;
}

/** POST that re-runs (debounced) whenever its body changes; stale responses are discarded. */
export function usePost<T>(path: string, body: unknown, delay = 350) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const key = JSON.stringify(body);
  useEffect(() => {
    const ctl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api<T>(path, JSON.parse(key), ctl.signal).then(
        (data) => setState({ data, loading: false }),
        (e: Error) => e.name !== "AbortError" && setState((s) => ({ ...s, error: e.message, loading: false })),
      );
    }, delay);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [path, key, delay]);
  return state;
}

// ---------------------------------------------------------------- shared UI
export function ErrorBox({ message }: { message: string }) {
  const unconfigured = /not configured|fetch failed|ECONNREFUSED/i.test(message);
  return (
    <div className="error" role="alert">
      <b>Couldn't load data.</b> {message}
      {unconfigured && (
        <p style={{ margin: "8px 0 0" }}>
          Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in the Netlify site settings, then redeploy. The README has the steps.
        </p>
      )}
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <div className="skeleton" aria-live="polite">{what}…</div>;
}

/** A figure inside a statement that briefly highlights when its value changes. */
export function Fig({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef<string>("");
  const text = String(children);
  useEffect(() => {
    if (prev.current && prev.current !== text && ref.current) {
      const el = ref.current;
      el.classList.add("flash");
      const t = setTimeout(() => el.classList.remove("flash"), 60);
      prev.current = text;
      return () => clearTimeout(t);
    }
    prev.current = text;
  }, [text]);
  return <span ref={ref} className="fig">{children}</span>;
}

export interface Insight { tone: "positive" | "warning" | "negative" | "neutral"; title: string; detail: string }

export function Insights({ items }: { items: Insight[] }) {
  return (
    <div className="insights">
      {items.map((i) => (
        <div key={i.title} className={`insight ${i.tone}`}>
          <b>{i.title}</b>
          <p>{i.detail}</p>
        </div>
      ))}
    </div>
  );
}

export function BandChip({ band }: { band: string }) {
  return <span className="band-chip"><i style={{ background: BAND_COLOR[band] }} />{band}</span>;
}

export function Rag({ value }: { value: string }) {
  const v = value.toUpperCase();
  const cls = v === "GREEN" || v === "PASS" ? "green" : v === "AMBER" || v === "WARN" ? "amber" : "red";
  const label = { GREEN: "Stable", AMBER: "Monitor", RED: "Act", PASS: "Pass", WARN: "Warning", FAIL: "Fail" }[v] ?? v;
  return <span className={`status ${cls}`}>{label}</span>;
}

interface TipRow { label: string; value: string }
export function Tip({ title, rows }: { title: string; rows: TipRow[] }) {
  return (
    <div className="tip">
      <b>{title}</b>
      {rows.map((r) => <div key={r.label}><span>{r.label}</span><span>{r.value}</span></div>)}
    </div>
  );
}

export const axis = {
  tick: { fill: "#4a5465", fontSize: 12 },
  axisLine: { stroke: "#d6dbe2" },
  tickLine: false,
} as const;
export const grid = { stroke: "#e6e9ee", vertical: false } as const;
