-- PHASE 8 — Item-first Expense Entry
--
-- Expenses are category/item driven. Supplier remains optional and is captured
-- separately. Each expense line now points to the universal public.items master.

alter table public.expense_items
  add column if not exists item_id uuid references public.items(id) on delete set null;

create index if not exists idx_expense_items_item on public.expense_items(item_id);

-- Canonical expense writer. The UI supplies only the populated item lines;
-- the server verifies that every item belongs to the selected Expense Category.
create or replace function public.create_expense(
  p_category_id uuid,
  p_paid_from_account_id uuid,
  p_amount numeric,
  p_txn_date date default current_date,
  p_description text default null,
  p_items jsonb default '[]'::jsonb
) returns uuid as $$
declare
  v_user users%rowtype;
  v_txn_id uuid;
  v_category expense_categories%rowtype;
  v_account accounts%rowtype;
  v_payable accounts%rowtype;
  v_item jsonb;
  v_item_row items%rowtype;
  v_item_total numeric := 0;
  v_line_amount numeric;
  v_quantity numeric;
  v_rate numeric;
  v_gst_rate numeric;
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists for this signed-in user'; end if;
  perform phase3_assert_unlocked(p_txn_date);

  select * into v_category from expense_categories where id=p_category_id and active=true;
  if v_category.id is null then raise exception 'Choose an active expense category'; end if;
  if jsonb_typeof(coalesce(p_items,'[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items,'[]'::jsonb))=0 then
    raise exception 'Enter at least one expense item';
  end if;
  if v_user.role='staff' then raise exception 'Only Owners and Managers can record itemized expenses'; end if;
  if p_paid_from_account_id is not null then
    select * into v_account from accounts where id=p_paid_from_account_id and active=true and type in ('cash','bank','collection_account');
    if v_account.id is null then raise exception 'Choose an active payment account'; end if;
  else
    select * into v_payable from accounts where name='Expense Payables' and type='payable' and active=true;
    if v_payable.id is null then raise exception 'Expense Payables account is not configured'; end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    if nullif(v_item->>'item_id','') is null then raise exception 'Every expense line must reference a Master Item'; end if;
    select * into v_item_row from items where id=(v_item->>'item_id')::uuid and active=true;
    if v_item_row.id is null then raise exception 'One or more expense items are inactive or invalid'; end if;
    if not exists(select 1 from expense_category_items where expense_category_id=p_category_id and item_id=v_item_row.id) then
      raise exception 'Item % is not linked to the selected Expense Category', v_item_row.name;
    end if;
    v_line_amount := coalesce((v_item->>'amount')::numeric,0);
    v_quantity := nullif(v_item->>'quantity','')::numeric;
    v_rate := nullif(v_item->>'rate','')::numeric;
    v_gst_rate := coalesce(nullif(v_item->>'gst_rate','')::numeric,0);
    if v_line_amount <= 0 then raise exception 'Every populated expense item needs a positive amount'; end if;
    if v_quantity is not null and v_quantity <= 0 then raise exception 'Expense quantity must be greater than zero'; end if;
    if v_rate is not null and v_rate < 0 then raise exception 'Expense rate cannot be negative'; end if;
    if v_gst_rate < 0 then raise exception 'GST rate cannot be negative'; end if;
    v_item_total := v_item_total + round(v_line_amount,2);
  end loop;

  if round(v_item_total,2) <> round(coalesce(p_amount,0),2) then
    raise exception 'Expense total does not match the populated item lines';
  end if;

  insert into transactions(txn_type,txn_date,amount,description,created_by)
  values('expense',p_txn_date,round(v_item_total,2),nullif(trim(p_description),''),v_user.id)
  returning id into v_txn_id;

  insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id) values
    (v_txn_id,null,'debit',round(v_item_total,2),'expense_category',v_category.id),
    (v_txn_id,coalesce(v_account.id,v_payable.id),'credit',round(v_item_total,2),case when v_account.id is null then 'expense' else 'expense_category' end,case when v_account.id is null then v_txn_id else v_category.id end);

  insert into expense_details(transaction_id,category_id,paid_from_account_id,item_id)
  values(v_txn_id,v_category.id,v_account.id,case when jsonb_array_length(p_items)=1 then (p_items->0->>'item_id')::uuid else null end);

  insert into expense_items(transaction_id,item_id,description,quantity,unit,rate,amount)
  select v_txn_id,
         (value->>'item_id')::uuid,
         coalesce(nullif(value->>'description',''),(select name from items where id=(value->>'item_id')::uuid)),
         nullif(value->>'quantity','')::numeric,
         coalesce(nullif(value->>'unit',''),(select unit from items where id=(value->>'item_id')::uuid)),
         nullif(value->>'rate','')::numeric,
         (value->>'amount')::numeric
  from jsonb_array_elements(p_items);

  insert into audit_log(user_id,action,entity_type,entity_id,after)
  values(v_user.id,'create','transaction',v_txn_id,jsonb_build_object(
    'txn_type','expense','amount',round(v_item_total,2),'category_id',v_category.id,
    'paid_from_account_id',v_account.id,'unpaid',v_account.id is null,
    'txn_date',p_txn_date,'item_count',jsonb_array_length(p_items)
  ));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function public.create_expense(uuid,uuid,numeric,date,text,jsonb) to authenticated;

create or replace function public.create_unpaid_expense_idempotent(
  p_client_uuid uuid,
  p_category_id uuid,
  p_amount numeric,
  p_txn_date date default current_date,
  p_description text default null,
  p_items jsonb default '[]'::jsonb
) returns uuid as $$
declare v_id uuid;
begin
  if p_client_uuid is null then raise exception 'Expense requires a client UUID'; end if;
  select id into v_id from transactions where client_uuid=p_client_uuid;
  if v_id is not null then return v_id; end if;
  select public.create_expense(p_category_id,null,p_amount,p_txn_date,p_description,p_items) into v_id;
  update transactions set client_uuid=p_client_uuid where id=v_id;
  return v_id;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function public.create_unpaid_expense_idempotent(uuid,uuid,numeric,date,text,jsonb) to authenticated;

-- Supplier remains optional. When supplied, keep it category-routed where a
-- supplier/category relationship exists; otherwise reject the accidental link.
create or replace function public.set_expense_supplier(p_transaction_id uuid,p_supplier_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare v_category_id uuid;
begin
  select category_id into v_category_id from expense_details where transaction_id=p_transaction_id;
  if v_category_id is null then raise exception 'Expense transaction not found'; end if;
  if p_supplier_id is not null then
    if not exists(select 1 from suppliers where id=p_supplier_id and active=true) then raise exception 'Supplier not found'; end if;
    if not exists(select 1 from supplier_expense_categories where supplier_id=p_supplier_id and expense_category_id=v_category_id) then
      raise exception 'Supplier is not linked to this Expense Category';
    end if;
  end if;
  update expense_details set supplier_id=p_supplier_id where transaction_id=p_transaction_id;
end;
$$;

grant execute on function public.set_expense_supplier(uuid,uuid) to authenticated;

notify pgrst, 'reload schema';
