# CLIENT_CHANGES — exact edits index.html needs for multiplayer parity

Everything the game file must change so a client, its opponent, and the
server (`multiplayer/server/solver.js`) build **bit-identical** levels from a
seed and agree on every solve. All code below is ES5 and touches nothing
cosmetic. Line numbers refer to the current index.html (git HEAD; the parity
test in `tests/netcode.test.js` asserts the exact occurrence counts at these
sites, so it will fail loudly if the file drifts before these edits land).

The invariants behind every edit:

- **Seeded stream discipline** — exactly the listed `Math.random()` sites
  (and no others) switch to `rnd()`, preserving call order. Any extra or
  missing draw desyncs every subsequent placement.
- **No engine-dependent math in gameplay** — `Math.sin/cos/hypot` are not
  bit-identical across JS engines; `Math.sqrt`, `+ - * /`, `floor/round/
  min/max/abs/imul` are. Gameplay code switches to `dSin/dCos/hyp2`.
- **Solo play unchanged** — `rnd` defaults to `Math.random`; the dSin/hyp2
  swaps change results by < 1e-9 (far below any gameplay threshold).

---

## 1. Add the deterministic primitives (new code)

Insert after the tuning block, right after line 643
(`var reduceMotion = ...`). This must stay byte-for-byte in sync with the
same functions in `multiplayer/server/solver.js`:

```js
// ------------------------------------------------- netcode determinism
// Mirrors multiplayer/server/solver.js — do not edit one without the other.
var _imul = Math.imul || function(a,b){
  var ah=(a>>>16)&0xffff, al=a&0xffff, bh=(b>>>16)&0xffff, bl=b&0xffff;
  return ((al*bl)+(((ah*bl+al*bh)<<16)>>>0))|0;
};
function mulberry32(a){
  a = a >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = _imul(t ^ (t >>> 15), t | 1);
    t = (t + _imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// levelgen RNG: solo = Math.random, duels swap in a seeded stream
var rnd = Math.random;
function setLevelRng(f){ rnd = f || Math.random; }
// engine-independent sin/cos (exact float ops only; |err| < 1e-13)
var _DTAU = Math.PI*2, _DHPI = Math.PI/2;
var _S3=-1/6,_S5=1/120,_S7=-1/5040,_S9=1/362880,_S11=-1/39916800,
    _S13=1/6227020800,_S15=-1/1307674368000,_S17=1/355687428096000;
function dSin(x){
  x = x - Math.floor(x/_DTAU)*_DTAU;
  if (x > Math.PI) x = x - _DTAU;
  if (x > _DHPI) x = Math.PI - x;
  else if (x < -_DHPI) x = -Math.PI - x;
  var x2 = x*x;
  return x*(1 + x2*(_S3 + x2*(_S5 + x2*(_S7 + x2*(_S9 + x2*(_S11 +
         x2*(_S13 + x2*(_S15 + x2*_S17))))))));
}
function dCos(x){ return dSin(x + _DHPI); }
function hyp2(a,b){ return Math.sqrt(a*a + b*b); }
```

---

## 2. `Math.random()` → `rnd()` — exactly these 20 call sites

### 2a. `addEnemy` (lines 1047–1049) — 3 draws: axis, phase, speed

```js
  enemies.push({ group:g, base:new THREE.Vector2(x,z), axis:axis||(rnd()<0.5?0:1),
                 span:span||0, t:rnd()*6.283,
                 speed:(0.4+rnd()*0.45)*(variant==="veteran"?1.7:1),
```

### 2b. `goldenPoints` (lines 1075–1076) — 2 draws per attempt

```js
    var yaw = rnd()*Math.PI*2;
    var pitch = (rnd()*0.42) - 0.16;
```

### 2c. `buildLevel` block placement (lines 1126, 1131–1135) — 6 draws per try

The style roll (line 1126) is cosmetic but MUST come from the seeded stream
because it sits between gameplay draws:

```js
                : (function(){ var r0=rnd();
```
```js
      var bw = kind==="solid" ? 1.7+rnd()*4.4 : 1.5+rnd()*2.2;
      var bd = kind==="solid" ? 1.7+rnd()*4.4 : 1.5+rnd()*2.2;
      var bh = kind==="solid" ? 1.7+rnd()*4.8 : 2.4+rnd()*3.0;
      var cx = (rnd()-0.5)*(ROOM.w-8.5);
      var cz = (rnd()-0.5)*(ROOM.d-8.5);
```

