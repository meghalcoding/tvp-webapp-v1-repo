-- PHASE 6 — UNIVERSAL MASTER ITEM RELATIONSHIPS (SAFE EXISTING-DATA VERSION)
-- This migration intentionally does NOT assume items.name is UNIQUE.
-- It reuses existing items case-insensitively and only creates an item when no
-- matching active/inactive master item exists.

create table if not exists public.sales_channels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null unique,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.purchase_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.expense_item_catalog (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  unit text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.sales_channel_items (
  sales_channel_id uuid not null references public.sales_channels(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (sales_channel_id, item_id)
);

create table if not exists public.purchase_category_items (
  purchase_category_id uuid not null references public.purchase_categories(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (purchase_category_id, item_id)
);

create table if not exists public.expense_category_items (
  expense_category_id uuid not null references public.expense_categories(id) on delete cascade,
  expense_item_id uuid not null references public.expense_item_catalog(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (expense_category_id, expense_item_id)
);

insert into public.sales_channels(code,name,sort_order) values
 ('cash','Cash',1),('upi','UPI',2),('zomato','Zomato',3),('swiggy','Swiggy',4)
on conflict (code) do update set name=excluded.name, active=true, sort_order=excluded.sort_order;

insert into public.purchase_categories(name,sort_order) values
 ('TASTY Vada Pav Raw Material',1),('Beverage Vendor',2),('Amul Items',3),('Packaging',4)
on conflict (name) do update set active=true, sort_order=excluded.sort_order;

-- Historical supplier/category rows are preserved. Only future selection is
-- affected by deactivation/renaming.
update public.suppliers set active=false
where lower(name) in ('water bottle vendor','extra bun packet');

-- Canonicalise Singh -> Sing without requiring items.name to be unique.
do $$
declare
  v_sing uuid;
  v_singh uuid;
begin
  select id into v_sing from public.items where lower(trim(name))='sing' order by active desc, created_at asc limit 1;
  select id into v_singh from public.items where lower(trim(name))='singh' order by active desc, created_at asc limit 1;

  if v_sing is null and v_singh is not null then
    update public.items set name='Sing' where id=v_singh;
  elsif v_sing is not null and v_singh is not null and v_sing <> v_singh then
    update public.items set active=false where id=v_singh;
  end if;
end $$;

update public.items set active=false
where lower(trim(name))='extra bun packet';

-- Safely rename an expense category only when the target does not already
-- exist. If the target exists, the legacy source is simply deactivated.
do $$
declare
  v_source uuid;
  v_target uuid;
begin
  -- Satguru Water Supply -> Water Jug Vendor
  select id into v_source from public.expense_categories where lower(name)='satguru water supply' limit 1;
  select id into v_target from public.expense_categories where lower(name)='water jug vendor' limit 1;
  if v_source is not null and v_target is null then
    update public.expense_categories set name='Water Jug Vendor' where id=v_source;
  elsif v_source is not null and v_target is not null and v_source <> v_target then
    update public.expense_categories set active=false where id=v_source;
  end if;

  -- Vegetables -> Vegetables/Grocery
  select id into v_source from public.expense_categories where lower(name)='vegetables' limit 1;
  select id into v_target from public.expense_categories where lower(name)='vegetables/grocery' limit 1;
  if v_source is not null and v_target is null then
    update public.expense_categories set name='Vegetables/Grocery' where id=v_source;
  elsif v_source is not null and v_target is not null and v_source <> v_target then
    update public.expense_categories set active=false where id=v_source;
  end if;

  -- Staff Tiffin / Food Allowance -> Staff Extra
  select id into v_source from public.expense_categories where lower(name)='staff tiffin / food allowance' limit 1;
  select id into v_target from public.expense_categories where lower(name)='staff extra' limit 1;
  if v_source is not null and v_target is null then
    update public.expense_categories set name='Staff Extra' where id=v_source;
  elsif v_source is not null and v_target is not null and v_source <> v_target then
    update public.expense_categories set active=false where id=v_source;
  end if;

  -- Printing & Stationery -> Printing & Stationary
  select id into v_source from public.expense_categories where lower(name)='printing & stationery' limit 1;
  select id into v_target from public.expense_categories where lower(name)='printing & stationary' limit 1;
  if v_source is not null and v_target is null then
    update public.expense_categories set name='Printing & Stationary' where id=v_source;
  elsif v_source is not null and v_target is not null and v_source <> v_target then
    update public.expense_categories set active=false where id=v_source;
  end if;
end $$;

-- Categories explicitly removed from future selection. Historical transactions
-- remain intact because their IDs are not deleted.
update public.expense_categories set active=false
where lower(name) in ('amul items','chass masala','staff padiki','tea','plumber','staff transport','electrician','porter');

insert into public.expense_categories(name,pl_bucket,active)
values
 ('Salary','operating',true),
 ('Staff Extra','direct',true),
 ('Kitchen Operations','direct',true),
 ('Vegetables/Grocery','direct',true),
 ('Water Jug Vendor','operating',true),
 ('Service Providers','operating',true),
 ('Porter/Transport','operating',true),
 ('Printing & Stationary','operating',true)
on conflict (name) do update set active=true;

-- Helper: find an existing item by case-insensitive canonical name, otherwise
-- create it. This replaces the unsafe ON CONFLICT(name) pattern because the
-- legacy items table intentionally has no UNIQUE constraint on name.
create or replace function public.phase6_get_or_create_item(
  p_name text,
  p_category text,
  p_unit text,
  p_gst_rate numeric default 0,
  p_reorder_level numeric default 0,
  p_master_rate numeric default 0
) returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_id uuid;
begin
  select id into v_id
  from public.items
  where lower(trim(name))=lower(trim(p_name))
  order by active desc, created_at asc
  limit 1;

  if v_id is null then
    insert into public.items(name,category,unit,gst_rate,reorder_level,master_rate,active)
    values(p_name,p_category,p_unit,coalesce(p_gst_rate,0),coalesce(p_reorder_level,0),coalesce(p_master_rate,0),true)
    returning id into v_id;
  else
    update public.items
       set active=true,
           category=coalesce(nullif(p_category,''),category),
           unit=coalesce(nullif(p_unit,''),unit),
           gst_rate=coalesce(p_gst_rate,gst_rate),
           reorder_level=coalesce(p_reorder_level,reorder_level),
           master_rate=case when coalesce(p_master_rate,0) <> 0 then p_master_rate else master_rate end
     where id=v_id;
  end if;

  return v_id;
end $$;

grant execute on function public.phase6_get_or_create_item(text,text,text,numeric,numeric,numeric) to authenticated;

-- Requested master items. Existing names are reused case-insensitively.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('Water Bottle Crate (24 nos.)','Beverage','crate',0::numeric,0::numeric,110::numeric),
      ('Cold Drink Crate','Beverage','crate',0::numeric,0::numeric,0::numeric),
      ('Amul Cheese (500 gms)','Grocery','pack',0::numeric,0::numeric,0::numeric),
      ('Amul Cheese (1 KG)','Grocery','pack',0::numeric,0::numeric,0::numeric),
      ('Amul Butter (500 gms)','Grocery','pack',0::numeric,0::numeric,0::numeric),
      ('Amul Butter (1KG)','Grocery','pack',0::numeric,0::numeric,0::numeric),
      ('Frankie Cover','Packaging','pack',0::numeric,0::numeric,0::numeric),
      ('2 Vadapav Paper Bag','Packaging','pack',0::numeric,0::numeric,0::numeric),
      ('4 Vadapav Paper Bag','Packaging','pack',0::numeric,0::numeric,0::numeric),
      ('Paper Plate','Packaging','pack',0::numeric,0::numeric,0::numeric),
      ('Tissue','Packaging','pack',0::numeric,0::numeric,0::numeric),
      ('Aluminium Foil','Packaging','roll',0::numeric,0::numeric,0::numeric),
      ('Small Chutney Bag','Packaging','pack',0::numeric,0::numeric,0::numeric),
      ('Big Chutney Bag','Packaging','pack',0::numeric,0::numeric,0::numeric),
      ('Big Carry Bag','Packaging','pack',0::numeric,0::numeric,0::numeric),
      ('Small Carry Bag','Packaging','pack',0::numeric,0::numeric,0::numeric),
      ('Doro','Packaging','pack',0::numeric,0::numeric,0::numeric),
      ('Printer Roll','Packaging','roll',0::numeric,0::numeric,0::numeric)
    ) as x(name,category,unit,gst_rate,reorder_level,master_rate)
  loop
    perform public.phase6_get_or_create_item(r.name,r.category,r.unit,r.gst_rate,r.reorder_level,r.master_rate);
  end loop;
end $$;

-- Purchase relationships.
with cat as (select id from public.purchase_categories where name='TASTY Vada Pav Raw Material')
insert into public.purchase_category_items(purchase_category_id,item_id)
select cat.id,i.id from cat cross join public.items i
where i.active and lower(trim(i.name)) in (
 'pav (18 pcs)','vada masalo aalu','lal chatni','green chatni','dabeli masalo',
 'red kora masala','roti/tikki','vimal butter packet 500gms','vimal cheese','sing',
 'sev','mayonnaise','white cheese','ketchup','schezwan','chat masala'
) on conflict do nothing;

with cat as (select id from public.purchase_categories where name='Beverage Vendor')
insert into public.purchase_category_items(purchase_category_id,item_id)
select cat.id,i.id from cat cross join public.items i
where i.active and lower(trim(i.name)) in ('water bottle crate (24 nos.)','cold drink crate') on conflict do nothing;

with cat as (select id from public.purchase_categories where name='Amul Items')
insert into public.purchase_category_items(purchase_category_id,item_id)
select cat.id,i.id from cat cross join public.items i
where i.active and lower(trim(i.name)) in ('amul cheese (500 gms)','amul cheese (1 kg)','amul butter (500 gms)','amul butter (1kg)') on conflict do nothing;

with cat as (select id from public.purchase_categories where name='Packaging')
insert into public.purchase_category_items(purchase_category_id,item_id)
select cat.id,i.id from cat cross join public.items i
where i.active and lower(trim(i.name)) in ('frankie cover','2 vadapav paper bag','4 vadapav paper bag','paper plate','tissue','aluminium foil','small chutney bag','big chutney bag','big carry bag','small carry bag','doro','printer roll') on conflict do nothing;

-- Expense item catalog.
insert into public.expense_item_catalog(name,unit) values
 ('Prakash (Worker 1)',null),('Ramila (Worker 2)',null),('Worker 3',null),
 ('Staff Food/Snacks/Tea',null),('Staff Padiki',null),('Staff Bonus',null),('Staff Home Grocery',null),('Staff Home Rent',null),('Staff Transport',null),('Staff Misc.',null),
 ('Cabbage','kg'),('Onion','kg'),('Dhaniya','kg'),('Marcha','kg'),('Besan','kg'),('Baking Soda','pack'),('Salt','kg'),('Chhas masala','kg'),('Chhas','ltr'),
 ('Electrician',null),('Plumber',null),('Carpenter',null),('Internet',null),('CCTV',null),
 ('Porter',null),('Rapido',null),('Rickshaw',null),('Train',null),('Flight',null),('Petrol/Diesel',null)
on conflict (name) do update set active=true;

with c as (select id from public.expense_categories where name='Salary')
insert into public.expense_category_items(expense_category_id,expense_item_id)
select c.id,e.id from c cross join public.expense_item_catalog e where e.name in ('Prakash (Worker 1)','Ramila (Worker 2)','Worker 3') on conflict do nothing;
with c as (select id from public.expense_categories where name='Staff Extra')
insert into public.expense_category_items(expense_category_id,expense_item_id)
select c.id,e.id from c cross join public.expense_item_catalog e where e.name in ('Staff Food/Snacks/Tea','Staff Padiki','Staff Bonus','Staff Home Grocery','Staff Home Rent','Staff Transport','Staff Misc.') on conflict do nothing;
with c as (select id from public.expense_categories where name='Vegetables/Grocery')
insert into public.expense_category_items(expense_category_id,expense_item_id)
select c.id,e.id from c cross join public.expense_item_catalog e where e.name in ('Cabbage','Onion','Dhaniya','Marcha','Besan','Baking Soda','Salt','Chhas masala','Chhas') on conflict do nothing;
with c as (select id from public.expense_categories where name='Service Providers')
insert into public.expense_category_items(expense_category_id,expense_item_id)
select c.id,e.id from c cross join public.expense_item_catalog e where e.name in ('Electrician','Plumber','Carpenter','Internet','CCTV') on conflict do nothing;
with c as (select id from public.expense_categories where name='Porter/Transport')
insert into public.expense_category_items(expense_category_id,expense_item_id)
select c.id,e.id from c cross join public.expense_item_catalog e where e.name in ('Porter','Rapido','Rickshaw','Train','Flight','Petrol/Diesel') on conflict do nothing;

-- Secure relationship writers behind RPCs.
create or replace function public.set_item_master_relationships(
 p_item_id uuid,
 p_sales_channel_ids uuid[] default '{}',
 p_purchase_category_ids uuid[] default '{}'
) returns void language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype;
begin
 select * into v_user from phase3_current_user();
 if not found or v_user.role not in ('owner','manager') then raise exception 'Only Owner or Manager can manage item relationships'; end if;
 if not exists(select 1 from items where id=p_item_id) then raise exception 'Item not found'; end if;
 delete from sales_channel_items where item_id=p_item_id;
 delete from purchase_category_items where item_id=p_item_id;
 insert into sales_channel_items(sales_channel_id,item_id) select x,p_item_id from unnest(coalesce(p_sales_channel_ids,'{}')) x on conflict do nothing;
 insert into purchase_category_items(purchase_category_id,item_id) select x,p_item_id from unnest(coalesce(p_purchase_category_ids,'{}')) x on conflict do nothing;
end; $$;
grant execute on function public.set_item_master_relationships(uuid,uuid[],uuid[]) to authenticated;

create or replace function public.set_expense_item_relationships(
 p_expense_item_id uuid,
 p_category_ids uuid[] default '{}'
) returns void language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype;
begin
 select * into v_user from phase3_current_user();
 if not found or v_user.role not in ('owner','manager') then raise exception 'Only Owner or Manager can manage expense item relationships'; end if;
 delete from expense_category_items where expense_item_id=p_expense_item_id;
 insert into expense_category_items(expense_category_id,expense_item_id) select x,p_expense_item_id from unnest(coalesce(p_category_ids,'{}')) x on conflict do nothing;
end; $$;
grant execute on function public.set_expense_item_relationships(uuid,uuid[]) to authenticated;

-- Searchable universal resolver views.
create or replace view public.item_sales_context as
select i.id item_id,i.name item_name,c.id context_id,c.name context_name
from items i join sales_channel_items m on m.item_id=i.id join sales_channels c on c.id=m.sales_channel_id
where i.active and c.active;
create or replace view public.item_purchase_context as
select i.id item_id,i.name item_name,c.id context_id,c.name context_name
from items i join purchase_category_items m on m.item_id=i.id join purchase_categories c on c.id=m.purchase_category_id
where i.active and c.active;
create or replace view public.item_expense_context as
select e.id item_id,e.name item_name,c.id context_id,c.name context_name
from expense_item_catalog e join expense_category_items m on m.expense_item_id=e.id join expense_categories c on c.id=m.expense_category_id
where e.active and c.active;

-- RLS: authenticated users can read mappings; writes go through RPCs.
alter table sales_channels enable row level security;
alter table purchase_categories enable row level security;
alter table expense_item_catalog enable row level security;
alter table sales_channel_items enable row level security;
alter table purchase_category_items enable row level security;
alter table expense_category_items enable row level security;

drop policy if exists sales_channels_read on sales_channels;
create policy sales_channels_read on sales_channels for select to authenticated using (true);
drop policy if exists purchase_categories_read on purchase_categories;
create policy purchase_categories_read on purchase_categories for select to authenticated using (true);
drop policy if exists expense_item_catalog_read on expense_item_catalog;
create policy expense_item_catalog_read on expense_item_catalog for select to authenticated using (true);
drop policy if exists sales_channel_items_read on sales_channel_items;
create policy sales_channel_items_read on sales_channel_items for select to authenticated using (true);
drop policy if exists purchase_category_items_read on purchase_category_items;
create policy purchase_category_items_read on purchase_category_items for select to authenticated using (true);
drop policy if exists expense_category_items_read on expense_category_items;
create policy expense_category_items_read on expense_category_items for select to authenticated using (true);

-- Budget lines can reference the universal context selected by the user.
alter table public.budget_lines add column if not exists sales_channel_id uuid references public.sales_channels(id);
alter table public.budget_lines add column if not exists purchase_category_id uuid references public.purchase_categories(id);
alter table public.budget_lines add column if not exists expense_item_id uuid references public.expense_item_catalog(id);
create index if not exists idx_budget_lines_sales_channel on public.budget_lines(sales_channel_id);
create index if not exists idx_budget_lines_purchase_category on public.budget_lines(purchase_category_id);
create index if not exists idx_budget_lines_expense_item on public.budget_lines(expense_item_id);

-- Cleanup helper: application code should use the relationship resolver; the
-- helper is kept available for the migration/runtime compatibility layer.
