// Shop rules: one-time upgrades must gate on effect (has()), not just on the
// card having been bought (taken). A weapon that ships an effect built in —
// Kestrel ships tracer:true — must never be offered the matching card.
var assert = require("assert");
var U = require("./_upgrades");

var checks = 0;
function ok(cond, msg){ assert.ok(cond, msg); checks++; console.log("  ok  " + msg); }

function make(over){
  var S = U.freshS();
  if (over) for (var k in over) S.stats[k] = over[k];
  var taken = {};
  var wanted = { n: 1 };
  var g = U.load({ S: S, taken: taken, targetsWanted: function(){ return wanted.n; } });
  return { S: S, taken: taken, wanted: wanted, POOL: g.POOL, offer: g.offerUpgrades };
}

function draws(env, n){
  var seen = {};
  for (var i = 0; i < (n || 200); i++){
    env.offer().forEach(function(u){ seen[u.id] = true; });
  }
  return seen;
}

// 1 — pool integrity: unique ids, every card fully formed
(function(){
  var env = make();
  var ids = {};
  env.POOL.forEach(function(u){
    assert.ok(u.id && u.name && u.tag && u.desc && typeof u.apply === "function",
      "malformed card " + u.id);
    assert.ok(!ids[u.id], "duplicate id " + u.id);
    ids[u.id] = true;
  });
  ok(env.POOL.length >= 12, "POOL has " + env.POOL.length + " well-formed cards, unique ids");
})();

// 2 — every once:true card carries a has() effect predicate
(function(){
  var env = make();
  var onceIds = env.POOL.filter(function(u){ return u.once; }).map(function(u){ return u.id; });
  assert.deepStrictEqual(onceIds.sort(), ["bloom","frag","scope","tracer"]);
  env.POOL.forEach(function(u){
    if (u.once) assert.strictEqual(typeof u.has, "function", u.id + " missing has()");
  });
  ok(true, "one-time cards are tracer/scope/frag/bloom, all with has()");
})();

// 3 — has() tracks the effect: false on fresh stats, true after apply()
(function(){
  var env = make();
  env.POOL.filter(function(u){ return u.once; }).forEach(function(u){
    assert.strictEqual(u.has(), false, u.id + " has() should start false");
    u.apply();
    assert.strictEqual(u.has(), true, u.id + " has() should be true after apply");
  });
  ok(true, "has() follows the effect through apply()");
})();

// 4 — the Kestrel bug: effect present from the weapon, card never bought
(function(){
  var env = make({ tracer: true });               // Kestrel ships tracer built in
  var seen = draws(env);
  ok(!seen.tracer, "tracer never offered when S.stats.tracer is already true (Kestrel)");
})();

// 5 — same rule for the other effect-shipped cases
(function(){
  var env = make({ scope: true, frag: true, bloom: true });
  var seen = draws(env);
  ok(!seen.scope && !seen.frag && !seen.bloom,
    "scope/frag/bloom never offered when the effect is already present");
})();

// 6 — taken-based once gating still holds on its own
(function(){
  var env = make();
  env.taken.frag = true;
  var seen = draws(env);
  ok(!seen.frag, "a bought once card stays out of the pool via taken");
})();

// 7 — offers are at most 3, unique, and drawn from POOL
(function(){
  var env = make();
  for (var i = 0; i < 50; i++){
    var out = env.offer();
    assert.ok(out.length <= 3, "more than 3 offers");
    var ids = {};
    out.forEach(function(u){
      assert.ok(env.POOL.indexOf(u) >= 0, "offer not from POOL");
      assert.ok(!ids[u.id], "duplicate offer " + u.id);
      ids[u.id] = true;
    });
  }
  ok(true, "offers are <=3, unique, all from POOL");
})();

// 8 — pierce is forced first when the next range wants more targets than pierce
(function(){
  var env = make();
  env.wanted.n = 5;                               // 5 targets, pierce is 1
  for (var i = 0; i < 50; i++){
    assert.strictEqual(env.offer()[0].id, "pierce", "pierce not forced");
  }
  env.wanted.n = 1;                               // and heavy's ok() gate still bites
  env.S.stats.radius = 0.41;
  ok(!draws(env).heavy && true, "pierce forced when outgunned; heavy gated by ok() at max radius");
})();

console.log("upgrades.test.js — " + checks + " checks passed");