### 2d. `buildLevel` target fallback (line 1157) — 2 draws per try

```js
        var rx = (rnd()-0.5)*(ROOM.w-7), rz = (rnd()-0.5)*(ROOM.d-7);
```

### 2e. `buildLevel` enemy rolls (lines 1162, 1164, 1169)

Careful — the `&&` short-circuits are load-bearing for draw order (armored
consumes a draw only when `armorLeft > 0`; span's second draw only happens
when the first passes):

```js
    var armored = armorLeft > 0 && rnd() < 0.55;
```
```js
    var span = (moveSpan > 0 && rnd() < 0.55) ? moveSpan*(0.6+rnd()*0.4) : 0;
```
```js
    addEnemy(pos.x, pos.z, armored, span, null, pool[Math.floor(rnd()*pool.length)]);
```

Total: 17 draws inside `spotClear…buildLevel` (asserted by the parity test)
plus 3 in `addEnemy`.

---

## 3. `Math.hypot` → `hyp2` — exactly these 4 sites

- line 1056 (`spotClear`, player distance):
  `if (hyp2(x-player.pos.x, z-player.pos.z) < minPlayer) return false;`
- line 1063 (`spotClear`, enemy spacing):
  `if (hyp2(x-enemies[j].base.x, z-enemies[j].base.y) < Math.min(3.4, ROOM.w*0.09)) return false;`
- line 1136 (`buildLevel`, block-to-player distance):
  `if (hyp2(cx-player.pos.x, cz-player.pos.z) < Math.min(8, Math.max(4.2, ROOM.d*0.2))) continue;`
- line 1453 (`solvePath`, frag radius — this one is in the SOLVER, so it must
  match the server bit-for-bit):
  `if (hyp2(ef.pos.x-hp.x, ef.pos.z-hp.z) > FRAG_R) continue;`

Leave line 3635 (`touch` analog magnitude) alone — input only.

---

## 4. `Math.sin/cos` → `dSin/dCos` — exactly these 2 places

### 4a. `goldenPoints` direction (line 1077) — feeds seeded levelgen

```js
    var dir = new THREE.Vector3(-dSin(yaw)*dCos(pitch), dSin(pitch), -dCos(yaw)*dCos(pitch));
```

### 4b. Enemy patrol offset (line 3689) — the position the solver reads

```js
        var off = dSin(e.t)*e.span;
```

Leave line 3691 (`rotation.y`, cosmetic wobble), the head-bob sin (3664), and
`aimDir()` (1291–1294) alone. `aimDir()` may stay on `Math.sin/cos` because
the client transmits the resulting *vector*; the server uses the transmitted
doubles and never recomputes them from yaw/pitch.

---

## 5. New: `buildDuelLevel` (add near the MAPS section, after line 3220)

```js
// Build a level both duelists and the server can reproduce bit-for-bit.
// stats comes straight from the level_start message (canonical duel loadout).
function buildDuelLevel(seed, mapId, level, stats){
  S.level = level;
  S.stats = stats;
  pendingMap = MAPS[0];
  for (var i=0;i<MAPS.length;i++) if (MAPS[i].id === mapId) pendingMap = MAPS[i];
  setLevelRng(mulberry32(seed));
  try { buildLevel(); }          // pendingMap is set, so pickMap() never runs
  finally { setLevelRng(null); } // solo play goes back to Math.random
}
```

Notes:
- `applyMap` (line 3221) internally uses `Math.random` for dust motes — that
  is fine and must NOT switch to `rnd`, or it would desync the stream.
- The `try/finally` guarantees a thrown error can't leave solo play seeded.

---

## 6. Duel networking glue (new, additive)

A small `NET` module (sketch — wire the handlers to the existing UI):

