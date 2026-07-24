// Netcode rules: the server must be able to rebuild the exact level and
// re-solve the exact shot the client saw. This suite tests the shared
// modules (multiplayer/server/solver.js + shared.js) in isolation, then
// proves scoring parity by extracting the REAL solvePath + levelgen out
// of index.html (with the substitutions CLIENT_CHANGES.md prescribes:
// Math.random->rnd, Math.hypot->hyp2, Math.sin/cos->dSin/dCos), running
// it on real three.js r128, and comparing bit-for-bit with the port.
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var cp = require("child_process");
var os = require("os");

var SOLVER = require("../multiplayer/server/solver.js");
var SHARED = require("../multiplayer/server/shared.js");

var checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; console.log("  ok  " + msg); }

// ======================================================================
// 1 — seeded PRNG: deterministic, seed-sensitive, in [0,1)
// ======================================================================
(function () {
  var a = SOLVER.mulberry32(12345), b = SOLVER.mulberry32(12345), c = SOLVER.mulberry32(12346);
  var same = true, diff = false;
  for (var i = 0; i < 1000; i++) {
    var x = a(), y = b(), z = c();
    if (x !== y) same = false;
    if (x !== z) diff = true;
    assert.ok(x >= 0 && x < 1, "rng out of [0,1)");
  }
  assert.ok(same && diff);
  // negative / float seeds coerce via >>>0 like the client will
  assert.strictEqual(SOLVER.mulberry32(-1)(), SOLVER.mulberry32(0xFFFFFFFF)());
  ok(true, "mulberry32 is deterministic per seed, seed-sensitive, [0,1)");
})();

// ======================================================================
// 2 — deterministic transcendentals: dSin/dCos/hyp2
// ======================================================================
(function () {
  var worst = 0;
  for (var i = 0; i < 4000; i++) {
    var x = (i - 2000) * 0.01;
    worst = Math.max(worst, Math.abs(SOLVER.dSin(x) - Math.sin(x)),
                            Math.abs(SOLVER.dCos(x) - Math.cos(x)));
    assert.strictEqual(SOLVER.dSin(x), SOLVER.dSin(x));
  }
  assert.ok(worst < 1e-9, "dSin/dCos drift " + worst);
  assert.strictEqual(SOLVER.hyp2(3, 4), 5);
  assert.strictEqual(SOLVER.hyp2(0.1, 0.2), Math.sqrt(0.1 * 0.1 + 0.2 * 0.2));
  ok(true, "dSin/dCos within 1e-9 of Math.sin/cos, built from exact ops only");
})();

// ======================================================================
// 3 — room codes: format, alphabet, determinism, validation
// ======================================================================
(function () {
  var rng = SOLVER.mulberry32(7);
  var c1 = SHARED.makeRoomCode(rng);
  assert.strictEqual(SHARED.makeRoomCode(SOLVER.mulberry32(7)), c1, "codes not deterministic under injected rand");
  for (var i = 0; i < 1000; i++) {
    var c = SHARED.makeRoomCode();
    assert.ok(SHARED.isRoomCode(c), "generated code invalid: " + c);
  }
  ["ABCI", "AB0D", "ABO1", "abcd", "ABC", "ABCDE", "", null, 1234].forEach(function (bad) {
    assert.ok(!SHARED.isRoomCode(bad), "accepted bad code " + bad);
  });
  assert.ok(SHARED.ROOM_CODE_ALPHABET.indexOf("O") < 0 && SHARED.ROOM_CODE_ALPHABET.indexOf("0") < 0 &&
            SHARED.ROOM_CODE_ALPHABET.indexOf("I") < 0 && SHARED.ROOM_CODE_ALPHABET.indexOf("1") < 0);
  ok(true, "room codes: 4 chars, no 0/O/1/I, deterministic under injected rand");
})();

