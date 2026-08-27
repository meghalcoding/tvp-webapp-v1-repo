-- ============================================================================
-- PHASE 6 RELATIONSHIP FOUNDATION
-- Universal Channel/Category -> Item mappings used by budgeting and operations.
-- Run after Phase 6A/6B budget builder and current Phase 5 migrations.
-- ============================================================================

create table if not exists sales_channels (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null unique,
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists sales_channel_items (
  sales_channel_id uuid references sales_channels(id) on delete cascade not null,
  item_id uuid references items(id) on delete cascade not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (sales_channel_id, item_id)
);

create table if not exists purchase_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  supplier_id uuid references suppliers(id) on delete set null,
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists purchase_category_items (
  purchase_category_id uuid references purchase_categories(id) on delete cascade not null,
  item_id uuid references items(id) on delete cascade not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (purchase_category_id, item_id)
);

-- Expense items are a separate catalog because transaction expense_items are
-- historical transaction lines and must remain immutable. An expense item can
-- be used only under the category to which it is linked.
create table if not exists expense_item_catalog (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references expense_categories(id) on delete cascade not null,
  name text not null,
  unit text,
  default_rate numeric(12,2) not null default 0 check (default_rate >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (category_id, name)
);

-- Budget line relationship fields.
alter table budget_lines add column if not exists sales_channel_id uuid references sales_channels(id);
alter table budget_lines add column if not exists purchase_category_id uuid references purchase_categories(id);
alter table budget_lines add column if not exists expense_item_id uuid references expense_item_catalog(id);

create index if not exists idx_sales_channel_items_item on sales_channel_items(item_id);
create index if not exists idx_purchase_category_items_item on purchase_category_items(item_id);
create index if not exists idx_expense_item_catalog_category on expense_item_catalog(category_id);
create index if not exists idx_budget_lines_sales_channel on budget_lines(sales_channel_id);
create index if not exists idx_budget_lines_purchase_category on budget_lines(purchase_category_id);
create index if not exists idx_budget_lines_expense_item on budget_lines(expense_item_id);

-- Replace the old generic target check with budget-type-aware relationships.
alter table budget_lines drop constraint if exists budget_line_target_check;
alter table budget_lines add constraint budget_line_target_check check (
  (budget_version_id is not null)
  and (
    (sales_channel_id is not null and item_id is null and purchase_category_id is null and expense_item_id is null)
    or
    (sales_channel_id is not null and item_id is not null and purchase_category_id is null and expense_item_id is null)
    or
    (purchase_category_id is not null and item_id is not null and sales_channel_id is null and expense_item_id is null)
    or
    (purchase_category_id is not null and item_id is null and sales_channel_id is null and expense_item_id is null)
    or
    (category_id is not null and expense_item_id is null and item_id is null and sales_channel_id is null and purchase_category_id is null)
    or
    (category_id is not null and expense_item_id is not null and item_id is null and sales_channel_id is null and purchase_category_id is null)
    or
    (item_id is not null and sales_channel_id is null and purchase_category_id is null and expense_item_id is null)
  )
);

-- Seed the five business-facing sales channels. The existing sale_details
-- channel text remains unchanged for transaction compatibility.
insert into sales_channels(key,name,display_order) values
  ('walk_in','Walk-in',1),
  ('cash','Cash',2),
  ('upi','UPI',3),
  ('zomato','Zomato',4),
  ('swiggy','Swiggy',5)
on conflict(key) do update set name=excluded.name, active=true, display_order=excluded.display_order;

-- Initial sales mapping: every currently active item is available to every
-- channel. Owner/Manager can later narrow this mapping without touching sales
-- transactions or the item master.
insert into sales_channel_items(sales_channel_id,item_id,active)
select sc.id,i.id,true
from sales_channels sc cross join items i
where sc.active=true and i.active=true
on conflict (sales_channel_id,item_id) do update set active=true;

-- Purchase categories: the existing item category labels plus supplier-specific
-- purchasing workflows. Supplier-specific categories let Tasty Vadapav remain
-- a bulk category selection rather than an item-by-item builder.
insert into purchase_categories(name, supplier_id, display_order)
select 'Raw Material', null, 1
where not exists (select 1 from purchase_categories where lower(name)=lower('Raw Material'));

insert into purchase_categories(name, supplier_id, display_order)
select 'Grocery', null, 2
where not exists (select 1 from purchase_categories where lower(name)=lower('Grocery'));

insert into purchase_categories(name, supplier_id, display_order)
select s.name, s.id, 10 + row_number() over(order by s.name)::int
from suppliers s
where s.active=true
  and not exists (select 1 from purchase_categories pc where lower(pc.name)=lower(s.name));

-- Generic item-category mappings.
insert into purchase_category_items(purchase_category_id,item_id,active)
select pc.id,i.id,true
from purchase_categories pc
join items i on lower(i.category)=lower(pc.name) and i.active=true
where pc.supplier_id is null
on conflict (purchase_category_id,item_id) do update set active=true;

-- Supplier-specific mappings come from the already canonical Tasty template
-- where available, and otherwise from historical purchase lines.
insert into purchase_category_items(purchase_category_id,item_id,active)
select pc.id,t.item_id,true
from purchase_categories pc
join supplier_purchase_templates t on t.supplier_id=pc.supplier_id and t.active=true
where pc.supplier_id is not null and t.item_id is not null
on conflict (purchase_category_id,item_id) do update set active=true;

insert into purchase_category_items(purchase_category_id,item_id,active)
select pc.id,pi.item_id,true
from purchase_categories pc
join purchase_details pd on pd.supplier_id=pc.supplier_id
join purchase_items pi on pi.transaction_id=pd.transaction_id
where pc.supplier_id is not null
on conflict (purchase_category_id,item_id) do update set active=true;

-- Seed expense item catalog from actual historical itemized expenses. This
-- preserves existing transaction text while making the same descriptions
-- reusable for future detailed expense entry and budgets.
insert into expense_item_catalog(category_id,name,unit,default_rate,active)
select ed.category_id, trim(ei.description), max(ei.unit),
       coalesce(round(avg(nullif(ei.rate,0)),2),0), true
from expense_items ei
join expense_details ed on ed.transaction_id=ei.transaction_id
where trim(coalesce(ei.description,'')) <> ''
group by ed.category_id, trim(ei.description)
on conflict (category_id,name) do update set
  active=true,
  unit=coalesce(expense_item_catalog.unit,excluded.unit),
  default_rate=case when expense_item_catalog.default_rate=0 then excluded.default_rate else expense_item_catalog.default_rate end;

-- RLS.
alter table sales_channels enable row level security;
alter table sales_channel_items enable row level security;
alter table purchase_categories enable row level security;
alter table purchase_category_items enable row level security;
alter table expense_item_catalog enable row level security;

drop policy if exists sales_channels_select on sales_channels;
create policy sales_channels_select on sales_channels for select using (auth.uid() is not null);
drop policy if exists sales_channels_write on sales_channels;
create policy sales_channels_write on sales_channels for all using (current_user_role() in ('owner','manager')) with check (current_user_role() in ('owner','manager'));

drop policy if exists sales_channel_items_select on sales_channel_items;
create policy sales_channel_items_select on sales_channel_items for select using (auth.uid() is not null);
drop policy if exists sales_channel_items_write on sales_channel_items;
create policy sales_channel_items_write on sales_channel_items for all using (current_user_role() in ('owner','manager')) with check (current_user_role() in ('owner','manager'));

drop policy if exists purchase_categories_select on purchase_categories;
create policy purchase_categories_select on purchase_categories for select using (auth.uid() is not null);
drop policy if exists purchase_categories_write on purchase_categories;
create policy purchase_categories_write on purchase_categories for all using (current_user_role() in ('owner','manager')) with check (current_user_role() in ('owner','manager'));

drop policy if exists purchase_category_items_select on purchase_category_items;
create policy purchase_category_items_select on purchase_category_items for select using (auth.uid() is not null);
drop policy if exists purchase_category_items_write on purchase_category_items;
create policy purchase_category_items_write on purchase_category_items for all using (current_user_role() in ('owner','manager')) with check (current_user_role() in ('owner','manager'));

drop policy if exists expense_item_catalog_select on expense_item_catalog;
create policy expense_item_catalog_select on expense_item_catalog for select using (auth.uid() is not null);
drop policy if exists expense_item_catalog_write on expense_item_catalog;
create policy expense_item_catalog_write on expense_item_catalog for all using (current_user_role() in ('owner','manager')) with check (current_user_role() in ('owner','manager'));

notify pgrst, 'reload schema';

-- ============================================================================
-- PHASE 6 RELATIONSHIP-AWARE BUDGET RPCS
-- ============================================================================

drop function if exists create_budget_version(date,text,text,jsonb);
create or replace function create_budget_version(
  p_month_start date,
  p_budget_type text,
  p_notes text default null,
  p_lines jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_user users%rowtype;
  v_period_id uuid;
  v_version_id uuid;
  v_next integer;
  v_line jsonb;
  v_item_id uuid;
  v_category_id uuid;
  v_sales_channel_id uuid;
  v_purchase_category_id uuid;
  v_expense_item_id uuid;
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists for this signed-in user'; end if;
  if v_user.role not in ('owner','manager') then raise exception 'Only Owner or Manager can manage budgets'; end if;
  if p_budget_type not in ('sales','purchase','expense','wastage') then raise exception 'Invalid budget type'; end if;
  if p_month_start is null then raise exception 'Budget month is required'; end if;
  if jsonb_typeof(coalesce(p_lines,'[]'::jsonb)) <> 'array' then raise exception 'Budget lines must be a list'; end if;

  insert into budget_periods(month_start,created_by)
  values(date_trunc('month',p_month_start)::date,v_user.id)
  on conflict(month_start) do nothing;
  select id into v_period_id from budget_periods where month_start=date_trunc('month',p_month_start)::date;

  select coalesce(max(version_no),0)+1 into v_next
  from budget_versions where budget_period_id=v_period_id and budget_type=p_budget_type;

  insert into budget_versions(budget_period_id,budget_type,version_no,status,notes,created_by)
  values(v_period_id,p_budget_type,v_next,'draft',nullif(trim(p_notes),''),v_user.id)
  returning id into v_version_id;

  for v_line in select value from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) loop
    v_item_id := nullif(v_line->>'item_id','')::uuid;
    v_category_id := nullif(v_line->>'category_id','')::uuid;
    v_sales_channel_id := nullif(v_line->>'sales_channel_id','')::uuid;
    v_purchase_category_id := nullif(v_line->>'purchase_category_id','')::uuid;
    v_expense_item_id := nullif(v_line->>'expense_item_id','')::uuid;

    if p_budget_type='sales' then
      if v_sales_channel_id is null then raise exception 'Sales budget requires a sales channel'; end if;
      if v_item_id is not null and not exists (
        select 1 from sales_channel_items where sales_channel_id=v_sales_channel_id and item_id=v_item_id and active=true
      ) then raise exception 'Selected sales item is not linked to this channel'; end if;
    elsif p_budget_type='purchase' then
      if v_purchase_category_id is null then raise exception 'Purchase budget requires a purchase category'; end if;
      if v_item_id is not null and not exists (
        select 1 from purchase_category_items where purchase_category_id=v_purchase_category_id and item_id=v_item_id and active=true
      ) then raise exception 'Selected purchase item is not linked to this category'; end if;
    elsif p_budget_type='expense' then
      if v_category_id is null then raise exception 'Expense budget requires an expense category'; end if;
      if v_expense_item_id is not null and not exists (
        select 1 from expense_item_catalog where id=v_expense_item_id and category_id=v_category_id and active=true
      ) then raise exception 'Selected expense item is not linked to this category'; end if;
    elsif p_budget_type='wastage' then
      if v_item_id is null then raise exception 'Wastage budget requires an item'; end if;
    end if;

    insert into budget_lines(
      budget_version_id,item_id,category_id,sales_channel_id,purchase_category_id,expense_item_id,
      description,quantity,rate,sort_order
    )
    values(
      v_version_id,v_item_id,v_category_id,v_sales_channel_id,v_purchase_category_id,v_expense_item_id,
      nullif(trim(v_line->>'description'),''),
      greatest(coalesce((v_line->>'quantity')::numeric,0),0),
      greatest(coalesce((v_line->>'rate')::numeric,0),0),
      coalesce((v_line->>'sort_order')::integer,0)
    );
  end loop;
  return v_version_id;
end;
$$;

drop function if exists replace_budget_version_lines(uuid,jsonb,text);
create or replace function replace_budget_version_lines(
  p_version_id uuid,
  p_lines jsonb,
  p_notes text default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_user users%rowtype;
  v_version budget_versions%rowtype;
  v_line jsonb;
  v_item_id uuid;
  v_category_id uuid;
  v_sales_channel_id uuid;
  v_purchase_category_id uuid;
  v_expense_item_id uuid;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role not in ('owner','manager') then raise exception 'Only Owner or Manager can manage budgets'; end if;
  select * into v_version from budget_versions where id=p_version_id;
  if v_version.id is null then raise exception 'Budget version not found'; end if;
  if v_version.status <> 'draft' then raise exception 'Only draft budget versions can be edited'; end if;
  if jsonb_typeof(coalesce(p_lines,'[]'::jsonb)) <> 'array' then raise exception 'Budget lines must be a list'; end if;

  delete from budget_lines where budget_version_id=p_version_id;
  update budget_versions set notes=nullif(trim(p_notes),'' ) where id=p_version_id;

  for v_line in select value from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) loop
    v_item_id := nullif(v_line->>'item_id','')::uuid;
    v_category_id := nullif(v_line->>'category_id','')::uuid;
    v_sales_channel_id := nullif(v_line->>'sales_channel_id','')::uuid;
    v_purchase_category_id := nullif(v_line->>'purchase_category_id','')::uuid;
    v_expense_item_id := nullif(v_line->>'expense_item_id','')::uuid;

    if v_version.budget_type='sales' then
      if v_sales_channel_id is null then raise exception 'Sales budget requires a sales channel'; end if;
      if v_item_id is not null and not exists (
        select 1 from sales_channel_items where sales_channel_id=v_sales_channel_id and item_id=v_item_id and active=true
      ) then raise exception 'Selected sales item is not linked to this channel'; end if;
    elsif v_version.budget_type='purchase' then
      if v_purchase_category_id is null then raise exception 'Purchase budget requires a purchase category'; end if;
      if v_item_id is not null and not exists (
        select 1 from purchase_category_items where purchase_category_id=v_purchase_category_id and item_id=v_item_id and active=true
      ) then raise exception 'Selected purchase item is not linked to this category'; end if;
    elsif v_version.budget_type='expense' then
      if v_category_id is null then raise exception 'Expense budget requires an expense category'; end if;
      if v_expense_item_id is not null and not exists (
        select 1 from expense_item_catalog where id=v_expense_item_id and category_id=v_category_id and active=true
      ) then raise exception 'Selected expense item is not linked to this category'; end if;
    elsif v_version.budget_type='wastage' then
      if v_item_id is null then raise exception 'Wastage budget requires an item'; end if;
    end if;

    insert into budget_lines(
      budget_version_id,item_id,category_id,sales_channel_id,purchase_category_id,expense_item_id,
      description,quantity,rate,sort_order
    )
    values(
      p_version_id,v_item_id,v_category_id,v_sales_channel_id,v_purchase_category_id,v_expense_item_id,
      nullif(trim(v_line->>'description'),''),
      greatest(coalesce((v_line->>'quantity')::numeric,0),0),
      greatest(coalesce((v_line->>'rate')::numeric,0),0),
      coalesce((v_line->>'sort_order')::integer,0)
    );
  end loop;
end;
$$;

grant execute on function create_budget_version(date,text,text,jsonb) to authenticated;
grant execute on function replace_budget_version_lines(uuid,jsonb,text) to authenticated;

notify pgrst, 'reload schema';
