/* ======================================================================
   ONE ROUND — shared deterministic solver + levelgen (server-side port)

   This is a faithful, self-contained port of the gameplay-relevant logic
   in index.html:

     - solvePath (index.html:1410) and its geometry kernel
       rayAABB / shellHits / raySphere / rayCylY / nearestSurface /
       nearestTarget (index.html:1301-1406)
     - the level generator buildLevel / goldenPoints / spotClear /
       pathDistance (index.html:1055-1174) with every Math.random()
       replaced by a seeded PRNG (mulberry32)
     - the kill/clear scoring arithmetic from playback()/resolveShot()
       (index.html:1581-1656)

   DETERMINISM RULES (the whole point of this file):
     - only IEEE-754-exact operations: + - * /, Math.sqrt, Math.abs,
       Math.min/max, Math.floor, Math.round, Math.imul. These are
       specified bit-exactly and identical in every JS engine.
     - NO Math.random, NO Math.sin/cos/hypot/pow in gameplay code.
       Transcendentals are replaced by dSin/dCos below (polynomial,
       exact ops only) and Math.hypot(a,b) by hyp2 = sqrt(a*a+b*b).
     - The Vec3 class reproduces THREE.Vector3 (r128) operation-for-
       operation (e.g. normalize() multiplies by 1/len rather than
       dividing, because that is what three r128 does).

   Given the identical (seed, mapId, level, stats) both the client (after
   the changes in multiplayer/CLIENT_CHANGES.md) and this module build a
   bit-identical level, and given the identical (pos, aim, phases, stats)
   they produce a bit-identical event stream and score.

   Dual-target module: CommonJS for node tests, and importable from the
   Worker (esbuild/wrangler interops `module.exports` automatically).
   ==================================================================== */
"use strict";

// ------------------------------------------------------------ constants
// Exact copies of index.html:628-640 (tuning block).
var EYE = 1.62, PLAYER_R = 0.42;
var MAX_SEGMENTS = 90, MAX_PATH = 1100;
var EPS = 1e-4;
var BODY_R = 0.46, BODY_LO = 0.07, BODY_HI = 1.37;
var HEAD_Y = 1.63, HEAD_R = 0.29;
var FRAG_R = 3.1;
var SCORE_BODY = 100, SCORE_HEAD = 260, SCORE_ARMOR = 1.7;
var BANK_STEP = 0.5, BANK_CAP = 6;
var MUZZLE_OFF = 0.55;               // muzzle() offset, index.html:1296

// Exact copy of index.html:3208-3214 (gameplay fields only).
var MAPS = [
  { id: "range", name: "The Range", w: 44, d: 44, h: 9.5,  bmul: 1.0  },
  { id: "well",  name: "The Well",  w: 28, d: 28, h: 15.5, bmul: 0.7  },
  { id: "hall",  name: "Long Hall", w: 62, d: 22, h: 8.0,  bmul: 1.1  },
  { id: "vault", name: "The Vault", w: 34, d: 34, h: 6.2,  bmul: 0.9  },
  { id: "yard",  name: "The Yard",  w: 54, d: 54, h: 12.0, bmul: 1.35 }
];
function mapById(id) {
  for (var i = 0; i < MAPS.length; i++) if (MAPS[i].id === id) return MAPS[i];
  return null;
}

// ------------------------------------------------------ seeded PRNG
// mulberry32 — 32-bit state, uses only >>> ^ + Math.imul (all bit-exact).
function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------- deterministic sin/cos
// Math.sin/Math.cos are NOT guaranteed bit-identical across JS engines.
// dSin/dCos use only exact float ops (range reduction + odd Taylor
// polynomial through x^17, |err| < 1e-13 on the reduced range), so every
// engine produces the identical double.
var PI = Math.PI, TAU = PI * 2, HALF_PI = PI / 2;
var S3 = -1 / 6, S5 = 1 / 120, S7 = -1 / 5040, S9 = 1 / 362880,
    S11 = -1 / 39916800, S13 = 1 / 6227020800,
    S15 = -1 / 1307674368000, S17 = 1 / 355687428096000;
function dSin(x) {
  x = x - Math.floor(x / TAU) * TAU;          // [0, TAU)
  if (x > PI) x = x - TAU;                    // (-PI, PI]
  if (x > HALF_PI) x = PI - x;                // fold into [-PI/2, PI/2]
  else if (x < -HALF_PI) x = -PI - x;
  var x2 = x * x;
  return x * (1 + x2 * (S3 + x2 * (S5 + x2 * (S7 + x2 * (S9 + x2 * (S11 +
         x2 * (S13 + x2 * (S15 + x2 * S17))))))));
}
function dCos(x) { return dSin(x + HALF_PI); }