// ======================================================================
// 4 — leaderboard: sanitize + merge-by-name + top-30
// ======================================================================
(function () {
  var now = 1700000000000;
  var e = SHARED.sanitizeScoreEntry({ n: "  ACE<script> ", s: 1234.7, l: 5, k: 9, b: 3, w: "needle" }, now);
  assert.deepStrictEqual(e, { n: "ACEscript", s: 1234, l: 5, k: 9, b: 3, w: "needle", t: now });
  assert.strictEqual(SHARED.sanitizeScoreEntry({ n: "", s: 1, l: 0, k: 0, b: 0 }, now), null);
  assert.strictEqual(SHARED.sanitizeScoreEntry({ n: "X", s: -5, l: 0, k: 0, b: 0 }, now), null);
  assert.strictEqual(SHARED.sanitizeScoreEntry({ n: "X", s: NaN, l: 0, k: 0, b: 0 }, now), null);
  assert.strictEqual(SHARED.sanitizeScoreEntry({ n: "X", s: 1e12, l: 0, k: 0, b: 0 }, now).s,
                     SHARED.SCORE_CAP, "score not capped");
  assert.strictEqual(SHARED.sanitizeScoreEntry({ n: "X", s: 1, l: 0, k: 0, b: 0, w: "aimbot" }, now).w, "ranger");
  ok(true, "sanitizeScoreEntry strips names, caps fields, whitelists weapons");

  // merge-by-name: a name's best wins per field, w/t track the latest
  var board = [];
  board = SHARED.mergeBoard(board, { n: "ACE", s: 100, l: 2, k: 3, b: 1, w: "ranger", t: 1 });
  board = SHARED.mergeBoard(board, { n: "BEE", s: 300, l: 1, k: 1, b: 0, w: "twin", t: 2 });
  board = SHARED.mergeBoard(board, { n: "ACE", s: 50, l: 9, k: 1, b: 4, w: "needle", t: 3 });
  assert.strictEqual(board.length, 2);
  assert.strictEqual(board[0].n, "BEE", "not sorted by score desc");
  var ace = board[1];
  assert.deepStrictEqual(ace, { n: "ACE", s: 100, l: 9, k: 3, b: 4, w: "needle", t: 3 },
    "merge should keep best s/l/k/b and latest w/t");
  ok(true, "mergeBoard merges by name keeping each field's best, sorts by score");

  var big = [];
  for (var i = 0; i < 40; i++) big = SHARED.mergeBoard(big, { n: "P" + i, s: i * 10, l: 0, k: 0, b: 0, w: "ranger", t: i });
  assert.strictEqual(big.length, 30, "board not truncated to 30");
  assert.strictEqual(big[0].s, 390);
  assert.strictEqual(big[29].s, 100, "wrong tail after truncation");
  var frozen = big.slice();
  SHARED.mergeBoard(big, { n: "Q", s: 999, l: 0, k: 0, b: 0, w: "ranger", t: 0 });
  assert.deepStrictEqual(big, frozen, "mergeBoard must not mutate its input");
  ok(true, "board caps at top 30 and mergeBoard is pure");
})();

// ======================================================================
// 5 — protocol message validation
// ======================================================================
(function () {
  var V = SHARED.validateClientMessage;
  assert.strictEqual(V("{").ok, false);
  assert.strictEqual(V("{}").ok, false);
  assert.strictEqual(V(JSON.stringify({ type: "level_start" })).ok, false, "server-only type accepted");
  assert.strictEqual(V(JSON.stringify({ type: "shot" }), 64).ok, false);
  assert.strictEqual(V(new Array(5000).join("a")).code, "too_long");

  var j = V(JSON.stringify({ type: "join", name: " Gun<>ner " }));
  assert.ok(j.ok && j.msg.name === "Gunner", "join name not sanitized");
  assert.strictEqual(V(JSON.stringify({ type: "join", name: "éé" })).ok, false, "empty-after-sanitize name accepted");
  assert.strictEqual(V(JSON.stringify({ type: "join", name: "A", token: "short" })).ok, false);

  var s = V(JSON.stringify({ type: "shot", range: 2, pos: [0, 1.62, 16.8], aim: [0, 0, -1], ph: [1.5, 2.5] }));
  assert.ok(s.ok, "valid shot rejected");
  assert.strictEqual(V(JSON.stringify({ type: "shot", range: 2, pos: [0, 1.62], aim: [0, 0, -1] })).code, "bad_pos");
  assert.strictEqual(V(JSON.stringify({ type: "shot", range: 2, pos: [0, "x", 1], aim: [0, 0, -1] })).code, "bad_pos");
  assert.strictEqual(V(JSON.stringify({ type: "shot", range: 0, pos: [0, 1.62, 1], aim: [0, 0, -1] })).code, "bad_range");
  assert.strictEqual(V(JSON.stringify({ type: "shot", range: 1, pos: [0, 1.62, 1], aim: [0, 0, -1], ph: [null] })).code, "bad_phases");
  ["ready", "rematch", "ping"].forEach(function (t) {
    assert.ok(V(JSON.stringify({ type: t })).ok, t + " rejected");
  });
  ok(true, "client messages validate: types, join names/tokens, shot shapes");
})();

// ======================================================================
// 6 — duel loadout schedule: every range is clearable, stats echo-check
// ======================================================================
(function () {
  for (var L = 1; L <= 5; L++) {
    var st = SOLVER.duelStats(L);
    assert.ok(st.pierce >= SOLVER.targetsWanted(L), "level " + L + " not clearable");
    assert.strictEqual(st.radius, 0.17);
    assert.strictEqual(st.frag, false);
    assert.ok(SOLVER.statsMatch(st, SOLVER.duelStats(L)));
    assert.ok(SOLVER.statsMatch(st, JSON.parse(JSON.stringify(st))), "stats echo fails after JSON round-trip");
  }
  assert.ok(!SOLVER.statsMatch(SOLVER.duelStats(1), SOLVER.duelStats(3)));
  var forged = SOLVER.duelStats(2); forged.bounces = 99;
  assert.ok(!SOLVER.statsMatch(forged, SOLVER.duelStats(2)), "forged bounces accepted");
  ok(true, "duelStats: clearable at every level, statsMatch catches forgeries");
})();

