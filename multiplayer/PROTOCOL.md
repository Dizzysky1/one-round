# ONE ROUND — Duel & Leaderboard Protocol (v1)

Backend: one Cloudflare Worker (`multiplayer/server/worker.js`).

| Endpoint | Method | Purpose |
|---|---|---|
| `/board` | GET | Shared leaderboard, top 30 (KV) |
| `/score` | POST | Submit a score entry (KV, per-IP rate limited) |
| `/duel/new` | POST | Mint a 4-char room code |
| `/duel/:code` | GET + `Upgrade: websocket` | Join a duel room (Durable Object) |

CORS / Origin is locked to `https://dizzysky1.github.io` plus
`http://localhost[:port]` / `http://127.0.0.1[:port]` for dev — for the JSON
endpoints **and** the WebSocket upgrade. No cookies, no accounts, no secrets;
identity inside a room is a per-player random token minted by the server.

---

## 1. Design invariant: the shot is the packet

`solvePath` is a pure function of `(level geometry, enemy positions, origin,
direction, stats)`, and the level is a pure function of `(seed, mapId, level,
stats)`. So the entire gameplay exchange per range is:

```
server → both clients:  level_start { seed, mapId, level, stats, deadline }
client → server:        shot { pos, aim, ph, stats }        (once, per range)
server → that client:   verdict { events, score, ... }      (server re-solve)
```

The server never trusts a score. It rebuilds the identical level from the
seed and re-runs the identical solver on `(pos, aim)`. A modified client can
aim with a robot's precision, but it cannot *score* anything the geometry
doesn't allow — the solver **is** the anticheat.

### Seed determinism plan

Both clients and the server must generate bit-identical levels from a seed.
That requires (all mirrored in `multiplayer/CLIENT_CHANGES.md`):

1. **PRNG** — mulberry32 (32-bit seed). Every `Math.random()` in
   gameplay-relevant levelgen (`buildLevel`, `goldenPoints`, `addEnemy`)
   becomes a draw from this stream, in the exact original call order.
   Cosmetic randomness (particles, audio, textures, upgrade offers) stays on
   `Math.random` and must NOT touch the seeded stream.
2. **Transcendentals** — `Math.sin/cos/hypot` are not bit-identical across JS
   engines. Gameplay code uses `dSin/dCos` (polynomial, exact float ops) and
   `hyp2(a,b) = sqrt(a*a+b*b)` instead. `Math.sqrt` and arithmetic are
   IEEE-exact everywhere and stay as-is.
3. **Map + level are explicit** — `level_start` carries `mapId` and `level`,
   so the client never runs `pickMap()` (unseeded) in a duel.
4. **Stats are canonical** — levelgen reads `stats` (pierce/pads/radius…), so
   both players must generate with the SAME stats. Duels therefore use a
   fixed loadout (below); weapon choice is cosmetic in duels v1.
5. **Enemy patrol phases ride along** — patrolling targets move as
   `base + sin(t)·span` where `t` advances with frame time. The shot message
   carries each enemy's `t` at the instant of fire (`ph` array); the server
   recomputes positions with `dSin(t)·span`. Because `sin` is bounded, a
   forged phase can only place a target somewhere its patrol legally reaches.
6. **Floats survive the wire** — positions/aims are sent as JSON numbers;
   JSON round-trips IEEE doubles exactly (shortest round-trip repr), verified
   in `tests/netcode.test.js`.

### Duel loadout (`duelStats(level)` in `server/solver.js`)

| Range | Level | Targets | Pierce | Bounces | Radius |
|---|---|---|---|---|---|
| 1 | 1 | 1 | 1 | 3 | 0.17 |
| 2 | 2 | 1 | 1 | 3 | 0.17 |
| 3 | 3 | 2 | 2 | 4 | 0.17 |
| 4 | 4 | 2 | 2 | 4 | 0.17 |
| 5 | 5 | 3 | 3 | 5 | 0.17 |

All other stats are the Ranger baseline (bankStep 0.5, crit 1, no frag/bloom/
guide, tracer on for both so the duel is a pure aiming contest). `pierce`
always equals the target count, so every range is clearable.

---

## 2. Room lifecycle

1. Host: `POST /duel/new` → `{ "code": "KX7Q" }` (alphabet `A-Z2-9` minus
   `O/I`, 32^4 rooms). Share the code out-of-band.
2. Both: open `wss://<worker>/duel/KX7Q`, then send `join`.
3. Server replies `joined` (includes your `slot` 0/1 and a private `token` —
   persist it; it is your reconnect credential for this room).
4. Both send `ready` → match starts.

A match is **best of 5 ranges** at levels 1–5, maps: range 1 is always
The Range, then a server-shuffled walk of the other four. Per range, the
higher verdict score **wins the range** (tie = drawn range, no point).
**First to 3 range wins** takes the match; after range 5 the most range wins,
tie-broken by total score, else a draw.

### Timing rules

| Rule | Value |
|---|---|
| Pre-range countdown (range 1) | 3 s (`startAt` in `level_start`) |
| Shot clock per range | 75 s from `startAt` (`deadline`, epoch ms) |
| Not fired by deadline | that range scores 0 (`timeout: true`) |
| Intermission between ranges | 6 s (next `level_start` sent immediately with a future `startAt`) |
| Reconnect grace on disconnect mid-match | 60 s, then forfeit |
| Idle room cleanup | 15 min with no sockets → storage wiped |

Both players receive the same `level_start` at the same moment; shots sent
before `startAt` are rejected (`too_early`).

---

## 3. Messages

All messages are JSON text frames, `{ "type": ... }`. Max frame 4 KiB.
Unknown/malformed messages get `error` and are otherwise ignored.
Per-socket rate limit: 30 messages / 10 s, then the socket is closed (1008).

