-- ============================================================================
-- PHASE 2 FIX — PURCHASE RATE UNLOCK + ITEM GST RATE MANAGEMENT
-- Run after db/phase2_supplier_rate_management.sql.
--
-- This migration:
--   1. Stores GST as a percentage on every item.
--   2. Snapshots the GST percentage used on each purchase line.
--   3. Calculates GST amount server-side from quantity × rate × GST %.
--   4. Removes GST-amount entry from the purchase workflow.
--   5. Supports audited master GST-rate updates from purchase entry.
--   6. Preserves historical purchase GST amounts; existing transactions are
--      never recalculated or rewritten.
-- ============================================================================

-- --------------------------------------------------------------------------
-- ITEM GST MASTER + HISTORY
-- --------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'items_gst_rate_range'
      and conrelid = 'items'::regclass
  ) then
    alter table items add constraint items_gst_rate_range check (gst_rate >= 0 and gst_rate <= 100);
  end if;
end $$;

create table if not exists item_gst_rate_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references items(id) on delete cascade not null,
  old_rate numeric(5,2) not null,
  new_rate numeric(5,2) not null,
  effective_from timestamptz not null default now(),
  changed_by uuid references users(id),
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_item_gst_rate_history_item_date
  on item_gst_rate_history(item_id, effective_from desc);

alter table item_gst_rate_history enable row level security;

drop policy if exists item_gst_rate_history_owner_select on item_gst_rate_history;
create policy item_gst_rate_history_owner_select on item_gst_rate_history
  for select using (current_user_role() = 'owner');

revoke all on item_gst_rate_history from anon;
grant select on item_gst_rate_history to authenticated;

-- --------------------------------------------------------------------------
-- PURCHASE LINE GST SNAPSHOT
-- --------------------------------------------------------------------------
alter table purchase_items
  add column if not exists gst_rate_at_entry numeric(5,2),
  add column if not exists gst_rate_overridden boolean not null default false;

create or replace function fn_snapshot_purchase_gst_rate() returns trigger as $$
declare
  v_master_gst numeric(5,2);
begin
  select gst_rate into v_master_gst from items where id = new.item_id;
  new.gst_rate_at_entry := coalesce(new.gst_rate_at_entry, v_master_gst, 0);
  new.gst_rate_overridden := round(coalesce(new.gst_rate_at_entry,0),2) <> round(coalesce(v_master_gst,0),2);
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_snapshot_purchase_gst_rate on purchase_items;
create trigger trg_snapshot_purchase_gst_rate
  before insert on purchase_items
  for each row execute function fn_snapshot_purchase_gst_rate();

-- --------------------------------------------------------------------------
-- PURCHASE WRITER
-- GST is now derived from the percentage supplied in p_items.
-- If a caller omits gst_rate, the current item master GST percentage is used.
-- The server never trusts a client-supplied GST amount.
-- --------------------------------------------------------------------------
create or replace function create_purchase(
  p_supplier_id uuid,
  p_paid_from_account_id uuid default null,
  p_txn_date date default current_date,
  p_description text default null,
  p_items jsonb default '[]'::jsonb
) returns uuid as $$
declare
  v_user users%rowtype;
  v_txn_id uuid;
  v_item jsonb;
  v_total numeric := 0;
  v_paid numeric := 0;
  v_supplier suppliers%rowtype;
  v_account accounts%rowtype;
  v_item_row items%rowtype;
  v_qty numeric;
  v_rate numeric;
  v_gst_rate numeric;
  v_gst numeric;
  v_line_total numeric;
