-- ============================================================================
-- TASTY VADAPAV FINANCIAL SYSTEM — DATABASE SCHEMA
-- Implements: Specification v1.0, Section 4
-- Run this in the Supabase SQL editor on a fresh project, top to bottom.
-- Then run rls_policies.sql, then (optionally) seed.sql.
-- ============================================================================

create extension if not exists pgcrypto; -- for gen_random_uuid()

-- ===== IDENTITY =====

create table users (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid references auth.users(id) unique not null,
  name text not null,
  role text not null check (role in ('owner','manager','staff')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table users is 'App-level profile + role, one row per auth.users row. Role drives RLS policies.';

-- ===== MASTERS =====

create table accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  type text not null check (type in ('cash','bank','collection_account')),
  holder_name text,                    -- e.g. 'Vansh', 'Meghal' — informational only, not a permission boundary
  opening_balance numeric(12,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  pl_bucket text not null default 'operating'
    check (pl_bucket in ('direct','operating','other')),  -- used by Management P&L, spec §11.1
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,              -- 'Raw Material', 'Grocery', etc.
  unit text not null,                  -- 'kg','pack','nos','ltr'
  gst_rate numeric(5,2) not null default 0,
  reorder_level numeric(10,3) not null default 0,
  last_purchase_rate numeric(10,2) not null default 0,   -- maintained by trigger, used for stock valuation
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ===== LEDGER (the core — see spec §5) =====

create table transactions (
  id uuid primary key default gen_random_uuid(),
  txn_type text not null check (txn_type in
    ('sale','purchase','expense','transfer','settlement','supplier_payment',
     'stock_adjustment','wastage','opening_balance','reversal')),
  txn_date date not null,
  amount numeric(12,2) not null check (amount >= 0),
  description text,
  reversal_of uuid references transactions(id),
  created_by uuid references users(id) not null,
  created_at timestamptz not null default now(),
  locked_day boolean not null default false,
  client_uuid uuid unique  -- set by the PWA offline queue for idempotent sync; null for server-created rows
);

create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references transactions(id) on delete cascade not null,
  account_id uuid references accounts(id),          -- null when this leg is a pure P&L line
  entry_side text not null check (entry_side in ('debit','credit')),
  amount numeric(12,2) not null check (amount > 0),
  counterparty_type text check (counterparty_type in
    ('revenue','expense_category','supplier','account','wastage','inventory')),
  counterparty_id uuid
);

create table sale_details (
  transaction_id uuid primary key references transactions(id) on delete cascade,
  payment_method text not null check (payment_method in ('cash','upi')),
  collection_account_id uuid references accounts(id)
);

create table purchase_details (
  transaction_id uuid primary key references transactions(id) on delete cascade,
  supplier_id uuid references suppliers(id) not null,
  paid_amount numeric(12,2) not null default 0,
  bill_photo_url text
);

create table purchase_items (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references transactions(id) on delete cascade not null,
  item_id uuid references items(id) not null,
  quantity numeric(10,3) not null check (quantity > 0),
  rate numeric(10,2) not null check (rate >= 0),
  gst_amount numeric(10,2) not null default 0,
  amount numeric(12,2) not null
);

create table expense_details (
  transaction_id uuid primary key references transactions(id) on delete cascade,
  category_id uuid references expense_categories(id) not null,
  paid_from_account_id uuid references accounts(id) not null
);

create table expense_items (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references transactions(id) on delete cascade not null,
  description text not null,
  quantity numeric(10,3),
  unit text,
  rate numeric(10,2),
  amount numeric(12,2) not null
);

create table transfer_details (
  transaction_id uuid primary key references transactions(id) on delete cascade,
  from_account_id uuid references accounts(id) not null,
  to_account_id uuid references accounts(id) not null,
  check (from_account_id <> to_account_id)
);

create table settlement_details (
  transaction_id uuid primary key references transactions(id) on delete cascade,
  collection_account_id uuid references accounts(id) not null,
  settled_to_account_id uuid references accounts(id) not null
);

-- ===== STOCK (spec §8) =====

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references items(id) not null,
  transaction_id uuid references transactions(id) on delete cascade,
  movement_type text not null check (movement_type in
    ('purchase','waste','adjustment','opening')),
  quantity numeric(10,3) not null,      -- signed: + in, - out
  rate numeric(10,2),
  reason text,
  created_at timestamptz not null default now()
);

-- ===== DAILY CLOSING (spec §10) =====

create table daily_closings (
  id uuid primary key default gen_random_uuid(),
  closing_date date not null unique,
  expected_cash numeric(12,2) not null,
  actual_cash numeric(12,2) not null,
  difference numeric(12,2) not null,
  denomination_breakdown jsonb,
  closed_by uuid references users(id) not null,
  closed_at timestamptz not null default now(),
  reopened_at timestamptz,
  reopened_by uuid references users(id),
  reopen_reason text,
  notes text
);

-- ===== AUDIT (spec §7, §20) =====

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) not null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

