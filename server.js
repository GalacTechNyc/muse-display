// Muse for Meta Ray-Ban Display — tiny server that serves the glasses web app,
// proxies chat to Meta's Muse Spark on Meta Model API (the API key never leaves the
// server), and hosts the mini web apps Muse writes for the glasses.
// Meta Model API serves an Anthropic-compatible Messages endpoint, so this uses the Anthropic SDK.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createAppStore, blobEnvNames, MAX_APP_BYTES } from "./apps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const APPS_DIR = path.resolve(here, process.env.APPS_DIR || "data/apps");

const MODEL = process.env.MUSE_MODEL || "muse-spark-1.3";
const EFFORT = process.env.MUSE_EFFORT || "medium";

const BASE_PROMPT = `You are Muse, answering on the heads-up display of Meta Ray-Ban Display smart glasses.
The screen is a small 600x600 square and the wearer is often walking or doing something else.
- Lead with the answer. Keep replies short: usually 1-4 sentences, under 80 words unless asked for more.
- Plain text only. No markdown headings, tables, code fences or bold markers. Short "- " bullet lists are fine.
- The wearer may speak or handwrite their message, so tolerate typos and transcription errors.`;

const APP_BUILDER_PROMPT = `
You can also write mini web apps that run on these glasses, using the list_apps, read_app, save_app and delete_app tools.
When the wearer asks you to make, build or create an app, tool, game, widget or screen, write it and save it with save_app. When they ask to change an app ("make it bigger", "add a reset button"), call read_app first, then save_app with the same app_id and the full updated HTML. If it is unclear which app they mean, call list_apps. Never paste code into your reply: after saving, reply with one short sentence saying what you built or changed.

Rules for every app you write (Meta Ray-Ban Display web app platform):
- One complete, self-contained HTML document with inline <style> and <script>. Scripts from https://cdn.jsdelivr.net or https://cdnjs.cloudflare.com are allowed but rarely needed.
- Include <meta name="viewport" content="width=600, height=600, initial-scale=1.0, user-scalable=no"> and <meta name="mrbd-web-app-capable" content="yes">.
- Fixed 600x600 layout: html, body { width:600px; height:600px; margin:0; overflow:hidden; }. Nothing may need page scrolling; paginate or scroll inner elements with the arrow keys instead.
- Additive see-through display: pure black (#000) is transparent. Use a black background, bright high-contrast text and accents, text at least 24px, no large bright filled areas.
- Input is only keyboard events: ArrowUp/ArrowDown/ArrowLeft/ArrowRight (swipes) and Enter (pinch). There is no mouse, touch or physical keyboard. Every control must be focusable (button or tabindex="0"), at least 88px tall, with a bright visible :focus style. Implement arrow-key focus movement yourself and focus a sensible control on load.
- Escape is reserved: it returns the wearer to Muse. Do not handle or preventDefault Escape.
- Text entry: a focused <input type="text"> or <textarea> opens the glasses' composer (voice, handwriting or on-screen keyboard) when pinched; read the value from input/change events. No per-character key events reach the page while typing.
- Available: localStorage (persist app state there, with keys prefixed by the app name), speechSynthesis (one English voice), DeviceOrientationEvent/DeviceMotionEvent (need a user gesture to request permission), navigator.geolocation (from the phone), fetch to https APIs that allow CORS. Not available: camera, microphone, notifications.
- Voice control: Meta AI on the glasses can operate the app through WebMCP. Register 1-3 tools for the app's main actions, only when supported: if (document.modelContext) { try { document.modelContext.registerTool({ name, description, inputSchema, async execute(input) { ... } }); } catch {} }.
  - Name tools for what the wearer would say (add_item, start_timer), short and distinct. Never use the names openUrl, goBack, goForward, reload, getCurrentUrl, getPageTitle or getPageText.
  - inputSchema is a flat JSON Schema object ({ type: "object", properties: {...}, required: [...] }); list every mandatory parameter in required. Use type "number" for numbers and also accept numbers sent as strings. enum, ranges and nested objects are not passed on, so state allowed values in the description.
  - execute must validate its input, do exactly what the on-screen controls do (same state, same storage, same display update) and finish within a few seconds. Return a plain object with the new state and a next_action telling Meta AI what to say in one short sentence; return { error, message, next_action } for a problem it can explain. Never read the whole screen back.
  - Every tool action must also be possible with swipes and pinches.`;