### Client → server

| Type | Fields | Notes |
|---|---|---|
| `join` | `name` (1–16 chars `[A-Za-z0-9 _.-]`), `token?` | First message on every socket. With a known `token`: reconnect/resync (older sockets for that token are closed). Without: claims a free seat (`room_full` otherwise). |
| `ready` | — | Lobby only. Both ready ⇒ match starts. |
| `shot` | `range` (int), `pos` `[x,y,z]`, `aim` `[x,y,z]` unit, `ph?` `[t…]`, `stats?` | One per range. `pos` is `player.pos` at fire, `aim` is `aimDir()` verbatim, `ph[i]` is enemy i's patrol phase `e.t`. `stats` is an echo — must equal `duelStats(level)` or the shot is rejected (`stats_mismatch`). |
| `rematch` | — | After `match_result`. Both ⇒ fresh plan, new seeds. |
| `ping` | — | Keepalive; server answers `pong`. |

### Server → client

| Type | Fields | Notes |
|---|---|---|
| `joined` | `code, token, slot, phase, you, opponent, current?` | Full resync snapshot; also sent on reconnect. `current` (when mid-range) repeats the `level_start` payload plus `fired`. |
| `opponent_status` | `opponent {slot,name,ready,connected,wins,fired?}` | On join/ready/disconnect/reconnect and when the opponent fires (score withheld until `round_result`). |
| `level_start` | `range, level, seed, mapId, stats, startAt, deadline, bestOf, winsNeeded` | Build the level with `buildDuelLevel(seed,mapId,level,stats)`; enter aim phase at `startAt`. |
| `verdict` | `range, events, ending, score, kills, cleared, bestBank, clearBonus, gains, spareBounce, sparePierce, length, bounces` | Authoritative result of YOUR shot (server re-solve). The client should display this score, not its local one (they match unless someone tampered). |
| `round_result` | `range, scores [slot0,slot1], winnerSlot, wins, next {range,startAt}?` | Both shots resolved (or timed out). `next:null` means the match is over. |
| `match_result` | `winnerSlot, wins, totals, reason: "score"\|"forfeit"\|"draw"` | End of match. Room stays open for `rematch`. |
| `rematch` | `from` (slot) | Opponent asked for a rematch. |
| `error` | `code` | e.g. `room_full, not_joined, bad_json, wrong_range, already_fired, too_early, stats_mismatch, pos_oob, pos_y, pos_in_block, aim_not_unit, bad_phases, rate` |
| `pong` | `t` | Keepalive reply. |

---

## 4. Disconnect / reconnect (hibernation)

The Durable Object uses the WebSocket **Hibernation API**: sockets are
accepted with `state.acceptWebSocket()`, player identity is stored on the
socket with `serializeAttachment({token})`, and ALL match state lives in DO
storage — so the DO can be evicted between messages without dropping the
match. Deadlines (shot clock, grace, idle cleanup) are DO storage alarms.

- On disconnect mid-match the opponent gets `opponent_status {connected:false}`
  and a 60 s grace alarm starts. The shot clock keeps running regardless.
- The client reconnects to the same URL and sends `join` with its saved
  `token` → server replies with the full `joined` resync (including the
  current range's `level_start` data, so the level can be rebuilt from seed).
- Grace expiry → `match_result {reason:"forfeit"}` for the opponent.
- In the lobby a disconnect simply frees the seat.

---

## 5. Anticheat model

1. **Server re-solve** (primary): the verdict comes from the server running
   the same pure solver on the same seeded level. Client-reported scores are
   never read.
2. **Canonical stats**: `stats` echo must match `duelStats(level)` exactly
   (`statsMatch`), so no invented bounces/pierce/frag.
3. **Position sanity** (`validateShot`): `pos.y === 1.62` (eye height is
   pinned by `movePlayer`), `|x| ≤ w/2−0.42`, `|z| ≤ d/2−0.42` (the walk
   clamp), and not strictly inside any player-blocking block — states an
   honest client cannot reach are rejected.
4. **Aim sanity**: finite unit vector (|len−1| < 1e−6).
5. **Phase sanity**: `ph` length must equal the enemy count, finite; `sin`
   bounds the resulting offset to the legal patrol segment by construction.
6. **Rate limiting**: one shot per range (state machine), 30 msgs/10 s per
   socket, 10 `POST /score` per IP per minute (naive KV counter).

Out of scope v1 (accepted): aim assistance ("perfect aim") is undetectable
server-side in a puzzle-aim game; the shot clock is the only mitigation.

---

## 6. Leaderboard API

Board schema (identical to the client's local board):
`{ n: callsign, s: score, l: ranges, k: kills, b: bestBank, w: weaponId, t: timestamp }`

- `GET /board` → `{ board: [entry, …] }` (top 30, sorted by `s` desc,
  `Cache-Control: max-age=15`).
- `POST /score` with an entry body → `{ board: [...] }` after merge.
  Validation: name sanitized to 1–16 chars, integers capped
  (`s ≤ 5,000,000`), `w` whitelisted, `t` set server-side.
  Merge rule (same as the old local `boardSubmit`): **merge-by-name** — an
  existing name keeps the best of each numeric field (`s,l,k,b` max), `w`/`t`
  from the latest submission; then sort by `s` desc and truncate to 30.
- Rate limit: 10 submissions/IP/minute (KV counter, eventually-consistent —
  a soft cap by design).
- Writes are read-merge-write on a single KV key (`board:v1`); a concurrent
  race loses one merge (last-write-wins). Acceptable for a casual board; the
  upgrade path is a one-key Durable Object (see server/README.md).
