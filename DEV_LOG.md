# Dev Log — Purchases & Expenses UI/UX Revamp

Repo: tvp-webapp-v1-repo
Scope: Purchases (js/procurement-inventory.js) + Expenses (js/daily-operations.js) + shared helpers (js/ui.js) + css/styles.css

## Task checklist — all complete
1. [x] Active-row visual tint (.has-value on purchase-line / franchise row / expense-item-row, toggled on qty/amount)
2. [x] Mobile accordion for purchase item rows (collapsed summary line, tap to expand — desktop grid untouched)
3. [x] Padlock icon (open/closed SVG) replacing "Modify Rate"/"Lock Rate" text, both screens
4. [x] Field order aligned: Expenses now goes metadata (supplier/payment/date/document) → item work zone, matching Purchases
7. [x] Rate/GST override warnings routed through .badge.badge-warning (also added to Expenses, which tracked overrides but never rendered them)
8. [x] Hero-number treatment for purchase/expense totals (tabular-nums, large size, dashboard-style)
9. [x] Native <datalist> replaced with custom combobox (js/ui.js: createItemCombobox) — substring highlight, "Last ₹X" subtitle, keyboard nav, click-outside close
10. [x] Document type + note collapsed behind <details class="more-options">, both screens
11. [x] Tab split: New entry / History (js/ui.js: wireScreenTabs), both screens

## Files touched
- css/styles.css — active-row tint, lock-toggle icon button, badge-warning wiring, hero-number, combobox menu, more-options disclosure, screen-tabs, mobile accordion
- js/ui.js — new exports: createItemCombobox(), wireScreenTabs()
- js/procurement-inventory.js — accordion row markup, padlock icons, combobox wiring, tab panels, field reorder (unchanged, already metadata-first), more-options wrap
- js/daily-operations.js — padlock icons, combobox wiring, tab panels, metadata-first reorder, more-options wrap, badge-warning spans added to expense rows

## Notes / things to sanity check in-app
- node --check passed clean on all three JS files; brace/paren counts balanced.
- Combobox is a lightweight custom component (not a full ARIA combobox pattern) — good enough for this use case but worth a screen-reader pass later if that matters to you.
- Accordion behavior only kicks in at max-width: 740px; desktop grid layout is untouched.
- "More options" default state is collapsed — if bill/document type is filled from OCR import, consider auto-expanding it (not wired yet).