```js
var NET = { ws:null, base:"https://one-round-net.YOURACCOUNT.workers.dev",
            duel:false, range:0, token:null, code:null };

function duelConnect(code, name, token){
  NET.code = code;
  NET.ws = new WebSocket(NET.base.replace(/^http/,"ws") + "/duel/" + code);
  NET.ws.onopen = function(){
    NET.ws.send(JSON.stringify({ type:"join", name:name, token:token||undefined }));
  };
  NET.ws.onmessage = function(ev){
    var m; try { m = JSON.parse(ev.data); } catch(e){ return; }
    if (m.type === "joined"){
      NET.token = m.token; NET.duel = true;      // persist m.token for reconnect
      if (m.current){ duelStartRange(m.current); }
    } else if (m.type === "level_start"){
      duelStartRange(m);
    } else if (m.type === "verdict"){
      // AUTHORITATIVE: display m.score / m.cleared, not the local numbers
    } else if (m.type === "round_result"){ /* show both scores, wins */ }
    else if (m.type === "match_result"){ /* winner screen, offer rematch */ }
    else if (m.type === "opponent_status"){ /* lobby / "opponent fired" UI */ }
    else if (m.type === "rematch"){ /* show "opponent wants a rematch" */ }
    else if (m.type === "error"){ /* surface m.code */ }
  };
  NET.ws.onclose = function(){
    // reconnect with the saved token inside the 60s grace window
    if (NET.duel) setTimeout(function(){ duelConnect(NET.code, name, NET.token); }, 1500);
  };
}

function duelStartRange(cur){
  NET.range = cur.range;
  buildDuelLevel(cur.seed, cur.mapId, cur.level, cur.stats);
  resetToAim();
  // honour cur.startAt (countdown) and cur.deadline (75s shot clock) in the HUD
}
```

### Hook in `fire()` (line 1513)

Right after `shot = solvePath(muzzle(), dir, false);` add:

```js
  if (NET.duel && NET.ws && NET.ws.readyState === 1){
    var ph = [];
    for (var ei=0; ei<enemies.length; ei++) ph.push(enemies[ei].t);
    NET.ws.send(JSON.stringify({ type:"shot", range:NET.range,
      pos:[player.pos.x, player.pos.y, player.pos.z],
      aim:[dir.x, dir.y, dir.z], ph:ph, stats:S.stats }));
  }
```

`player.pos` / `dir` / `enemies[i].t` are exactly the inputs the local solve
used (enemies stop moving outside the aim phase, so `e.t` is frozen at fire
time), and JSON round-trips doubles exactly — the server's re-solve is
bit-identical to the local one. Keep the local solve for tracer/playback;
treat the `verdict` as the score of record.

### Duel flow control

In duel mode `resolveShot()` (line 1648) must NOT advance the level or open
the upgrade screen — range flow is driven by `level_start`/`round_result`
messages. Guard the `setTimeout` block with `if (NET.duel) return;` after the
HUD update.

---

## 7. Shared leaderboard over HTTP (replaces the Store-backed board)

Replace the bodies of `boardLoad` / `boardSubmit` (lines 3067–3092). The
entry shape `{n,s,l,k,b,w,t}` already matches the server schema exactly.

```js
var BOARD_URL = "https://one-round-net.YOURACCOUNT.workers.dev";
function boardLoad(force){
  if (boardCache && !force) return Promise.resolve(boardCache);
  return fetch(BOARD_URL + "/board")
    .then(function(r){ return r.json(); })
    .then(function(d){ boardCache = Array.isArray(d.board) ? d.board : []; return boardCache; })
    .catch(function(){ return boardCache || []; });
}
function boardSubmit(entry){
  return fetch(BOARD_URL + "/score", { method:"POST",
      headers:{ "Content-Type":"application/json" }, body: JSON.stringify(entry) })
    .then(function(r){ return r.json(); })
    .then(function(d){ boardCache = Array.isArray(d.board) ? d.board : []; return boardCache; })
    .catch(function(){ return boardCache || []; });
}
```

(Server rewrites `t` and sanitizes `n`; merge-by-name/top-30 now happens
server-side with the same rules the local version used.)

---

## 8. Explicitly NOT changed (cosmetic randomness stays `Math.random`)

Audio noise (707, 717), canvas textures (738–791), floor dressing (853),
decal rotation (1189), particles (1277–1282), upgrade offers (2112 — solo
only), debris/sparks/smoke/casings (2833–2913), solo `pickMap` (3219 — duels
bypass it via `pendingMap`), dust motes (3249–3251), camera shake
(3763–3765). Routing any of these through `rnd` would desync duel levelgen.

---

## 9. Verification

`node tests/run.js` — `netcode.test.js` extracts the solver and levelgen
straight out of index.html, applies exactly the substitutions in §2–§4
(asserting the occurrence counts: 17 `Math.random()` in
spotClear…buildLevel, 3 + 1 `Math.hypot(`, 2 `Math.sin(` / 3 `Math.cos(` in
goldenPoints), and requires bit-identical blocks, enemies, event streams and
scores against `multiplayer/server/solver.js` across 5 seeded levels and
~180 shots. After editing index.html per this document, that test doubles as
the regression gate for the real client code path.
