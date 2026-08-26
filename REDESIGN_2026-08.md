# 2026 Control Center SaaS Redesign

Implemented the attached Apple-style SaaS redesign brief.

## Main changes
- Rebuilt semantic design-token layer and 8px spacing system while preserving existing JS hooks.
- Neutral Apple-like surfaces, restrained blue accent, softer borders/shadows and calmer hierarchy.
- Sidebar consolidated into Overview / Operations / Money / Insights / Admin with collapsible groups, Show more, menu search and Cmd/Ctrl+K focus.
- Replaced nav Unicode glyphs with inline accessible SVG icons.
- Mobile bottom navigation now has a functional More workspace exposing all other destinations.
- Consolidated report navigation into a Reports workspace with segmented tabs while retaining existing report routes.
- Dashboard now has one hero metric and a single primary New action.
- Typography raised to a readable 12px minimum and 15px base, with smaller labels removed from the visual hierarchy.
- Buttons, fields, cards, badges and tables use the new primitive system.
- Status stamps are visually mapped to accessible pill badges without the rotated stamp treatment.
- Locked inputs have a distinct read-only/sunken treatment.
- Item-first Purchase/Expense rows collapse to card-per-line-item on mobile.
- Large OCR modals are styled as right-side full-height panels.
- Added a shared toast/snackbar system and Promise-based confirmation/prompt dialogs.
- Removed native alert/confirm/prompt usage from live JS modules.
- Rate/GST override confirmations now use explicit action labels instead of OK/Cancel semantics.
- Login has a loading state to prevent double-submit.
- Service worker cache bumped to v21 and includes the new shared UI module.

## Validation
- `npm run check` passes.
- All JavaScript files pass `node --check`.
- Local dev server returns HTTP 200 for `/`.

## Round 2 — 2026-08-26 — Apple-style redesign completion pass

This pass replaces the previous override-based redesign rather than adding another token/override layer.

### Verified changes

- Consolidated the stylesheet into one `:root` token block using semantic Apple-style color, typography, spacing, radius, shadow and motion tokens.
- Removed the legacy `--ink`, `--paper`, `--turmeric`, `--steel`, chutney token aliases and the entire `--px-*` token block.
- Rewrote screen-level rules for expense item-first entry, purchase franchise rows, documents, OCR review, relationship pickers, Link To controls, master data, and rate/GST controls using the semantic system.
- Raised stylesheet typography to the 12px minimum: all `font-size` declarations now resolve through `--text-*` tokens (or inherit from a 15px+ parent).
- Removed hardcoded hex colors outside the token block and removed stale `var(--token, #fallback)` forms.
- Removed all `!important` from `css/styles.css`.
- Reworked rate/GST controls so Modify actions stay inside the control rather than floating outside field boxes.
- Fixed desktop navigation search so matching secondary items automatically reveal their group; manual expansion state is preserved when search is cleared.
- Added mobile More-screen search and a mobile topbar search affordance. `Ctrl+K` / `Cmd+K` now routes mobile users to More search and focuses it.
- Added Escape handling, focus trapping, and focus restoration to shared confirm/prompt dialogs.
- Added reusable `attachDropdown()` behavior for Quick Actions with `aria-haspopup`, `aria-expanded`, outside-click dismissal and Escape/focus restoration.
- Made `ui.js` an explicit dependency for the transaction/document/relationship/budget/automation/financial modules that consume its primitives. Removed the corresponding `window.__toast`, `window.__confirmDialog`, `window.__promptDialog`, `window.__friendlyError`, and `window.__setButtonLoading` globals from `ui.js`.
- Removed static inline screen styles from generated app markup and moved those rules into CSS classes.
- Changed Backup feedback to toast + button loading states and changed the Dashboard data-load error path to friendly user-facing feedback.
- Kept the OCR progress width as a runtime value because it is genuinely dynamic; the static screen markup no longer contains an inline style.

### Verification performed

- `npm run check` — passed; 24 JavaScript files checked, plus `index.html` and `manifest.json`.
- `node tools/check-design.mjs` — passed.
- Design verification confirms:
  - exactly one `:root` block;
  - zero legacy token references;
  - zero `--px-*` references;
  - zero hardcoded hex colors outside the token block;
  - zero `!important` declarations;
  - no raw font-size declarations below the 12px semantic minimum;
  - no raw px values in padding/margin/gap declarations;
  - no static inline `style="..."` attributes in app screens;
  - explicit `ui.js` imports in the specified consumers;
  - dialog/dropdown/nav-search implementation checks pass.

No claim is made here about live Supabase data behavior or device-by-device visual QA; those require a connected runtime and real-device inspection.
