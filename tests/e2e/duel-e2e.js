// End-to-end duel: two headless Chromium pages duel through a local mock of
// the Worker protocol that scores with the REAL server solver
// (multiplayer/server/solver.js). Verifies the whole client wire-up:
// lobby, ready flow, seeded level build, shot send, verdict, round_result,
// match_result.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright-core");

const ROOT = path.join(__dirname, "..", "..");
const SOLVER = require(path.join(ROOT, "multiplayer/server/solver.js"));
const SHARED = require(path.join(ROOT, "multiplayer/server/shared.js"));

// ---------------------------------------------------------------- rooms
const rooms = {}; // code -> {players:[{ws,name,token,ready,fired,score,wins}], range, seeds, phase}
function makeRoom(code) {
  return rooms[code] = { code, players: [], range: 0, phase: "lobby",
    seeds: [1, 2, 3, 4, 5].map((l) => 100000 + l * 7919),
    maps: ["range", "well", "hall", "vault", "yard"], wins: [0, 0], totals: [0, 0] };
}
function send(p, m) { if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(m)); }
function levelStartMsg(room) {
  const level = room.range;
  return { type: "level_start", range: room.range, level,
    seed: room.seeds[level - 1], mapId: room.maps[level - 1],
    stats: SOLVER.duelStats(level), startAt: Date.now() + 500,
    deadline: Date.now() + 75500, bestOf: 5, winsNeeded: 3 };
}
function startRange(room) {
  room.range++;
  room.players.forEach((p) => { p.fired = false; p.score = 0; });
  const msg = levelStartMsg(room);
  room.players.forEach((p) => send(p, msg));
}
function endRound(room) {
  const [a, b] = room.players;
  const scores = [a.score | 0, b.score | 0];
  room.totals[0] += scores[0]; room.totals[1] += scores[1];
  let winnerSlot = scores[0] === scores[1] ? -1 : (scores[0] > scores[1] ? 0 : 1);
  if (winnerSlot >= 0) room.wins[winnerSlot]++;
  const over = room.wins[0] >= 3 || room.wins[1] >= 3 || room.range >= 5;
  room.players.forEach((p) => send(p, { type: "round_result", range: room.range,
    scores, winnerSlot, wins: room.wins.slice(), next: over ? null : { range: room.range + 1 } }));
  if (over) {
    let w = room.wins[0] === room.wins[1]
      ? (room.totals[0] === room.totals[1] ? -1 : (room.totals[0] > room.totals[1] ? 0 : 1))
      : (room.wins[0] > room.wins[1] ? 0 : 1);
    room.players.forEach((p) => send(p, { type: "match_result", winnerSlot: w,
      wins: room.wins.slice(), totals: room.totals.slice(), reason: w === -1 ? "draw" : "score" }));
  } else setTimeout(() => startRange(room), 800);
}

const server = http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "content-type": "application/json" };
  if (req.url === "/duel/new" && req.method === "POST") {
    const code = SHARED.makeRoomCode(); makeRoom(code);
    res.writeHead(200, cors); res.end(JSON.stringify({ code })); return;
  }
  if (req.url === "/board") { res.writeHead(200, cors); res.end(JSON.stringify({ board: [] })); return; }
  // static game
  if (req.url.startsWith("/game")) {
    let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    html = html.replace(/src="https:\/\/cdnjs\.cloudflare\.com[^"]*three\.min\.js"/, 'src="/three.min.js"');
    res.writeHead(200, { "content-type": "text/html" }); res.end(html); return;
  }
  if (req.url === "/three.min.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(fs.readFileSync(path.join(__dirname, "..", "node_modules", "three", "build", "three.min.js"))); return;
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const m = req.url.match(/^\/duel\/([A-Z2-9]{4})$/);
  if (!m || !rooms[m[1]]) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = rooms[m[1]];
    ws.on("message", (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
      if (msg.type === "join") {
        if (room.players.length >= 2) { ws.send(JSON.stringify({ type: "error", code: "room_full" })); return; }
        const slot = room.players.length;
        const p = { ws, name: msg.name, token: "tok" + slot, ready: false, fired: false, score: 0 };
        room.players.push(p);
        send(p, { type: "joined", code: room.code, token: p.token, slot,
          phase: room.phase, you: { name: p.name, ready: false }, opponent: room.players[1 - slot]
            ? { slot: 1 - slot, name: room.players[1 - slot].name, ready: room.players[1 - slot].ready, connected: true, wins: 0 } : null });
        const op = room.players[1 - slot];
        if (op) send(op, { type: "opponent_status", opponent: { slot, name: p.name, ready: false, connected: true, wins: 0 } });
      } else if (msg.type === "ready") {
        const p = room.players.find((x) => x.ws === ws); if (!p) return;
        p.ready = true;
        const op = room.players.find((x) => x.ws !== ws);
        if (op) send(op, { type: "opponent_status", opponent: { name: p.name, ready: true, connected: true, wins: 0 } });
        if (room.players.length === 2 && room.players.every((x) => x.ready) && room.phase === "lobby") {
          room.phase = "live"; startRange(room);
        }
      } else if (msg.type === "shot") {
        const p = room.players.find((x) => x.ws === ws); if (!p || p.fired) return;
        p.fired = true;
        const level = room.range;
        const r = SOLVER.solve(room.seeds[level - 1], room.maps[level - 1], level,
          msg.pos, msg.aim, msg.ph, msg.stats);
        p.score = r.ok ? r.score : 0; console.log("shot", p.name, "range", room.range, r.ok ? ("ok score=" + r.score + " ending=" + r.ending + " kills=" + r.kills) : ("REJECTED " + r.code));
        send(p, { type: "verdict", range: room.range, score: p.score, ending: r.ending,
          kills: r.kills, cleared: !!r.cleared, events: [], bounces: r.bounces,
          rejected: r.ok ? undefined : r.code });
        const op = room.players.find((x) => x.ws !== ws);
        if (op) send(op, { type: "opponent_status", opponent: { name: p.name, ready: true, connected: true, wins: room.wins[room.players.indexOf(p)], fired: true } });
        if (room.players.every((x) => x.fired)) setTimeout(() => endRound(room), 300);
      }
    });
  });
});

