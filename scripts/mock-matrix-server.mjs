#!/usr/bin/env node
/**
 * Lightweight Matrix Client-Server mock + chat UI for local bridge demos.
 * Not a real homeserver — enough for /whoami, /sync, /send, and the web console.
 *
 * Usage:
 *   node scripts/mock-matrix-server.mjs
 *   MATRIX_MOCK_PORT=18765 node scripts/mock-matrix-server.mjs
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MATRIX_MOCK_PORT || 18765);
const HOST = process.env.MATRIX_MOCK_HOST || "127.0.0.1";
const BOT_TOKEN = process.env.MATRIX_MOCK_BOT_TOKEN || "syt_mock_bot_token";
const BOT_USER = process.env.MATRIX_MOCK_BOT_USER || "@cursorbot:localhost";
const HUMAN_USER = "@alice:localhost";
const ROOM_ID = "!general:localhost";

/** @type {Map<string, { userId: string }>} */
const tokens = new Map([
  [BOT_TOKEN, { userId: BOT_USER }],
  ["syt_alice_token", { userId: HUMAN_USER }],
]);

/** @type {Array<{ type: string, event_id: string, sender: string, origin_server_ts: number, content: Record<string, unknown> }>} */
const timeline = [];
/** @type {Map<string, { resolve: (v: unknown) => void }[]>} */
const waiters = new Map();
let eventSeq = 0;

function nextEventId() {
  eventSeq += 1;
  return `$evt${eventSeq}:${randomUUID().slice(0, 8)}`;
}

function pushEvent(sender, content, type = "m.room.message") {
  const event = {
    type,
    event_id: nextEventId(),
    sender,
    origin_server_ts: Date.now(),
    content,
  };
  timeline.push(event);
  for (const [, queue] of waiters) {
    for (const waiter of queue.splice(0)) waiter.resolve(true);
  }
  return event;
}

function authUser(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  return tokens.get(match[1]) ?? null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  });
  res.end(payload);
}

