# Mod Host (fork hooks)

Mod Launcher system © 2026 Aidiotic — [LICENSE-MOD-LAUNCHER](LICENSE-MOD-LAUNCHER)

See the companion repo **docs/MOD_AUTHOR.md** for how to write mods without reading game source.

`mod-host.js` exposes `window.OneRoundModHost` after the game calls `.bind(...)`.

Load the game with `?modHost=1` (launcher does this). Built-in Tracer Map / FRAME keep running by default. Only if the launcher turns on **replace built-in presentation** does `OneRoundModHost.replaceBuiltins` skip stock `updatePreview` so a mod can own those overlays.

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
