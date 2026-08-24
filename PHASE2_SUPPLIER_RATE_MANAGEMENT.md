# Phase 2 — Supplier Master + Rate Management

This is the second phase of the new feature roadmap, following Phase 1 Progressive Transaction History.

The objective is to complete the Supplier Master lifecycle and establish a proper distinction between an item's configured master rate and the actual last purchase rate.

## Scope

### Supplier Master

The supplier master must support:

- Create supplier
- Edit supplier
- Activate/deactivate supplier
- Supplier name
- Phone
- Email
- Contact person
- Address
- GSTIN
- Purchase history
- Payment history
- Outstanding balance/history

Historical supplier transactions must remain intact when a supplier is deactivated. Deactivation prevents new purchases against the supplier but does not prevent payment of an existing outstanding balance.

### Item Master / Rate Management

The item master must support:

- Edit item
- Activate/deactivate item
- Category
- Unit
- GST rate
- Reorder level
- Current master rate
- Rate history

The current master rate is the rate suggested by the purchase-entry workflow.

`last_purchase_rate` remains the actual most recently recorded purchase rate and continues to support stock valuation and historical operational reporting.

These are deliberately separate concepts.

## Purchase Rate Behavior

When a purchase item has a configured master rate:

- Display the master rate automatically.
- Keep the rate field locked by default.
- Show a compact `Modify Rate` control inside/adjacent to the rate field.
- Clicking `Modify Rate` unlocks the field for that purchase only.
- If the entered rate differs from the master rate, show a visible warning.
- Ask whether the new rate should apply only to the current purchase or update the master rate from now onward.
- Default to the safer option: current purchase only.
- Never silently overwrite the master rate from a purchase transaction.

Each purchase line records the master rate that existed at entry and whether the actual purchase rate was overridden.

## Financial Integrity

The phase must not change the existing double-entry ledger model.

Supplier balances continue to be derived from the ledger.

Item stock valuation continues to use `last_purchase_rate`.

Changing an item's master rate does not rewrite historical purchase rates or historical stock movements.

Master-data changes are performed through audited security-definer RPCs rather than direct browser writes.

## Permissions

Owner:

- Create/edit/deactivate suppliers
- Create/edit/deactivate items
- Change master rates
- View rate history
- View supplier history

Manager:

- Record purchases and supplier payments
- Use configured master rates and purchase-level overrides
- Cannot modify supplier/item masters

Staff:

- Existing staff permissions remain unchanged
- Cannot manage supplier/item masters

RLS remains the authoritative permission boundary.

## UX

### Supplier Master

The Suppliers master screen should show:

- Supplier
- Contact person
- Phone
- GSTIN
- Status
- Outstanding
- Actions

Selecting a supplier opens a detail view with:

- Profile
- Purchase history
- Payment history
- Outstanding summary

The supplier should never be hard-deleted if historical transactions exist.

### Item Master

The Items master screen should show:

- Item
- Category
- Unit
- Master rate
- Last purchase rate
- GST
- Reorder level
- Status
- Actions

Editing an item must not alter historical purchase lines.

Rate history should show:

- Previous rate
- New rate
- Effective timestamp
- User
- Reason

## Database Changes

The migration adds:

- Supplier contact fields
- `items.master_rate`
- `purchase_items.master_rate_at_entry`
- `purchase_items.rate_overridden`
- `item_rate_history`
- Supplier master RPCs
- Item master RPCs
- Rate audit history

Existing data is preserved. Existing `last_purchase_rate` values seed the initial master rate for items that already have a purchase rate.

## Acceptance Criteria

### Suppliers

- Owner can create a supplier with complete profile information.
- Owner can edit supplier details.
- Owner can activate/deactivate a supplier.
- Deactivated suppliers cannot be selected for new purchases.
- Deactivated suppliers with outstanding balances can still receive payments.
- Purchase history is visible.
- Payment history is visible.
- Outstanding balance is visible and matches the live ledger.
- Historical transactions remain unchanged after master edits.

### Items

- Owner can edit item master data.
- Owner can activate/deactivate an item.
- Owner can define a master rate.
- Master-rate changes create rate-history records and audit entries.
- Historical purchase rates do not change.
- Last purchase rate remains independent from master rate.