function htmlPage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Matrix mock · cursorbot</title>
  <style>
    :root {
      --bg: #0f1419;
      --panel: #1a222c;
      --ink: #e7eef7;
      --muted: #8b9bb0;
      --accent: #3d9a6a;
      --line: #2a3542;
      --bot: #2b4c3e;
      --human: #243044;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(1200px 600px at 10% -10%, #1d3a2f 0%, transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #1a2a40 0%, transparent 50%),
        var(--bg);
    }
    main {
      max-width: 720px;
      margin: 0 auto;
      padding: 32px 16px 48px;
      display: grid;
      gap: 16px;
    }
    header h1 {
      margin: 0;
      font-family: "IBM Plex Serif", Georgia, serif;
      font-weight: 600;
      font-size: clamp(1.6rem, 4vw, 2.2rem);
      letter-spacing: -0.02em;
    }
    header p { margin: 8px 0 0; color: var(--muted); line-height: 1.45; }
    .meta {
      display: flex; flex-wrap: wrap; gap: 8px 16px;
      color: var(--muted); font-size: 0.85rem;
    }
    .meta code { color: var(--ink); }
    #log {
      background: color-mix(in srgb, var(--panel) 92%, black);
      border: 1px solid var(--line);
      min-height: 420px;
      max-height: 55vh;
      overflow: auto;
      padding: 16px;
      display: grid;
      gap: 10px;
    }
    .bubble {
      padding: 10px 12px;
      border-left: 3px solid var(--accent);
      background: var(--human);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble.bot { background: var(--bot); border-left-color: #6bcf8e; }
    .bubble .who { display:block; font-size: 0.75rem; color: var(--muted); margin-bottom: 4px; }
    form {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
    }
    input, button, select {
      font: inherit;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      padding: 12px 14px;
    }
    button {
      background: var(--accent);
      border-color: transparent;
      color: #04140c;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { filter: brightness(1.08); }
    .hints { color: var(--muted); font-size: 0.9rem; line-height: 1.4; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Matrix mock</h1>
      <p>Consola local para probar el bridge Cursor ↔ Matrix sin tu Synapse.</p>
    </header>
    <div class="meta">
      <span>Sala <code>${ROOM_ID}</code></span>
      <span>Bot <code>${BOT_USER}</code></span>
      <span>Tú <code>${HUMAN_USER}</code></span>
    </div>
    <div id="log" aria-live="polite"></div>
    <form id="composer">
      <input id="message" autocomplete="off" placeholder="Escribe @cursorbot hola  o  !cursor resume el ticket" />
      <button type="submit">Enviar</button>
    </form>
    <p class="hints">
      El bot despierta con mención (<code>@cursorbot</code>), DM, o prefijo <code>!cursor</code>.
      Arranca el agente con las variables del mock (ver README) y espera la respuesta <code>m.notice</code>.
    </p>
  </main>
  <script>
    const ROOM_ID = ${JSON.stringify(ROOM_ID)};
    const HUMAN = ${JSON.stringify(HUMAN_USER)};
    const logEl = document.getElementById("log");
    const form = document.getElementById("composer");
    const input = document.getElementById("message");
    let since = "0";

    function render(events) {
      for (const event of events) {
        if (event.type !== "m.room.message") continue;
        const div = document.createElement("div");
        div.className = "bubble" + (event.sender.includes("cursorbot") ? " bot" : "");
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = event.sender + " · " + (event.content.msgtype || "m.text");
        div.appendChild(who);
        div.appendChild(document.createTextNode(event.content.body || ""));
        logEl.appendChild(div);
      }
      logEl.scrollTop = logEl.scrollHeight;
    }

    async function syncLoop() {
      while (true) {
        try {
          const res = await fetch("/_matrix/client/v3/sync?timeout=15000&since=" + encodeURIComponent(since), {
            headers: { Authorization: "Bearer syt_alice_token" },
          });
          const data = await res.json();
          since = data.next_batch;
          const events = data.rooms?.join?.[ROOM_ID]?.timeline?.events || [];
          render(events);
        } catch (err) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      input.value = "";
      const mentions = [];
      if (/@cursorbot\\b/i.test(body) || body.includes("${BOT_USER}")) {
        mentions.push("${BOT_USER}");
      }
      await fetch("/_matrix/client/v3/rooms/" + encodeURIComponent(ROOM_ID) + "/send/m.room.message/" + crypto.randomUUID(), {
        method: "PUT",
        headers: {
          Authorization: "Bearer syt_alice_token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          msgtype: "m.text",
          body,
          "m.mentions": mentions.length ? { user_ids: mentions } : undefined,
        }),
      });
    });

    syncLoop();
  </script>
</body>
</html>`;
}

function eventsSince(token) {
  const index = Number(token || "0");
  if (!Number.isFinite(index) || index < 0) return timeline.slice();
  return timeline.slice(index);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    });
    return res.end();
  }

  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(htmlPage());
    }

    if (req.method === "GET" && url.pathname === "/_matrix/client/versions") {
      return sendJson(res, 200, { versions: ["v1.11"] });
    }

    if (req.method === "POST" && url.pathname === "/_matrix/client/v3/login") {
      const body = await readBody(req);
      if (body?.type === "m.login.password" && body.identifier?.user === "cursorbot") {
        return sendJson(res, 200, {
          user_id: BOT_USER,
          access_token: BOT_TOKEN,
          device_id: "MOCKBOT",
          home_server: "localhost",
        });
      }
      return sendJson(res, 403, { errcode: "M_FORBIDDEN", error: "Bad credentials" });
    }

    const user = authUser(req);
    if (!user && url.pathname.startsWith("/_matrix/")) {
      return sendJson(res, 401, { errcode: "M_UNKNOWN_TOKEN", error: "Invalid token" });
    }

    if (req.method === "GET" && url.pathname === "/_matrix/client/v3/account/whoami") {
      return sendJson(res, 200, { user_id: user.userId, device_id: "MOCK" });
    }

    if (req.method === "GET" && url.pathname === "/_matrix/client/v3/joined_rooms") {
      return sendJson(res, 200, { joined_rooms: [ROOM_ID] });
    }

    if (req.method === "POST" && url.pathname.startsWith("/_matrix/client/v3/join/")) {
      return sendJson(res, 200, { room_id: ROOM_ID });
    }

    if (req.method === "GET" && url.pathname === "/_matrix/client/v3/sync") {
      const timeout = Math.min(Number(url.searchParams.get("timeout") || 0), 25000);
      const since = url.searchParams.get("since") || "0";
      let batch = eventsSince(since);
      if (batch.length === 0 && timeout > 0) {
        await new Promise((resolve) => {
          const key = randomUUID();
          const timer = setTimeout(() => {
            const queue = waiters.get(key);
            if (queue) waiters.delete(key);
            resolve(false);
          }, timeout);
          waiters.set(key, [
            {
              resolve: () => {
                clearTimeout(timer);
                waiters.delete(key);
                resolve(true);
              },
            },
          ]);
        });
        batch = eventsSince(since);
      }
      const next = String(timeline.length);
      return sendJson(res, 200, {
        next_batch: next,
        rooms: {
          join: {
            [ROOM_ID]: {
              summary: { "m.joined_member_count": 3 },
              timeline: { events: batch },
            },
          },
        },
      });
    }

    const sendMatch = url.pathname.match(
      /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/,
    );
    if (req.method === "PUT" && sendMatch) {
      const body = (await readBody(req)) || {};
      const event = pushEvent(user.userId, body, decodeURIComponent(sendMatch[2]));
      return sendJson(res, 200, { event_id: event.event_id });
    }

    const typingMatch = url.pathname.match(
      /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/typing\/([^/]+)$/,
    );
    if (req.method === "PUT" && typingMatch) {
      return sendJson(res, 200, {});
    }

    sendJson(res, 404, { errcode: "M_NOT_FOUND", error: `No route ${url.pathname}` });
  } catch (error) {
    sendJson(res, 500, {
      errcode: "M_UNKNOWN",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-matrix] UI http://${HOST}:${PORT}/`);
  console.log(`[mock-matrix] CS API http://${HOST}:${PORT}/_matrix/client/v3/...`);
  console.log(`[mock-matrix] bot token ${BOT_TOKEN} as ${BOT_USER}`);
});