// ======================================================================
// 7 — seeded levelgen: deterministic, seed-sensitive, sane
// ======================================================================
var LEVEL_CASES = [
  { seed: 1,          mapId: "range", level: 1 },
  { seed: 7,          mapId: "yard",  level: 2 },
  { seed: 42,         mapId: "well",  level: 3 },
  { seed: 0xDEADBEEF, mapId: "vault", level: 4 },
  { seed: 1337,       mapId: "hall",  level: 5 }
];
(function () {
  LEVEL_CASES.forEach(function (tc) {
    var st = SOLVER.duelStats(tc.level);
    var a = SOLVER.generateLevel(tc.seed, tc.mapId, tc.level, st);
    var b = SOLVER.generateLevel(tc.seed, tc.mapId, tc.level, st);
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b),
      "levelgen not deterministic for " + JSON.stringify(tc));
    var c = SOLVER.generateLevel(tc.seed + 1, tc.mapId, tc.level, st);
    assert.notStrictEqual(JSON.stringify(a.blocks), JSON.stringify(c.blocks),
      "seed+1 produced identical blocks");
    assert.strictEqual(a.enemies.length, SOLVER.targetsFor(tc.level, st),
      "wrong target count for level " + tc.level);
    a.blocks.forEach(function (blk) {
      assert.ok(blk.min.x >= -a.room.w / 2 && blk.max.x <= a.room.w / 2 &&
                blk.min.z >= -a.room.d / 2 && blk.max.z <= a.room.d / 2,
                "block outside room");
      assert.ok(["solid", "pad", "sink"].indexOf(blk.kind) >= 0);
    });
    a.enemies.forEach(function (e) {
      assert.ok(Math.abs(e.base.x) < a.room.w / 2 && Math.abs(e.base.y) < a.room.d / 2, "enemy outside room");
    });
  });
  ok(true, "generateLevel: bit-identical per seed, differs across seeds, in-bounds");
})();

// ======================================================================
// 8 — solver determinism + JSON wire safety
// ======================================================================
(function () {
  LEVEL_CASES.forEach(function (tc) {
    var st = SOLVER.duelStats(tc.level);
    var lvl = SOLVER.generateLevel(tc.seed, tc.mapId, tc.level, st);
    var pos = [lvl.playerStart.x, lvl.playerStart.y, lvl.playerStart.z];
    var rng = SOLVER.mulberry32(tc.seed ^ 0x9E3779B9);
    for (var s = 0; s < 8; s++) {
      var yaw = rng() * Math.PI * 2, pitch = rng() * 0.5 - 0.2;
      var aim = [-SOLVER.dSin(yaw) * SOLVER.dCos(pitch), SOLVER.dSin(pitch), -SOLVER.dCos(yaw) * SOLVER.dCos(pitch)];
      var ph = lvl.enemies.map(function (e, i) { return e.t0 + i * 1.7; });
      var r1 = SOLVER.solve(tc.seed, tc.mapId, tc.level, pos, aim, ph, st);
      var r2 = SOLVER.solve(tc.seed, tc.mapId, tc.level, pos, aim, ph, st);
      assert.strictEqual(JSON.stringify(r1), JSON.stringify(r2), "solve not deterministic");
      // wire safety: JSON round-trip of the inputs changes nothing
      var w = JSON.parse(JSON.stringify({ pos: pos, aim: aim, ph: ph, stats: st }));
      var r3 = SOLVER.solve(tc.seed, tc.mapId, tc.level, w.pos, w.aim, w.ph, w.stats);
      assert.strictEqual(JSON.stringify(r1), JSON.stringify(r3), "JSON round-trip changed the verdict");
      assert.ok(r1.ok, "solve rejected a legal shot: " + r1.code);
    }
  });
  ok(true, "solve(seed,map,level,pos,aim,ph,stats) is bit-stable and JSON-safe");
})();

