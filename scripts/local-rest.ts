// Local stand-in for Supabase's REST layer, for development and tests without a Supabase
// project. Implements the small PostgREST subset the API uses:
//   GET  /rest/v1/<table|view>?select=a,b&order=col[.desc]&limit=n
//   POST /rest/v1/rpc/<function>   (JSON body = named arguments)
// Usage: LOCAL_DATABASE_URL=postgres://user:pass@localhost:5432/db npm run dev:pg-rest
import http from "node:http";
import pg from "pg";

const PORT = Number(process.env.LOCAL_REST_PORT ?? 54321);
// PostgREST returns bigint and numeric as JSON numbers; node-postgres returns strings
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
const db = new pg.Pool({ connectionString: process.env.LOCAL_DATABASE_URL, max: 10 });
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`bad identifier ${s}`);
  return `"${s}"`;
};

async function handle(req: http.IncomingMessage): Promise<[number, unknown]> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname.replace(/^\/rest\/v1\//, "");
  const client = await db.connect();
  try {
    await client.query("set role anon"); // same privileges as the Supabase anon key
    if (req.method === "POST" && path.startsWith("rpc/")) {
      const fn = path.slice(4);
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const args = raw ? JSON.parse(raw) : {};
      const names = Object.keys(args);
      const sql = `select public.${ident(fn)}(${names.map((n, i) => `${ident(n)} => $${i + 1}`).join(", ")}) as r`;
      const r = await client.query(sql, names.map((n) => (typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n])));
      return [200, r.rows[0]?.r ?? null];
    }
    if (req.method === "POST") {
      // bulk upsert, used by pipeline/seed_supabase.py (service-role equivalent)
      await client.query("reset role");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const rows = JSON.parse(raw) as Record<string, unknown>[];
      const cols = Object.keys(rows[0] ?? {});
      const pk = await client.query(
        `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = $1::regclass and i.indisprimary`, [`public.${ident(path)}`]);
      const key = pk.rows.map((r) => ident(r.attname)).join(", ");
      const update = cols.filter((c) => !pk.rows.some((r) => r.attname === c)).map((c) => `${ident(c)} = excluded.${ident(c)}`);
      await client.query(
        `insert into public.${ident(path)} (${cols.map(ident).join(", ")})
         select ${cols.map(ident).join(", ")} from jsonb_populate_recordset(null::public.${ident(path)}, $1::jsonb)
         on conflict (${key}) ${update.length ? `do update set ${update.join(", ")}` : "do nothing"}`,
        [JSON.stringify(rows)]);
      return [201, null];
    }
    if (req.method === "GET") {
      const cols = (url.searchParams.get("select") ?? "*").split(",").map((c) => (c === "*" ? "*" : ident(c))).join(", ");
      const order = url.searchParams.get("order");
      const limit = Number(url.searchParams.get("limit") ?? 0);
      let sql = `select ${cols} from public.${ident(path)}`;
      if (order) {
        const [c, dir] = order.split(".");
        sql += ` order by ${ident(c)} ${dir === "desc" ? "desc" : "asc"}`;
      }
      if (limit > 0) sql += ` limit ${Math.floor(limit)}`;
      return [200, (await client.query(sql)).rows];
    }
    return [404, { message: "not found" }];
  } finally {
    await client.query("reset role").catch(() => undefined);
    client.release();
  }
}

http.createServer(async (req, res) => {
  try {
    const [status, body] = await handle(req);
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ message: (e as Error).message }));
  }
}).listen(PORT, () => console.log(`local REST shim on http://localhost:${PORT}`));
