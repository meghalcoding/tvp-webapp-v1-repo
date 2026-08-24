-- PHASE 4B — Explicit unpaid-expense writer
-- This intentionally uses a dedicated RPC so the UI is not dependent on an
-- older create_expense implementation that requires a payment-account UUID.

alter table accounts drop constraint if exists accounts_type_check;
alter table accounts add constraint accounts_type_check
  check (type in ('cash','bank','collection_account','payable'));

insert into accounts(name,type,holder_name,opening_balance,active)
values ('Expense Payables','payable','Cravory',0,true)
on conflict (name) do update set type='payable', active=true;

create or replace function create_unpaid_expense_idempotent(
  p_client_uuid uuid,
  p_category_id uuid,
  p_amount numeric,
  p_txn_date date default current_date,
  p_description text default null,
  p_items jsonb default '[]'::jsonb
) returns uuid as $$
declare
  v_user users%rowtype;
  v_txn_id uuid;
  v_category expense_categories%rowtype;
  v_payable accounts%rowtype;
  v_item jsonb;
  v_item_total numeric := 0;
begin
  if p_client_uuid is null then raise exception 'Expense requires a client UUID'; end if;

  select id into v_txn_id from transactions where client_uuid=p_client_uuid;
  if v_txn_id is not null then return v_txn_id; end if;

  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists for this signed-in user'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Expense amount must be greater than zero'; end if;
  if jsonb_typeof(coalesce(p_items,'[]'::jsonb)) <> 'array' then raise exception 'Expense items must be a list'; end if;
  if v_user.role='staff' and jsonb_array_length(coalesce(p_items,'[]'::jsonb))>0 then raise exception 'Staff can record quick expenses only'; end if;

  perform phase3_assert_unlocked(p_txn_date);

  select * into v_category from expense_categories where id=p_category_id and active=true;
  if v_category.id is null then raise exception 'Choose an active expense category'; end if;

  select * into v_payable from accounts where name='Expense Payables' and type='payable' and active=true;
  if v_payable.id is null then raise exception 'Expense Payables account is not configured'; end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    if coalesce(v_item->>'description','')='' or coalesce((v_item->>'amount')::numeric,0)<=0 then
      raise exception 'Every expense item needs a description and amount';
    end if;
    v_item_total := v_item_total + round((v_item->>'amount')::numeric,2);
  end loop;

  if jsonb_array_length(coalesce(p_items,'[]'::jsonb))>0 and round(v_item_total,2)<>round(p_amount,2) then
    raise exception 'Detailed expense items must add up exactly to the expense amount';
  end if;

  insert into transactions(txn_type,txn_date,amount,description,created_by,client_uuid)
  values('expense',p_txn_date,round(p_amount,2),nullif(trim(p_description),''),v_user.id,p_client_uuid)
  returning id into v_txn_id;

  insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id)
  values
    (v_txn_id,null,'debit',round(p_amount,2),'expense_category',v_category.id),
    (v_txn_id,v_payable.id,'credit',round(p_amount,2),'expense',v_txn_id);

  insert into expense_details(transaction_id,category_id,paid_from_account_id)
  values(v_txn_id,v_category.id,null);

  insert into expense_items(transaction_id,description,quantity,unit,rate,amount)
  select v_txn_id,value->>'description',nullif(value->>'quantity','')::numeric,
         nullif(value->>'unit',''),nullif(value->>'rate','')::numeric,(value->>'amount')::numeric
  from jsonb_array_elements(coalesce(p_items,'[]'::jsonb));

  insert into audit_log(user_id,action,entity_type,entity_id,after)
  values(v_user.id,'create','transaction',v_txn_id,
    jsonb_build_object('txn_type','expense','amount',round(p_amount,2),
      'category_id',v_category.id,'paid_from_account_id',null,'unpaid',true,'txn_date',p_txn_date,
      'item_count',jsonb_array_length(coalesce(p_items,'[]'::jsonb))));

  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function create_unpaid_expense_idempotent(uuid,uuid,numeric,date,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