// ======================================================================
// 9 — scoring arithmetic (hand-computed against index.html:1581-1587,1654)
// ======================================================================
(function () {
  var base = SOLVER.duelStats(1);
  function res(events, spareB, spareP) { return { events: events, spareBounce: spareB, sparePierce: spareP }; }

  // head kill after 2 banks: mult=1+2*0.5=2, base=260 -> 520; no clear (2 targets)
  var r = SOLVER.scoreShot(res([{ type: "kill", head: true, nb: 2, armored: false }], 0, 0), 1, base, 2);
  assert.strictEqual(r.score, 520);
  assert.strictEqual(r.cleared, false);

  // armored body, no banks: 100*1.7 = 170
  r = SOLVER.scoreShot(res([{ type: "kill", head: false, nb: 0, armored: true }], 0, 0), 1, base, 2);
  assert.strictEqual(r.score, 170);

  // requireBank (Hairpin rule): direct-line kill pays 0
  var hairpin = Object.assign({}, base, { requireBank: true, bankStep: 0.85 });
  r = SOLVER.scoreShot(res([{ type: "kill", head: false, nb: 0, armored: false }], 0, 0), 1, hairpin, 2);
  assert.strictEqual(r.score, 0);

  // bank cap: nb=9 caps at 6 -> mult 4; body 100 -> 400
  r = SOLVER.scoreShot(res([{ type: "kill", head: false, nb: 9, armored: false }], 0, 0), 1, base, 2);
  assert.strictEqual(r.score, 400);
  assert.strictEqual(r.bestBank, 9, "bestBank should report the raw bank count");

  // clear bonus: level 3, 2 spare bounces, 1 spare pierce:
  // 240+3*60+2*45+1*40 = 550, plus the body kill 100
  r = SOLVER.scoreShot(res([{ type: "kill", head: false, nb: 0, armored: false }], 2, 1), 3, base, 1);
  assert.strictEqual(r.cleared, true);
  assert.strictEqual(r.clearBonus, 550);
  assert.strictEqual(r.score, 650);
  ok(true, "kill/bank/armor/requireBank/clear-bonus arithmetic matches the game");
})();

// ======================================================================
// 10 — shot sanity validation (the non-solver half of anticheat)
// ======================================================================
(function () {
  var st = SOLVER.duelStats(3);
  var lvl = SOLVER.generateLevel(42, "well", 3, st);
  var okPos = [0, 1.62, lvl.room.d / 2 - 5.2];
  var aim = [0, 0, -1];
  var ph = lvl.enemies.map(function (e) { return e.t0; });
  assert.ok(SOLVER.validateShot(lvl, { pos: okPos, aim: aim, ph: ph }).ok);
  assert.strictEqual(SOLVER.validateShot(lvl, { pos: [0, 1.7, 0], aim: aim }).code, "pos_y");
  assert.strictEqual(SOLVER.validateShot(lvl, { pos: [lvl.room.w, 1.62, 0], aim: aim }).code, "pos_oob");
  assert.strictEqual(SOLVER.validateShot(lvl, { pos: okPos, aim: [0, 0, -2] }).code, "aim_not_unit");
  assert.strictEqual(SOLVER.validateShot(lvl, { pos: okPos, aim: aim, ph: [1] }).code, "bad_phases");
  assert.strictEqual(SOLVER.validateShot(lvl, { pos: okPos, aim: aim, ph: ph.map(function () { return NaN; }) }).code, "bad_phases");
  var tall = null;
  for (var i = 0; i < lvl.blocks.length; i++) if (lvl.blocks[i].max.y >= 0.55) { tall = lvl.blocks[i]; break; }
  if (tall) {
    var inside = [(tall.min.x + tall.max.x) / 2, 1.62, (tall.min.z + tall.max.z) / 2];
    assert.strictEqual(SOLVER.validateShot(lvl, { pos: inside, aim: aim }).code, "pos_in_block");
  }
  ok(true, "validateShot rejects impossible positions, bad aim, bad phases");
})();

// ======================================================================
// 11 — server file smoke: worker/duel are valid ES modules with the
//      hibernation API surface in place
// ======================================================================
(function () {
  var dir = path.join(__dirname, "..", "multiplayer", "server");
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "or-esm-"));
  ["worker.js", "duel.js"].forEach(function (f) {
    var src = fs.readFileSync(path.join(dir, f), "utf8");
    // syntax-check as ESM by running node --check on an .mjs copy
    // (imports are rewritten to a stub so --check sees self-contained code)
    var mjs = path.join(tmp, f.replace(".js", ".mjs"));
    fs.writeFileSync(mjs, src.replace(/from "\.\/(solver|shared|duel)\.js"/g, 'from "./stub.mjs"'));
    fs.writeFileSync(path.join(tmp, "stub.mjs"), "export default {}; export const DuelRoom = 0;\n");
    var r = cp.spawnSync(process.execPath, ["--check", mjs], { encoding: "utf8" });
    assert.strictEqual(r.status, 0, f + " has a syntax error:\n" + r.stderr);
  });
  var duelSrc = fs.readFileSync(path.join(dir, "duel.js"), "utf8");
  ["acceptWebSocket", "serializeAttachment", "deserializeAttachment",
   "webSocketMessage", "webSocketClose", "webSocketError", "getWebSockets",
   "setAlarm", "async alarm()"].forEach(function (api) {
    assert.ok(duelSrc.indexOf(api) >= 0, "duel.js missing " + api);
  });
  var toml = fs.readFileSync(path.join(dir, "wrangler.toml"), "utf8");
  ["LEADERBOARD", "DUEL_ROOM", "DuelRoom", "compatibility_date", "migrations"].forEach(function (k) {
    assert.ok(toml.indexOf(k) >= 0, "wrangler.toml missing " + k);
  });
  ok(true, "worker.js/duel.js parse as ESM; hibernation API + bindings wired");
})();

