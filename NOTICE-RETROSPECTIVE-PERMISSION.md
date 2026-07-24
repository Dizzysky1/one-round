# Retrospective permission for licensed contribution changes

**Date:** 25 July 2026

**From:** Aidiotic (copyright holder)  
GitHub: https://github.com/Aidiotic

**To:** Dizzysky1 and the maintainers of ONE ROUND  
Repository: https://github.com/Dizzysky1/one-round

---

## 1. What happened

My contributions to ONE ROUND are covered by:

- `LICENSE-TRACER-MAP` — Tracer Map (earned tracer preview + plan-view minimap)
- `LICENSE-FRAME-INDICATOR` — Frame-Perfect Indicator (timing probe + FRAME panel)

Those licenses allow inclusion **as merged**, and require **my prior written permission** before anyone else modifies, rewrites, reimplements, or replaces the covered work.

After I validated PR #1, PR #2, and the 60Hz FRAME probe fix (`7fa700a`), commit `80360bf` (“Ship the standalone build…”) changed that covered code without asking first, including:

- Removing the Frame-Perfect Indicator from `index.html` (while leaving `LICENSE-FRAME-INDICATOR` in the tree)
- Rewriting Tracer Map preview / minimap paths still marked under `LICENSE-TRACER-MAP`

That was a **license violation**.

---

## 2. Assessment

Separately from the license issue: those product changes (standalone / inlined three.js, duels, Worker board, and related preview fixes) look like a **net good** for the game.

I am therefore **not** demanding a revert of `80360bf` on that basis.

---

## 3. Grant

I, Aidiotic, hereby grant **retrospective written permission** for the modifications to the Tracer Map and Frame-Perfect Indicator contributions as they appear on `main` through commit `80360bf` (and direct follow-ups that only wire online UI around that same shipped state, such as `7f0542e`).

This grant:

1. Covers those already-shipped changes only
2. Does **not** waive `LICENSE-TRACER-MAP` or `LICENSE-FRAME-INDICATOR` going forward
3. Does **not** authorize further modification, rewrite, reimplementation, or replacement of either contribution without asking me first

---

## 4. Request going forward

**Please ask next time** before you modify anything covered by `LICENSE-TRACER-MAP` or `LICENSE-FRAME-INDICATOR`.

Open an issue, ping me on a PR, or otherwise get my written OK first. I validated the 60Hz fix when asked in substance; I would rather approve good changes than discover them after the fact.

---

## 5. Contact

Reply on this pull request, or on https://github.com/Dizzysky1/one-round/issues/3.

---

**Aidiotic**  
Copyright (c) 2026 Aidiotic
