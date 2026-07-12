# UI consistency report — SDC Job Fair Prototype

_Living document — update this alongside `handoff.md` whenever a new screen lands, rather than writing a new one each time. Baseline: `old/jobfair-uiux-spec.html` (design tokens, typography, motion timing) + `new_architecture_uiux_spec.html` (companion — same tokens, new screens only). **Note:** `CLAUDE.md` currently describes `jobfair-uiux-spec.html` as if it lives at the repo root; it actually lives at `old/jobfair-uiux-spec.html` — a small doc-drift worth fixing next time that file is touched, not chased down further here._

## Headline finding: the app has two consistency profiles, not one

**Design tokens (color/type) are essentially perfect — zero drift found.** Every `.jsx` file in `react-app/src` was greped for hardcoded hex colors: **one hit** total, across the entire app (`GateCheckIn.jsx`'s `#000` video background — a camera-preview placeholder, not a themed UI decision, functionally a non-issue). Every screen, across every build pass from the original candidate flow through today's Gate check-in screen, draws colors and fonts exclusively from `index.css`'s `--ink`/`--candidate`/`--system`/`--live`/`--mono`/`--sans`/`--disp` tokens, which themselves match `old/jobfair-uiux-spec.html`'s definitions exactly. This held up across five separate build sessions with no coordination mechanism other than "reuse what's already there" — genuinely strong.

**Motion is the real gap.** The spec calls for Framer Motion throughout (`old/jobfair-uiux-spec.html`: 350ms outQuad cell flips, 700ms outExpo count-ups; `CLAUDE.md`: "Framer Motion everywhere, spec timings kept"), and the app-wide `LazyMotion`/`MotionConfig` wrapper in `main.jsx` is already loaded for the *entire* app, staff chunk included — so nothing is blocking any screen from using it. In practice:

| Uses `framer-motion` | Doesn't |
|---|---|
| `QRLanding.jsx`, `LivePosition.jsx`, `IncomingCard.jsx`, `DeskTablet.jsx` | `CompanyTiles.jsx`, `DetailsForm.jsx`, `RungBadge.jsx`, `CountdownRing.jsx` (uses a plain CSS `transition` instead — reasonable for a continuously-updating ring, not really a gap), `Login.jsx`, `StaffApp.jsx`, `UserAdmin.jsx`, `CompanyManagement.jsx`, `Reports.jsx`, `FloorMonitor.jsx`, `GateCheckIn.jsx` |

The clean split: **every screen built in the four-tab admin rebuild + Gate check-in (this session's work) has zero motion** — no toast enter/exit (spec: 250ms AnimatePresence), no stat count-up (spec: 700ms outExpo, and `FloorMonitor.jsx` literally has stat tiles that would want this), no row-expand transitions. This wasn't accidental — each of those screens' own build notes said so explicitly at the time ("no count-up animation this pass, consistent with how Staff/Companies/Reports skipped v1's animation polish in favor of shipping data first"). Worth being honest about now that there's a full picture: it's five repeated instances of the same scope cut, not five independent decisions.

## Component reuse — strong, with one real duplication debt

- **Table/form/toast primitives are reused correctly everywhere they apply.** `.data-table`/`.table-wrap`, `.field`, `.btn`/`.btn.ghost`, `.toast`/`.toast.err`, `.s-body`, `h2.screen-title`, `.sec-label` appear consistently across `UserAdmin`, `CompanyManagement`, `Reports`, `FloorMonitor`, `GateCheckIn` — none of them invented a competing pattern for something that already existed. `Reports`/`FloorMonitor`/`GateCheckIn` in particular shipped with **zero new CSS classes** for their table/form parts.
- **The toast pattern (`showToast(text, isErr)` + 2.5s `setTimeout`) is copy-pasted identically into four separate files** (`UserAdmin.jsx`, `CompanyManagement.jsx`, `DeskTablet.jsx`, `GateCheckIn.jsx`) rather than extracted into a shared hook (e.g. `useToast()`). Behaviorally consistent (every screen holds a toast for exactly 2.5s, matching the spec's timing even though the entrance/exit animation itself is missing — see above), but it's ~15 lines duplicated 4 times. Low urgency, but the next screen that needs a toast is the natural trigger to finally extract it.
- **Small-button padding has drifted into five slightly different values with no defined scale**: `.btn.ghost` inline-style overrides use `8px 12px` (`UserAdmin`, most of `CompanyManagement`), `8px 14px` (`GateCheckIn`'s batch controls), `6px 12px` (`StaffApp`'s logout button), `6px 10px` (`CompanyManagement`'s nested post-row actions), and `11px 18px` (`CompanyManagement`'s add-parameter/add-posting submit buttons) — all eyeballed per-screen rather than drawn from a shared size scale. 18 occurrences of this exact `width:'auto', padding:'…'` inline pattern exist across 5 files. Not visually jarring (the differences are a couple of pixels), but it's the kind of thing that compounds — worth promoting to `.btn.sm`/`.btn.xs` classes next time one of these screens is touched, rather than eyeballing a sixth value.

## Terminology — consistent

Screen titles follow one implicit rule without it ever being written down: single word for a tab's own name (`Staff`, `Floor`, `Reports`, `Companies`), sentence case for a sub-screen (`Gate check-in`, `Desk tablet`, `Staff login`). No competing capitalization scheme found (no `Staff Login`, no `DESK TABLET`, etc.).

## Recommendations, roughly in order of value for the effort

1. **Cheapest, highest-value: bring motion to `FloorMonitor.jsx`'s stat tiles.** It's the one screen in the no-motion group where the spec's absence is most visible (five numbers that are supposed to count up and don't), the runtime is already loaded app-wide, and `IncomingCard.jsx` already has a working `m.div` pattern two files away to copy from.
2. **Extract `showToast` into a shared hook** the next time a sixth screen needs one — don't do it as a standalone refactor, just stop duplicating it going forward.
3. **Define two button-size utility classes** (`.btn.sm`, `.btn.xs` or similar) and migrate the five ad-hoc padding values to them incrementally, screen by screen, rather than in one sweep. **Spec side done (2026-07-12):** `new_architecture_uiux_spec.html` §09 now defines `.btn.sm` (`8px 12px`) / `.btn.xs` (`6px 10px`) with a visual demo, plus a swatch for the `--rung-far/warm/hot` tokens that shipped with §02's ping-ladder diagram but were never given one. **Code side still open** — none of the five existing ad-hoc values in `UserAdmin.jsx`/`CompanyManagement.jsx`/`GateCheckIn.jsx`/`StaffApp.jsx` have been migrated to the new classes yet; do that incrementally as flagged above, not in one sweep.
4. **Toast entrance/exit animation (250ms AnimatePresence)** across the admin screens is the lowest-priority motion gap — it's real, but the toasts already work and hold for the spec-correct duration; only the transition polish is missing.

## Per-screen scorecard (update this table as new screens land)

| Screen | Tokens only | Motion | Reuses shared primitives | New CSS added |
|---|---|---|---|---|
| `QRLanding.jsx` | ✅ | ✅ | — | none |
| `CompanyTiles.jsx` | ✅ | — | `.tile` | none |
| `DetailsForm.jsx` | ✅ | — | `.field` | none |
| `LivePosition.jsx` | ✅ | ✅ | — | `.ladder`/`.pos-card` (spec-defined) |
| `DeskTablet.jsx` / `IncomingCard.jsx` / `CountdownRing.jsx` | ✅ | ✅ (Countdown via CSS transition) | `.tablet-grid`, `.seg`, `.stars` | `.incoming-card`, `.ring*` (spec-defined) |
| `Login.jsx` | ✅ | — | `.field`, `.btn` | none |
| `UserAdmin.jsx` | ✅ | — | `.data-table`, `.field`, `.btn`, `.toast` | none |
| `CompanyManagement.jsx` | ✅ | — | `.data-table`, `.field`, `.btn`, `.toast` | none |
| `Reports.jsx` | ✅ | — | `.data-table`, `.btn` | none |
| `FloorMonitor.jsx` | ✅ | — | `.data-table`, `.stats-row`/`.stat` (pre-existing, unused until now) | `.buf-*`, `.now-*`, `.alert-*` |
| `GateCheckIn.jsx` | ✅ (1 non-token hex, harmless) | — | `.field`, `.search-bar`, `.scan-btn`, `.ci-row` (all pre-existing, unused until now) | none |
| `Insights.jsx` | ✅ | — | `.data-table`, `.field`, `.stats-row`/`.stat` (status-colored via `--st-*` tokens) | none — one inline `gridTemplateColumns` override on a second stats row (same ad-hoc-inline-override pattern flagged in Recommendation 3, worth folding into a `.stats-row.cols-4` variant alongside the button-scale cleanup rather than a new one-off) |

**Overall theme health: strong and holding.** Five independent build passes, zero coordinating document beyond "look at what's already there," and the design tokens never drifted once. The gap that exists (motion on the admin side) is well-understood, was called out honestly at build time rather than hidden, and is cheap to close incrementally — not a sign the system is breaking down.
