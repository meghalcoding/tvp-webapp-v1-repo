-- ============================================================================
-- ROW LEVEL SECURITY — implements Specification v1.0, Section 7 (Permissions Matrix)
-- Run after schema.sql.
-- The browser only ever holds the Supabase anon key. All role checks below
-- run inside Postgres, not client JS (spec §17, §7).
-- ============================================================================

-- ---- helper: current app user's role, resolved from auth.uid() ----
create or replace function current_user_role() returns text as $$
  select role from users where auth_id = auth.uid();
$$ language sql stable security definer;

create or replace function current_app_user_id() returns uuid as $$
  select id from users where auth_id = auth.uid();
$$ language sql stable security definer;

-- ============================================================================
-- Enable RLS on every table
-- ============================================================================
alter table users enable row level security;
alter table accounts enable row level security;
alter table expense_categories enable row level security;
alter table suppliers enable row level security;
alter table items enable row level security;
alter table transactions enable row level security;
alter table ledger_entries enable row level security;
alter table sale_details enable row level security;
alter table purchase_details enable row level security;
alter table purchase_items enable row level security;
alter table expense_details enable row level security;
alter table expense_items enable row level security;
alter table transfer_details enable row level security;
alter table settlement_details enable row level security;
alter table stock_movements enable row level security;
alter table daily_closings enable row level security;
alter table audit_log enable row level security;

-- ============================================================================
-- USERS — everyone can read active users (for pickers); only owner writes
-- ============================================================================
create policy users_select on users for select
  using (auth.uid() is not null);

create policy users_owner_write on users for all
  using (current_user_role() = 'owner')
  with check (current_user_role() = 'owner');

-- ============================================================================
-- MASTERS — accounts, expense_categories, suppliers, items
-- Everyone (any signed-in role) can read. Only owner can write (spec §7).
-- ============================================================================
create policy masters_select_accounts on accounts for select using (auth.uid() is not null);
create policy masters_write_accounts on accounts for all
  using (current_user_role() = 'owner') with check (current_user_role() = 'owner');

create policy masters_select_categories on expense_categories for select using (auth.uid() is not null);
create policy masters_write_categories on expense_categories for all
  using (current_user_role() = 'owner') with check (current_user_role() = 'owner');

create policy masters_select_suppliers on suppliers for select using (auth.uid() is not null);
create policy masters_write_suppliers on suppliers for all
  using (current_user_role() = 'owner') with check (current_user_role() = 'owner');

create policy masters_select_items on items for select using (auth.uid() is not null);
create policy masters_write_items on items for all
  using (current_user_role() = 'owner') with check (current_user_role() = 'owner');

-- ============================================================================
-- TRANSACTIONS
-- Insert: owner/manager/staff can all insert (type-level restriction is
--   enforced in the app layer + txn_type-specific detail-table policies below,
--   since Postgres RLS on `transactions` alone can't see txn_type-specific
--   nuance cleanly — the detail tables are the real gate for staff).
-- Select: owner/manager see everything; staff see only their own entries.
-- Update/Delete: never allowed directly (app never issues these); corrections
--   go through the reversal workflow (insert-only), enforced by not granting
--   update/delete policies at all.
-- ============================================================================
create policy transactions_select on transactions for select
  using (
    current_user_role() in ('owner','manager')
    or created_by = current_app_user_id()
  );

create policy transactions_insert on transactions for insert
  with check (
    created_by = current_app_user_id()
    and (
      current_user_role() in ('owner','manager')
      or (current_user_role() = 'staff' and txn_type in ('sale','expense','wastage'))
    )
  );
-- No update/delete policy on transactions -> disallowed by default under RLS.
-- Locked-day protection is additionally enforced by the trigger in schema.sql.

-- ============================================================================
-- LEDGER_ENTRIES — mirrors visibility of the parent transaction; insert-only,
-- always written by the app in the same request as the transaction row.
-- ============================================================================
create policy ledger_entries_select on ledger_entries for select
  using (
    exists (
      select 1 from transactions t
      where t.id = ledger_entries.transaction_id
        and (current_user_role() in ('owner','manager') or t.created_by = current_app_user_id())
    )
  );

create policy ledger_entries_insert on ledger_entries for insert
  with check (
    exists (
      select 1 from transactions t
      where t.id = ledger_entries.transaction_id
        and t.created_by = current_app_user_id()
    )
  );

-- ============================================================================
-- DETAIL TABLES — sale/purchase/expense/transfer/settlement details + line items
-- Purchases, transfers, settlements, detailed expenses require manager/owner.
-- Quick expenses and sales are open to staff.
-- ============================================================================
create policy sale_details_all on sale_details for all
  using (current_user_role() in ('owner','manager','staff'))
  with check (current_user_role() in ('owner','manager','staff'));

create policy purchase_details_all on purchase_details for all
  using (current_user_role() in ('owner','manager'))
  with check (current_user_role() in ('owner','manager'));

create policy purchase_items_all on purchase_items for all
  using (current_user_role() in ('owner','manager'))
  with check (current_user_role() in ('owner','manager'));

create policy expense_details_all on expense_details for all
  using (current_user_role() in ('owner','manager','staff'))
  with check (current_user_role() in ('owner','manager','staff'));

create policy expense_items_all on expense_items for all
  using (current_user_role() in ('owner','manager'))  -- detailed expenses: manager/owner only, spec §7
  with check (current_user_role() in ('owner','manager'));

create policy transfer_details_all on transfer_details for all
  using (current_user_role() in ('owner','manager'))
  with check (current_user_role() in ('owner','manager'));

create policy settlement_details_all on settlement_details for all
  using (current_user_role() in ('owner','manager'))
  with check (current_user_role() in ('owner','manager'));

-- ============================================================================
-- STOCK MOVEMENTS — purchases create these automatically (manager/owner);
-- wastage entries (staff-allowed) also create these.
-- ============================================================================
create policy stock_movements_select on stock_movements for select
  using (auth.uid() is not null);

create policy stock_movements_insert on stock_movements for insert
  with check (
    current_user_role() in ('owner','manager')
    or (current_user_role() = 'staff' and movement_type = 'waste')
  );

-- ============================================================================
-- DAILY CLOSINGS — manager/owner create; only owner can "reopen" (update)
-- ============================================================================
create policy daily_closings_select on daily_closings for select
  using (current_user_role() in ('owner','manager'));

create policy daily_closings_insert on daily_closings for insert
  with check (current_user_role() in ('owner','manager'));

create policy daily_closings_update_owner_only on daily_closings for update
  using (current_user_role() = 'owner')
  with check (current_user_role() = 'owner');

-- ============================================================================
-- AUDIT LOG — owner only (spec §7)
-- ============================================================================
create policy audit_log_owner_select on audit_log for select
  using (current_user_role() = 'owner');

create policy audit_log_insert on audit_log for insert
  with check (auth.uid() is not null);  -- app inserts an audit row for every write, any role
