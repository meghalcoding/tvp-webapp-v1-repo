-- Phase 6 Universal Picker + Expense Item Bridge
-- Safe to run after phase6_master_relationships_fixed.sql.

alter table public.expense_item_catalog
  add column if not exists master_item_id uuid references public.items(id) on delete set null;

alter table public.expense_details
  add column if not exists expense_item_id uuid references public.expense_item_catalog(id) on delete set null;

create index if not exists idx_expense_item_catalog_master_item
  on public.expense_item_catalog(master_item_id);

create index if not exists idx_expense_details_expense_item
  on public.expense_details(expense_item_id);

-- Link existing expense catalog rows to master items by canonical name where possible.
update public.expense_item_catalog e
set master_item_id = i.id
from lateral (
  select id from public.items i
  where lower(trim(i.name)) = lower(trim(e.name))
  order by i.active desc, i.created_at asc
  limit 1
) i
where e.master_item_id is null;

-- Create/update the master relationship RPC with Expense Category support.
drop function if exists public.set_item_master_relationships(uuid,uuid[],uuid[]);
create or replace function public.set_item_master_relationships(
  p_item_id uuid,
  p_sales_channel_ids uuid[] default '{}',
  p_purchase_category_ids uuid[] default '{}',
  p_expense_category_ids uuid[] default '{}'
) returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_expense_item_id uuid;
  v_item_name text;
  v_item_unit text;
begin
  if p_item_id is null then raise exception 'Item is required'; end if;
  select name,unit into v_item_name,v_item_unit from public.items where id=p_item_id;
  if v_item_name is null then raise exception 'Master item not found'; end if;

  delete from public.sales_channel_items where item_id=p_item_id;
  insert into public.sales_channel_items(sales_channel_id,item_id)
  select x,p_item_id from unnest(coalesce(p_sales_channel_ids,'{}')) x on conflict do nothing;

  delete from public.purchase_category_items where item_id=p_item_id;
  insert into public.purchase_category_items(purchase_category_id,item_id)
  select x,p_item_id from unnest(coalesce(p_purchase_category_ids,'{}')) x on conflict do nothing;

  -- Expense items historically use their own catalog. Reuse/create the catalog row
  -- for this master item so the same item can participate in expense routing too.
  select id into v_expense_item_id
  from public.expense_item_catalog
  where master_item_id=p_item_id
  order by active desc, id
  limit 1;

  if v_expense_item_id is null then
    select id into v_expense_item_id
    from public.expense_item_catalog
    where lower(trim(name))=lower(trim(v_item_name))
    order by active desc, id
    limit 1;
  end if;

  if v_expense_item_id is null and coalesce(array_length(p_expense_category_ids,1),0)>0 then
    insert into public.expense_item_catalog(name,unit,active,master_item_id)
    values(v_item_name,nullif(v_item_unit,''),true,p_item_id)
    returning id into v_expense_item_id;
  elsif v_expense_item_id is not null then
    update public.expense_item_catalog
       set master_item_id=p_item_id,
           name=v_item_name,
           unit=coalesce(nullif(v_item_unit,''),unit),
           active=true
     where id=v_expense_item_id;
  end if;

  if v_expense_item_id is not null then
    delete from public.expense_category_items where expense_item_id=v_expense_item_id;
    insert into public.expense_category_items(expense_category_id,expense_item_id)
    select x,v_expense_item_id from unnest(coalesce(p_expense_category_ids,'{}')) x on conflict do nothing;
  end if;
end;
$$;

grant execute on function public.set_item_master_relationships(uuid,uuid[],uuid[],uuid[]) to authenticated;

-- Helper used by the Expense quick-entry form after a transaction is created.
create or replace function public.set_expense_item(
  p_transaction_id uuid,
  p_expense_item_id uuid default null
) returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_user users%rowtype;
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists for this signed-in user'; end if;

  if not exists(select 1 from transactions where id=p_transaction_id and txn_type='expense') then
    raise exception 'Expense transaction not found';
  end if;

  update expense_details
  set expense_item_id=p_expense_item_id
  where transaction_id=p_transaction_id;

  if not found then raise exception 'Expense details not found'; end if;
end;
$$;

grant execute on function public.set_expense_item(uuid,uuid) to authenticated;

-- Read policy for the new bridge column is covered by the existing catalog policy.
