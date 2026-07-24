// Runs every *.test.js in this directory as its own node process, so one
// suite blowing up cannot mask the others. Exit code is non-zero if any fail.
var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var files = fs.readdirSync(__dirname).filter(function(f){ return /\.test\.js$/.test(f); }).sort();
if (!files.length){ console.error("no *.test.js files found"); process.exit(1); }

var failed = 0;
files.forEach(function(f){
  console.log("== " + f);
  var r = cp.spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
});
console.log(failed ? "FAIL — " + failed + " suite(s) failed" : "all suites green");
process.exit(failed ? 1 : 0);
