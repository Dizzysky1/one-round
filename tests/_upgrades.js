// Extracts POOL and offerUpgrades out of index.html so the shop rules can be
// tested without a browser. Same approach as _solver.js: slice the source
// between stable markers and evaluate it with the game globals injected.
var fs = require("fs");
var path = require("path");

function load(ctx){
  var src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  var start = src.indexOf("var POOL = [");
  if (start < 0) throw new Error("POOL not found in index.html");
  var fnStart = src.indexOf("function offerUpgrades(){", start);
  if (fnStart < 0) throw new Error("offerUpgrades not found in index.html");
  var end = src.indexOf("\n}", fnStart);
  if (end < 0) throw new Error("offerUpgrades end brace not found");
  var code = src.slice(start, end + 2);
  var factory = new Function("S", "taken", "targetsWanted",
    code + "\nreturn { POOL: POOL, offerUpgrades: offerUpgrades };");
  return factory(ctx.S, ctx.taken, ctx.targetsWanted);
}

function freshS(){
  return { level: 1, stats: {
    bounces:3, pierce:1, radius:0.17, guide:0, tracer:false, scope:false,
    chrono:0, retries:0, frag:false, bloom:false, pads:0, crit:1
  } };
}

module.exports = { load: load, freshS: freshS };