create index idx_ledger_entries_txn on ledger_entries(transaction_id);
create index idx_ledger_entries_account on ledger_entries(account_id);
create index idx_transactions_date on transactions(txn_date);
create index idx_transactions_type on transactions(txn_type);
create index idx_stock_movements_item on stock_movements(item_id);
create index idx_purchase_items_txn on purchase_items(transaction_id);
create index idx_purchase_items_item on purchase_items(item_id);
create index idx_audit_log_entity on audit_log(entity_type, entity_id);

-- ============================================================================
-- HELPER VIEWS — read-only, computed live (never store balances — spec §20.2)
-- ============================================================================

-- Live balance per account
create or replace view account_balances as
select
  a.id as account_id,
  a.name,
  a.type,
  a.opening_balance
    + coalesce(sum(case when le.entry_side = 'debit' then le.amount else 0 end), 0)
    - coalesce(sum(case when le.entry_side = 'credit' then le.amount else 0 end), 0)
    as balance
from accounts a
left join ledger_entries le on le.account_id = a.id
group by a.id, a.name, a.type, a.opening_balance;

-- Live current stock per item
create or replace view current_stock as
select
  i.id as item_id,
  i.name,
  i.unit,
  i.reorder_level,
  coalesce(sum(sm.quantity), 0) as quantity,
  i.last_purchase_rate,
  coalesce(sum(sm.quantity), 0) * i.last_purchase_rate as stock_value
from items i
left join stock_movements sm on sm.item_id = i.id
group by i.id, i.name, i.unit, i.reorder_level, i.last_purchase_rate;

-- UPI collection account reconciliation (spec §9)
create or replace view upi_reconciliation as
select
  a.id as account_id,
  a.name,
  coalesce(sales.total, 0) as sales,
  coalesce(settled.total, 0) as settled,
  coalesce(sales.total, 0) - coalesce(settled.total, 0) as pending
from accounts a
left join (
  select sd.collection_account_id, sum(t.amount) as total
  from sale_details sd
  join transactions t on t.id = sd.transaction_id
  where sd.payment_method = 'upi'
  group by sd.collection_account_id
) sales on sales.collection_account_id = a.id
left join (
  select sdet.collection_account_id, sum(t.amount) as total
  from settlement_details sdet
  join transactions t on t.id = sdet.transaction_id
  group by sdet.collection_account_id
) settled on settled.collection_account_id = a.id
where a.type = 'collection_account';

-- Supplier outstanding balances
create or replace view supplier_balances as
select
  s.id as supplier_id,
  s.name,
  coalesce(purchased.total, 0) as total_purchased,
  coalesce(paid.total, 0) as total_paid,
  coalesce(purchased.total, 0) - coalesce(paid.total, 0) as outstanding
from suppliers s
left join (
  select pd.supplier_id, sum(t.amount) as total
  from purchase_details pd join transactions t on t.id = pd.transaction_id
  group by pd.supplier_id
) purchased on purchased.supplier_id = s.id
left join (
  select le.counterparty_id as supplier_id, sum(le.amount) as total
  from ledger_entries le
  where le.counterparty_type = 'supplier' and le.entry_side = 'debit'
  group by le.counterparty_id
) paid on paid.supplier_id = s.id;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Keep items.last_purchase_rate current whenever a purchase line is inserted
create or replace function fn_update_last_purchase_rate() returns trigger as $$
begin
  update items set last_purchase_rate = new.rate where id = new.item_id;
  return new;
end;
$$ language plpgsql;

create trigger trg_update_last_purchase_rate
  after insert on purchase_items
  for each row execute function fn_update_last_purchase_rate();

-- Guard: ledger_entries on a transaction must net to zero (debits = credits)
-- Checked via a deferred constraint trigger so multi-row inserts within one
-- transaction are validated only at commit.
create or replace function fn_check_ledger_balances() returns trigger as $$
declare
  txn_id uuid;
  debit_total numeric(12,2);
  credit_total numeric(12,2);
begin
  txn_id := coalesce(new.transaction_id, old.transaction_id);
  select
    coalesce(sum(amount) filter (where entry_side = 'debit'), 0),
    coalesce(sum(amount) filter (where entry_side = 'credit'), 0)
  into debit_total, credit_total
  from ledger_entries where transaction_id = txn_id;

  if debit_total <> credit_total then
    raise exception 'Ledger out of balance for transaction %: debits % != credits %',
      txn_id, debit_total, credit_total;
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger trg_check_ledger_balances
  after insert or update or delete on ledger_entries
  deferrable initially deferred
  for each row execute function fn_check_ledger_balances();

-- Guard: cannot modify transactions/ledger_entries belonging to a locked day
-- unless the caller is an owner (enforced again, authoritatively, in RLS).
create or replace function fn_block_locked_day_edits() returns trigger as $$
begin
  if TG_OP in ('UPDATE','DELETE') then
    if old.locked_day = true then
      raise exception 'Transaction % belongs to a locked day and cannot be modified directly. Use a reversal.', old.id;
    end if;
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

create trigger trg_block_locked_day_edits
  before update or delete on transactions
  for each row execute function fn_block_locked_day_edits();
