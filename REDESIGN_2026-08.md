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
- Service worker cache bumped to v20 and includes the new shared UI module.

## Validation
- `npm run check` passes.
- All JavaScript files pass `node --check`.
- Local dev server returns HTTP 200 for `/`.