### Purchase Rate

- A configured master rate appears automatically in purchase entry.
- The rate is locked until `Modify Rate` is selected.
- A modified rate produces a warning.
- The user can use the modified rate for one purchase only.
- The user can choose to update the master rate for future purchases.
- The actual purchase line records the master rate at entry and whether it was overridden.

### General

- Existing purchase, supplier-dues, inventory, ledger, audit, and reporting behavior remains intact.
- No historical transaction is rewritten by master-data changes.
- `npm run check` passes.
- The application remains usable on desktop and mobile.

## Implementation Status

Phase 2 is implemented in the current source tree.

### Implemented

- Complete Owner-managed Supplier Master profile.
- Supplier activation/deactivation without deleting history.
- Supplier purchase/payment/outstanding history view.
- Supplier payments remain possible after deactivation so outstanding dues cannot become stranded.
- Item Master editing and activation/deactivation.
- Separate master rate from last purchase rate.
- Existing item last purchase rates seed the initial master rates.
- Master-rate history and audit trail.
- Purchase lines show the configured master rate by default and keep the rate locked until `Modify Rate` is selected.
- Purchase-level rate overrides are visibly identified.
- Owner can choose whether an override applies only to the current purchase or becomes the new master rate.
- Master-rate update and purchase posting are atomic through a dedicated RPC wrapper.
- Purchase lines snapshot the master rate at entry and whether the actual rate was overridden.
- Existing inventory valuation continues to use last purchase rate.
- Existing ledger and supplier-balance architecture remains intact.

### Local validation

`npm run check` passes.

The dependency-light local server also starts successfully at:

```text
http://127.0.0.1:5173
```

### Supabase migration required

Before using the new functionality against the real application database, run:

```text
db/phase2_supplier_rate_management.sql
```

in the Supabase SQL Editor after the existing database migrations.

The migration is designed to be additive and preserves historical transactions.


## Phase 2 corrective update — GST percentage + rate unlock

### Purchase-entry behavior
- Master rate is read-only by default and can be unlocked with **Modify Rate**.
- The unlock now explicitly removes the `readonly` attribute so the field is editable in the browser.
- The button changes to **Lock Rate** while editing and restores the locked state when clicked.
- GST is now represented as a **percentage**, never as a manually entered rupee amount.
- Every item has a GST percentage in the item master; `0%` is a valid configured rate for GST-free/exempt items.
- Purchase entry displays the configured GST percentage locked by default with **Modify GST**.
- GST amount is calculated automatically as `quantity × rate × GST% / 100`.
- If the GST percentage is overridden, the purchase shows a warning and the Owner can optionally save the new GST percentage as the item's master GST rate.
- Purchase-line GST percentage is snapshotted so later master changes do not rewrite historical transactions.

### Database
- Added `purchase_items.gst_rate_at_entry` and `purchase_items.gst_rate_overridden`.
- Added `item_gst_rate_history`.
- Added `db/phase2_supplier_rate_gst_fix.sql`.
- The purchase RPC now calculates GST server-side from the percentage and does not trust a client-supplied GST amount.
- Existing purchase records are preserved as-is; this migration does not recalculate historical GST amounts.

### Local verification
- `npm run check` must pass after applying the migration.
- Test a purchase line with a predefined rate and GST.
- Test **Modify Rate → edit → Lock Rate**.
- Test **Modify GST → edit → Lock GST**.
- Test purchase-only overrides.
- As Owner, test saving the new master rate and/or GST percentage.
- Verify the item master and rate/GST history reflect the selected update.


## Phase 2 follow-up fix — rate/GST editing and purchase total

Implemented after local user testing:

- Fixed the Rate `Modify Rate` / `Lock Rate` control so the underlying input explicitly toggles its `readonly` attribute and normal interaction state.
- Fixed the GST `Modify GST` / `Lock GST` control using the same mechanism.
- Added deterministic hydration of a selected item when a browser restores a select value without firing `change`, preventing false “differs from master” warnings and blank rate/GST fields.
- Rate/GST warning badges now compare against the selected item's master values only after those values have been hydrated.
- Purchase total now calculates GST directly from quantity × rate × GST percentage in the browser summary; GST is included in the displayed purchase total.
- Service-worker cache version bumped so the updated procurement module is not masked by a stale cached shell after deployment.

