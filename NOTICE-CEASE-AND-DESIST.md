# NOTICE AND DEMAND TO CEASE AND DESIST

**Date:** 24 July 2026

**From:** Aidiotic (copyright holder)  
GitHub: https://github.com/Aidiotic

**To:** Dizzysky1 and the maintainers of ONE ROUND  
Repository: https://github.com/Dizzysky1/one-round

---

## 1. Protected work

I am the author and copyright holder of the **Tracer Map contribution** to ONE ROUND. This is my **original design and implementation**, including:

- The concept of an **earned tracer-gated plan-view minimap** (not a stock always-on radar), unlocked via the **Tracer Sight** upgrade
- The **3D tracer preview** system (ricochet path, halo, bounce rings, kill orbs)
- The **plan-view Tracer map** UI and logic (`#miniBox`, `#miniMap`, `drawMiniMap`, `updatePreview`, `hideTracerPreview`, and related CSS/HTML/JS in `index.html`)

This contribution was submitted and merged via **Pull Request #1** (merge commit `01c99d0`, 24 July 2026). It is licensed under **`LICENSE-TRACER-MAP`**, which permits inclusion in ONE ROUND only as merged, unmodified, and with the license intact. No one may modify, rewrite, reimplement, or replace this contribution except me or a person with my prior written permission.

A copy of the license terms is in commit `33d9c55` and in my fork at `LICENSE-TRACER-MAP`.

---

## 2. Unauthorized use and copying

You merged my contribution and continue to **use my code and my original minimap/tracer design** in `main`. Evidence includes:

- PR #1 merged the Tracer Map system into your repository
- Commit `43e4f68` ("Delete LICENSE-TRACER-MAP") removed my license file from `main` while **keeping my code**
- Your own tooling references my renamed canvas id (`#miniMap`, formerly `#mmC`), confirming active use of my merged implementation
- Issue #3 (opened 24 July 2026) requested compliance; no remedy has been applied on `main`

By distributing and relying on my Tracer Map contribution **without** `LICENSE-TRACER-MAP`, you are using my work outside the terms I granted. You may **not** retain a tracer-gated plan-view minimap, continue copying my implementation, or ship a derivative of the same system without my license or written authorization.

---

## 3. Demand

Within **14 calendar days** of the date of this notice (on or before **7 August 2026**), you must do **one** of the following:

### Option A — Restore compliance (preferred)

1. Restore `LICENSE-TRACER-MAP` on the `main` branch
2. Distribute the Tracer Map contribution only under those license terms
3. Cease any unauthorized modification or replacement of the contribution

### Option B — Remove the contribution

1. Permanently remove the entire Tracer Map contribution from `main`, including:
   - Tracer Sight gating and earned minimap behavior
   - 3D tracer preview (path, halo, bounce rings, kill orbs)
   - Plan-view Tracer map UI and all related code, comments, and assets
2. Stop distributing any part of my Tracer Map contribution
3. Do not reimplement the same earned-tracer / plan-view minimap system without my written permission

Until you comply, **cease** distributing, modifying, and reimplementing my Tracer Map contribution.

---

## 4. No further merges until resolved

Do **not** merge any pull request or other code into `main` that incorporates, extends, modifies, or builds upon my Tracer Map contribution — including but not limited to **PR #2** — until you have **fully complied** with Section 3 (Option A or Option B).

If you merge any such code before this matter is resolved, that will be treated as **knowing, continued infringement**. By doing so, you understand and accept that I will pursue an immediate **DMCA takedown notice** against the repository and any hosted distribution of ONE ROUND (including GitHub Pages), without further warning.

---

## 5. Reservation of rights

All rights are reserved. Failure to comply may result in further action, including a **DMCA takedown notice** and other remedies available under applicable law.

---

## 6. Contact

Reply on:

- GitHub Issue: https://github.com/Dizzysky1/one-round/issues/3
- The pull request that adds this notice

---

## Disclaimer

This document is a formal demand notice sent by the copyright holder. It is **not legal advice**. If you believe you have rights to use this material, state your basis in writing on the issue or PR thread.

---

**Aidiotic**  
Copyright (c) 2026 Aidiotic
