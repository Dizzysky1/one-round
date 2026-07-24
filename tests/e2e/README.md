# Headless browser checks (optional)

These need real Chromium and two extra dev deps:

```sh
cd tests
npm install playwright-core ws
CHROMIUM_PATH=/path/to/chromium node e2e/smoke.js      # boots the game, fires a round, screenshots
CHROMIUM_PATH=/path/to/chromium node e2e/duel-e2e.js   # two pages play a full duel vs a protocol mock
```

`smoke.js` fails on any page error. `duel-e2e.js` runs the whole duel flow —
room create/join, ready, seeded level build (asserts both clients' minimaps
are pixel-identical), shots, server re-solve verdicts via the REAL
`multiplayer/server/solver.js`, round results, match result on both screens.

three.js is served from `tests/node_modules/three` (installed by `npm install`),
so no network access is needed.
