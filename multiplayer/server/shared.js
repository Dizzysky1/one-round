/* ======================================================================
   ONE ROUND — shared pure helpers for the Worker + Durable Object:
   room codes, leaderboard merge, wire-message validation, CORS.
   No I/O, no Workers APIs — node-testable (tests/netcode.test.js).
   Dual-target module: CommonJS for node, esbuild interops it for the
   Worker's ESM imports.
   ==================================================================== */
"use strict";

// --------------------------------------------------------- room codes
// 4 chars, 32-symbol alphabet without 0/O/1/I (32^4 = ~1.05M rooms).
var ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;

function makeRoomCode(rand) {
  rand = rand || Math.random;
  var s = "";
  for (var i = 0; i < 4; i++) {
    var k = Math.floor(rand() * ROOM_CODE_ALPHABET.length);
    if (k >= ROOM_CODE_ALPHABET.length) k = ROOM_CODE_ALPHABET.length - 1;
    s += ROOM_CODE_ALPHABET.charAt(k);
  }
  return s;
}
function isRoomCode(s) { return typeof s === "string" && ROOM_CODE_RE.test(s); }

// --------------------------------------------------------- callsigns
function sanitizeName(n) {
  if (typeof n !== "string") return null;
  n = n.replace(/[^A-Za-z0-9 _.\-]/g, "").trim().slice(0, 16);
  return n.length ? n : null;
}

// --------------------------------------------------------- leaderboard
// Board schema (matches the client's local board, index.html:3077-3092):
//   { n:callsign, s:score, l:ranges, k:kills, b:bestBank, w:weaponId, t:timestamp }
var BOARD_MAX = 30;
var WEAPON_IDS = ["ranger", "bulldog", "needle", "twin", "kestrel", "warden", "hairpin"];
var SCORE_CAP = 5000000, RANGES_CAP = 500, KILLS_CAP = 5000, BANK_CAP_FIELD = 99;

function intIn(v, lo, hi) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  v = Math.floor(v);
  if (v < lo) return null;
  return v > hi ? hi : v;
}

// Validate + normalise a POST /score body. Returns the clean entry or null.
function sanitizeScoreEntry(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  var n = sanitizeName(raw.n);
  if (!n) return null;
  var s = intIn(raw.s, 0, SCORE_CAP);
  var l = intIn(raw.l, 0, RANGES_CAP);
  var k = intIn(raw.k, 0, KILLS_CAP);
  var b = intIn(raw.b, 0, BANK_CAP_FIELD);
  if (s === null || l === null || k === null || b === null) return null;
  var w = WEAPON_IDS.indexOf(raw.w) >= 0 ? raw.w : "ranger";
  return { n: n, s: s, l: l, k: k, b: b, w: w, t: now || Date.now() };
}

// Pure merge — same rules as the client's boardSubmit (index.html:3077-3092):
// merge-by-name keeps each field's best, w/t come from the latest entry,
// sort by score desc, truncate to top 30. Returns a NEW array.
function mergeBoard(list, entry, max) {
  max = max || BOARD_MAX;
  var out = Array.isArray(list) ? list.slice() : [];
  var mine = -1;
  for (var i = 0; i < out.length; i++) if (out[i].n === entry.n) mine = i;
  if (mine >= 0) {
    var e = out[mine] = {
      n: out[mine].n,
      s: Math.max(out[mine].s | 0, entry.s),
      l: Math.max(out[mine].l | 0, entry.l),
      k: Math.max(out[mine].k | 0, entry.k),
      b: Math.max(out[mine].b | 0, entry.b),
      w: entry.w, t: entry.t
    };
  } else out.push(entry);
  out.sort(function (a, b) { return (b.s | 0) - (a.s | 0); });
  if (out.length > max) out.length = max;
  return out;
}

// --------------------------------------------------- message validation
// Client → server duel messages. Schema table in PROTOCOL.md §Messages.
var CLIENT_TYPES = { join: 1, ready: 1, shot: 1, rematch: 1, ping: 1 };

