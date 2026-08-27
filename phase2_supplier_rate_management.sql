-- ============================================================================
-- NEW PHASE 2 — SUPPLIER MASTER + RATE MANAGEMENT
-- Run after the existing schema, Phase 2 financial engine, Phase 3 daily
-- operations, Phase 4 procurement/inventory, Phase 6 automation, and Phase 7
-- hardening migrations.
--
-- This migration is additive and keeps historical transaction data intact.
-- It separates the item's current MASTER RATE from the LAST PURCHASE RATE:
--   - master_rate = rate suggested/locked by the purchase-entry UI
--   - last_purchase_rate = actual most recent transaction rate, used for stock
--     valuation and operational history
-- ============================================================================

-- --------------------------------------------------------------------------
-- SUPPLIER MASTER FIELDS
-- --------------------------------------------------------------------------
alter table suppliers
  add column if not exists contact_person text,
  add column if not exists email text,
  add column if not exists address text,
  add column if not exists gstin text;

-- --------------------------------------------------------------------------
-- ITEM MASTER RATE
-- --------------------------------------------------------------------------
alter table items
  add column if not exists master_rate numeric(10,2) not null default 0;

-- Existing records already use last_purchase_rate as the effective configured
-- rate. Seed master_rate from that value exactly once for existing items.
update items
set master_rate = last_purchase_rate
where master_rate = 0 and last_purchase_rate <> 0;

-- --------------------------------------------------------------------------
-- PURCHASE RATE AUDIT CONTEXT
-- --------------------------------------------------------------------------
alter table purchase_items
  add column if not exists master_rate_at_entry numeric(10,2),
  add column if not exists rate_overridden boolean not null default false;

update purchase_items pi
set master_rate_at_entry = coalesce(i.master_rate, pi.rate),
    rate_overridden = false
from items i
where i.id = pi.item_id
  and pi.master_rate_at_entry is null;

create table if not exists item_rate_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references items(id) on delete cascade not null,
  old_rate numeric(10,2) not null,
  new_rate numeric(10,2) not null,
  effective_from timestamptz not null default now(),
  changed_by uuid references users(id),
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_item_rate_history_item_date
  on item_rate_history(item_id, effective_from desc);

alter table item_rate_history enable row level security;

drop policy if exists item_rate_history_owner_select on item_rate_history;
create policy item_rate_history_owner_select on item_rate_history
  for select using (current_user_role() = 'owner');

-- --------------------------------------------------------------------------
-- PURCHASE LINE RATE SNAPSHOT
-- Runs before the existing last_purchase_rate trigger.
-- --------------------------------------------------------------------------
create or replace function fn_snapshot_purchase_master_rate() returns trigger as $$
declare
  v_master_rate numeric(10,2);
begin
  select master_rate into v_master_rate from items where id = new.item_id;
  new.master_rate_at_entry := coalesce(v_master_rate, new.rate);
  new.rate_overridden := round(coalesce(new.rate,0),2) <> round(coalesce(v_master_rate,0),2);
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_snapshot_purchase_master_rate on purchase_items;
create trigger trg_snapshot_purchase_master_rate
  before insert on purchase_items
  for each row execute function fn_snapshot_purchase_master_rate();

-- --------------------------------------------------------------------------
-- SUPPLIER MASTER CREATE / UPDATE
-- --------------------------------------------------------------------------
drop function if exists create_supplier_master(text,text);

create or replace function create_supplier_master(
  p_name text,
  p_phone text default null,
  p_contact_person text default null,
  p_email text default null,
  p_address text default null,
  p_gstin text default null
) returns uuid as $$
declare
  v_user users%rowtype;
  v_id uuid;
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage suppliers'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Supplier name is required'; end if;

  insert into suppliers(name,phone,contact_person,email,address,gstin)
  values (
    trim(p_name),
    nullif(trim(p_phone),''),
    nullif(trim(p_contact_person),''),
    nullif(trim(p_email),''),
    nullif(trim(p_address),''),
    nullif(upper(trim(p_gstin)),'')
  ) returning id into v_id;

  insert into audit_log(user_id,action,entity_type,entity_id,after)
  values(v_user.id,'create','supplier',v_id,jsonb_build_object(
    'name',trim(p_name),
    'phone',nullif(trim(p_phone),''),
    'contact_person',nullif(trim(p_contact_person),''),
    'email',nullif(trim(p_email),''),
    'address',nullif(trim(p_address),''),
    'gstin',nullif(upper(trim(p_gstin)),'')
  ));
  return v_id;
end;
$$ language plpgsql security definer set search_path=public;