// Deterministic 2-argument hypot: Math.hypot is engine-dependent,
// sqrt(a*a+b*b) is bit-exact everywhere.
function hyp2(a, b) { return Math.sqrt(a * a + b * b); }

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); } // index.html:674

// ------------------------------------------------------------- Vec3
// Operation-for-operation port of the THREE.Vector3 (r128) methods the
// solver touches. Order of arithmetic matters for bit parity.
function Vec3(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
Vec3.prototype = {
  constructor: Vec3,
  set: function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; },
  clone: function () { return new Vec3(this.x, this.y, this.z); },
  copy: function (v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; },
  add: function (v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; },
  sub: function (v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; },
  multiplyScalar: function (s) { this.x *= s; this.y *= s; this.z *= s; return this; },
  addScaledVector: function (v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; },
  dot: function (v) { return this.x * v.x + this.y * v.y + this.z * v.z; },
  length: function () { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); },
  // three r128: divideScalar(length()||1) => multiplyScalar(1/scalar)
  normalize: function () { return this.multiplyScalar(1 / (this.length() || 1)); },
  negate: function () { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; },
  // three r128: this.sub(_v.copy(normal).multiplyScalar(2*this.dot(normal)))
  reflect: function (n) {
    var s = 2 * this.dot(n);
    this.x -= n.x * s; this.y -= n.y * s; this.z -= n.z * s;
    return this;
  },
  lerp: function (v, a) {
    this.x += (v.x - this.x) * a;
    this.y += (v.y - this.y) * a;
    this.z += (v.z - this.z) * a;
    return this;
  },
  distanceTo: function (v) {
    var dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },
  setComponent: function (i, v) {
    if (i === 0) this.x = v; else if (i === 1) this.y = v; else this.z = v;
    return this;
  },
  setY: function (y) { this.y = y; return this; }
};