const SEARCH_PROMPT = `
Use the web_search tool for anything current, local or checkable: weather, news, scores, prices, opening hours, events, directions and places nearby. Don't guess at facts that change.
Messages may end with a [Context from the glasses: ...] note giving the wearer's local time and, when shared, their location. Use it for "near me", "here", "now" and "today" questions; don't mention it otherwise.
Never put URLs, source lists or citation markers in replies; just give the answer, naming a source briefly only when it matters.
Don't announce or narrate your steps ("Checking now", "Let me pull that up"); the glasses already show progress while you search or work. Write only the final reply.`;

const SYSTEM_PROMPT = (process.env.SYSTEM_PROMPT || BASE_PROMPT) + "\n" + SEARCH_PROMPT + "\n" + APP_BUILDER_PROMPT;

const MAX_MESSAGES = 40;
const MAX_CHARS = 20000;
const MAX_TOOL_ROUNDS = 8;

// Meta Model API takes the Anthropic SDK as-is: its own host, and the key sent as a bearer token.
const client = new Anthropic({
  baseURL: process.env.MUSE_BASE_URL || "https://api.meta.ai",
  apiKey: null,
  authToken: process.env.MODEL_API_KEY || null,
});
const apps = createAppStore({ dir: APPS_DIR });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// --- Tools Muse uses to manage glasses apps ----------------------------------

const TOOLS = [
  {
    name: "list_apps",
    description: "List the mini web apps saved for the wearer's glasses (id, title, description, last updated).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_app",
    description: "Read the full HTML source of a saved app. Always call this before modifying an app.",
    input_schema: {
      type: "object",
      properties: { app_id: { type: "string", description: "Id from list_apps or an earlier save_app" } },
      required: ["app_id"],
      additionalProperties: false,
    },
  },
  {
    name: "save_app",
    description:
      "Create a new glasses app, or replace an existing one when app_id is given. html must be the complete, self-contained HTML document. Returns the app's id.",
    input_schema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "Omit to create a new app; pass an existing id to overwrite it" },
        title: { type: "string", description: "Short name shown in the app list, e.g. 'Pomodoro Timer'" },
        description: { type: "string", description: "One short sentence describing the app" },
        html: { type: "string", description: "Complete HTML document for the app" },
      },
      required: ["title", "description", "html"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_app",
    description: "Permanently delete a saved app. Only use when the wearer clearly asks to delete it.",
    input_schema: {
      type: "object",
      properties: { app_id: { type: "string" } },
      required: ["app_id"],
      additionalProperties: false,
    },
  },
];

// Meta's docs don't pin down the type string its Messages endpoint wants for hosted
// web search. Anthropic's works (Oct 2026); if that changes, try the bare name, then
// go on without search. Remembered across requests once a type is accepted.
const SEARCH_TYPES = ["web_search_20250305", "web_search"];
const search = { index: 0, confirmed: false };

// Meta-hosted web search; runs on Meta's servers, no extra setup. Meta rejects max_uses.
function webSearchTool(place, timezone) {
  const user_location = { type: "approximate" };
  if (place?.city) user_location.city = place.city;
  if (place?.region) user_location.region = place.region;
  if (place?.country) user_location.country = place.country;
  if (timezone) user_location.timezone = timezone;
  return {
    type: SEARCH_TYPES[search.index],
    name: "web_search",
    ...(Object.keys(user_location).length > 1 ? { user_location } : {}),
  };
}

function toolsFor(context) {
  if (search.index >= SEARCH_TYPES.length) return TOOLS;
  return [...TOOLS, webSearchTool(context.place, context.timezone)];
}

// --- Where and when the wearer is -------------------------------------------

const num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

