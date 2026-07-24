# Mod Host (fork hooks)

Mod Launcher system © 2026 Aidiotic — [LICENSE-MOD-LAUNCHER](LICENSE-MOD-LAUNCHER)

See the companion repo **docs/MOD_AUTHOR.md** for how to write mods without reading game source.

`mod-host.js` exposes `window.OneRoundModHost` after the game calls `.bind(...)`.

Load the game with `?modHost=1` (launcher does this). The host script is **only fetched when that flag (or `?mods=1`) is present**, so normal play stays a single self-contained `index.html`. Built-in Tracer Map / FRAME keep running by default. Only if the launcher turns on **replace built-in presentation** does `OneRoundModHost.replaceBuiltins` skip stock `updatePreview` so a mod can own those overlays.

## postMessage origins

Config messages (`oneround-modhost-config`) are accepted only from an allowlisted origin, and replies use that concrete `targetOrigin` (never `*`). Allowed by default:

- the game’s own `location.origin` (same-origin launcher via `scripts/dev.sh`)

Add more with `?modHostOrigin=https://example.com` (repeatable or comma-separated) when the launcher and game are on different origins.

## Safe surface

- Snapshots: phase, level, stats (booleans/numbers), pose, enemies, aim ray, blocks, room
- `previewPath()` — compute-only wrapper around `solvePath`
- `framePerfect()` — assist probe (host-side; does not trust mod path data)
- Presentation: overlay, plan-view panel, badges

## Not exposed

Score, fire, upgrade apply, RNG, raw Three.js / enemy objects.

## Online stub

`OneRoundModHost.mode = "offline" | "online"`. Online uses the same visual/assist capability set and fail-closes anything else. No authority syscalls exist in v1.

See the companion repo `one-round-mod-launcher` for the Python → ORML toolchain and launcher UI.