// ======================================================================
// 12 — THE PARITY TEST. Extract the real solver + levelgen from
//      index.html, apply exactly the CLIENT_CHANGES.md substitutions,
//      run on real three.js r128, and require bit-identical levels,
//      event streams and scores against the server port.
// ======================================================================
(function () {
  var THREE;
  try { THREE = require("three"); }
  catch (e) { console.log("  --  three.js not installed; run `npm install` in tests/ for the parity test"); return; }
  assert.strictEqual(THREE.REVISION, "128", "parity test needs three r128 (game version)");

  var src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  function slice(startMarker, endMarker) {
    var s = src.indexOf(startMarker);
    assert.ok(s >= 0, "marker not found: " + startMarker);
    var e = src.indexOf(endMarker, s);
    assert.ok(e >= 0, "end marker not found: " + endMarker);
    return src.slice(s, e + endMarker.length);
  }
  function subst(code, from, to, expected, what) {
    var n = code.split(from).length - 1;
    assert.strictEqual(n, expected,
      what + ": expected " + expected + " occurrence(s) of " + from + ", found " + n +
      " — index.html drifted, update CLIENT_CHANGES.md and this test");
    return code.split(from).join(to);
  }

  // ---- slice 1: target/block/pad/sink counts (index.html:664-671)
  var counts = slice("function targetsWanted(L){",
                     "function sinksFor(L){ return Math.min(3, L>=5 ? 1 + Math.floor((L-5)/4) : 0); }");

  // ---- slice 2: geometry kernel + solvePath (index.html:1301-1500)
  var solver = slice("function rayAABB(ro, rd, min, max, r){",
                     "spareBounce:Math.max(0,bounces), sparePierce:Math.max(0,pierce) };\n}");
  solver = subst(solver, "Math.hypot(", "hyp2(", 1, "solver frag radius");   // CLIENT_CHANGES §3

  // ---- slice 3: spotClear + goldenPoints + pathDistance + buildLevel
  //      (index.html:1055-1174)
  var gen = slice("function spotClear(x,z,minPlayer,pad){",
                  "buildDressing();\n  sun.shadow.needsUpdate = true;\n  refreshHUD();\n  showBanner();\n}");
  // 15 sites since the off-path fallback-target loop was removed (bug fix:
  // fallback targets broke the every-range-is-clearable guarantee)
  gen = subst(gen, "Math.random()", "rnd()", 15, "levelgen rng sites");      // CLIENT_CHANGES §2
  gen = subst(gen, "Math.hypot(", "hyp2(", 3, "levelgen hypot sites");       // CLIENT_CHANGES §3
  gen = subst(gen, "Math.sin(", "dSin(", 2, "golden dir sin");               // CLIENT_CHANGES §4
  gen = subst(gen, "Math.cos(", "dCos(", 3, "golden dir cos");               // CLIENT_CHANGES §4

  // ---- sandbox: the game globals the slices reach for, with addEnemy /
  //      addBlock stubs that consume rng in the client's exact order
  //      (addEnemy per CLIENT_CHANGES §2e).
  var harness = [
    "var EPS=1e-4, MAX_SEGMENTS=90, MAX_PATH=1100;",
    "var BODY_R=0.46, BODY_LO=0.07, BODY_HI=1.37, HEAD_Y=1.63, HEAD_R=0.29, FRAG_R=3.1;",
    "var EYE=1.62;",
    "function clamp(v,a,b){ return v<a?a:(v>b?b:v); }",
    "var ROOM={w:44,d:44,h:9.5};",
    "var S={level:1,stats:null};",
    "var curMap=null, pendingMap=null;",
    "var blocks=[], enemies=[];",
    "var player={pos:new THREE.Vector3(0,EYE,ROOM.d/2-5.2), vel:new THREE.Vector3(), yaw:0, pitch:0};",
    "function clearLevel(){ blocks.length=0; enemies.length=0; }",
    "function applyMap(m){ curMap=m; ROOM.w=m.w; ROOM.d=m.d; ROOM.h=m.h; }",
    "function pickMap(){ throw new Error('pickMap must never run during seeded duel levelgen'); }",
    "function buildDressing(){} function refreshHUD(){} function showBanner(){}",
    "var sun={shadow:{}};",
    "function addBlock(cx,cz,w,h,d,kind,style){",
    "  blocks.push({ min:new THREE.Vector3(cx-w/2,0,cz-d/2),",
    "                max:new THREE.Vector3(cx+w/2,h,cz+d/2), kind:kind });",
    "}",
    "function addEnemy(x,z,armored,span,axis,variant){",
    "  variant = armored ? 'armour' : (variant || 'drum');",
    "  enemies.push({ base:new THREE.Vector2(x,z), axis:axis||(rnd()<0.5?0:1),",
    "                 span:span||0, t:rnd()*6.283,",
    "                 speed:(0.4+rnd()*0.45)*(variant==='veteran'?1.7:1),",
    "                 alive:true, armored:!!armored, variant:variant,",
    "                 pos:new THREE.Vector3(x,0,z) });",
    "}",
    counts, solver, gen,
    "return { S:S, ROOMref:function(){return ROOM;}, blocks:blocks, enemies:enemies,",
    "         player:player, setPendingMap:function(m){ pendingMap=m; },",
    "         buildLevel:buildLevel, solvePath:solvePath };"
  ].join("\n");

  function makeClient(seed) {
    var rnd = SOLVER.mulberry32(seed);
    return new Function("THREE", "rnd", "dSin", "dCos", "hyp2", harness)(
      THREE, rnd, SOLVER.dSin, SOLVER.dCos, SOLVER.hyp2);
  }

  var MAP_DEFS = {};
  SOLVER.MAPS.forEach(function (m) { MAP_DEFS[m.id] = m; });

  var totalKillParity = 0, totalEvents = 0, totalShots = 0;
  LEVEL_CASES.forEach(function (tc) {
    var stats = SOLVER.duelStats(tc.level);

    // client-side (extracted) build
    var cl = makeClient(tc.seed);
    cl.S.level = tc.level;
    cl.S.stats = stats;
    cl.setPendingMap(MAP_DEFS[tc.mapId]);
    cl.buildLevel();

    // server-side (ported) build
    var sv = SOLVER.generateLevel(tc.seed, tc.mapId, tc.level, stats);

    assert.strictEqual(cl.blocks.length, sv.blocks.length, "block count differs " + JSON.stringify(tc));
    cl.blocks.forEach(function (b, i) {
      var p = sv.blocks[i];
      ["x", "y", "z"].forEach(function (ax) {
        assert.strictEqual(b.min[ax], p.min[ax], "block " + i + " min." + ax + " differs");
        assert.strictEqual(b.max[ax], p.max[ax], "block " + i + " max." + ax + " differs");
      });
      assert.strictEqual(b.kind, p.kind, "block " + i + " kind differs");
    });
    assert.strictEqual(cl.enemies.length, sv.enemies.length, "enemy count differs " + JSON.stringify(tc));
    cl.enemies.forEach(function (e, i) {
      var p = sv.enemies[i];
      assert.strictEqual(e.base.x, p.base.x, "enemy " + i + " base.x");
      assert.strictEqual(e.base.y, p.base.y, "enemy " + i + " base.z");
      assert.strictEqual(e.axis, p.axis, "enemy " + i + " axis");
      assert.strictEqual(e.span, p.span, "enemy " + i + " span");
      assert.strictEqual(e.t, p.t0, "enemy " + i + " phase");
      assert.strictEqual(e.speed, p.speed, "enemy " + i + " speed");
      assert.strictEqual(e.armored, p.armored, "enemy " + i + " armored");
      assert.strictEqual(e.variant, p.variant, "enemy " + i + " variant");
    });

    // shots: freeze patrol phases, fire a spread of aims, compare verdicts
    var aimRng = SOLVER.mulberry32((tc.seed * 2654435761) >>> 0);
    var ph = cl.enemies.map(function (e, i) { return e.t + i * 2.13 + 0.7; });
    // client positions enemies exactly like the animate loop (index.html:3687-3698,
    // dSin per CLIENT_CHANGES §4b)
    cl.enemies.forEach(function (e, i) {
      var x = e.base.x, z = e.base.y;
      if (e.span > 0) {
        var off = SOLVER.dSin(ph[i]) * e.span;
        if (e.axis) x = e.base.x + off; else z = e.base.y + off;
      }
      e.pos.set(x, 0, z);
    });
    SOLVER.positionEnemies(sv, ph);
    cl.enemies.forEach(function (e, i) {
      assert.strictEqual(e.pos.x, sv.enemies[i].pos.x, "enemy " + i + " fire-time x");
      assert.strictEqual(e.pos.z, sv.enemies[i].pos.z, "enemy " + i + " fire-time z");
    });

    var svCtx = { room: sv.room, blocks: sv.blocks, enemies: sv.enemies };
    var pos = [cl.player.pos.x, cl.player.pos.y, cl.player.pos.z];
    function compareShot(dir, tag) {
      totalShots++;
      // client fire(): muzzle = pos + dir*0.55, then solvePath (index.html:1296,1516)
      var mzC = new THREE.Vector3(pos[0], pos[1], pos[2])
                  .addScaledVector(new THREE.Vector3(dir[0], dir[1], dir[2]), 0.55);
      var rc = cl.solvePath(mzC, new THREE.Vector3(dir[0], dir[1], dir[2]), false);

      var mzS = new SOLVER.Vec3(pos[0] + dir[0] * 0.55, pos[1] + dir[1] * 0.55, pos[2] + dir[2] * 0.55);
      var rs = SOLVER.solvePath(svCtx, mzS, new SOLVER.Vec3(dir[0], dir[1], dir[2]), false, stats);

      assert.strictEqual(rc.ending, rs.ending, "ending differs (" + tag + " " + JSON.stringify(tc) + ")");
      assert.strictEqual(rc.length, rs.length, "path length differs (" + tag + ")");
      assert.strictEqual(rc.bounces, rs.bounces, "bounce count differs");
      assert.strictEqual(rc.kills, rs.kills, "kill count differs");
      assert.strictEqual(rc.spareBounce, rs.spareBounce, "spareBounce differs");
      assert.strictEqual(rc.sparePierce, rs.sparePierce, "sparePierce differs");
      assert.strictEqual(rc.events.length, rs.events.length, "event count differs");
      rc.events.forEach(function (ec, i) {
        var es = rs.events[i];
        assert.strictEqual(ec.type, es.type, "event " + i + " type");
        assert.strictEqual(ec.at, es.at, "event " + i + " at (distance)");
        ["x", "y", "z"].forEach(function (ax) {
          assert.strictEqual(ec.p[ax], es.p[ax], "event " + i + " p." + ax);
          if (ec.n) assert.strictEqual(ec.n[ax], es.n[ax], "event " + i + " n." + ax);
        });
        if (ec.type === "kill") {
          assert.strictEqual(ec.i, es.i, "event " + i + " target index");
          assert.strictEqual(ec.head, es.head, "event " + i + " head flag");
          assert.strictEqual(ec.nb, es.nb, "event " + i + " bank count");
          assert.strictEqual(ec.armored, es.armored, "event " + i + " armored");
          assert.strictEqual(ec.frag, es.frag, "event " + i + " frag");
          totalKillParity++;
        }
        totalEvents++;
      });
      var scC = SOLVER.scoreShot(rc, tc.level, stats, cl.enemies.length);
      var scS = SOLVER.scoreShot(rs, tc.level, stats, sv.enemies.length);
      assert.strictEqual(scC.score, scS.score, "score differs (" + tag + ")");
      assert.strictEqual(scC.cleared, scS.cleared, "cleared differs");
    }
    for (var s = 0; s < 24; s++) {
      var yaw = aimRng() * Math.PI * 2, pitch = aimRng() * 0.6 - 0.25;
      compareShot([-SOLVER.dSin(yaw) * SOLVER.dCos(pitch), SOLVER.dSin(pitch),
                   -SOLVER.dCos(yaw) * SOLVER.dCos(pitch)], "random " + s);
    }
    // aimed shots: straight at each target's head and body (plus a slight
    // jitter) so kill events actually occur and stay in parity
    cl.enemies.forEach(function (e, ei) {
      [[e.pos.x, 1.63, e.pos.z], [e.pos.x, 0.8, e.pos.z],
       [e.pos.x + 0.18, 1.6, e.pos.z], [e.pos.x - 0.3, 0.5, e.pos.z]].forEach(function (tgt, ti) {
        var dx = tgt[0] - pos[0], dy = tgt[1] - pos[1], dz = tgt[2] - pos[2];
        var inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        compareShot([dx * inv, dy * inv, dz * inv], "aimed e" + ei + "t" + ti);
      });
    });
  });
  assert.ok(totalEvents > 100, "parity run too small to be meaningful (" + totalEvents + " events)");
  ok(true, "PARITY: extracted index.html solver+levelgen === server port, bit-for-bit " +
           "(" + LEVEL_CASES.length + " levels, " + totalShots + " shots, " + totalEvents + " events, " +
           totalKillParity + " kills)");

  // upgraded-stat physics branches (guide/frag/bloom) stay in parity too
  (function () {
    var stats = Object.assign({}, SOLVER.duelStats(5), { guide: 2, frag: true, bloom: true, pierce: 6, bounces: 7 });
    var cl = makeClient(909); cl.S.level = 5; cl.S.stats = stats;
    cl.setPendingMap(MAP_DEFS.range); cl.buildLevel();
    var sv = SOLVER.generateLevel(909, "range", 5, stats);
    var ph = cl.enemies.map(function (e) { return e.t; });
    SOLVER.positionEnemies(sv, ph);
    cl.enemies.forEach(function (e, i) {           // same fire-time placement client-side
      var x = e.base.x, z = e.base.y;
      if (e.span > 0) {
        var off = SOLVER.dSin(ph[i]) * e.span;
        if (e.axis) x = e.base.x + off; else z = e.base.y + off;
      }
      e.pos.set(x, 0, z);
    });
    var svCtx = { room: sv.room, blocks: sv.blocks, enemies: sv.enemies };
    var aimRng = SOLVER.mulberry32(909 ^ 0x51ED270B);
    var fragSeen = 0;
    for (var s = 0; s < 60; s++) {
      var yaw = aimRng() * Math.PI * 2, pitch = aimRng() * 0.6 - 0.25;
      var dir = [-SOLVER.dSin(yaw) * SOLVER.dCos(pitch), SOLVER.dSin(pitch), -SOLVER.dCos(yaw) * SOLVER.dCos(pitch)];
      var p0 = [cl.player.pos.x, cl.player.pos.y, cl.player.pos.z];
      var rc = cl.solvePath(new THREE.Vector3(p0[0] + dir[0] * 0.55, p0[1] + dir[1] * 0.55, p0[2] + dir[2] * 0.55),
                            new THREE.Vector3(dir[0], dir[1], dir[2]), false);
      var rs = SOLVER.solvePath(svCtx, new SOLVER.Vec3(p0[0] + dir[0] * 0.55, p0[1] + dir[1] * 0.55, p0[2] + dir[2] * 0.55),
                                new SOLVER.Vec3(dir[0], dir[1], dir[2]), false, stats);
      assert.strictEqual(JSON.stringify(SOLVER.serializeEvents(rc.events.map(fixup))),
                         JSON.stringify(SOLVER.serializeEvents(rs.events)),
                         "guide/frag/bloom event stream differs (shot " + s + ")");
      rc.events.forEach(function (e) { if (e.frag) fragSeen++; });
    }
    function fixup(e) { return e; } // THREE vectors expose .x/.y/.z like Vec3 — serializer is shared
    ok(true, "PARITY holds with guide/frag/bloom upgrades active (" + fragSeen + " frag kills seen)");
  })();

  // synthetic close-quarters range: guarantees the kill, pierce-cost,
  // armored and frag branches all fire and stay in parity
  (function () {
    var stats = Object.assign({}, SOLVER.duelStats(1), { frag: true, pierce: 3, bounces: 2 });
    var cl = makeClient(1);           // no buildLevel: hand-built range, default ROOM
    cl.S.stats = stats;
    function put(x, z, armored) {
      cl.enemies.push({ base: new THREE.Vector2(x, z), axis: 0, span: 0, t: 0, speed: 0.5,
                        alive: true, armored: !!armored, variant: "drum",
                        pos: new THREE.Vector3(x, 0, z) });
    }
    put(0, 8, false);        // straight-line body kill
    put(1.6, 8.9, false);    // within FRAG_R of the first -> shrapnel kill
    put(0.4, 4, true);       // armored further down the same line, costs 2 pierce
    var svCtx = {
      room: { w: 44, d: 44, h: 9.5 }, blocks: [],
      enemies: cl.enemies.map(function (e) {
        return { alive: true, armored: e.armored, pos: new SOLVER.Vec3(e.pos.x, 0, e.pos.z) };
      })
    };
    var pos = [0, 1.62, 16.8];
    var fragKills = 0, armoredKills = 0, endings = {};
    [[0, 0.8, 8], [0, 1.63, 8], [0.15, 0.9, 8], [0.4, 0.7, 4]].forEach(function (tgt, ti) {
      var dx = tgt[0] - pos[0], dy = tgt[1] - pos[1], dz = tgt[2] - pos[2];
      var inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      var dir = [dx * inv, dy * inv, dz * inv];
      var rc = cl.solvePath(new THREE.Vector3(pos[0] + dir[0] * 0.55, pos[1] + dir[1] * 0.55, pos[2] + dir[2] * 0.55),
                            new THREE.Vector3(dir[0], dir[1], dir[2]), false);
      var rs = SOLVER.solvePath(svCtx, new SOLVER.Vec3(pos[0] + dir[0] * 0.55, pos[1] + dir[1] * 0.55, pos[2] + dir[2] * 0.55),
                                new SOLVER.Vec3(dir[0], dir[1], dir[2]), false, stats);
      assert.strictEqual(JSON.stringify(SOLVER.serializeEvents(rc.events)),
                         JSON.stringify(SOLVER.serializeEvents(rs.events)),
                         "synthetic shot " + ti + " event stream differs");
      var scC = SOLVER.scoreShot(rc, 1, stats, 3), scS = SOLVER.scoreShot(rs, 1, stats, 3);
      assert.strictEqual(scC.score, scS.score, "synthetic shot " + ti + " score differs");
      rc.events.forEach(function (e) {
        if (e.type === "kill" && e.frag) fragKills++;
        if (e.type === "kill" && e.armored) armoredKills++;
      });
      endings[rc.ending] = true;
    });
    assert.ok(fragKills > 0, "synthetic range never produced a frag kill");
    assert.ok(armoredKills > 0, "synthetic range never produced an armored kill");
    ok(true, "PARITY on synthetic range: kill/frag/armored/pierce branches " +
             "(" + fragKills + " frags, " + armoredKills + " armored, endings: " +
             Object.keys(endings).join(",") + ")");
  })();
})();

console.log("netcode.test.js — " + checks + " checks passed");
