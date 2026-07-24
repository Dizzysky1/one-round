// Boots ONE ROUND in headless Chromium: serves the repo, loads the page,
// collects console errors, clicks Start, and screenshots menu + gameplay.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.join(__dirname, "..", "..");
const OUT = __dirname;

const server = http.createServer((req, res) => {
  if (req.url === "/" ) {
    // serve index.html with the CDN three.js swapped for the local copy
    let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    html = html.replace(/src="https:\/\/cdnjs\.cloudflare\.com[^"]*three\.min\.js"/, 'src="/three.min.js"');
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
    return;
  }
  if (req.url === "/three.min.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(fs.readFileSync(path.join(__dirname, "..", "node_modules", "three", "build", "three.min.js")));
    return;
  }
  const p = path.join(ROOT, req.url.split("?")[0]);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const type = p.endsWith(".html") ? "text/html" : p.endsWith(".js") ? "text/javascript" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
});

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined,
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));

  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(2500);
  const threeOk = await page.evaluate(() => typeof THREE !== "undefined");
  await page.screenshot({ path: path.join(OUT, "menu.png") });

  const start = page.locator("#bStart");
  let started = false;
  if (await start.count()) {
    try { await start.click({ timeout: 5000 }); started = true; } catch (e) { errors.push("start click failed: " + e.message); }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "game.png") });
  // engage drag-look aim and fire the round; screenshot mid-flight and after
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.mouse.move(660, 350, { steps: 4 });
  await page.waitForTimeout(300);
  await page.keyboard.press("Space");
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, "game2.png") });
  await page.mouse.up();
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(OUT, "game3.png") });

  const state = await page.evaluate(() => {
    try { return { phase: (typeof S !== "undefined" && S.phase) || null, level: (typeof S !== "undefined" && S.level) || null }; }
    catch (e) { return { err: e.message }; }
  });
  console.log(JSON.stringify({ threeOk, started, state, errors }, null, 2));
  await browser.close();
  server.close();
  process.exit(errors.filter(e => !/favicon/.test(e)).length ? 1 : 0);
})().catch(e => { console.error("SMOKE FATAL", e); process.exit(2); });
