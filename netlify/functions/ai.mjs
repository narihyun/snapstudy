// Server-side relay to the OpenAI Chat Completions API.
// The API key stays here (Netlify environment variable OPENAI_API_KEY), never in the browser.
// The browser sends only {step, data}; the prompt for each step is built on the server
// (netlify/prompts.mjs), so nobody can use this endpoint as a free general chatbot.
import { STEPS } from "../prompts.mjs";

const MAX_BODY_BYTES = 5_500_000;
const MAX_IMAGES = 6;

export default async (req) => {
  if (req.method === "GET") {
    // Lets the page tell the learner whether the AI is connected.
    return json({ ready: Boolean(Netlify.env.get("OPENAI_API_KEY")), model: model() });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Netlify.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "The server has no OPENAI_API_KEY yet. Add it in Netlify: Site configuration → Environment variables, then redeploy." }, 500);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "Bad JSON." }, 400); }

  const build = STEPS[body?.step];
  if (!build) return json({ error: "Unknown step." }, 400);
  const data = body.data || {};
  if (Array.isArray(data.images) && data.images.length > MAX_IMAGES) return json({ error: "Too many images." }, 400);

  let prompt;
  try { prompt = build(data); } catch { return json({ error: "Bad data for this step." }, 400); }

  const started = Date.now();
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model(),
      messages: prompt.messages,
      max_completion_tokens: prompt.max,
      response_format: { type: "json_object" },
    }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: out?.error?.message || `OpenAI error ${r.status}` }, 502);

  const text = out.choices?.[0]?.message?.content || "";
  let result;
  try { result = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    try { result = m ? JSON.parse(m[0]) : null; } catch { result = null; }
  }
  if (!result) return json({ error: "The AI did not return usable data. Please try again." }, 502);
  return json({ result, model: model(), ms: Date.now() - started, usage: out.usage ?? null });
};

const model = () => Netlify.env.get("OPENAI_MODEL") || "gpt-4.1-mini";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export const config = { path: "/api/ai" };
