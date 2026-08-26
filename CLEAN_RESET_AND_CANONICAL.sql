-- TASTY VADAPAV / CRAVORY HOSPITALITY LLP
-- CLEAN RESET + CANONICAL MASTER DATA MODEL
--
-- Purpose:
--   1. Remove all dummy transactional/master data.
--   2. Preserve users, accounts, authentication, financial structure,
--      audit infrastructure, documents infrastructure, daily closing,
--      budgets and RLS/security structure.
--   3. Remove the legacy separate expense-item catalog model.
--   4. Make public.items the single universal master-item table.
--   5. Make Sales Channel / Purchase Category / Expense Category -> Item
--      relationships many-to-many.
--   6. Add supplier -> Purchase Category / Expense Category routing.
--   7. Leave the database ready for organic manual setup through the app.
--
-- IMPORTANT:
--   Run only after the current application migrations have been installed.
--   This intentionally deletes all application data that was described as
--   dummy. It does NOT delete auth.users, public.users or public.accounts.

begin;

-- ---------------------------------------------------------------------------
-- A. DELETE DUMMY TRANSACTIONAL DATA, KEEP TABLES / FUNCTIONS / RLS
-- ---------------------------------------------------------------------------
truncate table
  public.sales_import_rows,
  public.sales_import_batches,
  public.transaction_documents,
  public.documents,
  public.purchase_items,
  public.expense_items,
  public.sale_details,
  public.purchase_details,
  public.expense_details,
  public.transfer_details,
  public.settlement_details,
  public.stock_movements,
  public.transactions
restart identity cascade;

-- Other operational snapshots / automation / budget data are also dummy data.
-- Their table structures remain intact.
truncate table
  public.salary_payments,
  public.salary_profiles,
  public.recurring_expenses,
  public.monthly_closings,
  public.daily_closings,
  public.budget_lines,
  public.budget_versions,
  public.budget_periods,
  public.item_rate_history,
  public.item_gst_rate_history
restart identity cascade;

-- Audit infrastructure is preserved; the dummy audit history is not.
truncate table public.audit_log restart identity cascade;

-- ---------------------------------------------------------------------------
-- B. REMOVE LEGACY MASTER STRUCTURES
-- ---------------------------------------------------------------------------
-- Supplier purchase templates were a legacy workaround for the old Tasty
-- workflow. The canonical workflow is now Category -> Items + Supplier
-- Category routing.
drop table if exists public.supplier_purchase_templates cascade;

-- Separate expense-item catalog is explicitly retired. Expense items are now
-- rows in public.items, exactly like purchase items.
drop table if exists public.expense_category_items cascade;
drop table if exists public.expense_item_catalog cascade;

-- Remove legacy bridge columns from the surviving tables.
alter table public.expense_details drop column if exists expense_item_id;
alter table public.budget_lines drop column if exists expense_item_id;

-- The old free-text/general item category is no longer a routing mechanism.
-- Keep the column nullable for physical compatibility with old accounting
-- functions/views, but the application never asks the user for it.
alter table public.items alter column category drop not null;