create or replace function update_supplier_master(
  p_supplier_id uuid,
  p_name text,
  p_phone text default null,
  p_contact_person text default null,
  p_email text default null,
  p_address text default null,
  p_gstin text default null,
  p_active boolean default true
) returns void as $$
declare
  v_user users%rowtype;
  v_before jsonb;
  v_after jsonb;
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage suppliers'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Supplier name is required'; end if;

  select jsonb_build_object(
    'name',name,'phone',phone,'contact_person',contact_person,'email',email,
    'address',address,'gstin',gstin,'active',active
  ) into v_before
  from suppliers where id=p_supplier_id;
  if v_before is null then raise exception 'Supplier not found'; end if;

  update suppliers
  set name=trim(p_name),
      phone=nullif(trim(p_phone),''),
      contact_person=nullif(trim(p_contact_person),''),
      email=nullif(trim(p_email),''),
      address=nullif(trim(p_address),''),
      gstin=nullif(upper(trim(p_gstin)),''),
      active=coalesce(p_active,true)
  where id=p_supplier_id;

  select jsonb_build_object(
    'name',name,'phone',phone,'contact_person',contact_person,'email',email,
    'address',address,'gstin',gstin,'active',active
  ) into v_after from suppliers where id=p_supplier_id;

  insert into audit_log(user_id,action,entity_type,entity_id,before,after)
  values(v_user.id,'update','supplier',p_supplier_id,v_before,v_after);
end;
$$ language plpgsql security definer set search_path=public;

-- --------------------------------------------------------------------------
-- ITEM MASTER CREATE / UPDATE
-- --------------------------------------------------------------------------
drop function if exists create_item_master(text,text,text,numeric,numeric);

create or replace function create_item_master(
  p_name text,
  p_category text,
  p_unit text,
  p_gst_rate numeric default 0,
  p_reorder_level numeric default 0,
  p_master_rate numeric default 0
) returns uuid as $$
declare
  v_user users%rowtype;
  v_id uuid;
  v_rate numeric(10,2) := round(coalesce(p_master_rate,0),2);
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage items'; end if;
  if nullif(trim(p_name),'') is null or nullif(trim(p_category),'') is null or nullif(trim(p_unit),'') is null then
    raise exception 'Item name, category, and unit are required';
  end if;
  if coalesce(p_gst_rate,0)<0 or coalesce(p_reorder_level,0)<0 or v_rate<0 then
    raise exception 'GST, reorder level, and master rate cannot be negative';
  end if;

  insert into items(name,category,unit,gst_rate,reorder_level,master_rate)
  values(trim(p_name),trim(p_category),trim(p_unit),round(coalesce(p_gst_rate,0),2),round(coalesce(p_reorder_level,0),3),v_rate)
  returning id into v_id;

  if v_rate > 0 then
    insert into item_rate_history(item_id,old_rate,new_rate,changed_by,reason)
    values(v_id,0,v_rate,v_user.id,'Initial master rate');
  end if;

  insert into audit_log(user_id,action,entity_type,entity_id,after)
  values(v_user.id,'create','item',v_id,jsonb_build_object(
    'name',trim(p_name),'category',trim(p_category),'unit',trim(p_unit),
    'gst_rate',round(coalesce(p_gst_rate,0),2),
    'reorder_level',round(coalesce(p_reorder_level,0),3),
    'master_rate',v_rate
  ));
  return v_id;
end;
$$ language plpgsql security definer set search_path=public;

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
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage items'; end if;
  if nullif(trim(p_name),'') is null or nullif(trim(p_category),'') is null or nullif(trim(p_unit),'') is null then
    raise exception 'Item name, category, and unit are required';
  end if;
  if coalesce(p_gst_rate,0)<0 or coalesce(p_reorder_level,0)<0 or v_rate<0 then
    raise exception 'GST, reorder level, and master rate cannot be negative';
  end if;

  select * into v_item from items where id=p_item_id;
  if not found then raise exception 'Item not found'; end if;

  v_before := jsonb_build_object(
    'name',v_item.name,'category',v_item.category,'unit',v_item.unit,
    'gst_rate',v_item.gst_rate,'reorder_level',v_item.reorder_level,
    'master_rate',v_item.master_rate,'active',v_item.active
  );

  update items
  set name=trim(p_name), category=trim(p_category), unit=trim(p_unit),
      gst_rate=round(coalesce(p_gst_rate,0),2),
      reorder_level=round(coalesce(p_reorder_level,0),3),
      master_rate=v_rate,
      active=coalesce(p_active,true)
  where id=p_item_id;

  if round(coalesce(v_item.master_rate,0),2) <> v_rate then
    insert into item_rate_history(item_id,old_rate,new_rate,changed_by,reason)
    values(p_item_id,round(coalesce(v_item.master_rate,0),2),v_rate,v_user.id,'Master rate updated');
  end if;

  insert into audit_log(user_id,action,entity_type,entity_id,before,after)
  values(v_user.id,'update','item',p_item_id,v_before,jsonb_build_object(
    'name',trim(p_name),'category',trim(p_category),'unit',trim(p_unit),
    'gst_rate',round(coalesce(p_gst_rate,0),2),
    'reorder_level',round(coalesce(p_reorder_level,0),3),
    'master_rate',v_rate,'active',coalesce(p_active,true)
  ));
