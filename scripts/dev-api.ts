// Runs the Netlify API function as a plain Node server for local development, so the
// project works without the Netlify CLI. Vite proxies /api to this port.
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run dev:api
import http from "node:http";
import handler from "../netlify/functions/api.mts";

const PORT = Number(process.env.API_PORT ?? 8888);

http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: { "Content-Type": "application/json" },
    body: req.method === "POST" ? body : undefined,
  });
  const t0 = Date.now();
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(await response.text());
  console.log(`${req.method} ${req.url} -> ${response.status} (${Date.now() - t0}ms)`);
}).listen(PORT, () => console.log(`API on http://localhost:${PORT}/api`));
