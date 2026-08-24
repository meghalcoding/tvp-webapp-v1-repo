# Phase 5B — Zomato + Swiggy Excel Importer

## Scope

Phase 5B adds a review-first marketplace sales import pipeline for Zomato and Swiggy.

```text
Excel
 ↓
Detect platform
 ↓
Parse
 ↓
Normalize
 ↓
Validate
 ↓
Duplicate check
 ↓
Import staging
 ↓
User review / edit / remove
 ↓
Commit
 ↓
Production sales
```

Production `transactions` are never populated directly from an Excel file.

## Marketplace settlement correction

UPI Reconciliation is now the dedicated reconciliation screen for:

- UPI collection accounts
- Zomato Collections
- Swiggy Collections

The existing settlement workflow is reused. A pending marketplace collection can be moved to an active Cash or Bank account from the reconciliation screen.

The settlement RPC now counts both:

- `payment_method = 'upi'`
- `payment_method = 'marketplace'`

against the selected collection account.

## Import staging

### `sales_import_batches`

Stores the import event:

- platform
- source filename
- SHA-256 file hash
- importer
- status
- row counts

### `sales_import_rows`

Stores each normalized Excel row:

- external order ID
- order date/time
- gross amount
- discount
- tax
- platform fee
- net amount
- import amount
- payment/status information
- original raw row JSON
- normalized JSON
- validation errors
- duplicate reference
- user action
- committed transaction ID

The original raw row is retained deliberately.

## Duplicate protection

Duplicate detection uses:

```text
sales_channel + external_order_id
```

and the production database has a unique partial index for marketplace orders.

The importer also checks existing production sales before staging.

A final duplicate check occurs inside the commit transaction.

## Platform parsing

The importer supports:

- `.xlsx`
- `.xls`
- `.csv`

Platform detection uses filename and header signals. The user can override detection.

The parser is intentionally alias-based rather than tied to a single export-column spelling.

## Amount behavior

The importer attempts to identify:

1. net/merchant/settlement amount
2. gross/order total

The selected `import_amount` is visible in the review screen and can be edited before commit.

This is deliberately review-first. We will refine platform-specific financial semantics after testing against real Zomato and Swiggy merchant exports.

## Commit

`commit_sales_import_batch()` is the only production-write path.

For every selected valid row it:

1. checks the platform collection account;
2. checks the external order ID again;
3. creates a sale transaction;
4. creates the marketplace collection ledger entry;
5. creates `sale_details`;
6. records the import batch;
7. records an audit event;
8. marks the staging row committed.

The entire commit runs inside one database transaction.

## UI

Sales has an `Import Zomato / Swiggy` entry point.

There is also a dedicated:

**Marketplace Imports**

screen with:

- platform selector
- Excel upload
- automatic platform detection
- staging
- row-level preview
- editable order ID/date/amount
- select/remove rows
- duplicate/invalid status
- commit
- recent import history

## Deferred AI work

This phase does not use an LLM.

Document OCR and future intelligent invoice field mapping remain separate.

## Deployment

Run:

```text
db/phase5b_marketplace_imports.sql
```

after Phase 5A.

Then:

```text
npm run check
npm run dev
```

## Testing

1. Verify existing Walk-in Cash sale.
2. Verify existing Walk-in UPI sale.
3. Verify Zomato sale appears as pending in UPI & Marketplace Reconciliation.
4. Settle Zomato from that page into Cash/Bank.
5. Verify the pending amount becomes zero.
6. Repeat for Swiggy.
7. Import a real Zomato Excel report.
8. Confirm platform detection.
9. Confirm staging counts.
10. Edit/remove a row.
11. Confirm duplicate rows are not selected.
12. Commit selected rows.
13. Confirm sales appear with Zomato/Swiggy channel.
14. Import the same file again.
15. Confirm existing orders are detected as duplicates and no duplicate production sales are created.
