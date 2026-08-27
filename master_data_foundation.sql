-- MASTER DATA FOUNDATION
-- Canonical master-data architecture after the clean operational reset.
-- Run once after the clean reset. Do not run legacy Phase 6 relationship seeds after this.

-- Fundamental item master: category routing lives only in relationship tables.
alter table public.items drop column if exists category;

-- Compatibility for installations where these relationship tables were created by an older migration.
-- The canonical RPCs use an active flag so the relationship can be disabled without deleting history.
alter table public.purchase_category_items add column if not exists active boolean not null default true;
alter table public.expense_category_items add column if not exists active boolean not null default true;
alter table public.sales_channel_items add column if not exists active boolean not null default true;
alter table public.supplier_purchase_categories add column if not exists is_fixed boolean not null default false;
alter table public.supplier_expense_categories add column if not exists is_fixed boolean not null default false;

-- Canonical many-to-many category relationships.
create table if not exists public.purchase_category_items (
  purchase_category_id uuid not null references public.purchase_categories(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (purchase_category_id,item_id)
);

create table if not exists public.expense_category_items (
  expense_category_id uuid not null references public.expense_categories(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (expense_category_id,item_id)
);

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
  is_fixed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (supplier_id,expense_category_id)
);

create index if not exists idx_pci_item on public.purchase_category_items(item_id);
create index if not exists idx_eci_item on public.expense_category_items(item_id);
create index if not exists idx_spc_category on public.supplier_purchase_categories(purchase_category_id);
create index if not exists idx_sec_category on public.supplier_expense_categories(expense_category_id);

-- Retire category-owned supplier routing in favour of the many-to-many supplier map.
alter table public.purchase_categories drop column if exists supplier_id;

-- Expense transaction detail now points directly to the universal master item.
alter table public.expense_details add column if not exists item_id uuid references public.items(id) on delete set null;

-- Migrate any existing bridge rows that still exist before removing the bridge table.
do $$
begin
  if to_regclass('public.expense_item_catalog') is not null
     and exists (select 1 from information_schema.columns where table_schema='public' and table_name='expense_item_catalog' and column_name='master_item_id') then
    update public.expense_details ed
       set item_id = eic.master_item_id
      from public.expense_item_catalog eic
     where ed.expense_item_id = eic.id
       and ed.item_id is null
       and eic.master_item_id is not null;
  end if;
end $$;

-- Existing budget lines already use the universal item_id for purchase/expense detail.
-- Remove the obsolete expense-item-catalog budget pointer if present.
alter table public.budget_lines drop column if exists expense_item_id;

-- The current application does not use fundamental items as sales-channel menu items.
-- Keep the table during this migration so existing sales/import infrastructure is not
-- broken; it is intentionally no longer populated or used by the master-item UI.

-- Canonical master-data RPCs.
drop function if exists public.create_item_master(text,text,text,numeric,numeric,numeric);
drop function if exists public.update_item_master(uuid,text,text,text,numeric,numeric,numeric,boolean);
drop function if exists public.create_supplier_master(text,text,text,text,text,text);
drop function if exists public.update_supplier_master(uuid,text,text,text,text,text,text,boolean);

create or replace function public.create_item_master(
  p_name text,
  p_unit text,
  p_gst_rate numeric default 0,
  p_reorder_level numeric default 0,
  p_master_rate numeric default 0
) returns uuid
language plpgsql security definer set search_path=public
as $$
declare v_user users%rowtype; v_id uuid; v_rate numeric(12,2):=round(coalesce(p_master_rate,0),2);
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage items'; end if;
  if nullif(trim(p_name),'') is null or nullif(trim(p_unit),'') is null then raise exception 'Item name and unit are required'; end if;
  if coalesce(p_gst_rate,0) < 0 or coalesce(p_gst_rate,0) > 100 or coalesce(p_reorder_level,0) < 0 or v_rate < 0 then raise exception 'GST must be 0–100 and rates/levels cannot be negative'; end if;
  if exists(select 1 from items where lower(trim(name))=lower(trim(p_name))) then raise exception 'An item with this name already exists'; end if;
  insert into items(name,unit,gst_rate,reorder_level,master_rate) values(trim(p_name),trim(p_unit),round(coalesce(p_gst_rate,0),2),round(coalesce(p_reorder_level,0),3),v_rate) returning id into v_id;
  if v_rate>0 then insert into item_rate_history(item_id,old_rate,new_rate,changed_by,reason) values(v_id,0,v_rate,v_user.id,'Initial master rate'); end if;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','item',v_id,jsonb_build_object('name',trim(p_name),'unit',trim(p_unit),'gst_rate',round(coalesce(p_gst_rate,0),2),'reorder_level',round(coalesce(p_reorder_level,0),3),'master_rate',v_rate));
  return v_id;
end $$;

grant execute on function public.create_item_master(text,text,numeric,numeric,numeric) to authenticated;

create or replace function public.update_item_master(
  p_item_id uuid,
  p_name text,
  p_unit text,
  p_gst_rate numeric default 0,
  p_reorder_level numeric default 0,
  p_master_rate numeric default 0,
  p_active boolean default true
) returns void
language plpgsql security definer set search_path=public
as $$
declare v_user users%rowtype; v_item items%rowtype; v_rate numeric(12,2):=round(coalesce(p_master_rate,0),2);
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage items'; end if;
  select * into v_item from items where id=p_item_id;
  if not found then raise exception 'Item not found'; end if;
  if nullif(trim(p_name),'') is null or nullif(trim(p_unit),'') is null then raise exception 'Item name and unit are required'; end if;
  if exists(select 1 from items where lower(trim(name))=lower(trim(p_name)) and id<>p_item_id) then raise exception 'An item with this name already exists'; end if;
  if coalesce(p_gst_rate,0)<0 or coalesce(p_gst_rate,0)>100 or coalesce(p_reorder_level,0)<0 or v_rate<0 then raise exception 'GST must be 0–100 and rates/levels cannot be negative'; end if;
  update items set name=trim(p_name),unit=trim(p_unit),gst_rate=round(coalesce(p_gst_rate,0),2),reorder_level=round(coalesce(p_reorder_level,0),3),master_rate=v_rate,active=coalesce(p_active,true) where id=p_item_id;
  if round(coalesce(v_item.master_rate,0),2)<>v_rate then insert into item_rate_history(item_id,old_rate,new_rate,changed_by,reason) values(p_item_id,round(coalesce(v_item.master_rate,0),2),v_rate,v_user.id,'Master rate updated'); end if;
  insert into audit_log(user_id,action,entity_type,entity_id,before,after) values(v_user.id,'update','item',p_item_id,to_jsonb(v_item),jsonb_build_object('name',trim(p_name),'unit',trim(p_unit),'gst_rate',round(coalesce(p_gst_rate,0),2),'reorder_level',round(coalesce(p_reorder_level,0),3),'master_rate',v_rate,'active',coalesce(p_active,true)));
end $$;

grant execute on function public.update_item_master(uuid,text,text,numeric,numeric,numeric,boolean) to authenticated;

create or replace function public.set_item_master_relationships(
  p_item_id uuid,
  p_purchase_category_ids uuid[] default '{}',
  p_expense_category_ids uuid[] default '{}'
) returns void
language plpgsql security definer set search_path=public
as $$
declare v_user users%rowtype;
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage item relationships'; end if;
  if not exists(select 1 from items where id=p_item_id) then raise exception 'Item not found'; end if;
  update purchase_category_items set active=false where item_id=p_item_id;
  update expense_category_items set active=false where item_id=p_item_id;
  insert into purchase_category_items(purchase_category_id,item_id,active) select x,p_item_id,true from unnest(coalesce(p_purchase_category_ids,'{}')) x on conflict(purchase_category_id,item_id) do update set active=true;
  insert into expense_category_items(expense_category_id,item_id,active) select x,p_item_id,true from unnest(coalesce(p_expense_category_ids,'{}')) x on conflict(expense_category_id,item_id) do update set active=true;
end $$;

grant execute on function public.set_item_master_relationships(uuid,uuid[],uuid[]) to authenticated;

create or replace function public.create_purchase_category(p_name text, p_sort_order integer default 0) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype; v_id uuid;
begin select * into v_user from phase4_owner_user(); if not found then raise exception 'Only the Owner can manage categories'; end if; if nullif(trim(p_name),'') is null then raise exception 'Category name is required'; end if; if exists(select 1 from purchase_categories where lower(trim(name))=lower(trim(p_name))) then raise exception 'Purchase category already exists'; end if; insert into purchase_categories(name,sort_order) values(trim(p_name),coalesce(p_sort_order,0)) returning id into v_id; insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','purchase_category',v_id,jsonb_build_object('name',trim(p_name))); return v_id; end $$;
grant execute on function public.create_purchase_category(text,integer) to authenticated;

create or replace function public.create_expense_category(p_name text, p_pl_bucket text default 'operating') returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype; v_id uuid;
begin select * into v_user from phase4_owner_user(); if not found then raise exception 'Only the Owner can manage categories'; end if; if nullif(trim(p_name),'') is null then raise exception 'Category name is required'; end if; if p_pl_bucket not in ('direct','operating','other') then raise exception 'Invalid P&L bucket'; end if; if exists(select 1 from expense_categories where lower(trim(name))=lower(trim(p_name))) then raise exception 'Expense category already exists'; end if; insert into expense_categories(name,pl_bucket) values(trim(p_name),p_pl_bucket) returning id into v_id; insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','expense_category',v_id,jsonb_build_object('name',trim(p_name),'pl_bucket',p_pl_bucket)); return v_id; end $$;
grant execute on function public.create_expense_category(text,text) to authenticated;

create or replace function public.update_purchase_category_master(p_category_id uuid,p_name text,p_active boolean default true) returns void
language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype; v_before jsonb;
begin
  select * into v_user from phase4_owner_user(); if not found then raise exception 'Only the Owner can manage categories'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Category name is required'; end if;
  if exists(select 1 from purchase_categories where lower(trim(name))=lower(trim(p_name)) and id<>p_category_id) then raise exception 'Purchase category already exists'; end if;
  select jsonb_build_object('name',name,'active',active) into v_before from purchase_categories where id=p_category_id;
  if v_before is null then raise exception 'Purchase category not found'; end if;
  update purchase_categories set name=trim(p_name),active=coalesce(p_active,true) where id=p_category_id;
  insert into audit_log(user_id,action,entity_type,entity_id,before,after) values(v_user.id,'update','purchase_category',p_category_id,v_before,jsonb_build_object('name',trim(p_name),'active',coalesce(p_active,true)));
end $$;
grant execute on function public.update_purchase_category_master(uuid,text,boolean) to authenticated;

create or replace function public.update_expense_category_master(p_category_id uuid,p_name text,p_pl_bucket text,p_active boolean default true) returns void
language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype; v_before jsonb;
begin
  select * into v_user from phase4_owner_user(); if not found then raise exception 'Only the Owner can manage categories'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Category name is required'; end if;
  if p_pl_bucket not in ('direct','operating','other') then raise exception 'Invalid P&L bucket'; end if;
  if exists(select 1 from expense_categories where lower(trim(name))=lower(trim(p_name)) and id<>p_category_id) then raise exception 'Expense category already exists'; end if;
  select jsonb_build_object('name',name,'pl_bucket',pl_bucket,'active',active) into v_before from expense_categories where id=p_category_id;
  if v_before is null then raise exception 'Expense category not found'; end if;
  update expense_categories set name=trim(p_name),pl_bucket=p_pl_bucket,active=coalesce(p_active,true) where id=p_category_id;
  insert into audit_log(user_id,action,entity_type,entity_id,before,after) values(v_user.id,'update','expense_category',p_category_id,v_before,jsonb_build_object('name',trim(p_name),'pl_bucket',p_pl_bucket,'active',coalesce(p_active,true)));
end $$;
grant execute on function public.update_expense_category_master(uuid,text,text,boolean) to authenticated;

create or replace function public.create_supplier_master(p_name text,p_phone text default null,p_contact_person text default null,p_email text default null,p_address text default null,p_gstin text default null) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype; v_id uuid;
begin
  select * into v_user from phase4_owner_user(); if not found then raise exception 'Only the Owner can manage suppliers'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Supplier name is required'; end if;
  if exists(select 1 from suppliers where lower(trim(name))=lower(trim(p_name))) then raise exception 'A supplier with this name already exists'; end if;
  insert into suppliers(name,phone,contact_person,email,address,gstin) values(trim(p_name),nullif(trim(p_phone),''),nullif(trim(p_contact_person),''),nullif(trim(p_email),''),nullif(trim(p_address),''),nullif(upper(trim(p_gstin)),'')) returning id into v_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','supplier',v_id,jsonb_build_object('name',trim(p_name),'phone',nullif(trim(p_phone),''),'contact_person',nullif(trim(p_contact_person),''),'email',nullif(trim(p_email),''),'address',nullif(trim(p_address),''),'gstin',nullif(upper(trim(p_gstin)),'')));
  return v_id;
end $$;
grant execute on function public.create_supplier_master(text,text,text,text,text,text) to authenticated;

create or replace function public.update_supplier_master(p_supplier_id uuid,p_name text,p_phone text default null,p_contact_person text default null,p_email text default null,p_address text default null,p_gstin text default null,p_active boolean default true) returns void
language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype; v_before jsonb;
begin
  select * into v_user from phase4_owner_user(); if not found then raise exception 'Only the Owner can manage suppliers'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Supplier name is required'; end if;
  if exists(select 1 from suppliers where lower(trim(name))=lower(trim(p_name)) and id<>p_supplier_id) then raise exception 'A supplier with this name already exists'; end if;
  select jsonb_build_object('name',name,'phone',phone,'contact_person',contact_person,'email',email,'address',address,'gstin',gstin,'active',active) into v_before from suppliers where id=p_supplier_id;
  if v_before is null then raise exception 'Supplier not found'; end if;
  update suppliers set name=trim(p_name),phone=nullif(trim(p_phone),''),contact_person=nullif(trim(p_contact_person),''),email=nullif(trim(p_email),''),address=nullif(trim(p_address),''),gstin=nullif(upper(trim(p_gstin)),''),active=coalesce(p_active,true) where id=p_supplier_id;
  insert into audit_log(user_id,action,entity_type,entity_id,before,after) values(v_user.id,'update','supplier',p_supplier_id,v_before,jsonb_build_object('name',trim(p_name),'phone',nullif(trim(p_phone),''),'contact_person',nullif(trim(p_contact_person),''),'email',nullif(trim(p_email),''),'address',nullif(trim(p_address),''),'gstin',nullif(upper(trim(p_gstin)),''),'active',coalesce(p_active,true)));
end $$;
grant execute on function public.update_supplier_master(uuid,text,text,text,text,text,text,boolean) to authenticated;

create or replace function public.set_supplier_category_links(p_supplier_id uuid,p_purchase_category_ids uuid[] default '{}',p_expense_category_ids uuid[] default '{}',p_fixed_purchase_category_ids uuid[] default '{}') returns void
language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype;
begin select * into v_user from phase4_owner_user(); if not found then raise exception 'Only the Owner can manage supplier relationships'; end if; if not exists(select 1 from suppliers where id=p_supplier_id) then raise exception 'Supplier not found'; end if;
  update supplier_purchase_categories set is_fixed=false where purchase_category_id=any(coalesce(p_fixed_purchase_category_ids,'{}')) and supplier_id<>p_supplier_id;
  delete from supplier_purchase_categories where supplier_id=p_supplier_id;
  delete from supplier_expense_categories where supplier_id=p_supplier_id;
  insert into supplier_purchase_categories(supplier_id,purchase_category_id,is_fixed) select p_supplier_id,x,(x=any(coalesce(p_fixed_purchase_category_ids,'{}'))) from unnest(coalesce(p_purchase_category_ids,'{}')) x;
  insert into supplier_expense_categories(supplier_id,expense_category_id,is_fixed) select p_supplier_id,x,false from unnest(coalesce(p_expense_category_ids,'{}')) x;
end $$;
grant execute on function public.set_supplier_category_links(uuid,uuid[],uuid[],uuid[]) to authenticated;

-- Category forms update just one category's supplier membership. This avoids
-- replacing the other category links already maintained from the Supplier form.
create or replace function public.set_category_supplier_links(
  p_category_type text,
  p_category_id uuid,
  p_supplier_ids uuid[] default '{}',
  p_fixed_supplier_id uuid default null
) returns void
language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype;
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage supplier relationships'; end if;
  if p_category_type not in ('purchase','expense') then raise exception 'Invalid category type'; end if;
  if p_category_type='purchase' and not exists(select 1 from purchase_categories where id=p_category_id) then raise exception 'Purchase category not found'; end if;
  if p_category_type='expense' and not exists(select 1 from expense_categories where id=p_category_id) then raise exception 'Expense category not found'; end if;
  if exists(select 1 from unnest(coalesce(p_supplier_ids,'{}'::uuid[])) x where not exists(select 1 from suppliers where id=x)) then raise exception 'One or more suppliers were not found'; end if;
  if p_fixed_supplier_id is not null and (p_category_type<>'purchase' or not p_fixed_supplier_id=any(coalesce(p_supplier_ids,'{}'::uuid[]))) then raise exception 'The fixed supplier must be selected for this Purchase category'; end if;
  if p_category_type='purchase' then
    delete from supplier_purchase_categories where purchase_category_id=p_category_id;
    insert into supplier_purchase_categories(supplier_id,purchase_category_id,is_fixed)
    select distinct x,p_category_id,(x=p_fixed_supplier_id) from unnest(coalesce(p_supplier_ids,'{}'::uuid[])) x;
  else
    delete from supplier_expense_categories where expense_category_id=p_category_id;
    insert into supplier_expense_categories(supplier_id,expense_category_id,is_fixed)
    select distinct x,p_category_id,false from unnest(coalesce(p_supplier_ids,'{}'::uuid[])) x;
  end if;
end $$;
grant execute on function public.set_category_supplier_links(text,uuid,uuid[],uuid) to authenticated;

-- Canonical expense item setter. Transaction lines reference items directly.
drop function if exists public.set_expense_item(uuid,uuid);
create or replace function public.set_expense_item(p_transaction_id uuid,p_item_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from transactions where id=p_transaction_id and txn_type='expense') then raise exception 'Expense transaction not found'; end if;
  if p_item_id is not null and not exists(select 1 from items where id=p_item_id and active=true) then raise exception 'Item not found'; end if;
  update expense_details set item_id=p_item_id where transaction_id=p_transaction_id;
end $$;
grant execute on function public.set_expense_item(uuid,uuid) to authenticated;

-- Expense supplier/vendor capture: vendors can be routed by expense category too.
alter table public.expense_details add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;
create index if not exists idx_expense_details_supplier on public.expense_details(supplier_id);

create or replace function public.set_expense_supplier(p_transaction_id uuid,p_supplier_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from transactions where id=p_transaction_id and txn_type='expense') then raise exception 'Expense transaction not found'; end if;
  if p_supplier_id is not null and not exists(select 1 from suppliers where id=p_supplier_id and active=true) then raise exception 'Supplier not found'; end if;
  update expense_details set supplier_id=p_supplier_id where transaction_id=p_transaction_id;
end $$;
grant execute on function public.set_expense_supplier(uuid,uuid) to authenticated;

-- RLS for the canonical relationship tables. Writes are performed through SECURITY DEFINER RPCs.
alter table public.purchase_category_items enable row level security;
alter table public.expense_category_items enable row level security;
alter table public.supplier_purchase_categories enable row level security;
alter table public.supplier_expense_categories enable row level security;

drop policy if exists purchase_category_items_select on public.purchase_category_items;
create policy purchase_category_items_select on public.purchase_category_items for select to authenticated using (true);
drop policy if exists expense_category_items_select on public.expense_category_items;
create policy expense_category_items_select on public.expense_category_items for select to authenticated using (true);
drop policy if exists supplier_purchase_categories_select on public.supplier_purchase_categories;
create policy supplier_purchase_categories_select on public.supplier_purchase_categories for select to authenticated using (true);
drop policy if exists supplier_expense_categories_select on public.supplier_expense_categories;
create policy supplier_expense_categories_select on public.supplier_expense_categories for select to authenticated using (true);

-- Remove the obsolete Expense Item Catalog bridge completely after transaction details
-- have been migrated to items.id. This is safe after the clean reset because there is
-- no live dummy expense-item data to preserve.
alter table public.expense_details drop column if exists expense_item_id;
drop table if exists public.expense_item_catalog cascade;

-- Remove obsolete overloaded relationship RPCs left by earlier Phase 6 builds.
drop function if exists public.set_item_master_relationships(uuid,uuid[],uuid[],uuid[]);
drop function if exists public.create_item_master(text,text,text,numeric,numeric);
drop function if exists public.update_item_master(uuid,text,text,text,numeric,numeric,numeric,boolean);
