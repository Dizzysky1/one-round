# ONE ROUND

**Issue · Fire · Recover.** A first-person ricochet puzzle for the browser.
One bullet per range: it pierces what it can, banks off what it must, and
when it stops moving you answer for every metre of the line you chose.

**Play:** https://dizzysky1.github.io/one-round/ — desktop mouse or touch
(auto-detected). No install, no build, one file.

## How it plays

- Each *range* issues exactly one round. It pierces up to N targets and
  ricochets off geometry until its rebound budget runs out.
- Clear the range, pick one upgrade, step up to the next. Score is also the
  currency for seven buyable weapons.
- Amber **kinetic pads** rebound the round for free. Dark **absorber
  panels** swallow it. Armoured targets pay more. Banked shots multiply.
- **Duel** (requires a deployed server, below): best-of-five 1v1 on
  identical seeded ranges — higher score takes the range, first to three.

## Why the code is shaped like this

The whole flight is solved **analytically at fire time** — exact ray/AABB,
ray/cylinder and ray/sphere intersections in `solvePath`, no marching, no
physics steps (~0.05 ms per solve). Playback is pure animation over the
solved polyline, and the tracer preview calls the identical solver, so what
you see is exactly what you get.

Levels are generated **backwards from a solution**: an imaginary shot is
fired through the empty room first and targets are hung on its path, so
every range is clearable by construction.

House rule: **all visual detail stays strictly inside the collision volumes
the solver uses.** Nothing on screen lies about where the round can go.

The solver being a pure function of `(seed, position, aim, stats)` is the
multiplayer anticheat design: the duel server re-runs the same solver on the
same seeded level and never trusts a client's score. See
[`multiplayer/PROTOCOL.md`](multiplayer/PROTOCOL.md).

- `index.html` — the entire game (three.js r128, ES5, procedural textures,
  hand-rolled post-processing, synth audio, no dependencies)
- `multiplayer/server/` — Cloudflare Worker + Durable Object duel server and
  shared-leaderboard API, plus a deterministic port of the solver/levelgen
- `tests/` — headless suite, no browser required

## Tests

```sh
cd tests
npm install        # jsdom + three r128 (for the parity test)
npm test
```

`netcode.test.js` extracts the real `solvePath` and level generator out of
`index.html`, runs them on three r128, and requires **bit-identical**
blocks, enemies, event streams and scores against the server port across
seeded levels — the regression gate for client/server lockstep.
`upgrades.test.js` covers the shop rules. `tests/e2e/` has optional
headless-Chromium checks (`smoke.js` boots and fires; `duel-e2e.js` plays a
full two-browser duel against a local mock of the wire protocol scored by
the real server solver) — they need `playwright-core`, `ws`, and a Chromium
binary (`CHROMIUM_PATH`).

## Multiplayer + shared leaderboard

Deploy the Worker (see [`multiplayer/server/README.md`](multiplayer/server/README.md)):

```sh
cd multiplayer/server
wrangler kv namespace create LEADERBOARD   # put the id in wrangler.toml
wrangler deploy
```

Then open the game once with `?server=https://<your-worker-url>` — the
address is remembered. The leaderboard becomes shared (top 30,
merge-by-callsign) and the Duel lobby goes live.

## License

MIT.
