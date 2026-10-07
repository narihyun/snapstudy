// Run the app on your own computer without Netlify:
//   1) put your key in a file named .env next to this file:  OPENAI_API_KEY=sk-...
//   2) node local-server.mjs
//   3) open http://localhost:8888
// Needs Node.js 18 or newer. No packages to install.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (typeof fetch !== "function" || typeof Request !== "function") {
  console.error(`Your Node.js is too old (${process.version}). SnapStudy needs Node.js 18 or newer.\nInstall the "LTS" version from https://nodejs.org, close and reopen the terminal, then run: node local-server.mjs`);
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    // Accepts "OPENAI_API_KEY=sk-...", with optional "export", spaces or quotes.
    const m = line.replace(/^\uFEFF/, "").match(/^\s*(?:export\s+)?([A-Za-z_]+)\s*[=:]\s*(.*?)\s*;?\s*$/);
    if (m && !process.env[m[1].toUpperCase()]) process.env[m[1].toUpperCase()] = m[2].replace(/^["']|["']$/g, "");
  }
}
const key = process.env.OPENAI_API_KEY || "";
if (!fs.existsSync(envFile)) console.warn(`No .env file found at ${envFile}`);
if (!key) console.warn("OPENAI_API_KEY is NOT set. Put one line in .env:  OPENAI_API_KEY=sk-...   then restart.");
else console.log(`OPENAI_API_KEY loaded (…${key.slice(-4)}).`);

globalThis.Netlify = { env: { get: (k) => process.env[k] } };
const { default: ai } = await import("./netlify/functions/ai.mjs");

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
const root = path.join(here, "public");
const port = Number(process.env.PORT) || 8888;

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/ai")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await ai(new Request(`http://localhost${req.url}`, {
        method: req.method, headers: req.headers,
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      }));
      res.writeHead(r.status, { "Content-Type": "application/json" });
      return res.end(await r.text());
    }
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(root, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(port, () => console.log(`SnapStudy running at http://localhost:${port}`));