function validTimezone(tz) {
  if (typeof tz !== "string" || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// Coordinates -> neighborhood/city via OpenStreetMap Nominatim (free, light use only).
const placeCache = new Map();
async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (placeCache.has(key)) return placeCache.get(key);
  let place = null;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&addressdetails=1&lat=${lat}&lon=${lon}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "muse-display/1.0 (personal Meta Ray-Ban Display app)", "Accept-Language": "en" },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const a = (await res.json()).address || {};
      place = {
        area: a.neighbourhood || a.suburb || a.quarter || a.city_district || a.borough || "",
        street: a.road || "",
        city: a.city || a.town || a.village || a.hamlet || a.county || "",
        region: a.state || "",
        country: (a.country_code || "").toUpperCase(),
      };
    }
  } catch (err) {
    console.warn("Reverse geocoding failed:", err.message);
  }
  if (placeCache.size > 500) placeCache.clear();
  placeCache.set(key, place);
  return place;
}

// Builds the context note appended to the latest user message, plus the place for web search.
async function buildContext(raw) {
  if (!raw || typeof raw !== "object") return { note: "", place: null, timezone: null };
  const timezone = validTimezone(raw.timezone);
  const parts = [];
  if (timezone) {
    const now = new Date().toLocaleString("en-US", {
      timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    parts.push(`local time ${now} (${timezone})`);
  }
  let place = null;
  const loc = raw.location;
  if (loc && num(loc.lat, -90, 90) && num(loc.lon, -180, 180)) {
    place = await reverseGeocode(loc.lat, loc.lon);
    const name = place ? [place.street, place.area, place.city, place.region, place.country].filter(Boolean).join(", ") : "";
    const accuracy = num(loc.accuracy, 0, 1e6) ? `, ±${Math.round(loc.accuracy)} m` : "";
    parts.push(`location ${name ? name + " " : ""}(${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}${accuracy})`);
  }
  return { note: parts.length ? `\n\n[Context from the glasses: ${parts.join("; ")}]` : "", place, timezone };
}

const isStr = (v) => typeof v === "string" && v.trim() !== "";

function validateToolInput(name, input) {
  if (!input || typeof input !== "object") return "Input must be an object.";
  switch (name) {
    case "list_apps":
      return null;
    case "read_app":
    case "delete_app":
      return isStr(input.app_id) ? null : "app_id must be a non-empty string.";
    case "save_app":
      if (input.app_id !== undefined && !isStr(input.app_id)) return "app_id must be a non-empty string when given.";
      if (!isStr(input.title) || !isStr(input.description)) return "title and description are required strings.";
      if (!isStr(input.html) || !/<\/html>\s*$/i.test(input.html)) {
        return "html must be a complete HTML document ending in </html> (it may have been cut off).";
      }
      if (Buffer.byteLength(input.html) > MAX_APP_BYTES) return `html is larger than ${MAX_APP_BYTES} bytes.`;
      return null;
    default:
      return `Unknown tool ${name}.`;
  }
}

// Runs one tool call. Returns { content, isError, app? } where app is set when an app was saved.
async function runTool(block) {
  const problem = validateToolInput(block.name, block.input);
  if (problem) {
    return { isError: true, content: JSON.stringify({ INVALID_INPUT: problem }) };
  }
  const input = block.input;
  try {
    switch (block.name) {
      case "list_apps": {
        const list = await apps.list();
        return { content: list.length ? JSON.stringify(list) : "No apps saved yet." };
      }
      case "read_app":
        return { content: await apps.readHtml(input.app_id) };
      case "save_app": {
        const entry = await apps.save({
          id: input.app_id,
          title: input.title.trim().slice(0, 60),
          description: input.description.trim().slice(0, 200),
          html: input.html,
        });
        return { content: JSON.stringify({ saved: true, app_id: entry.id }), app: entry };
      }
      case "delete_app":
        await apps.remove(input.app_id);
        return { content: JSON.stringify({ deleted: true }), deleted: input.app_id };
    }
  } catch (err) {
    return { isError: true, content: String(err.message || err) };
  }
}

// --- HTTP helpers ------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": MIME[".json"] });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const authorized = (req) => !ACCESS_TOKEN || req.headers["x-access-token"] === ACCESS_TOKEN;

// Keep only well-formed, alternating text turns that start with the user.
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const messages = raw
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() !== "",
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages.at(-1).role !== "user") return null;
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) return null;
  }
  return messages;
}

// --- Chat --------------------------------------------------------------------

