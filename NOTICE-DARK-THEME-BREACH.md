# Notice: unauthorized dark-theme reskin of Tracer Map contribution

**Date:** 25 July 2026

**From:** Aidiotic (copyright holder)  
GitHub: https://github.com/Aidiotic

**To:** Dizzysky1 / Thyro and the maintainers of ONE ROUND  
Repository: https://github.com/Dizzysky1/one-round

---

## 1. Protected work

I am the author and copyright holder of the **Tracer Map contribution** to ONE ROUND, licensed under [`LICENSE-TRACER-MAP`](LICENSE-TRACER-MAP).

That license covers the earned tracer preview and the plan-view Tracer map UI/logic, **including related CSS/HTML/JS** for that system. It allows inclusion in ONE ROUND as merged. It does **not** allow anyone else to modify, rewrite, reimplement, or replace the contribution — including changes that alter its panel behavior or presentation — except:

1. me (Aidiotic), or  
2. a person acting with my **prior written permission**.

---

## 2. What you already had permission for

In PR #7 I granted **retrospective** written permission for modifications already shipped through commit `80360bf` (and direct follow-ups such as `7f0542e` that only wire online UI around that state).

That grant:

- covers those already-shipped changes only  
- does **not** waive `LICENSE-TRACER-MAP` going forward  
- does **not** authorize further modification without asking me first  

I asked you to **ask next time**. You did not.

---

## 3. The breach

Commit [`9a76c2c`](https://github.com/Dizzysky1/one-round/commit/9a76c2c93cf4a1482893466386dfdf72ef25f97b) (“Tactical dark: retheme the whole UI as an instrument panel”) landed on `main` on 25 July 2026 **without my prior written permission**.

That commit changed Tracer Map–covered presentation, including:

- the Tracer Map legend colors next to `#miniMap` (Path / Kill / Pad / Sink)  
- the touch background for `.mm` (the Tracer Map panel chrome)  
- global theme tokens and `.panel` styling that restyle the Tracer Map panel shell  

Leaving `drawMiniMap` byte-identical does **not** put this outside `LICENSE-TRACER-MAP`. The license covers related CSS/HTML and panel presentation, not only the canvas draw function. Your own commit message acknowledges the license and still ships a reskin of the map’s surrounding UI without asking.

**That is a breach of `LICENSE-TRACER-MAP`.**

---

## 4. Demand — cure, then permission

I am not demanding a full revert of the dark theme for the whole game.

I demand the following cure on `main`:

### Required cure

1. **Add a Light mode** (default or clearly selectable) that restores the Tracer Map contribution’s **original** light / print presentation in full — including the minimap panel chrome, legend colors, and related Tracer Map CSS/HTML appearance as it stood under the licensed contribution before `9a76c2c`.
2. Keep Dark mode as an optional theme only after that Light mode path exists.
3. Do not further modify Tracer Map–covered code or presentation without my prior written OK.

### What I will grant once cured

When Light mode is on `main` and restores the original Tracer Map presentation as described above, I will grant **written permission for the Dark mode–only reskin** of the Tracer Map contribution (the dark panel/legend/theme treatment introduced in `9a76c2c` and any equivalent dark-only styling), subject to:

- Light mode remaining available and faithful to the original Tracer Map look  
- `LICENSE-TRACER-MAP` remaining in force for all other modifications  
- asking me before further changes to the covered contribution  

Until the cure lands, the dark reskin of my contribution remains unauthorized.

---

## 5. Timeline

Please reply on the related issue or this pull request and land the Light mode cure within a reasonable period (**ordinarily 3 days** from this notice — on or before ** 28th of july 2026**).

---

## 6. Contact

Reply on:

- the GitHub issue opened with this notice  
- this pull request  

---

## Disclaimer

This document is a formal compliance notice from the copyright holder. 

---

**Aidiotic**  
Copyright (c) 2026 Aidiotic