// ================================================================
//  GEOMETRY KERNEL — line-for-line port of index.html:1301-1406
//  (ctx = { room:{w,d,h}, blocks:[{min,max,kind}], enemies:[...] })
// ================================================================
function rayAABB(ro, rd, min, max, r) {
  var lo = [min.x - r, min.y - r, min.z - r], hi = [max.x + r, max.y + r, max.z + r];
  var o = [ro.x, ro.y, ro.z], d = [rd.x, rd.y, rd.z];
  var tmin = -Infinity, tmax = Infinity, axis = 0, sign = -1;
  for (var i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    var inv = 1 / d[i];
    var t1 = (lo[i] - o[i]) * inv, t2 = (hi[i] - o[i]) * inv;
    var s = d[i] > 0 ? -1 : 1;
    if (t1 > t2) { var tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmin < EPS || tmin === -Infinity) return null;
  var n = new Vec3(0, 0, 0); n.setComponent(axis, sign);
  return { t: tmin, n: n };
}

function shellHits(room, ro, rd, r, out) {
  var hx = room.w / 2 - r, hz = room.d / 2 - r, ylo = r, yhi = room.h - r;
  function push(t, x, y, z) { if (t > EPS) out.push({ t: t, n: new Vec3(x, y, z), kind: "wall" }); }
  if (rd.x > 1e-9) push((hx - ro.x) / rd.x, -1, 0, 0);
  if (rd.x < -1e-9) push((-hx - ro.x) / rd.x, 1, 0, 0);
  if (rd.y > 1e-9) push((yhi - ro.y) / rd.y, 0, -1, 0);
  if (rd.y < -1e-9) push((ylo - ro.y) / rd.y, 0, 1, 0);
  if (rd.z > 1e-9) push((hz - ro.z) / rd.z, 0, 0, -1);
  if (rd.z < -1e-9) push((-hz - ro.z) / rd.z, 0, 0, 1);
}

var KIND_RANK = { pad: 1, wall: 2, solid: 2, sink: 3 };

function raySphere(ro, rd, c, rad) {
  var ox = ro.x - c.x, oy = ro.y - c.y, oz = ro.z - c.z;
  var b = ox * rd.x + oy * rd.y + oz * rd.z;
  var cc = ox * ox + oy * oy + oz * oz - rad * rad;
  var disc = b * b - cc;
  if (disc < 0) return -1;
  var sq = Math.sqrt(disc), t = -b - sq;
  if (t < EPS) t = -b + sq;
  return t > EPS ? t : -1;
}

function rayCylY(ro, rd, cx, cz, rad, y0, y1) {
  var ox = ro.x - cx, oz = ro.z - cz;
  var a = rd.x * rd.x + rd.z * rd.z;
  var hits = [];
  if (a > 1e-9) {
    var b = ox * rd.x + oz * rd.z;
    var cc = ox * ox + oz * oz - rad * rad;
    var disc = b * b - a * cc;
    if (disc >= 0) {
      var sq = Math.sqrt(disc);
      hits.push((-b - sq) / a); hits.push((-b + sq) / a);
    }
  }
  if (Math.abs(rd.y) > 1e-9) { hits.push((y0 - ro.y) / rd.y); hits.push((y1 - ro.y) / rd.y); }
  var best = -1;
  for (var i = 0; i < hits.length; i++) {
    var t = hits[i]; if (t <= EPS) continue;
    var y = ro.y + rd.y * t;
    if (y < y0 - 1e-4 || y > y1 + 1e-4) continue;
    var px = ro.x + rd.x * t - cx, pz = ro.z + rd.z * t - cz;
    if (px * px + pz * pz > rad * rad + 1e-3) continue;
    if (best < 0 || t < best) best = t;
  }
  return best;
}

function nearestSurface(ctx, pos, vel, r) {
  var hits = [];
  shellHits(ctx.room, pos, vel, r, hits);
  for (var i = 0; i < ctx.blocks.length; i++) {
    var b = ctx.blocks[i];
    var h = rayAABB(pos, vel, b.min, b.max, r);
    if (h) { h.kind = b.kind; hits.push(h); }
  }
  if (!hits.length) return null;
  var best = hits[0];
  for (i = 1; i < hits.length; i++) if (hits[i].t < best.t) best = hits[i];
  var n = best.n.clone(), kind = best.kind;
  for (i = 0; i < hits.length; i++) {
    var o = hits[i];
    if (o === best || o.t - best.t > 2.5e-3) continue;
    if (Math.abs(o.n.dot(best.n)) < 0.99) n.add(o.n);
    if (KIND_RANK[o.kind] > KIND_RANK[kind]) kind = o.kind;
  }
  return { t: best.t, n: n.normalize(), kind: kind };
}

function nearestTarget(ctx, pos, vel, r, down) {
  var best = null;
  for (var i = 0; i < ctx.enemies.length; i++) {
    var e = ctx.enemies[i];
    if (!e.alive || down[i]) continue;
    var p = e.pos;
    var tb = rayCylY(pos, vel, p.x, p.z, BODY_R + r, BODY_LO, BODY_HI);
    var th = raySphere(pos, vel, new Vec3(p.x, HEAD_Y, p.z), HEAD_R + r);
    var t = -1, head = false;
    if (tb > 0 && th > 0) { t = Math.min(tb, th); head = th <= tb; }
    else if (tb > 0) t = tb;
    else if (th > 0) { t = th; head = true; }
    if (t > 0 && (!best || t < best.t)) best = { t: t, i: i, head: head };
  }
  return best;
}

// ================================================================
//  SOLVER — line-for-line port of solvePath, index.html:1410-1500.
//  Only difference: `Math.hypot(dx,dz)` in the frag loop is hyp2()
//  (CLIENT_CHANGES.md makes index.html match).
// ================================================================
function solvePath(ctx, origin, dir, ghost, stats) {
  var st = stats;
  var pos = origin.clone(), vel = dir.clone().normalize();
  var r = st.radius, bounces = st.bounces, pierce = st.pierce;
  var pts = [pos.clone()], events = [], down = {};
  var dist = 0, nb = 0, kills = 0, ending = "spent";

  for (var guard = 0; guard < MAX_SEGMENTS; guard++) {
    if (st.guide > 0 && nb > 0 && !ghost) {
      var lead = null, ld = 1e9;
      for (var g = 0; g < ctx.enemies.length; g++) {
        var en = ctx.enemies[g]; if (!en.alive || down[g]) continue;
        var to = new Vec3(en.pos.x, 0.95, en.pos.z).sub(pos);
        var dd = to.length();
        if (dd > 15 || dd < 0.6) continue;
        var u = to.multiplyScalar(1 / dd);
        if (u.dot(vel) < 0.87) continue;
        if (dd < ld) { ld = dd; lead = u; }
      }
      if (lead) { vel.lerp(lead, Math.min(0.6, 0.24 * st.guide)).normalize(); }
    }

    var eHit = ghost ? null : nearestTarget(ctx, pos, vel, r, down);
    var sHit = nearestSurface(ctx, pos, vel, r);

    if (eHit && (!sHit || eHit.t < sHit.t)) {
      var hp = pos.clone().addScaledVector(vel, eHit.t);
      var cost = ctx.enemies[eHit.i].armored ? 2 : 1;
      dist += eHit.t;
      if (cost > pierce) {
        pts.push(hp.clone());
        events.push({ at: dist, type: "stop", p: hp.clone(), n: vel.clone().negate() });
        ending = "blocked"; break;
      }
      pts.push(hp.clone());
      pierce -= cost; kills++;
      events.push({ at: dist, type: "kill", i: eHit.i, head: eHit.head, p: hp.clone(),
                    nb: nb, armored: ctx.enemies[eHit.i].armored, frag: false });
      down[eHit.i] = true;
      if (st.frag) {
        for (var f = 0; f < ctx.enemies.length; f++) {
          var ef = ctx.enemies[f];
          if (!ef.alive || down[f]) continue;
          if (hyp2(ef.pos.x - hp.x, ef.pos.z - hp.z) > FRAG_R) continue;
          down[f] = true; kills++;
          events.push({ at: dist + 0.01, type: "kill", i: f, head: false, p: ef.pos.clone().setY(1.0),
                        nb: nb, armored: ef.armored, frag: true });
        }
      }
      pos.copy(hp).addScaledVector(vel, 0.01);
      if (pierce <= 0) { ending = "pierce"; break; }
      continue;
    }

    if (!sHit) { ending = "void"; break; }
    var wp = pos.clone().addScaledVector(vel, sHit.t);
    dist += sHit.t;
    pts.push(wp.clone());

    if (sHit.kind === "sink") {
      events.push({ at: dist, type: "sink", p: wp.clone(), n: sHit.n.clone() });
      ending = "sink"; break;
    }
    if (bounces <= 0 && sHit.kind !== "pad") {
      events.push({ at: dist, type: "stop", p: wp.clone(), n: sHit.n.clone() });
      ending = "spent"; break;
    }
    vel.reflect(sHit.n).normalize();
    nb++;
    if (sHit.kind === "pad") {
      events.push({ at: dist, type: "pad", p: wp.clone(), n: sHit.n.clone(), left: bounces });
    } else {
      bounces--;
      events.push({ at: dist, type: "bounce", p: wp.clone(), n: sHit.n.clone(), left: bounces });
    }
    if (st.bloom) r = Math.min(0.52, r + 0.024);
    pos.copy(wp).addScaledVector(sHit.n, 0.012);
    pos.x = clamp(pos.x, -ctx.room.w / 2 + r + 1e-3, ctx.room.w / 2 - r - 1e-3);
    pos.z = clamp(pos.z, -ctx.room.d / 2 + r + 1e-3, ctx.room.d / 2 - r - 1e-3);
    pos.y = clamp(pos.y, r + 1e-3, ctx.room.h - r - 1e-3);
    if (dist > MAX_PATH) { ending = "spent"; break; }
  }

  var cum = [0];
  for (var c = 1; c < pts.length; c++) cum[c] = cum[c - 1] + pts[c - 1].distanceTo(pts[c]);
  return { pts: pts, cum: cum, events: events, length: dist, ending: ending,
           bounces: nb, kills: kills, spareBounce: Math.max(0, bounces), sparePierce: Math.max(0, pierce) };
}

// ================================================================
//  LEVEL GENERATION — seeded port of index.html:664-671 (counts),
//  1055-1066 (spotClear), 1071-1106 (goldenPoints/pathDistance) and
//  1108-1170 (buildLevel). Every `Math.random()` of the original is
//  `rng()` here, consumed in the identical order; `Math.hypot` is
//  hyp2, `Math.sin/cos` are dSin/dCos (CLIENT_CHANGES.md mirrors all
//  three substitutions in index.html).
// ================================================================
function targetsWanted(L) { return Math.min(1 + Math.floor((L - 1) * 0.62), 8); } // :664
function targetsFor(L, stats) { return Math.max(1, Math.min(targetsWanted(L), stats.pierce)); } // :665
function blocksFor(L, bmul) { // :666
  return Math.max(3, Math.round((5 + Math.min(9, Math.floor(L / 1.35))) * bmul));
}
function padsFor(L, stats) { return Math.min(3, (L >= 3 ? 1 : 0) + Math.floor(L / 6)) + stats.pads; } // :670
function sinksFor(L) { return Math.min(3, L >= 5 ? 1 + Math.floor((L - 5) / 4) : 0); } // :671

function spotClear(ctx, playerPos, x, z, minPlayer, pad) { // :1055
  if (hyp2(x - playerPos.x, z - playerPos.z) < minPlayer) return false;
  if (Math.abs(x) > ctx.room.w / 2 - 1.6 || Math.abs(z) > ctx.room.d / 2 - 1.6) return false;
  for (var i = 0; i < ctx.blocks.length; i++) {
    var b = ctx.blocks[i];
    if (x > b.min.x - pad && x < b.max.x + pad && z > b.min.z - pad && z < b.max.z + pad) return false;
  }
  for (var j = 0; j < ctx.enemies.length; j++) {
    // original reads enemies[j].base.{x,y} where base is a Vector2 (y === z)
    if (hyp2(x - ctx.enemies[j].base.x, z - ctx.enemies[j].base.y) < Math.min(3.4, ctx.room.w * 0.09)) return false;
  }
  return true;
}

function pathDistance(path, segIndex, frac) { // :1101
  var d = 0;
  for (var i = 1; i < segIndex; i++) d += path.pts[i - 1].distanceTo(path.pts[i]);
  d += path.pts[segIndex - 1].distanceTo(path.pts[segIndex]) * frac;
  return d;
}

function goldenPoints(ctx, playerPos, level, stats, need, rng) { // :1071
  var origin = new Vec3(playerPos.x, EYE, playerPos.z);
  var best = null;
  for (var attempt = 0; attempt < 120; attempt++) {
    var yaw = rng() * Math.PI * 2;
    var pitch = (rng() * 0.42) - 0.16;
    var dir = new Vec3(-dSin(yaw) * dCos(pitch), dSin(pitch), -dCos(yaw) * dCos(pitch));
    var path = solvePath(ctx, origin, dir, true, stats);
    var picks = [], minStart = Math.min(4.5 + Math.max(0, level - 1) * 2.2, 26);
    for (var k = 1; k < path.pts.length && picks.length < need; k++) {
      var a = path.pts[k - 1], b = path.pts[k], seg = a.distanceTo(b);
      var stride = 2.2;
      for (var d = stride; d < seg && picks.length < need; d += stride) {
        var p = a.clone().lerp(b, d / seg);
        var along = pathDistance(path, k, d / seg);
        if (along < minStart) continue;
        if (p.y < 0.55 || p.y > 1.55) continue;
        if (!spotClear(ctx, playerPos, p.x, p.z, Math.min(7.5, Math.max(4.2, ctx.room.d * 0.19)), 1.35)) continue;
        var okSpacing = true;
        var gap = Math.min(4.6, Math.max(2.6, Math.min(ctx.room.w, ctx.room.d) * 0.12));
        for (var q = 0; q < picks.length; q++) if (picks[q].distanceTo(p) < gap) okSpacing = false;
        if (!okSpacing) continue;
        picks.push(p.clone());
      }
    }
    if (!best || picks.length > best.length) best = picks;
    if (picks.length >= need) break;
  }
  return best || [];
}

// addBlock — collision data only (index.html:982/1007; the rest is mesh work)
function addBlock(ctx, cx, cz, w, h, d, kind) {
  ctx.blocks.push({ min: new Vec3(cx - w / 2, 0, cz - d / 2),
                    max: new Vec3(cx + w / 2, h, cz + d / 2), kind: kind });
}

// addEnemy — gameplay fields only, rng consumed in the exact order of
// index.html:1012-1052 (variant coerced first, then axis, t, speed).
function addEnemy(ctx, x, z, armored, span, axis, variant, rng) {
  variant = armored ? "armour" : (variant || "drum");
  ctx.enemies.push({
    base: { x: x, y: z },                       // Vector2 in the game: y is z
    axis: axis || (rng() < 0.5 ? 0 : 1),
    span: span || 0,
    t0: rng() * 6.283,
    speed: (0.4 + rng() * 0.45) * (variant === "veteran" ? 1.7 : 1),
    alive: true, armored: !!armored, variant: variant,
    pos: new Vec3(x, 0, z)
  });
}

// buildLevel — seeded port of index.html:1108-1170.
function generateLevel(seed, mapId, level, stats) {
  var map = mapById(mapId);
  if (!map) throw new Error("unknown map " + mapId);
  var rng = mulberry32(seed);
  var ctx = { room: { w: map.w, d: map.d, h: map.h }, blocks: [], enemies: [] };
  var playerPos = { x: 0, y: EYE, z: ctx.room.d / 2 - 5.2 };   // :1112

  var nb = blocksFor(level, map.bmul), np = padsFor(level, stats), ns = sinksFor(level), tries;
  var wanted = [];
  for (var i = 0; i < nb; i++) wanted.push("solid");
  for (var p = 0; p < np; p++) wanted.push("pad");
  for (var s2 = 0; s2 < ns; s2++) wanted.push("sink");

  for (var w = 0; w < wanted.length; w++) {
    for (tries = 0; tries < 50; tries++) {
      var kind = wanted[w];
      // style roll consumes one rng draw for solids (index.html:1126) even
      // though the style itself is cosmetic — order must match the client.
      if (kind === "solid") rng();
      var bw = kind === "solid" ? 1.7 + rng() * 4.4 : 1.5 + rng() * 2.2;
      var bd = kind === "solid" ? 1.7 + rng() * 4.4 : 1.5 + rng() * 2.2;
      var bh = kind === "solid" ? 1.7 + rng() * 4.8 : 2.4 + rng() * 3.0;
      var cx = (rng() - 0.5) * (ctx.room.w - 8.5);
      var cz = (rng() - 0.5) * (ctx.room.d - 8.5);
      if (hyp2(cx - playerPos.x, cz - playerPos.z) < Math.min(8, Math.max(4.2, ctx.room.d * 0.2))) continue;
      var ok = true;
      for (var k = 0; k < ctx.blocks.length; k++) {
        var b = ctx.blocks[k];
        if (cx + bw / 2 > b.min.x - 1.9 && cx - bw / 2 < b.max.x + 1.9 &&
            cz + bd / 2 > b.min.z - 1.9 && cz - bd / 2 < b.max.z + 1.9) { ok = false; break; }
      }
      if (ok) { addBlock(ctx, cx, cz, bw, bh, bd, kind); break; }
    }
  }

  var need = targetsFor(level, stats);
  var spare = Math.max(0, stats.pierce - need);
  var armorLeft = level >= 5 ? Math.min(spare, Math.floor(need / 2)) : 0;
  var spots = goldenPoints(ctx, playerPos, level, stats, need, rng);
  var moveSpan = level < 3 ? 0 : Math.min(0.6 + (level - 3) * 0.28, 2.4);

  // only hang targets on the solved golden line — an off-path fallback
  // target can make a range unclearable (mirrors index.html buildLevel)
  for (var t = 0; t < need; t++) {
    var pos = spots[t];
    if (!pos) continue;
    var armored = armorLeft > 0 && rng() < 0.55;
    if (armored) armorLeft--;
    var span = (moveSpan > 0 && rng() < 0.55) ? moveSpan * (0.6 + rng() * 0.4) : 0;
    var pool = ["drum"];
    if (level >= 3) pool.push("spinner");
    if (level >= 4) pool.push("beacon");
    if (level >= 6) pool.push("veteran", "spinner");
    addEnemy(ctx, pos.x, pos.z, armored, span, null, pool[Math.floor(rng() * pool.length)], rng);
  }

  return { seed: seed >>> 0, mapId: mapId, level: level,
           room: ctx.room, blocks: ctx.blocks, enemies: ctx.enemies,
           playerStart: playerPos };
}

// Place enemies for a shot: the client sends each enemy's patrol phase t
// at the instant of fire; offset = sin(t)*span exactly as the animate
// loop does (index.html:3687-3698, with dSin per CLIENT_CHANGES.md).
// sin() bounds the offset, so a forged phase can never move a target
// anywhere its patrol could not legally take it.
function positionEnemies(levelData, phases) {
  for (var i = 0; i < levelData.enemies.length; i++) {
    var e = levelData.enemies[i];
    var x = e.base.x, z = e.base.y;
    if (e.span > 0) {
      var t = (phases && typeof phases[i] === "number") ? phases[i] : e.t0;
      var off = dSin(t) * e.span;
      if (e.axis) x = e.base.x + off; else z = e.base.y + off;
    }
    e.pos.set(x, 0, z);
  }
}

// ================================================================
//  SCORING — the arithmetic of playback() kill handling
//  (index.html:1581-1587) and resolveShot() clear bonus (:1654).
// ================================================================
function scoreShot(result, level, stats, totalEnemies) {
  var score = 0, kills = 0, bestBank = 0, gains = [];
  for (var i = 0; i < result.events.length; i++) {
    var ev = result.events[i];
    if (ev.type !== "kill") continue;
    var mult = 1 + Math.min(BANK_CAP, ev.nb) * (stats.bankStep || BANK_STEP);
    var base = ev.head ? SCORE_HEAD * stats.crit * (stats.headMul || 1)
                       : SCORE_BODY * (stats.bodyMul || 1);
    if (ev.armored) base *= SCORE_ARMOR;
    var gain = Math.round(base * mult * (stats.scoreMul || 1));
    if (stats.requireBank && ev.nb === 0) gain = 0;
    score += gain; kills++;
    if (ev.nb > bestBank) bestBank = ev.nb;
    gains.push(gain);
  }
  var cleared = kills >= totalEnemies;
  var clearBonus = 0;
  if (cleared) {
    clearBonus = Math.round((240 + level * 60 + result.spareBounce * 45 + result.sparePierce * 40) *
                            (stats.clearMul || 1) * (stats.scoreMul || 1));
    score += clearBonus;
  }
  return { score: score, kills: kills, cleared: cleared, bestBank: bestBank,
           clearBonus: clearBonus, gains: gains };
}

// ================================================================
//  DUEL LOADOUT — canonical stats used by BOTH players in a duel so the
//  two clients and the server generate the identical level and solve
//  with identical physics. (Weapon choice is cosmetic in duels, v1.)
//  Documented in PROTOCOL.md §Loadout.
// ================================================================
function duelStats(level) {
  return {
    bounces: 3 + (level >= 3 ? 1 : 0) + (level >= 5 ? 1 : 0),
    pierce: targetsWanted(level),        // every range is clearable
    radius: 0.17, guide: 0, tracer: true, scope: false,
    chrono: 0, retries: 0, frag: false, bloom: false, pads: 0, crit: 1,
    bodyMul: 1, headMul: 1, bankStep: 0.5, clearMul: 1, scoreMul: 1,
    requireBank: false
  };
}

var SOLVER_STAT_KEYS = ["bounces", "pierce", "radius", "guide", "frag", "bloom",
                        "crit", "bodyMul", "headMul", "bankStep", "clearMul",
                        "scoreMul", "requireBank"];
function statsMatch(a, b) {
  if (!a || !b) return false;
  for (var i = 0; i < SOLVER_STAT_KEYS.length; i++) {
    var k = SOLVER_STAT_KEYS[i];
    // booleans coerce to 0/1; every solver-relevant field must agree exactly
    if (Number(a[k] || 0) !== Number(b[k] || 0)) return false;
  }
  return true;
}

// ================================================================
//  SHOT VALIDATION — the sanity half of the anticheat model. The solver
//  re-run is the real judge; this just refuses states a legitimate
//  client can never be in (see PROTOCOL.md §Anticheat).
// ================================================================
function num3(a) {
  return Array.isArray(a) && a.length === 3 &&
         isFinite(a[0]) && isFinite(a[1]) && isFinite(a[2]) &&
         typeof a[0] === "number" && typeof a[1] === "number" && typeof a[2] === "number";
}

function validateShot(levelData, shot) {
  if (!shot || typeof shot !== "object") return { ok: false, code: "bad_shot" };
  if (!num3(shot.pos)) return { ok: false, code: "bad_pos" };
  if (!num3(shot.aim)) return { ok: false, code: "bad_aim" };
  var room = levelData.room;
  var x = shot.pos[0], y = shot.pos[1], z = shot.pos[2];
  // movePlayer pins y to EYE (index.html:3658) and clamps x/z to the shell
  // minus the player radius (:3645-3646).
  //
  // These are sanity checks against states an honest client cannot reach, NOT
  // a bit-exactness contract. They used to be exact (`y !== EYE`) and a single
  // ulp of drift — 1.620000000000001 — was enough to discard a real player's
  // shot, which deadlocked the whole range for BOTH players because the server
  // then never got that slot's result. Tolerances are millimetres: far below
  // anything that buys an advantage in a room tens of metres across, and far
  // above float noise.
  if (Math.abs(y - EYE) > 1e-4) return { ok: false, code: "pos_y" };
  var hx = room.w / 2 - PLAYER_R, hz = room.d / 2 - PLAYER_R;
  if (Math.abs(x) > hx + 1e-3 || Math.abs(z) > hz + 1e-3) return { ok: false, code: "pos_oob" };
  // movePlayer pushes the player out of tall blocks (:3647-3657); a
  // position strictly inside one is impossible for an honest client. Pressing
  // flush against cover to line up a bank shot is not — so only reject a
  // position a clear millimetre inside the block, not one merely touching it.
  for (var i = 0; i < levelData.blocks.length; i++) {
    var b = levelData.blocks[i];
    if (b.max.y < 0.55) continue;
    if (x > b.min.x - PLAYER_R + 1e-3 && x < b.max.x + PLAYER_R - 1e-3 &&
        z > b.min.z - PLAYER_R + 1e-3 && z < b.max.z + PLAYER_R - 1e-3) {
      return { ok: false, code: "pos_in_block" };
    }
  }
  var al = Math.sqrt(shot.aim[0] * shot.aim[0] + shot.aim[1] * shot.aim[1] + shot.aim[2] * shot.aim[2]);
  if (Math.abs(al - 1) > 1e-6) return { ok: false, code: "aim_not_unit" };
  if (shot.ph !== undefined) {
    if (!Array.isArray(shot.ph) || shot.ph.length !== levelData.enemies.length)
      return { ok: false, code: "bad_phases" };
    for (var j = 0; j < shot.ph.length; j++) {
      if (typeof shot.ph[j] !== "number" || !isFinite(shot.ph[j]) || Math.abs(shot.ph[j]) > 1e7)
        return { ok: false, code: "bad_phases" };
    }
  }
  return { ok: true };
}

// ================================================================
//  ONE-CALL RE-SOLVE: (seed, mapId, level, pos, aim, ph, stats)
//  → { events, score, ... } — the server-side verdict.
// ================================================================
function serializeEvents(events) {
  return events.map(function (ev) {
    var o = { type: ev.type, at: ev.at, p: [ev.p.x, ev.p.y, ev.p.z] };
    if (ev.n) o.n = [ev.n.x, ev.n.y, ev.n.z];
    if (ev.type === "kill") { o.i = ev.i; o.head = ev.head; o.nb = ev.nb; o.armored = ev.armored; o.frag = ev.frag; }
    if (ev.left !== undefined) o.left = ev.left;
    return o;
  });
}

function solve(seed, mapId, level, pos, aim, ph, stats) {
  var levelData = generateLevel(seed, mapId, level, stats);
  var v = validateShot(levelData, { pos: pos, aim: aim, ph: ph });
  if (!v.ok) return { ok: false, code: v.code };
  positionEnemies(levelData, ph);
  // muzzle(): player.pos + aimDir()*0.55 (index.html:1296); the client
  // sends aim exactly as aimDir() produced it, so use it unnormalized
  // here and let solvePath normalize, exactly like fire() does.
  var origin = new Vec3(pos[0] + aim[0] * MUZZLE_OFF,
                        pos[1] + aim[1] * MUZZLE_OFF,
                        pos[2] + aim[2] * MUZZLE_OFF);
  // mirrors solveOrigin() in index.html: a muzzle embedded in a block
  // falls back to the eye so the round cannot skip that face
  for (var ob = 0; ob < levelData.blocks.length; ob++) {
    var obb = levelData.blocks[ob];
    if (origin.x > obb.min.x && origin.x < obb.max.x &&
        origin.y > obb.min.y && origin.y < obb.max.y &&
        origin.z > obb.min.z && origin.z < obb.max.z) {
      origin.set(pos[0], pos[1], pos[2]); break;
    }
  }
  var dir = new Vec3(aim[0], aim[1], aim[2]);
  var ctx = { room: levelData.room, blocks: levelData.blocks, enemies: levelData.enemies };
  var result = solvePath(ctx, origin, dir, false, stats);
  var scored = scoreShot(result, level, stats, levelData.enemies.length);
  return {
    ok: true,
    events: serializeEvents(result.events),
    ending: result.ending,
    length: result.length,
    bounces: result.bounces,
    spareBounce: result.spareBounce,
    sparePierce: result.sparePierce,
    kills: scored.kills,
    score: scored.score,
    cleared: scored.cleared,
    bestBank: scored.bestBank,
    clearBonus: scored.clearBonus,
    gains: scored.gains
  };
}

var OneRoundSolver = {
  // constants
  EYE: EYE, PLAYER_R: PLAYER_R, MUZZLE_OFF: MUZZLE_OFF,
  SCORE_BODY: SCORE_BODY, SCORE_HEAD: SCORE_HEAD, SCORE_ARMOR: SCORE_ARMOR,
  BANK_STEP: BANK_STEP, BANK_CAP: BANK_CAP,
  MAPS: MAPS, mapById: mapById,
  // primitives
  mulberry32: mulberry32, dSin: dSin, dCos: dCos, hyp2: hyp2, clamp: clamp, Vec3: Vec3,
  // level + physics
  targetsWanted: targetsWanted, targetsFor: targetsFor,
  blocksFor: blocksFor, padsFor: padsFor, sinksFor: sinksFor,
  generateLevel: generateLevel, positionEnemies: positionEnemies,
  solvePath: solvePath, scoreShot: scoreShot, serializeEvents: serializeEvents,
  // duel
  duelStats: duelStats, statsMatch: statsMatch,
  validateShot: validateShot, solve: solve
};

if (typeof module !== "undefined" && module.exports) module.exports = OneRoundSolver;