// Streams newline-delimited JSON events to the glasses:
//   {type:"text",text}            answer text
//   {type:"status",text}          progress, e.g. "Writing Timer…"
//   {type:"round"}                a new model request starts (marks where a retry rewinds to)
//   {type:"retry"}                discard text since the last round (request re-issued, or it was narration before a tool call)
//   {type:"app",app}              an app was saved; {type:"app_deleted",id}
//   {type:"ping"}                 keep-alive, ignored by the client
//   {type:"done"} | {type:"error",error}
async function handleChat(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { error: "Wrong or missing access key" });

  let messages;
  let rawContext;
  try {
    const body = JSON.parse(await readBody(req));
    messages = sanitizeMessages(body.messages);
    rawContext = body.context;
  } catch {
    return sendJson(res, 400, { error: "Invalid request" });
  }
  if (!messages) return sendJson(res, 400, { error: "Invalid conversation" });

  const context = await buildContext(rawContext);
  if (context.note) {
    const last = messages.at(-1);
    messages[messages.length - 1] = { ...last, content: last.content + context.note };
  }
  let tools = toolsFor(context);

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  const emit = (event) => {
    if (!res.destroyed) res.write(JSON.stringify(event) + "\n");
  };

  let current = null;
  // Keep the connection alive while Muse thinks silently (proxies may drop idle streams).
  const heartbeat = setInterval(() => emit({ type: "ping" }), 10000);
  res.on("close", () => {
    clearInterval(heartbeat);
    current?.abort();
  });

  try {
    let parseRetries = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      emit({ type: "round" });
      current = client.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        system: SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
        tools,
        messages,
      });

      let final;
      try {
        let toolBytes = 0;
        let lastReport = 0;
        let shownText = false; // text from this request is on the display
        for await (const event of current) {
          if (event.type === "content_block_start") {
            const type = event.content_block.type;
            // Muse tends to narrate before it searches or uses a tool ("Checking now…"). The
            // glasses already show progress, so clear that text and keep only the answer.
            if ((type === "server_tool_use" || type === "tool_use") && shownText) {
              emit({ type: "retry" });
              shownText = false;
            }
            // Several text blocks in one reply: keep them apart.
            if (type === "text" && shownText) emit({ type: "text", text: " " });
          }
          if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
            emit({ type: "status", text: "Searching the web…" });
          } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
            const name = event.content_block.name;
            toolBytes = 0;
            emit({ type: "status", text: name === "save_app" ? "Writing code…" : name === "read_app" ? "Reading app…" : "Working…" });
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              emit({ type: "text", text: event.delta.text });
              shownText = true;
            } else if (event.delta.type === "input_json_delta") {
              toolBytes += event.delta.partial_json.length;
              if (toolBytes - lastReport > 1024) {
                lastReport = toolBytes;
                emit({ type: "status", text: `Writing code… ${(toolBytes / 1024).toFixed(0)} KB` });
              }
            }
          }
        }
        final = await current.finalMessage();
        search.confirmed = true;
      } catch (err) {
        // Meta Model API turned down this web search tool type: try the next one, or none.
        if (
          !search.confirmed &&
          search.index < SEARCH_TYPES.length &&
          err instanceof Anthropic.BadRequestError &&
          /web_search|tool/i.test(apiErrorText(err))
        ) {
          console.warn(`Meta Model API rejected web search type ${SEARCH_TYPES[search.index]}:`, apiErrorText(err));
          search.index++;
          tools = toolsFor(context);
          round--;
          continue;
        }
        // The SDK can fail to parse a streamed tool input it cannot repair.
        // Re-issue the same request a couple of times; rethrow API errors.
        if (err instanceof Anthropic.APIError || res.destroyed || parseRetries >= 2) throw err;
        parseRetries++;
        console.warn("Re-issuing request after stream parse error:", err.message);
        emit({ type: "retry" });
        round--;
        continue;
      }

      if (final.stop_reason === "refusal") {
        emit({ type: "error", error: "Muse declined to answer that one." });
        return res.end();
      }

      // Server-side tools (web search) hit their per-turn step limit: send the turn back
      // unchanged and the API resumes where it left off.
      if (final.stop_reason === "pause_turn") {
        messages = [...messages, { role: "assistant", content: final.content }];
        continue;
      }

      const toolUses = final.content.filter((b) => b.type === "tool_use");
      if (final.stop_reason !== "tool_use" || !toolUses.length) {
        emit({ type: "done", truncated: final.stop_reason === "max_tokens" });
        return res.end();
      }

      // Run every tool call from this turn and return all results in one user message.
      const results = [];
      for (const block of toolUses) {
        const result = await runTool(block);
        if (result.app) emit({ type: "app", app: result.app });
        if (result.deleted) emit({ type: "app_deleted", id: result.deleted });
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      messages = [...messages, { role: "assistant", content: final.content }, { role: "user", content: results }];
      emit({ type: "status", text: "Finishing…" });
    }
    emit({ type: "error", error: "That took too many steps. Try a simpler request." });
  } catch (err) {
    if (res.destroyed) return;
    let message = "Something went wrong. Try again.";
    if (!process.env.MODEL_API_KEY) message = "MODEL_API_KEY isn't set on the server.";
    else if (err instanceof Anthropic.AuthenticationError) message = "Server API key is invalid.";
    else if (err instanceof Anthropic.PermissionDeniedError) message = `API key lacks access: ${apiErrorText(err)}`;
    else if (err instanceof Anthropic.RateLimitError) message = "Rate limited. Wait a moment.";
    else if (err instanceof Anthropic.APIConnectionError) message = "Can't reach Muse right now.";
    else if (err instanceof Anthropic.APIError) message = `Muse API error ${err.status ?? ""}: ${apiErrorText(err)}`;
    console.error("Meta Model API error:", err);
    emit({ type: "error", error: message });
  }
  res.end();
}

