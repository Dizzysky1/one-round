/* ======================================================================
   ONE ROUND — DuelRoom Durable Object (server-authoritative 1v1).

   Uses the WebSocket Hibernation API: sockets are accepted with
   state.acceptWebSocket(), per-socket identity survives eviction via
   serializeAttachment(), and ALL match state lives in transactional
   storage so the object can hibernate between messages. Deadlines
   (shot clock, reconnect grace, idle cleanup) run on storage alarms.

   Protocol: multiplayer/PROTOCOL.md. Physics/levels: ./solver.js.
   ==================================================================== */
import SOLVER from "./solver.js";
import SHARED from "./shared.js";

const SHOT_CLOCK_MS = 75000;   // per range, from level_start startAt
const COUNTDOWN_MS = 3000;     // before range 1
const INTERMISSION_MS = 6000;  // between ranges
const GRACE_MS = 60000;        // reconnect window mid-match
const IDLE_TTL_MS = 15 * 60 * 1000;
const RANGES = 5;              // best of 5
const WINS_NEEDED = 3;         // first to 3 range wins ends the match
const MSG_WINDOW_MS = 10000, MSG_WINDOW_MAX = 30; // per-socket rate limit

function newToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[x & 63];
  return s;
}

function newSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] >>> 0;
}

// Range plan: 5 ranges at levels 1..5; map 1 is always "range" (like the
// solo game), then a random walk over the other maps. Seeds are fresh
// 32-bit values — clients never derive them, they receive them.
function makePlan() {
  const rest = SOLVER.MAPS.filter((m) => m.id !== "range").map((m) => m.id);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = rest[i]; rest[i] = rest[j]; rest[j] = t;
  }
  const mapIds = ["range"].concat(rest);
  const plan = [];
  for (let r = 1; r <= RANGES; r++) {
    plan.push({ range: r, level: r, mapId: mapIds[(r - 1) % mapIds.length], seed: newSeed() });
  }
  return plan;
}

function blankMatch(code) {
  return {
    code: code,
    phase: "lobby",            // lobby | range | done
    players: {},               // token -> {name, slot, ready, connected, wins, total}
    plan: null,
    range: 0,
    startAt: 0,
    deadline: 0,
    results: {},               // range -> slot -> {score,kills,cleared,bestBank,timeout,ending}
    rematch: {},
    graceUntil: null           // {token, at} while one player is disconnected mid-match
  };
}

