# Online leaderboard (Firebase)

Online Leaderboard system © 2026 Aidiotic — [LICENSE-ONLINE-LEADERBOARD](LICENSE-ONLINE-LEADERBOARD)

Project: `online---leaderboard--oneround`

Uses **Firebase Realtime Database** (already provisioned in `europe-west1`). Firestore was not enabled on the project yet; Identity Platform / Anonymous Auth needs billing, so v1 uses validated public writes.

## Data

Path: `/leaderboard/{callsignKey}`

| Field | Meaning |
|-------|---------|
| `n` | Callsign (1–12 chars) |
| `s` | Best run score (writes may only increase) |
| `l` | Deepest ranges cleared |
| `k` | Most targets |
| `b` | Biggest bank |
| `w` | Weapon id |
| `t` | Unix ms |

## Files

- `LICENSE-ONLINE-LEADERBOARD` — terms for this system
- `firebase-config.js` — public web config
- `leaderboard-firebase.js` — load/submit helpers
- `database.rules.json` — security rules (deployed)
- `firebase.json` / `.firebaserc` — Firebase project wiring
- `index.html` — callsign gate, start roster strip, game-over post/rank UI, leaderboard polish (online pill, refresh, relative time, your standing)

## Player experience

1. **Start** opens a callsign gate (welcome-back if already saved). Callsign is stored in the browser.
2. Start screen shows **Playing as …** and an **Online / Local board** pill.
3. On game over the run posts to Firebase; the panel shows rank, personal-best, and top-3.
4. Leaderboard shows relative times, a refresh control, and a **Your standing** card even outside the top 15.

## Deploy rules

```bash
npx -y firebase-tools@latest deploy --only database --project online---leaderboard--oneround
```

## Play

Serve the game folder (or mod launcher `./scripts/dev.sh`), set a callsign, finish a run — score posts to Firebase. Open **Leaderboard** to see the shared board.

Local `localStorage` is still used as a fallback if Firebase is unreachable.