begin
  select * into v_user from phase4_manager_user();
  if not found then raise exception 'Only an Owner or Manager can record purchases'; end if;
  perform phase3_assert_unlocked(p_txn_date);

  select * into v_supplier from suppliers where id=p_supplier_id and active=true;
  if v_supplier.id is null then raise exception 'Choose an active supplier'; end if;

  if jsonb_typeof(coalesce(p_items,'[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_items,'[]'::jsonb))=0 then
    raise exception 'Add at least one purchase item';
  end if;

  if p_paid_from_account_id is not null then
    select * into v_account from accounts where id=p_paid_from_account_id and active=true;
    if v_account.id is null then raise exception 'Choose an active payment account'; end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::numeric;
    v_rate := (v_item->>'rate')::numeric;
    select * into v_item_row from items where id=(v_item->>'item_id')::uuid and active=true;
    v_gst_rate := coalesce(nullif(v_item->>'gst_rate','')::numeric, v_item_row.gst_rate, 0);

    if v_item_row.id is null or v_qty<=0 or v_rate<0 or v_gst_rate<0 or v_gst_rate>100 then
      raise exception 'Every purchase line needs an active item, positive quantity, non-negative rate, and GST percentage between 0 and 100';
    end if;

    v_gst := round((v_qty * v_rate * v_gst_rate / 100),2);
    v_line_total := round(v_qty*v_rate+v_gst,2);
    v_total := v_total+v_line_total;
  end loop;

  if p_paid_from_account_id is not null then v_paid:=v_total; end if;

  insert into transactions(txn_type,txn_date,amount,description,created_by)
  values('purchase',p_txn_date,round(v_total,2),nullif(trim(p_description),''),v_user.id)
  returning id into v_txn_id;

  insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id) values
    (v_txn_id,null,'debit',round(v_total,2),'inventory',null),
    (v_txn_id,null,'credit',round(v_total,2),'supplier',v_supplier.id);

  if v_paid>0 then
    insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id) values
      (v_txn_id,null,'debit',round(v_paid,2),'supplier',v_supplier.id),
      (v_txn_id,v_account.id,'credit',round(v_paid,2),'supplier',v_supplier.id);
  end if;

  insert into purchase_details(transaction_id,supplier_id,paid_amount)
  values(v_txn_id,v_supplier.id,round(v_paid,2));

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::numeric;
    v_rate := (v_item->>'rate')::numeric;
    select * into v_item_row from items where id=(v_item->>'item_id')::uuid and active=true;
    v_gst_rate := coalesce(nullif(v_item->>'gst_rate','')::numeric, v_item_row.gst_rate, 0);
    v_gst := round((v_qty * v_rate * v_gst_rate / 100),2);
    v_line_total := round(v_qty*v_rate+v_gst,2);

    insert into purchase_items(
      transaction_id,item_id,quantity,rate,gst_amount,amount,gst_rate_at_entry
    ) values(
      v_txn_id,(v_item->>'item_id')::uuid,v_qty,v_rate,v_gst,v_line_total,round(v_gst_rate,2)
    );

    insert into stock_movements(item_id,transaction_id,movement_type,quantity,rate,reason)
    values((v_item->>'item_id')::uuid,v_txn_id,'purchase',v_qty,v_rate,'Purchase');
  end loop;

  insert into audit_log(user_id,action,entity_type,entity_id,after)
  values(v_user.id,'create','transaction',v_txn_id,jsonb_build_object(
    'txn_type','purchase','supplier_id',v_supplier.id,'amount',round(v_total,2),
    'paid_amount',round(v_paid,2),'txn_date',p_txn_date,
    'item_count',jsonb_array_length(p_items)
  ));

  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

-- --------------------------------------------------------------------------
-- ITEM MASTER UPDATE: record GST history as well as rate history.
-- --------------------------------------------------------------------------
drop function if exists update_item_master(uuid,text,text,text,numeric,numeric,numeric,boolean);

create or replace function update_item_master(
  p_item_id uuid,
  p_name text,
  p_category text,
  p_unit text,
  p_gst_rate numeric default 0,
  p_reorder_level numeric default 0,
  p_master_rate numeric default 0,
  p_active boolean default true
) returns void as $$
declare
  v_user users%rowtype;
  v_item items%rowtype;
  v_before jsonb;
  v_rate numeric(10,2) := round(coalesce(p_master_rate,0),2);
  v_gst numeric(5,2) := round(coalesce(p_gst_rate,0),2);
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage items'; end if;
  if nullif(trim(p_name),'') is null or nullif(trim(p_category),'') is null or nullif(trim(p_unit),'') is null then
    raise exception 'Item name, category, and unit are required';
  end if;
  if v_gst<0 or v_gst>100 or coalesce(p_reorder_level,0)<0 or v_rate<0 then
    raise exception 'GST must be between 0 and 100; reorder level and master rate cannot be negative';
  end if;

  select * into v_item from items where id=p_item_id;
  if not found then raise exception 'Item not found'; end if;

  v_before := jsonb_build_object(
    'name',v_item.name,'category',v_item.category,'unit',v_item.unit,
    'gst_rate',v_item.gst_rate,'reorder_level',v_item.reorder_level,
    'master_rate',v_item.master_rate,'active',v_item.active
  );

  update items set
    name=trim(p_name), category=trim(p_category), unit=trim(p_unit),
    gst_rate=v_gst, reorder_level=round(coalesce(p_reorder_level,0),3),
    master_rate=v_rate, active=coalesce(p_active,true)
  where id=p_item_id;

  if round(coalesce(v_item.master_rate,0),2) <> v_rate then
    insert into item_rate_history(item_id,old_rate,new_rate,changed_by,reason)
    values(p_item_id,round(coalesce(v_item.master_rate,0),2),v_rate,v_user.id,'Master rate updated');
  end if;

  if round(coalesce(v_item.gst_rate,0),2) <> v_gst then
    insert into item_gst_rate_history(item_id,old_rate,new_rate,changed_by,reason)
    values(p_item_id,round(coalesce(v_item.gst_rate,0),2),v_gst,v_user.id,'Master GST rate updated');
  end if;

  insert into audit_log(user_id,action,entity_type,entity_id,before,after)
  values(v_user.id,'update','item',p_item_id,v_before,jsonb_build_object(
    'name',trim(p_name),'category',trim(p_category),'unit',trim(p_unit),
    'gst_rate',v_gst,'reorder_level',round(coalesce(p_reorder_level,0),3),
    'master_rate',v_rate,'active',coalesce(p_active,true)
  ));
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function update_item_master(uuid,text,text,text,numeric,numeric,numeric,boolean) to authenticated;

