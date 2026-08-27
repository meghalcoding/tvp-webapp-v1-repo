-- MASTER DATA COMPATIBILITY / REPAIR
-- Run once on an existing database created from an older master-data migration.
-- Safe for the clean database: all statements are idempotent and preserve rows.

alter table public.purchase_category_items add column if not exists active boolean not null default true;
alter table public.expense_category_items add column if not exists active boolean not null default true;
alter table public.sales_channel_items add column if not exists active boolean not null default true;
alter table public.supplier_purchase_categories add column if not exists is_fixed boolean not null default false;
alter table public.supplier_expense_categories add column if not exists is_fixed boolean not null default false;

create index if not exists idx_pci_item_active on public.purchase_category_items(item_id,active);
create index if not exists idx_eci_item_active on public.expense_category_items(item_id,active);

-- Reassert the canonical master relationship RPC after the compatibility columns exist.
-- The full canonical function definition lives in db/master_data_foundation.sql.