function num3(a) {
  return Array.isArray(a) && a.length === 3 &&
         typeof a[0] === "number" && isFinite(a[0]) &&
         typeof a[1] === "number" && isFinite(a[1]) &&
         typeof a[2] === "number" && isFinite(a[2]);
}

// Structural validation only (game-state checks live in the DO + solver).
// Returns { ok:true, msg } with a normalised message, or { ok:false, code }.
function validateClientMessage(raw, maxLen) {
  maxLen = maxLen || 4096;
  if (typeof raw !== "string") return { ok: false, code: "not_text" };
  if (raw.length > maxLen) return { ok: false, code: "too_long" };
  var m;
  try { m = JSON.parse(raw); } catch (e) { return { ok: false, code: "bad_json" }; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, code: "bad_shape" };
  if (typeof m.type !== "string" || !CLIENT_TYPES[m.type]) return { ok: false, code: "bad_type" };

  switch (m.type) {
    case "join": {
      var name = sanitizeName(m.name);
      if (!name) return { ok: false, code: "bad_name" };
      var out = { type: "join", name: name };
      if (m.token !== undefined) {
        if (typeof m.token !== "string" || !/^[A-Za-z0-9_\-]{8,64}$/.test(m.token))
          return { ok: false, code: "bad_token" };
        out.token = m.token;
      }
      return { ok: true, msg: out };
    }
    case "ready":
      return { ok: true, msg: { type: "ready" } };
    case "shot": {
      if (!num3(m.pos)) return { ok: false, code: "bad_pos" };
      if (!num3(m.aim)) return { ok: false, code: "bad_aim" };
      if (typeof m.range !== "number" || (m.range | 0) !== m.range || m.range < 1 || m.range > 99)
        return { ok: false, code: "bad_range" };
      var ph;
      if (m.ph !== undefined) {
        if (!Array.isArray(m.ph) || m.ph.length > 16) return { ok: false, code: "bad_phases" };
        for (var i = 0; i < m.ph.length; i++) {
          if (typeof m.ph[i] !== "number" || !isFinite(m.ph[i])) return { ok: false, code: "bad_phases" };
        }
        ph = m.ph;
      }
      if (m.stats !== undefined && (typeof m.stats !== "object" || m.stats === null || Array.isArray(m.stats)))
        return { ok: false, code: "bad_stats" };
      return { ok: true, msg: { type: "shot", range: m.range, pos: m.pos, aim: m.aim, ph: ph, stats: m.stats } };
    }
    case "rematch":
      return { ok: true, msg: { type: "rematch" } };
    case "ping":
      return { ok: true, msg: { type: "ping" } };
  }
  return { ok: false, code: "bad_type" };
}

// ---------------------------------------------------------------- CORS
// Locked to the GitHub Pages origin plus localhost for development.
var PROD_ORIGIN = "https://dizzysky1.github.io";
var DEV_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

function isAllowedOrigin(origin) {
  if (typeof origin !== "string" || !origin) return false;
  return origin === PROD_ORIGIN || DEV_ORIGIN_RE.test(origin);
}

function corsHeaders(origin) {
  if (!isAllowedOrigin(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

var OneRoundShared = {
  ROOM_CODE_ALPHABET: ROOM_CODE_ALPHABET,
  makeRoomCode: makeRoomCode, isRoomCode: isRoomCode,
  sanitizeName: sanitizeName,
  BOARD_MAX: BOARD_MAX, WEAPON_IDS: WEAPON_IDS, SCORE_CAP: SCORE_CAP,
  sanitizeScoreEntry: sanitizeScoreEntry, mergeBoard: mergeBoard,
  validateClientMessage: validateClientMessage,
  PROD_ORIGIN: PROD_ORIGIN, isAllowedOrigin: isAllowedOrigin, corsHeaders: corsHeaders
};

if (typeof module !== "undefined" && module.exports) module.exports = OneRoundShared;