-- ---------------------------------------------------------------------------
-- C. REBUILD UNIVERSAL ITEM RELATIONSHIPS
-- ---------------------------------------------------------------------------
create table if not exists public.sales_channel_items (
  sales_channel_id uuid not null references public.sales_channels(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (sales_channel_id,item_id)
);

create table if not exists public.purchase_category_items (
  purchase_category_id uuid not null references public.purchase_categories(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (purchase_category_id,item_id)
);

create table public.expense_category_items (
  expense_category_id uuid not null references public.expense_categories(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (expense_category_id,item_id)
);

create index if not exists idx_sales_channel_items_item on public.sales_channel_items(item_id);
create index if not exists idx_purchase_category_items_item on public.purchase_category_items(item_id);
create index if not exists idx_expense_category_items_item on public.expense_category_items(item_id);

-- ---------------------------------------------------------------------------
-- D. SUPPLIER CATEGORY ROUTING
-- ---------------------------------------------------------------------------
create table if not exists public.supplier_purchase_categories (
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  purchase_category_id uuid not null references public.purchase_categories(id) on delete cascade,
  is_fixed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (supplier_id,purchase_category_id)
);

create table if not exists public.supplier_expense_categories (
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  expense_category_id uuid not null references public.expense_categories(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (supplier_id,expense_category_id)
);

create index if not exists idx_supplier_purchase_categories_category
  on public.supplier_purchase_categories(purchase_category_id);
create index if not exists idx_supplier_expense_categories_category
  on public.supplier_expense_categories(expense_category_id);

-- ---------------------------------------------------------------------------
-- E. RESET MASTER DATA
-- ---------------------------------------------------------------------------
-- Sales channels are genuine application configuration, not dummy transaction
-- data. Keep/create the five channels used by the sales workflow.
insert into public.sales_channels(code,name,sort_order,active)
values
  ('walk_in','Walk-in',1,true),
  ('cash','Cash',2,true),
  ('upi','UPI',3,true),
  ('zomato','Zomato',4,true),
  ('swiggy','Swiggy',5,true)
on conflict (code) do update
set name=excluded.name,sort_order=excluded.sort_order,active=true;

-- Remove every user-created master record. No categories/items/suppliers are
-- seeded here; the user will create them organically through the application.
delete from public.supplier_purchase_categories;
delete from public.supplier_expense_categories;
delete from public.sales_channel_items;
delete from public.purchase_category_items;
delete from public.expense_category_items;
delete from public.items;
delete from public.suppliers;
delete from public.purchase_categories;
delete from public.expense_categories;

-- ---------------------------------------------------------------------------
-- F. CANONICAL CATEGORY / ITEM RPCs
-- ---------------------------------------------------------------------------
create or replace function public.create_purchase_category_master(p_name text)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare v_user users%rowtype; v_id uuid;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role <> 'owner' then raise exception 'Only the Owner can manage purchase categories'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Category name is required'; end if;
  insert into purchase_categories(name,active,sort_order) values(trim(p_name),true,coalesce((select max(sort_order)+1 from purchase_categories),1)) returning id into v_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','purchase_category',v_id,jsonb_build_object('name',trim(p_name)));
  return v_id;
end;
$$;
grant execute on function public.create_purchase_category_master(text) to authenticated;

create or replace function public.update_purchase_category_master(p_category_id uuid,p_name text,p_active boolean default true)
returns void
language plpgsql security definer set search_path=public
as $$
declare v_user users%rowtype; v_before jsonb;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role <> 'owner' then raise exception 'Only the Owner can manage purchase categories'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Category name is required'; end if;
  select to_jsonb(pc) into v_before from purchase_categories pc where id=p_category_id;
  if v_before is null then raise exception 'Purchase category not found'; end if;
  update purchase_categories set name=trim(p_name),active=coalesce(p_active,true) where id=p_category_id;
  insert into audit_log(user_id,action,entity_type,entity_id,before,after) values(v_user.id,'update','purchase_category',p_category_id,v_before,jsonb_build_object('name',trim(p_name),'active',coalesce(p_active,true)));
end;
$$;
grant execute on function public.update_purchase_category_master(uuid,text,boolean) to authenticated;

-- Replace item-master RPCs with relationship-first semantics. The p_category
-- parameter remains accepted for API compatibility but is deliberately ignored.
drop function if exists public.create_item_master(text,text,text,numeric,numeric,numeric);
create or replace function public.create_item_master(
  p_name text,p_category text,p_unit text,p_gst_rate numeric default 0,
  p_reorder_level numeric default 0,p_master_rate numeric default 0
) returns uuid
language plpgsql security definer set search_path=public
as $$
declare v_user users%rowtype; v_id uuid; v_rate numeric(10,2):=round(coalesce(p_master_rate,0),2);
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage items'; end if;
  if nullif(trim(p_name),'') is null or nullif(trim(p_unit),'') is null then raise exception 'Item name and unit are required'; end if;
  if coalesce(p_gst_rate,0)<0 or coalesce(p_reorder_level,0)<0 or v_rate<0 then raise exception 'GST, reorder level, and master rate cannot be negative'; end if;
  insert into items(name,category,unit,gst_rate,reorder_level,master_rate)
  values(trim(p_name),null,trim(p_unit),round(coalesce(p_gst_rate,0),2),round(coalesce(p_reorder_level,0),3),v_rate)
  returning id into v_id;
  if v_rate>0 then insert into item_rate_history(item_id,old_rate,new_rate,changed_by,reason) values(v_id,0,v_rate,v_user.id,'Initial master rate'); end if;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','item',v_id,jsonb_build_object('name',trim(p_name),'unit',trim(p_unit),'gst_rate',round(coalesce(p_gst_rate,0),2),'reorder_level',round(coalesce(p_reorder_level,0),3),'master_rate',v_rate));
  return v_id;
end;
$$;
grant execute on function public.create_item_master(text,text,text,numeric,numeric,numeric) to authenticated;

-- Keep the existing update signature but stop treating p_category as a user
-- facing field.
create or replace function public.update_item_master(
  p_item_id uuid,p_name text,p_category text,p_unit text,p_gst_rate numeric default 0,
  p_reorder_level numeric default 0,p_master_rate numeric default 0,p_active boolean default true
) returns void
language plpgsql security definer set search_path=public
as $$
declare v_user users%rowtype; v_before jsonb; v_old_rate numeric; v_new_rate numeric:=round(coalesce(p_master_rate,0),2);
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage items'; end if;
  if nullif(trim(p_name),'') is null or nullif(trim(p_unit),'') is null then raise exception 'Item name and unit are required'; end if;
  select to_jsonb(i),i.master_rate into v_before,v_old_rate from items i where i.id=p_item_id;
  if v_before is null then raise exception 'Item not found'; end if;
  update items set name=trim(p_name),category=null,unit=trim(p_unit),gst_rate=round(coalesce(p_gst_rate,0),2),reorder_level=round(coalesce(p_reorder_level,0),3),master_rate=v_new_rate,active=coalesce(p_active,true) where id=p_item_id;
  if coalesce(v_old_rate,0)<>v_new_rate then insert into item_rate_history(item_id,old_rate,new_rate,changed_by,reason) values(p_item_id,v_old_rate,v_new_rate,v_user.id,'Master rate update'); end if;
  insert into audit_log(user_id,action,entity_type,entity_id,before,after) values(v_user.id,'update','item',p_item_id,v_before,jsonb_build_object('name',trim(p_name),'unit',trim(p_unit),'gst_rate',round(coalesce(p_gst_rate,0),2),'reorder_level',round(coalesce(p_reorder_level,0),3),'master_rate',v_new_rate,'active',coalesce(p_active,true)));
end;
$$;
grant execute on function public.update_item_master(uuid,text,text,text,numeric,numeric,numeric,boolean) to authenticated;

-- One universal relationship writer. Expense uses the same public.items row as
-- Purchase and Sales.
create or replace function public.set_item_master_relationships(
  p_item_id uuid,
  p_sales_channel_ids uuid[] default '{}',
  p_purchase_category_ids uuid[] default '{}',
  p_expense_category_ids uuid[] default '{}'
) returns void
language plpgsql security definer set search_path=public
as $$
declare v_user users%rowtype;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role not in ('owner','manager') then raise exception 'Only an Owner or Manager can manage item relationships'; end if;
  if not exists(select 1 from items where id=p_item_id) then raise exception 'Master item not found'; end if;

  delete from sales_channel_items where item_id=p_item_id;
  insert into sales_channel_items(sales_channel_id,item_id)
  select x,p_item_id from unnest(coalesce(p_sales_channel_ids,'{}')) x on conflict do nothing;

  delete from purchase_category_items where item_id=p_item_id;
  insert into purchase_category_items(purchase_category_id,item_id)
  select x,p_item_id from unnest(coalesce(p_purchase_category_ids,'{}')) x on conflict do nothing;

  delete from expense_category_items where item_id=p_item_id;
  insert into expense_category_items(expense_category_id,item_id)
  select x,p_item_id from unnest(coalesce(p_expense_category_ids,'{}')) x on conflict do nothing;

  insert into audit_log(user_id,action,entity_type,entity_id,after)
  values(v_user.id,'update','item_relationships',p_item_id,jsonb_build_object('sales_channels',coalesce(p_sales_channel_ids,'{}'),'purchase_categories',coalesce(p_purchase_category_ids,'{}'),'expense_categories',coalesce(p_expense_category_ids,'{}')));
end;
$$;
grant execute on function public.set_item_master_relationships(uuid,uuid[],uuid[],uuid[]) to authenticated;

-- Expense primary item now points directly to the universal master item.
alter table public.expense_details add column if not exists item_id uuid references public.items(id) on delete set null;
create index if not exists idx_expense_details_item on public.expense_details(item_id);

create or replace function public.set_expense_item(p_transaction_id uuid,p_expense_item_id uuid default null)
returns void language plpgsql security definer set search_path=public
as $$
begin
  if not exists(select 1 from transactions where id=p_transaction_id and txn_type='expense') then raise exception 'Expense transaction not found'; end if;
  if p_expense_item_id is not null and not exists(select 1 from items where id=p_expense_item_id and active=true) then raise exception 'Expense item not found'; end if;
  update expense_details set item_id=p_expense_item_id where transaction_id=p_transaction_id;
  if not found then raise exception 'Expense details not found'; end if;
end;
$$;
grant execute on function public.set_expense_item(uuid,uuid) to authenticated;

-- Budget lines use the same item_id for every item-level budget. The existing
-- category_id remains the category target for category-only budgets.
create index if not exists idx_budget_lines_item on public.budget_lines(item_id);

-- ---------------------------------------------------------------------------
-- G. RLS FOR NEW RELATIONSHIP TABLES
-- ---------------------------------------------------------------------------
alter table public.expense_category_items enable row level security;
alter table public.supplier_purchase_categories enable row level security;
alter table public.supplier_expense_categories enable row level security;

drop policy if exists expense_category_items_read on public.expense_category_items;
create policy expense_category_items_read on public.expense_category_items for select to authenticated using (true);
drop policy if exists supplier_purchase_categories_read on public.supplier_purchase_categories;
create policy supplier_purchase_categories_read on public.supplier_purchase_categories for select to authenticated using (true);
drop policy if exists supplier_expense_categories_read on public.supplier_expense_categories;
create policy supplier_expense_categories_read on public.supplier_expense_categories for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- H. STORAGE CLEANUP NOTE
-- ---------------------------------------------------------------------------
-- Supabase intentionally blocks direct DELETEs from storage.objects.
-- The bucket and Storage infrastructure are preserved by this reset.
-- Delete the dummy files through Supabase Storage (Dashboard or Storage API)
-- before/after running this SQL if a physical file purge is required.
-- We intentionally do NOT touch storage.objects here.

commit;

-- Verification queries (read-only):
-- select count(*) from transactions;
-- select count(*) from items;
-- select count(*) from suppliers;
-- select count(*) from purchase_categories;
-- select count(*) from expense_categories;
-- Storage object count can be checked from the Supabase Storage dashboard/API.
