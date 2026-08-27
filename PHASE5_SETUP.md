# Phase 5A — Sales Channel Foundation

Phase 5 adds Zomato + Swiggy marketplace sales to the existing financial engine.

## What this migration adds

- `sale_details.sales_channel`
  - `walk_in`
  - `zomato`
  - `swiggy`
- `sale_details.external_order_id` for future marketplace imports.
- Production-level uniqueness protection for marketplace external order IDs.
- `Zomato Collections` and `Swiggy Collections` collection accounts.
- Channel-aware sale RPCs.
- Marketplace collection mode.
- Existing walk-in Cash/UPI sales continue to work.

## Accounting model

Walk-in:

```text
Walk-in
  ├── Cash → Cash Drawer
  └── UPI  → selected UPI collection account
```

Marketplace:

```text
Zomato → Zomato Collections
Swiggy → Swiggy Collections
```

Marketplace collection accounts are intentionally separate from the bank account. Settlement/reconciliation will be handled in a later Phase 5 step.

## Import architecture

The Zomato/Swiggy Excel importer is **not** part of this migration yet.

The next step will add:

```text
Excel
 ↓
Import Batch
 ↓
Staging Rows
 ↓
Normalize
 ↓
Validate
 ↓
Preview
 ↓
Duplicate Check
 ↓
Commit
 ↓
Production Sales
```

Production sales will never be populated directly from an Excel file.

## Deployment

Run:

```text
db/phase5_sales_channels.sql
```

after the current Phase 4/7 database migrations.

Then run:

```text
npm run check
npm run dev
```

and manually verify:

1. Existing Cash sale.
2. Existing UPI sale.
3. Walk-in remains the default channel.
4. Zomato shows Zomato Collections.
5. Swiggy shows Swiggy Collections.
6. Existing sales history still loads.

Do not add service-role keys or other secrets to the repository.


## Phase 5B

Run `db/phase5b_marketplace_imports.sql` after Phase 5A. It adds the marketplace import staging layer and extends the dedicated reconciliation screen to settle Zomato/Swiggy collection accounts.
