// The demo's "your backend": the only place that holds the Fish API key.
// The app asks it for a session token when the user starts a call; it calls
// POST /v1/agent/sessions with the key and returns the response unchanged.
//
// A real backend would also check who the user is (and rate-limit them)
// before handing out a token, and pass that identity as end_user_id.
//
//   cp server/.env.example server/.env.local   # fill in the key and agent
//   pnpm server
import { createServer } from "node:http";

const API_KEY = process.env.FISH_API_KEY;
const AGENT_ID = process.env.FISH_AGENT_ID;
const PORT = Number(process.env.PORT ?? 3001);
const LANGUAGES = new Set(["en", "ja", "zh", "ko", "es", "fr", "de", "pt", "it", "nl"]);

if (!API_KEY || !AGENT_ID) {
  console.error("Set FISH_API_KEY and FISH_AGENT_ID in server/.env.local");
  process.exit(1);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/agent-session") {
    res.writeHead(404).end();
    return;
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    res.writeHead(400).end();
    return;
  }
  // The agent is the backend's choice, never the app's. The app may only pick
  // from what the backend allows: here, the reply language and its time zone.
  const request = {
    agent_id: AGENT_ID,
    ...(LANGUAGES.has(body.language) ? { overrides: { language: body.language } } : {}),
    ...(typeof body.timezone === "string" ? { client_timezone: body.timezone } : {}),
  };
  try {
    const upstream = await fetch("https://api.fish.audio/v1/agent/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(await upstream.text());
  } catch (error) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Could not reach Fish Audio: ${String(error)}` }));
  }
}).listen(PORT, "0.0.0.0", () => console.log(`token backend on :${PORT} (POST /agent-session)`));