export class DuelRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rate = new Map();     // per-socket rate limiting (in-memory, naive by design)
  }

  // ------------------------------------------------------------ helpers
  async load() {
    if (!this.match) this.match = (await this.state.storage.get("match")) || null;
    return this.match;
  }
  async save() {
    await this.state.storage.put("match", this.match);
  }
  async setAlarms(patch) {
    const alarms = (await this.state.storage.get("alarms")) || {};
    Object.assign(alarms, patch);
    await this.state.storage.put("alarms", alarms);
    const times = Object.values(alarms).filter((t) => typeof t === "number" && t > 0);
    if (times.length) await this.state.storage.setAlarm(Math.min(...times));
  }
  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket already gone */ }
  }
  broadcast(obj) {
    for (const ws of this.state.getWebSockets()) this.send(ws, obj);
  }
  socketsFor(token) {
    return this.state.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment();
      return a && a.token === token;
    });
  }
  sendTo(token, obj) {
    for (const ws of this.socketsFor(token)) this.send(ws, obj);
  }
  tokens(match) { return Object.keys(match.players); }
  opponentOf(match, token) {
    return this.tokens(match).find((t) => t !== token) || null;
  }
  playerPublic(p, extra) {
    return Object.assign({ slot: p.slot, name: p.name, ready: !!p.ready,
                           connected: !!p.connected, wins: p.wins | 0 }, extra || {});
  }

  // ------------------------------------------------------------- fetch
  // The worker only forwards WebSocket upgrades for /duel/:code here.
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const code = url.pathname.split("/")[2] || "";
    if (!SHARED.isRoomCode(code)) return new Response("bad room code", { status: 400 });

    let match = await this.load();
    if (!match) {
      this.match = match = blankMatch(code);
      await this.save();
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ token: null });   // identity set by the join message
    await this.setAlarms({ idle: Date.now() + IDLE_TTL_MS });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------- messages
  async webSocketMessage(ws, raw) {
    // naive per-socket rate limit — resets on hibernation, which is fine:
    // its only job is stopping tight message loops.
    const now = Date.now();
    let rl = this.rate.get(ws);
    if (!rl || now - rl.t0 > MSG_WINDOW_MS) { rl = { t0: now, n: 0 }; this.rate.set(ws, rl); }
    if (++rl.n > MSG_WINDOW_MAX) { ws.close(1008, "rate"); return; }

    const v = SHARED.validateClientMessage(typeof raw === "string" ? raw : "");
    if (!v.ok) { this.send(ws, { type: "error", code: v.code }); return; }
    const m = v.msg;

    const match = await this.load();
    if (!match) { ws.close(1011, "no room"); return; }

    if (m.type === "ping") { this.send(ws, { type: "pong", t: now }); return; }
    if (m.type === "join") { await this.onJoin(ws, m); return; }

    const att = ws.deserializeAttachment();
    const token = att && att.token;
    if (!token || !match.players[token]) {
      this.send(ws, { type: "error", code: "not_joined" });
      return;
    }
    if (m.type === "ready") await this.onReady(token);
    else if (m.type === "shot") await this.onShot(ws, token, m);
    else if (m.type === "rematch") await this.onRematch(token);
  }

  async onJoin(ws, m) {
    const match = this.match;

    // Reconnect: a token we know reclaims its seat (and boots stale sockets).
    if (m.token && match.players[m.token]) {
      const p = match.players[m.token];
      for (const other of this.socketsFor(m.token)) {
        if (other !== ws) other.close(4000, "superseded");
      }
      ws.serializeAttachment({ token: m.token });
      p.connected = true;
      p.name = m.name || p.name;
      if (match.graceUntil && match.graceUntil.token === m.token) {
        match.graceUntil = null;
        await this.setAlarms({ grace: 0 });
      }
      await this.save();
      this.send(ws, this.resyncPayload(match, m.token));
      const opp = this.opponentOf(match, m.token);
      if (opp) this.sendTo(opp, { type: "opponent_status", opponent: this.playerPublic(p) });
      return;
    }

    // Fresh join.
    if (this.tokens(match).length >= 2) {
      this.send(ws, { type: "error", code: "room_full" });
      ws.close(4001, "room full");
      return;
    }
    const token = newToken();
    const slot = this.tokens(match).map((t) => match.players[t].slot).includes(0) ? 1 : 0;
    match.players[token] = { name: m.name, slot: slot, ready: false, connected: true, wins: 0, total: 0 };
    ws.serializeAttachment({ token: token });
    await this.save();
    this.send(ws, this.resyncPayload(match, token));
    const opp = this.opponentOf(match, token);
    if (opp) this.sendTo(opp, { type: "opponent_status", opponent: this.playerPublic(match.players[token]) });
  }

  // Full state snapshot: used for the initial `joined` and every reconnect.
  resyncPayload(match, token) {
    const me = match.players[token];
    const oppTok = this.opponentOf(match, token);
    const out = {
      type: "joined",
      code: match.code,
      token: token,
      slot: me.slot,
      phase: match.phase,
      you: this.playerPublic(me),
      opponent: oppTok ? this.playerPublic(match.players[oppTok]) : null
    };
    if (match.phase === "range" && match.plan) {
      const cur = match.plan[match.range - 1];
      const fired = !!(match.results[match.range] && match.results[match.range][me.slot]);
      out.current = {
        range: cur.range, level: cur.level, seed: cur.seed, mapId: cur.mapId,
        stats: SOLVER.duelStats(cur.level),
        startAt: match.startAt, deadline: match.deadline, fired: fired
      };
    }
    return out;
  }

  async onReady(token) {
    const match = this.match;
    if (match.phase !== "lobby") return;
    match.players[token].ready = true;
    const toks = this.tokens(match);
    const opp = this.opponentOf(match, token);
    if (opp) this.sendTo(opp, { type: "opponent_status", opponent: this.playerPublic(match.players[token]) });
    if (toks.length === 2 && toks.every((t) => match.players[t].ready)) {
      await this.startMatch();
    } else {
      await this.save();
    }
  }

  async startMatch() {
    const match = this.match;
    match.plan = makePlan();
    match.results = {};
    match.rematch = {};
    for (const t of this.tokens(match)) { match.players[t].wins = 0; match.players[t].total = 0; }
    await this.startRange(1, Date.now() + COUNTDOWN_MS);
  }

  async startRange(range, startAt) {
    const match = this.match;
    match.phase = "range";
    match.range = range;
    match.startAt = startAt;
    match.deadline = startAt + SHOT_CLOCK_MS;
    match.results[range] = match.results[range] || {};
    await this.save();
    await this.setAlarms({ shot: match.deadline });
    const cur = match.plan[range - 1];
    this.broadcast({
      type: "level_start",
      range: cur.range, level: cur.level, seed: cur.seed, mapId: cur.mapId,
      stats: SOLVER.duelStats(cur.level),
      startAt: startAt, deadline: match.deadline,
      bestOf: RANGES, winsNeeded: WINS_NEEDED
    });
  }

  async onShot(ws, token, m) {
    const match = this.match;
    if (match.phase !== "range") { this.send(ws, { type: "error", code: "not_in_range" }); return; }
    if (m.range !== match.range) { this.send(ws, { type: "error", code: "wrong_range" }); return; }
    const me = match.players[token];
    const slotResults = match.results[match.range];
    if (slotResults[me.slot]) { this.send(ws, { type: "error", code: "already_fired" }); return; }
    if (Date.now() < match.startAt) { this.send(ws, { type: "error", code: "too_early" }); return; }

    const cur = match.plan[match.range - 1];
    const stats = SOLVER.duelStats(cur.level);
    // Anticheat: stats are never trusted — the client echoes them and the
    // server verifies the echo matches the canonical duel loadout.
    if (m.stats !== undefined && !SOLVER.statsMatch(m.stats, stats)) {
      this.send(ws, { type: "error", code: "stats_mismatch" });
      return;
    }

    // Server-authoritative re-solve: same solver, same seed, same level.
    const verdict = SOLVER.solve(cur.seed, cur.mapId, cur.level, m.pos, m.aim, m.ph, stats);
    if (!verdict.ok) { this.send(ws, { type: "error", code: verdict.code }); return; }

    slotResults[me.slot] = {
      score: verdict.score, kills: verdict.kills, cleared: verdict.cleared,
      bestBank: verdict.bestBank, ending: verdict.ending, timeout: false
    };
    me.total += verdict.score;
    await this.save();

    this.send(ws, Object.assign({ type: "verdict", range: match.range }, verdict, { ok: undefined }));
    const opp = this.opponentOf(match, token);
    if (opp) {
      this.sendTo(opp, { type: "opponent_status",
                         opponent: this.playerPublic(me, { fired: true }) });
    }

    const toks = this.tokens(match);
    if (toks.every((t) => slotResults[match.players[t].slot])) {
      await this.resolveRange();
    }
  }

  async resolveRange() {
    const match = this.match;
    const range = match.range;
    const res = match.results[range];
    const toks = this.tokens(match);
    const bySlot = [null, null];
    for (const t of toks) {
      const p = match.players[t];
      const r = res[p.slot] || { score: 0, kills: 0, cleared: false, bestBank: 0, timeout: true };
      res[p.slot] = r;
      bySlot[p.slot] = { slot: p.slot, name: p.name, score: r.score, kills: r.kills,
                         cleared: r.cleared, bestBank: r.bestBank, timeout: !!r.timeout };
    }
    let winnerSlot = null;
    if (bySlot[0] && bySlot[1]) {
      if (bySlot[0].score > bySlot[1].score) winnerSlot = 0;
      else if (bySlot[1].score > bySlot[0].score) winnerSlot = 1;
    }
    if (winnerSlot !== null) {
      for (const t of toks) if (match.players[t].slot === winnerSlot) match.players[t].wins++;
    }
    const wins = [0, 0];
    for (const t of toks) wins[match.players[t].slot] = match.players[t].wins;

    const over = wins[0] >= WINS_NEEDED || wins[1] >= WINS_NEEDED || range >= RANGES;
    const nextStartAt = over ? null : Date.now() + INTERMISSION_MS;
    await this.setAlarms({ shot: 0 });
    this.broadcast({ type: "round_result", range: range, scores: bySlot,
                     winnerSlot: winnerSlot, wins: wins,
                     next: over ? null : { range: range + 1, startAt: nextStartAt } });

    if (over) await this.endMatch("score");
    else await this.startRange(range + 1, nextStartAt);
  }

  async endMatch(reason, forfeitLoserSlot) {
    const match = this.match;
    match.phase = "done";
    match.startAt = 0; match.deadline = 0;
    match.rematch = {};
    for (const t of this.tokens(match)) match.players[t].ready = false;
    const wins = [0, 0], totals = [0, 0];
    for (const t of this.tokens(match)) {
      const p = match.players[t];
      wins[p.slot] = p.wins; totals[p.slot] = p.total;
    }
    let winnerSlot = null;
    if (reason === "forfeit") winnerSlot = forfeitLoserSlot === 0 ? 1 : 0;
    else if (wins[0] !== wins[1]) winnerSlot = wins[0] > wins[1] ? 0 : 1;
    else if (totals[0] !== totals[1]) winnerSlot = totals[0] > totals[1] ? 0 : 1; // tiebreak: total score
    await this.save();
    await this.setAlarms({ shot: 0, grace: 0 });
    this.broadcast({ type: "match_result", winnerSlot: winnerSlot, wins: wins,
                     totals: totals, reason: winnerSlot === null ? "draw" : reason });
  }

  async onRematch(token) {
    const match = this.match;
    if (match.phase !== "done") return;
    match.rematch[token] = true;
    await this.save();
    const opp = this.opponentOf(match, token);
    if (opp) this.sendTo(opp, { type: "rematch", from: match.players[token].slot });
    const toks = this.tokens(match);
    if (toks.length === 2 && toks.every((t) => match.rematch[t])) {
      await this.startMatch();
    }
  }

  // -------------------------------------------------------- disconnect
  async webSocketClose(ws) {
    this.rate.delete(ws);
    const att = ws.deserializeAttachment();
    const token = att && att.token;
    const match = await this.load();
    if (!match) return;

    if (token && match.players[token] && this.socketsFor(token).length === 0) {
      const p = match.players[token];
      p.connected = false;
      const opp = this.opponentOf(match, token);
      if (match.phase === "range") {
        // hibernation-friendly reconnect window before the forfeit
        match.graceUntil = { token: token, at: Date.now() + GRACE_MS };
        await this.setAlarms({ grace: match.graceUntil.at });
      } else if (match.phase === "lobby") {
        delete match.players[token];
      }
      await this.save();
      if (opp && match.players[opp]) {
        this.sendTo(opp, { type: "opponent_status",
                           opponent: this.playerPublic(p, { connected: false }) });
      }
    }
    if (this.state.getWebSockets().length === 0) {
      await this.setAlarms({ idle: Date.now() + IDLE_TTL_MS });
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  // ------------------------------------------------------------ alarms
  async alarm() {
    const now = Date.now();
    const alarms = (await this.state.storage.get("alarms")) || {};
    const match = await this.load();

    if (alarms.shot && now >= alarms.shot) {
      alarms.shot = 0;
      if (match && match.phase === "range" && match.deadline && now >= match.deadline) {
        await this.resolveRange();   // anyone who has not fired scores 0
      }
    }
    if (alarms.grace && now >= alarms.grace) {
      alarms.grace = 0;
      if (match && match.phase === "range" && match.graceUntil &&
          now >= match.graceUntil.at && match.players[match.graceUntil.token] &&
          !match.players[match.graceUntil.token].connected) {
        const loser = match.players[match.graceUntil.token].slot;
        match.graceUntil = null;
        await this.endMatch("forfeit", loser);
      }
    }
    if (alarms.idle && now >= alarms.idle) {
      alarms.idle = 0;
      if (this.state.getWebSockets().length === 0) {
        this.match = null;
        await this.state.storage.deleteAll();
        return;
      }
      alarms.idle = now + IDLE_TTL_MS;
    }
    await this.state.storage.put("alarms", alarms);
    const times = Object.values(alarms).filter((t) => typeof t === "number" && t > 0);
    if (times.length) await this.state.storage.setAlarm(Math.min(...times));
  }
}