end;
$$ language plpgsql security definer set search_path=public;

-- --------------------------------------------------------------------------
-- SUPPLIER PAYMENTS MAY CONTINUE AFTER A SUPPLIER IS DEACTIVATED.
-- Deactivation stops new purchases but should never freeze an outstanding due.
-- --------------------------------------------------------------------------
create or replace function record_supplier_payment(
  p_supplier_id uuid,p_from_account_id uuid,p_amount numeric,
  p_txn_date date default current_date,p_description text default null
) returns uuid as $$
declare v_user users%rowtype; v_txn_id uuid; v_due numeric;
begin
  select * into v_user from phase4_manager_user();
  if not found then raise exception 'Only an Owner or Manager can pay a supplier'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Payment amount must be greater than zero'; end if;
  perform phase3_assert_unlocked(p_txn_date);
  if not exists(select 1 from suppliers where id=p_supplier_id) or not exists(select 1 from accounts where id=p_from_account_id and active=true) then
    raise exception 'Choose an existing supplier and payment account';
  end if;
  select coalesce(sum(case when entry_side='credit' then amount else -amount end),0) into v_due
  from ledger_entries where counterparty_type='supplier' and counterparty_id=p_supplier_id;
  if round(p_amount,2) > round(v_due,2) then raise exception 'Payment cannot exceed the current supplier due (%).', v_due; end if;

  insert into transactions(txn_type,txn_date,amount,description,created_by)
  values('supplier_payment',p_txn_date,round(p_amount,2),nullif(trim(p_description),''),v_user.id)
  returning id into v_txn_id;

  insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id) values
    (v_txn_id,null,'debit',round(p_amount,2),'supplier',p_supplier_id),
    (v_txn_id,p_from_account_id,'credit',round(p_amount,2),'supplier',p_supplier_id);

  insert into audit_log(user_id,action,entity_type,entity_id,after)
  values(v_user.id,'supplier_payment','transaction',v_txn_id,jsonb_build_object(
    'supplier_id',p_supplier_id,'from_account_id',p_from_account_id,
    'amount',round(p_amount,2),'txn_date',p_txn_date
  ));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

-- --------------------------------------------------------------------------
-- GRANTS
-- --------------------------------------------------------------------------
grant execute on function create_supplier_master(text,text,text,text,text,text) to authenticated;
grant execute on function update_supplier_master(uuid,text,text,text,text,text,text,boolean) to authenticated;
grant execute on function create_item_master(text,text,text,numeric,numeric,numeric) to authenticated;
grant execute on function update_item_master(uuid,text,text,text,numeric,numeric,numeric,boolean) to authenticated;
grant execute on function record_supplier_payment(uuid,uuid,numeric,date,text) to authenticated;

-- Ensure the new table is readable only through its owner-only RLS policy.
revoke all on item_rate_history from anon;
grant select on item_rate_history to authenticated;

-- --------------------------------------------------------------------------
-- ATOMIC PURCHASE + OPTIONAL MASTER-RATE UPDATE
-- The existing Phase 4 create_purchase remains the transaction writer. This
-- wrapper calls it and, in the same database transaction, optionally updates
-- master rates. If anything fails, the whole operation rolls back.
-- --------------------------------------------------------------------------
create or replace function create_purchase_with_master_rate_updates(
  p_supplier_id uuid,
  p_paid_from_account_id uuid default null,
  p_txn_date date default current_date,
  p_description text default null,
  p_items jsonb default '[]'::jsonb,
  p_update_master_rates boolean default false
) returns uuid as $$
declare
  v_user users%rowtype;
  v_txn_id uuid;
  v_item jsonb;
  v_item_row items%rowtype;
  v_new_rate numeric(10,2);
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists'; end if;
  if p_update_master_rates and v_user.role <> 'owner' then
    raise exception 'Only the Owner can update master rates from a purchase';
  end if;

  v_txn_id := create_purchase(p_supplier_id,p_paid_from_account_id,p_txn_date,p_description,p_items);

  if p_update_master_rates then
    for v_item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
      select * into v_item_row from items where id=(v_item->>'item_id')::uuid;
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
    end loop;
  end if;

  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function create_purchase_with_master_rate_updates(uuid,uuid,date,text,jsonb,boolean) to authenticated;
