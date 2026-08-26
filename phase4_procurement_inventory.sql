-- ============================================================================
-- PHASE 4 — PROCUREMENT & INVENTORY
-- Run after the Phase 1, 2, and 3 SQL migrations.
-- ============================================================================

create or replace function phase4_manager_user() returns users as $$
  select u from users u where u.auth_id=auth.uid() and u.active=true and u.role in ('owner','manager');
$$ language sql stable security definer set search_path=public;

create or replace function phase4_owner_user() returns users as $$
  select u from users u where u.auth_id=auth.uid() and u.active=true and u.role='owner';
$$ language sql stable security definer set search_path=public;

create or replace function create_supplier_master(p_name text, p_phone text default null) returns uuid as $$
declare v_user users%rowtype; v_id uuid;
begin
  select * into v_user from phase4_owner_user(); if not found then raise exception 'Only the Owner can manage suppliers'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Supplier name is required'; end if;
  insert into suppliers(name,phone) values(trim(p_name),nullif(trim(p_phone),'')) returning id into v_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','supplier',v_id,jsonb_build_object('name',trim(p_name),'phone',nullif(trim(p_phone),'')));
  return v_id;
end;
$$ language plpgsql security definer set search_path=public;

create or replace function create_item_master(p_name text,p_category text,p_unit text,p_gst_rate numeric default 0,p_reorder_level numeric default 0) returns uuid as $$
declare v_user users%rowtype; v_id uuid;
begin
  select * into v_user from phase4_owner_user(); if not found then raise exception 'Only the Owner can manage items'; end if;
  if nullif(trim(p_name),'') is null or nullif(trim(p_category),'') is null or nullif(trim(p_unit),'') is null then raise exception 'Item name, category, and unit are required'; end if;
  if coalesce(p_gst_rate,0)<0 or coalesce(p_reorder_level,0)<0 then raise exception 'GST and reorder level cannot be negative'; end if;
  insert into items(name,category,unit,gst_rate,reorder_level) values(trim(p_name),trim(p_category),trim(p_unit),round(coalesce(p_gst_rate,0),2),round(coalesce(p_reorder_level,0),3)) returning id into v_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','item',v_id,jsonb_build_object('name',trim(p_name),'category',trim(p_category),'unit',trim(p_unit),'gst_rate',p_gst_rate,'reorder_level',p_reorder_level));
  return v_id;
end;
$$ language plpgsql security definer set search_path=public;

create or replace function create_purchase(
  p_supplier_id uuid,p_paid_from_account_id uuid default null,p_txn_date date default current_date,
  p_description text default null,p_items jsonb default '[]'::jsonb
) returns uuid as $$
declare v_user users%rowtype; v_txn_id uuid; v_item jsonb; v_total numeric:=0; v_paid numeric:=0; v_supplier suppliers%rowtype; v_account accounts%rowtype; v_item_row items%rowtype; v_qty numeric; v_rate numeric; v_gst numeric; v_line_total numeric;
begin
  select * into v_user from phase4_manager_user(); if not found then raise exception 'Only an Owner or Manager can record purchases'; end if;
  perform phase3_assert_unlocked(p_txn_date);
  select * into v_supplier from suppliers where id=p_supplier_id and active=true; if v_supplier.id is null then raise exception 'Choose an active supplier'; end if;
  if jsonb_typeof(coalesce(p_items,'[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items,'[]'::jsonb))=0 then raise exception 'Add at least one purchase item'; end if;
  if p_paid_from_account_id is not null then select * into v_account from accounts where id=p_paid_from_account_id and active=true; if v_account.id is null then raise exception 'Choose an active payment account'; end if; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::numeric; v_rate := (v_item->>'rate')::numeric; v_gst := coalesce((v_item->>'gst_amount')::numeric,0);
    select * into v_item_row from items where id=(v_item->>'item_id')::uuid and active=true;
    if v_item_row.id is null or v_qty<=0 or v_rate<0 or v_gst<0 then raise exception 'Every purchase line needs an active item, positive quantity, rate, and GST amount'; end if;
    v_line_total:=round(v_qty*v_rate+v_gst,2); v_total:=v_total+v_line_total;
  end loop;
  if p_paid_from_account_id is not null then v_paid:=v_total; end if;
  insert into transactions(txn_type,txn_date,amount,description,created_by) values('purchase',p_txn_date,round(v_total,2),nullif(trim(p_description),''),v_user.id) returning id into v_txn_id;
  insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id) values
    (v_txn_id,null,'debit',round(v_total,2),'inventory',null),
    (v_txn_id,null,'credit',round(v_total,2),'supplier',v_supplier.id);
  if v_paid>0 then
    insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id) values
      (v_txn_id,null,'debit',round(v_paid,2),'supplier',v_supplier.id),
      (v_txn_id,v_account.id,'credit',round(v_paid,2),'supplier',v_supplier.id);
  end if;
  insert into purchase_details(transaction_id,supplier_id,paid_amount) values(v_txn_id,v_supplier.id,round(v_paid,2));
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty:=(v_item->>'quantity')::numeric; v_rate:=(v_item->>'rate')::numeric; v_gst:=coalesce((v_item->>'gst_amount')::numeric,0); v_line_total:=round(v_qty*v_rate+v_gst,2);
    insert into purchase_items(transaction_id,item_id,quantity,rate,gst_amount,amount) values(v_txn_id,(v_item->>'item_id')::uuid,v_qty,v_rate,v_gst,v_line_total);
    insert into stock_movements(item_id,transaction_id,movement_type,quantity,rate,reason) values((v_item->>'item_id')::uuid,v_txn_id,'purchase',v_qty,v_rate,'Purchase');
  end loop;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','transaction',v_txn_id,jsonb_build_object('txn_type','purchase','supplier_id',v_supplier.id,'amount',round(v_total,2),'paid_amount',round(v_paid,2),'txn_date',p_txn_date,'item_count',jsonb_array_length(p_items)));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