// The API's own error message (never includes the key), trimmed for the small display.
function apiErrorText(err) {
  return String(err.error?.error?.message || err.message || "unknown error").slice(0, 200);
}

// --- Apps --------------------------------------------------------------------

// Added to every app page: Escape (the glasses' back gesture) returns to Muse.
const BACK_SCRIPT = `<script>addEventListener("keydown",function(e){if(e.key==="Escape"){e.preventDefault();location.href="/?view=apps";}});</script>`;

async function serveApp(res, id) {
  try {
    if (!(await apps.get(id))) throw new Error("missing");
    const html = await apps.readHtml(id);
    const withBack = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, BACK_SCRIPT + "</body>") : html + BACK_SCRIPT;
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
    res.end(withBack);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("App not found");
  }
}

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/chat") return handleChat(req, res);
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      model: MODEL,
      locked: Boolean(ACCESS_TOKEN),
      apiKey: Boolean(process.env.MODEL_API_KEY),
      webSearch: SEARCH_TYPES[search.index] || "off",
      appStorage: apps.location.startsWith("Vercel Blob") ? "blob" : apps.location === "unavailable" ? "none" : "disk",
      blobEnv: blobEnvNames(), // names only, never values
      version: (process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 7),
      deployment: process.env.VERCEL_DEPLOYMENT_ID || "local",
      environment: process.env.VERCEL_ENV || "local",
    });
  }
  if (!authorized(req)) return sendJson(res, 401, { error: "Wrong or missing access key" });
  if (req.method === "GET" && url.pathname === "/api/apps") return sendJson(res, 200, { apps: await apps.list() });
  const m = url.pathname.match(/^\/api\/apps\/([a-z0-9-]{1,64})$/);
  if (m && req.method === "DELETE") {
    try {
      await apps.remove(m[1]);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 404, { error: err.message });
    }
  }
  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    const app = url.pathname.match(/^\/apps\/([a-z0-9-]{1,64})\/?$/);
    if (app && req.method === "GET") return await serveApp(res, app[1]);
    if (req.method === "GET" || req.method === "HEAD") return await serveStatic(req, res, url);
    res.writeHead(405).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Muse for Meta Ray-Ban Display on http://${HOST}:${PORT} (model: ${MODEL})`);
  console.log(`Apps are stored in ${apps.location}`);
  if (!process.env.MODEL_API_KEY) {
    console.warn("Warning: MODEL_API_KEY is not set — chat requests will fail.");
  }
  if (!ACCESS_TOKEN) {
    console.warn("Warning: ACCESS_TOKEN is not set — anyone with the URL can use your API key.");
  }
});
