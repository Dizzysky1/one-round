/* ======================================================================
   ONE ROUND — Cloudflare Worker entry.

   Routes:
     GET  /board        → shared leaderboard (KV, top 30)
     POST /score        → submit a score (per-IP naive rate limit via KV)
     POST /duel/new     → mint a 4-char room code
     GET  /duel/:code   → WebSocket upgrade → DuelRoom Durable Object

   No secrets anywhere in this file or repo. CORS is locked to the
   GitHub Pages origin plus localhost (see shared.js).
   ==================================================================== */
import SHARED from "./shared.js";
export { DuelRoom } from "./duel.js";

const BOARD_KEY = "board:v1";
const RATE_MAX_PER_MIN = 10;

function json(data, status, cors, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, cors || {}, extra || {})
  });
}

async function readBoard(env) {
  try {
    const raw = await env.LEADERBOARD.get(BOARD_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

// Naive per-IP limiter on KV. KV is eventually consistent, so this is a
// soft cap, not a hard guarantee — which is all a public leaderboard
// needs. (A hard limiter would be one more tiny DO; see README.md.)
async function rateLimited(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = "rl:" + ip + ":" + Math.floor(Date.now() / 60000);
  const n = parseInt((await env.LEADERBOARD.get(key)) || "0", 10);
  if (n >= RATE_MAX_PER_MIN) return true;
  await env.LEADERBOARD.put(key, String(n + 1), { expirationTtl: 120 });
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = SHARED.corsHeaders(origin);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Browser requests carry an Origin header; require it to be ours.
    // (curl/no-Origin GETs of the public board are allowed for debugging.)
    if (request.method === "OPTIONS") {
      return cors ? new Response(null, { status: 204, headers: cors })
                  : new Response(null, { status: 403 });
    }
    if (origin && !cors) return json({ error: "origin_forbidden" }, 403);

    // ------------------------------------------------------ leaderboard
    if (path === "/board" && request.method === "GET") {
      const board = await readBoard(env);
      return json({ board: board }, 200, cors, { "Cache-Control": "public, max-age=15" });
    }

    if (path === "/score" && request.method === "POST") {
      if (!cors) return json({ error: "origin_required" }, 403);
      if (await rateLimited(env, request)) return json({ error: "rate_limited" }, 429, cors);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "bad_json" }, 400, cors); }
      const entry = SHARED.sanitizeScoreEntry(body, Date.now());
      if (!entry) return json({ error: "bad_entry" }, 400, cors);
      // Read-merge-write on KV: last write wins on a race, acceptable for
      // a casual board (see README.md for the DO-backed upgrade path).
      const board = SHARED.mergeBoard(await readBoard(env), entry);
      await env.LEADERBOARD.put(BOARD_KEY, JSON.stringify(board));
      return json({ board: board }, 200, cors);
    }

    // ------------------------------------------------------------ duels
    if (path === "/duel/new" && request.method === "POST") {
      if (!cors) return json({ error: "origin_required" }, 403);
      const code = SHARED.makeRoomCode(() => {
        const a = new Uint32Array(1);
        crypto.getRandomValues(a);
        return a[0] / 4294967296;
      });
      return json({ code: code }, 200, cors);
    }

    const duel = path.match(/^\/duel\/([A-HJ-NP-Z2-9]{4})$/);
    if (duel && request.method === "GET") {
      const code = duel[1];
      if (!SHARED.isRoomCode(code)) return json({ error: "bad_code" }, 400, cors);
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ error: "expected_websocket" }, 426, cors);
      }
      // WebSocket upgrades also carry Origin in browsers — enforce it.
      if (!cors) return json({ error: "origin_forbidden" }, 403);
      const id = env.DUEL_ROOM.idFromName(code);
      return env.DUEL_ROOM.get(id).fetch(request);
    }

    return json({ error: "not_found" }, 404, cors);
  }
};
