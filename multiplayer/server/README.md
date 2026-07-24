# ONE ROUND backend — Cloudflare Worker + KV + Durable Objects

Single Worker serving the shared leaderboard (`/board`, `/score`) and 1v1
duel rooms (`/duel/:code`, WebSocket → `DuelRoom` Durable Object with
hibernation). Zero npm dependencies — Workers runtime APIs only.

Files:

- `worker.js` — entry: routing, CORS, KV leaderboard, per-IP rate limit
- `duel.js` — `DuelRoom` DO (WebSocket Hibernation API, storage alarms)
- `solver.js` — deterministic solver + seeded levelgen (shared with tests;
  parity-tested against index.html in `tests/netcode.test.js`)
- `shared.js` — room codes, board merge, message validation, CORS allowlist
- `wrangler.toml` — bindings (`LEADERBOARD` KV, `DUEL_ROOM` DO) + migration

## Deploy

Requires a Cloudflare account and `wrangler` (no install needed with npx).
**The Workers Free plan is enough** — KV is on the free tier, and the `v1`
migration below creates a *SQLite-backed* Durable Object
(`new_sqlite_classes`), which Cloudflare made available on the free plan in
April 2025. (Free-plan DO storage caps: 5 GB per account, 1 GB per object —
a duel room holds a few KB and is wiped after 15 idle minutes.)

```sh
cd multiplayer/server
npx wrangler login

# 1. create the KV namespace and paste its id into wrangler.toml
npx wrangler kv namespace create LEADERBOARD
#    -> [[kv_namespaces]] binding = "LEADERBOARD" id = "<paste here>"
#    (optionally also: npx wrangler kv namespace create LEADERBOARD --preview)

# 2. deploy (first deploy runs the v1 DO migration automatically)
npx wrangler deploy

# 3. local dev (leaderboard + duels on http://localhost:8787)
npx wrangler dev
```

Then point the client at the deployed URL by setting `DEFAULT_SERVER` near
the top of `index.html` (search for `var DEFAULT_SERVER`), e.g.

```js
var DEFAULT_SERVER = "https://one-round-net.<your-subdomain>.workers.dev";
```

Every visitor then gets the live board and duel lobby with no setup. Leave
it `""` to ship fully offline. `?server=<url>` still overrides it for
testing against a local `wrangler dev` (the value is remembered).

Smoke test:

```sh
curl -s -H "Origin: http://localhost:8080" https://<worker>/board
curl -s -X POST -H "Origin: http://localhost:8080" -H "Content-Type: application/json" \
     -d '{"n":"SMOKE","s":123,"l":1,"k":1,"b":0,"w":"ranger"}' https://<worker>/score
```

## Configuration knobs

- CORS allowlist: `shared.js` (`PROD_ORIGIN` = `https://dizzysky1.github.io`,
  plus localhost/127.0.0.1 on any port). Change `PROD_ORIGIN` if the game
  moves.
- Duel pacing: constants at the top of `duel.js` (shot clock 75 s, best of 5,
  first to 3, 60 s reconnect grace, 15 min idle wipe).
- Board caps and rate limits: `shared.js` / `worker.js`.

## Security notes

- **No secrets exist in this codebase** — no API keys, no tokens, nothing to
  leak. Player identity is a per-room random token minted at join time and
  stored only in DO storage. Keep it that way: any future admin feature
  should use `wrangler secret put`, never a committed value.
- This folder is self-contained (the game client never imports from it), so
  it can be **moved to a private repo before deploying** if you prefer the
  server logic — particularly the anticheat validation thresholds — not be
  public. Copy the folder, keep `tests/netcode.test.js` running against it
  in CI, and deploy from there. Nothing else in the game repo references
  these files at runtime.
- The per-IP `/score` limiter uses KV and is eventually consistent — it is a
  soft cap against casual spam, not a hard guarantee. The board write itself
  is read-merge-write on one KV key (last-write-wins under a race). If the
  board ever gets busy, the upgrade is a one-instance Durable Object that
  serializes merges — `mergeBoard` in `shared.js` is already pure, so it
  drops straight in.
- The duel verdict is server-authoritative: scores are computed by
  re-running `solver.js` on the seed + shot, never read from the client
  (see `multiplayer/PROTOCOL.md` §5 for the full anticheat model).