### Validation

`npm run check` must pass before this phase is considered ready for GitHub deployment. Manual acceptance: select an item with predefined rate/GST, verify both values populate and no mismatch warning appears; click Modify Rate/Modify GST, type a new percentage/value, lock again, and verify the purchase total recalculates.

## Phase 2 corrective update — robust application-level rate/GST locking

Implemented after the second round of user testing:

- Removed reliance on the HTML `readonly` attribute for purchase rate and GST editing state.
- Rate and GST inputs are now normal number inputs with an explicit application-level `data-locked` state.
- While locked, `beforeinput`, keyboard, paste, drop, and wheel editing events are blocked.
- Clicking `Modify Rate` or `Modify GST` changes the application lock state and makes the input genuinely editable/focusable.
- Clicking `Lock Rate` or `Lock GST` restores the application lock state.
- Master-rate resolution now uses the configured `master_rate` when it is positive and falls back to `last_purchase_rate` for legacy items whose master rate has not yet been populated.
- Master-rate mismatch warnings now use an explicit empty-value check and only appear when the entered value actually differs from the selected item's master value.
- GST continues to treat `0%` as a valid predefined master value.
- Service-worker cache version was incremented again to `v11` to invalidate the previous purchase-entry JavaScript shell.

### Validation

`npm run check` passes with all JavaScript, HTML, and manifest checks successful.

Manual acceptance for this corrective version:

1. Select an item with a predefined master rate and GST.
2. Confirm the values populate immediately.
3. Confirm no mismatch warning appears on initial selection.
4. Click `Modify Rate` and verify the cursor/focus enters the field and typing changes the value.
5. Click `Lock Rate` and verify further typing is blocked.
6. Repeat the same test for GST percentage.
7. Verify GST amount and purchase total recalculate from the entered percentage.

## Corrective implementation — canonical purchase-row state

This corrective iteration replaces the earlier purchase-entry locking/state implementation.

### Corrected behavior

- `items.master_rate` is the only authoritative default purchase rate.
- `items.last_purchase_rate` is never used as the new-purchase default when a master rate exists.
- `items.gst_rate` is the authoritative default GST percentage.
- Rate and GST fields use native browser `disabled`/`readonly` state for locking.
- `Modify Rate` / `Lock Rate` and `Modify GST` / `Lock GST` now change the actual input state.
- Purchase-row calculations use one canonical row state for displayed values, totals, warnings, and submission.
- Selecting an item immediately hydrates master rate and GST percentage.
- A warning appears only when the purchase value actually differs from the master value.
- GST amount is calculated as `quantity × purchase rate × GST% / 100`.
- The purchase total includes the calculated GST amount.
- Rate and GST master updates are independent Owner decisions.
- Purchase lines snapshot the master rate, master GST, actual purchase rate, actual GST, and override state.

### Database cleanup

`db/phase2_rate_gst_correction.sql` removes the obsolete overloaded purchase-wrapper signatures and leaves one canonical 7-argument `create_purchase_with_master_rate_updates` function.

The migration does **not** delete or reverse test transactions. Any test purchases that were recorded while debugging must be handled through the existing reversal workflow if they are not genuine business transactions.

### Validation target

For an item such as Dabeli Masalo with master rate ₹80 and GST 5%:

- Selecting the item shows ₹80 and 5% immediately.
- Both fields start locked.
- `Modify Rate` makes the rate input genuinely editable.
- `Lock Rate` makes it genuinely locked again.
- `Modify GST` makes the GST percentage genuinely editable.
- `Lock GST` makes it genuinely locked again.
- Qty 1 × ₹80 at 5% produces GST ₹4.00 and line total ₹84.00.
- Changing only the purchase rate or GST percentage produces the corresponding variance warning.
- Choosing purchase-only changes does not update the item master.
- Choosing master updates changes only the selected master values and records their histories.