// ---------------------------------------------------------------- e2e
(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });

  async function mkPage(name) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page._errs = [];
    page.on("pageerror", (e) => page._errs.push(name + ": " + e.message));
    await page.goto(base + "/game?server=" + encodeURIComponent(base), { waitUntil: "load" });
    await page.waitForTimeout(1800);
    await page.click("#bDuel");
    await page.fill("#dName", name);
    return page;
  }
  const A = await mkPage("ACE");
  const B = await mkPage("NOVA");

  await A.click("#bDuelNew");
  await A.waitForSelector("#dRoom", { state: "visible", timeout: 8000 });
  const code = await A.textContent("#dRoomCode");
  console.log("room:", code);

  await B.fill("#dCode", code);
  await B.click("#bDuelJoin");
  await B.waitForSelector("#dRoom", { state: "visible", timeout: 8000 });
  await A.screenshot({ path: path.join(__dirname, "duel-room.png") });

  await A.click("#bDuelReady");
  await B.click("#bDuelReady");

  // wait for the duel HUD (level_start applied, level built from seed)
  await A.waitForSelector("#duelHud.on", { timeout: 10000 });
  await B.waitForSelector("#duelHud.on", { timeout: 10000 });
  await A.waitForTimeout(900);   // countdown
  await A.screenshot({ path: path.join(__dirname, "duel-range1.png") });
  await B.screenshot({ path: path.join(__dirname, "duel-range1-b.png") });
  // determinism through the full UI: both clients built the level from the
  // same seed — their minimap canvases must be pixel-identical
  const mapA = await A.evaluate(() => document.getElementById("miniMap").toDataURL());
  const mapB = await B.evaluate(() => document.getElementById("miniMap").toDataURL());
  console.log("minimaps pixel-identical:", mapA === mapB);
  if (mapA !== mapB) {
    const diff = await A.evaluate(async (bUrl) => {
      const img = new Image(); img.src = bUrl; await img.decode();
      const c = document.getElementById("miniMap");
      const off = document.createElement("canvas"); off.width = c.width; off.height = c.height;
      const g = off.getContext("2d"); g.drawImage(img, 0, 0);
      const a = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const b = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0, xs = [], ys = [];
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i]-b[i]) > 8 || Math.abs(a[i+1]-b[i+1]) > 8 || Math.abs(a[i+2]-b[i+2]) > 8) {
          n++; const px = (i/4) % c.width, py = Math.floor((i/4) / c.width);
          if (xs.length < 8) { xs.push(px); ys.push(py); }
        }
      }
      return { differing: n, total: a.length/4, sampleX: xs, sampleY: ys };
    }, mapB);
    console.log("minimap diff:", JSON.stringify(diff));
  }

  // both fire through all 5 ranges (or until match ends)
  for (let round = 1; round <= 5; round++) {
    for (const P of [A, B]) {
      await P.mouse.move(640, 360); await P.mouse.down();
      await P.mouse.move(600 + Math.floor(Math.random() * 90), 330 + Math.floor(Math.random() * 60), { steps: 3 });
      await P.keyboard.press("Space");
      await P.mouse.up();
    }
    const done = await A.waitForFunction(
      () => document.querySelector("#dResult").style.display !== "none" ||
            document.querySelector("#duelHud.on"), { timeout: 15000 }).catch(() => null);
    await A.waitForTimeout(2500); // verdict + round_result + intermission
    const over = await A.evaluate(() => document.querySelector("#dResult").style.display !== "none");
    if (over) break;
  }
  await A.waitForSelector("#dResult", { state: "visible", timeout: 20000 });
  await B.waitForSelector("#dResult", { state: "visible", timeout: 20000 });
  const lineA = await A.textContent("#dResultLine");
  const subA = await A.textContent("#dResultSub");
  const lineB = await B.textContent("#dResultLine");
  await A.screenshot({ path: path.join(__dirname, "duel-result.png") });
  console.log(JSON.stringify({ code, A: lineA.trim() + " | " + subA.trim(), B: lineB.trim(),
    errors: A._errs.concat(B._errs) }, null, 2));
  await browser.close(); server.close();
  process.exit(A._errs.length + B._errs.length ? 1 : 0);
})().catch((e) => { console.error("E2E FATAL", e); process.exit(2); });