-- --------------------------------------------------------------------------
-- ATOMIC PURCHASE + OPTIONAL MASTER RATE / GST UPDATE
-- --------------------------------------------------------------------------
drop function if exists create_purchase_with_master_rate_updates(uuid,uuid,date,text,jsonb,boolean);

create or replace function create_purchase_with_master_rate_updates(
  p_supplier_id uuid,
  p_paid_from_account_id uuid default null,
  p_txn_date date default current_date,
  p_description text default null,
  p_items jsonb default '[]'::jsonb,
  p_update_master_rates boolean default false,
  p_update_master_gst_rates boolean default false
) returns uuid as $$
declare
  v_user users%rowtype;
  v_txn_id uuid;
  v_item jsonb;
  v_item_row items%rowtype;
  v_new_rate numeric(10,2);
  v_new_gst numeric(5,2);
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists'; end if;
  if (p_update_master_rates or p_update_master_gst_rates) and v_user.role <> 'owner' then
    raise exception 'Only the Owner can update master rates or GST percentages from a purchase';
  end if;

  v_txn_id := create_purchase(p_supplier_id,p_paid_from_account_id,p_txn_date,p_description,p_items);

  for v_item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    select * into v_item_row from items where id=(v_item->>'item_id')::uuid;

    if p_update_master_rates then
      v_new_rate := round((v_item->>'rate')::numeric,2);
      if v_item_row.id is not null and round(coalesce(v_item_row.master_rate,0),2) <> v_new_rate then
        insert into item_rate_history(item_id,old_rate,new_rate,changed_by,reason)
        values(v_item_row.id,round(coalesce(v_item_row.master_rate,0),2),v_new_rate,v_user.id,'Updated from purchase entry ' || v_txn_id);
        update items set master_rate=v_new_rate where id=v_item_row.id;
        insert into audit_log(user_id,action,entity_type,entity_id,before,after)
        values(v_user.id,'rate_update_from_purchase','item',v_item_row.id,
          jsonb_build_object('master_rate',round(coalesce(v_item_row.master_rate,0),2),'source_transaction_id',v_txn_id),
          jsonb_build_object('master_rate',v_new_rate,'source_transaction_id',v_txn_id));
      end if;
    end if;

    if p_update_master_gst_rates then
      v_new_gst := round(coalesce((v_item->>'gst_rate')::numeric,v_item_row.gst_rate,0),2);
      if v_item_row.id is not null and round(coalesce(v_item_row.gst_rate,0),2) <> v_new_gst then
        insert into item_gst_rate_history(item_id,old_rate,new_rate,changed_by,reason)
        values(v_item_row.id,round(coalesce(v_item_row.gst_rate,0),2),v_new_gst,v_user.id,'Updated from purchase entry ' || v_txn_id);
        update items set gst_rate=v_new_gst where id=v_item_row.id;
        insert into audit_log(user_id,action,entity_type,entity_id,before,after)
        values(v_user.id,'gst_rate_update_from_purchase','item',v_item_row.id,
          jsonb_build_object('gst_rate',round(coalesce(v_item_row.gst_rate,0),2),'source_transaction_id',v_txn_id),
          jsonb_build_object('gst_rate',v_new_gst,'source_transaction_id',v_txn_id));
      end if;
    end if;
  end loop;

  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function create_purchase_with_master_rate_updates(uuid,uuid,date,text,jsonb,boolean,boolean) to authenticated;