create or replace function record_supplier_payment(p_supplier_id uuid,p_from_account_id uuid,p_amount numeric,p_txn_date date default current_date,p_description text default null) returns uuid as $$
declare v_user users%rowtype; v_txn_id uuid;
begin
  select * into v_user from phase4_manager_user(); if not found then raise exception 'Only an Owner or Manager can pay a supplier'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Payment amount must be greater than zero'; end if; perform phase3_assert_unlocked(p_txn_date);
  if not exists(select 1 from suppliers where id=p_supplier_id and active=true) or not exists(select 1 from accounts where id=p_from_account_id and active=true) then raise exception 'Choose an active supplier and payment account'; end if;
  insert into transactions(txn_type,txn_date,amount,description,created_by) values('supplier_payment',p_txn_date,round(p_amount,2),nullif(trim(p_description),''),v_user.id) returning id into v_txn_id;
  insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id) values
    (v_txn_id,null,'debit',round(p_amount,2),'supplier',p_supplier_id),
    (v_txn_id,p_from_account_id,'credit',round(p_amount,2),'supplier',p_supplier_id);
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'supplier_payment','transaction',v_txn_id,jsonb_build_object('supplier_id',p_supplier_id,'from_account_id',p_from_account_id,'amount',round(p_amount,2),'txn_date',p_txn_date));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

create or replace function record_wastage(p_item_id uuid,p_quantity numeric,p_reason text,p_txn_date date default current_date,p_description text default null) returns uuid as $$
declare v_user users%rowtype; v_txn_id uuid; v_item items%rowtype; v_value numeric;
begin
  select * into v_user from phase3_current_user(); if not found then raise exception 'No active application profile exists'; end if;
  if p_quantity is null or p_quantity<=0 or nullif(trim(p_reason),'') is null then raise exception 'Item, positive quantity, and reason are required'; end if; perform phase3_assert_unlocked(p_txn_date);
  select * into v_item from items where id=p_item_id and active=true; if v_item.id is null then raise exception 'Choose an active item'; end if;
  v_value:=round(p_quantity*v_item.last_purchase_rate,2);
  insert into transactions(txn_type,txn_date,amount,description,created_by) values('wastage',p_txn_date,v_value,nullif(trim(p_description),''),v_user.id) returning id into v_txn_id;
  insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type) values
    (v_txn_id,null,'debit',v_value,'wastage'),(v_txn_id,null,'credit',v_value,'inventory');
  insert into stock_movements(item_id,transaction_id,movement_type,quantity,rate,reason) values(v_item.id,v_txn_id,'waste',-p_quantity,v_item.last_purchase_rate,trim(p_reason));
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','transaction',v_txn_id,jsonb_build_object('txn_type','wastage','item_id',v_item.id,'quantity',p_quantity,'value',v_value,'reason',trim(p_reason),'txn_date',p_txn_date));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

create or replace function record_stock_adjustment(p_item_id uuid,p_quantity numeric,p_reason text,p_txn_date date default current_date,p_description text default null) returns uuid as $$
declare v_user users%rowtype; v_txn_id uuid; v_item items%rowtype; v_value numeric;
begin
  select * into v_user from phase4_manager_user(); if not found then raise exception 'Only an Owner or Manager can adjust stock'; end if;
  if p_quantity is null or p_quantity=0 or nullif(trim(p_reason),'') is null then raise exception 'Item, non-zero quantity, and reason are required'; end if; perform phase3_assert_unlocked(p_txn_date);
  select * into v_item from items where id=p_item_id and active=true; if v_item.id is null then raise exception 'Choose an active item'; end if; v_value:=round(abs(p_quantity)*v_item.last_purchase_rate,2);
  insert into transactions(txn_type,txn_date,amount,description,created_by) values('stock_adjustment',p_txn_date,v_value,nullif(trim(p_description),''),v_user.id) returning id into v_txn_id;
  insert into ledger_entries(transaction_id,entry_side,amount,counterparty_type) values
    (v_txn_id,case when p_quantity>0 then 'debit' else 'credit' end,v_value,'inventory'),
    (v_txn_id,case when p_quantity>0 then 'credit' else 'debit' end,v_value,'inventory');
  insert into stock_movements(item_id,transaction_id,movement_type,quantity,rate,reason) values(v_item.id,v_txn_id,'adjustment',p_quantity,v_item.last_purchase_rate,trim(p_reason));
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','transaction',v_txn_id,jsonb_build_object('txn_type','stock_adjustment','item_id',v_item.id,'quantity',p_quantity,'value',v_value,'reason',trim(p_reason),'txn_date',p_txn_date));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function create_supplier_master(text,text) to authenticated;
grant execute on function create_item_master(text,text,text,numeric,numeric) to authenticated;
grant execute on function create_purchase(uuid,uuid,date,text,jsonb) to authenticated;
grant execute on function record_supplier_payment(uuid,uuid,numeric,date,text) to authenticated;
grant execute on function record_wastage(uuid,numeric,text,date,text) to authenticated;
grant execute on function record_stock_adjustment(uuid,numeric,text,date,text) to authenticated;
