// Minimal Supabase (PostgREST) client: no SDK needed for RPC calls and view reads.

export class DbError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

function config() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new DbError("Supabase is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY", 503);
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, key } = config();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? text;
    } catch {
      /* keep raw text */
    }
    throw new DbError(`Database error (${res.status}): ${msg}`.slice(0, 400));
  }
  return (text ? JSON.parse(text) : null) as T;
}

export function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  return request<T>(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
}

export function select<T>(relation: string, query = "select=*"): Promise<T> {
  return request<T>(`${relation}?${query}`);
}

/** Run async tasks with bounded concurrency (keeps the free-tier connection pool happy). */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
