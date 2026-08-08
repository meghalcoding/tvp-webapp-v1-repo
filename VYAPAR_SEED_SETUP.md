# Vyapar seed-data migration

This one-time migration loads the supplied Vyapar exports into the Tasty Vadapav financial model:

- 36 sales - INR 94,516.00
- 26 purchases - INR 63,644.00
- 70 expenses - INR 17,537.02
- 4 UPI settlements - INR 41,655.00
- Opening cash from the supplied Cash Flow report - INR 18,000.00

The migration file is [db/vyapar_seed_2026_08.sql](db/vyapar_seed_2026_08.sql).

## What it does

The financial records follow the specification's double-entry model:

- cash and UPI sales debit their actual cash/collection account and credit revenue;
- purchases debit inventory and credit the supplier, with a second supplier-to-payment-account pair for paid purchases;
- expenses debit their expense category and credit Cash Drawer, Petty Cash, or Cravory Bank;
- Vyapar `Payment-in` rows become UPI settlements from a collection account to Cravory Bank;
- complete purchase item lines create purchase lines and positive stock movements;
- all created records receive an audit entry.

Each transaction is deliberately posted with **today's database date** (`current_date`) as requested. The original Vyapar date, invoice/reference, source status, and description are retained in the transaction description and audit metadata.

This means the imported activity will appear on the cutover date in date-based app reports. If historical, day-by-day reporting is needed later, use a separate reviewed migration that posts the original dates - do **not** rerun this migration.

## Important source-data limitation

The transaction report contains three INR 110 purchases from **Water Bottle Vendor** (21, 23, and 24 July) with no matching Item Details row. Their supplier, ledger, and paid-purchase records are included, but no stock quantity is guessed. They are labelled `ITEM DETAIL MISSING IN SOURCE REPORT` in the transaction description and audit log.

Expense records are imported at the financial/category level. Itemized expense lines are intentionally not fabricated from incomplete source detail.

## First-time setup (fresh Supabase project)

1. Create the Supabase project and configure the app's environment variables.
2. In Supabase **SQL Editor**, run the database scripts in this order:

   1. [db/schema.sql](db/schema.sql)
   2. [db/rls_policies.sql](db/rls_policies.sql)
   3. Phase 2 through Phase 7 migration files, in their documented order

3. Sign in to the application once and ensure there is one active user with the `owner` role in `public.users`.
4. Open [db/vyapar_seed_2026_08.sql](db/vyapar_seed_2026_08.sql), copy its entire contents, and run it once in SQL Editor.
5. Keep the query result and verify the checks below.

The migration creates only the masters it needs if they do not already exist, so running the older general [db/seed.sql](db/seed.sql) is optional for this import.

## Update seed data on an existing live database

1. Make an application backup from the **Backup** screen and keep the downloaded file.
2. Confirm you are connected to the intended Supabase project. This operation creates financial entries and must not be run against production by mistake.
3. Verify an active owner exists:

   ```sql
   select id, name, role, active
   from public.users
   where role = 'owner' and active = true;
   ```

4. Run the entire [db/vyapar_seed_2026_08.sql](db/vyapar_seed_2026_08.sql) file in Supabase SQL Editor.
5. Do not run it a second time. It writes a migration marker to `audit_log` and deliberately stops if that marker already exists.
6. Refresh the web app. Database data is available immediately; a Cloudflare deploy is only needed when application code has changed.

## Reconciliation checks

Run these in Supabase SQL Editor immediately after the migration:

```sql
select txn_type, count(*) as records, sum(amount) as amount
from transactions
where description like 'Vyapar migration%'
group by txn_type
order by txn_type;
```

Expected result:

| Type | Records | Amount |
| --- | ---: | ---: |
| expense | 70 | 17,537.02 |
| opening_balance | 1 | 18,000.00 |
| purchase | 26 | 63,644.00 |
| sale | 36 | 94,516.00 |
| settlement | 4 | 41,655.00 |

```sql
select
  t.id,
  t.txn_type,
  t.amount,
  sum(case when le.entry_side = 'debit' then le.amount else -le.amount end) as ledger_difference
from transactions t
join ledger_entries le on le.transaction_id = t.id
where t.description like 'Vyapar migration%'
group by t.id, t.txn_type, t.amount
having sum(case when le.entry_side = 'debit' then le.amount else -le.amount end) <> 0;
```

This second query must return **zero rows**.

Check the intentionally unresolved source lines:

```sql
select txn_date, amount, description
from transactions
where description like '%ITEM DETAIL MISSING IN SOURCE REPORT%';
```

It should return exactly three rows, each for INR 110.

## Adding future data

Do not edit this historical migration after applying it. Add new sales, expenses, purchases, transfers, and settlements through the application so that its validation, audit trail, stock control, and daily-closing rules apply. For a future bulk import, create a new date-stamped migration, reconcile it first, and retain the source export beside it.
