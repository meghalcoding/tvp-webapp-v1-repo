-- ============================================================================
-- PHASE 3 — DAILY OPERATIONS
-- Run after db/phase2_financial_engine.sql.
-- All financial writes remain atomic: transaction, ledger, detail, audit.
-- ============================================================================

create or replace function phase3_current_user() returns users as $$
  select u from users u where u.auth_id = auth.uid() and u.active = true;
$$ language sql stable security definer set search_path = public;

create or replace function phase3_assert_unlocked(p_date date) returns void as $$
begin
  if exists (select 1 from daily_closings where closing_date = p_date and reopened_at is null) then
    raise exception 'This day is locked. Ask an Owner to reopen it before adding an entry.';
  end if;
end;
$$ language plpgsql stable security definer set search_path = public;

create or replace function create_sale(
  p_amount numeric, p_payment_method text, p_collection_account_id uuid default null,
  p_txn_date date default current_date, p_description text default null
) returns uuid as $$
declare v_user users%rowtype; v_txn_id uuid; v_account accounts%rowtype;
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists for this signed-in user'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Sale amount must be greater than zero'; end if;
  if p_payment_method not in ('cash', 'upi') then raise exception 'Choose Cash or UPI'; end if;
  perform phase3_assert_unlocked(p_txn_date);
  if p_payment_method = 'cash' then
    select * into v_account from accounts where name = 'Cash Drawer' and type = 'cash' and active = true;
  else
    select * into v_account from accounts where id = p_collection_account_id and type = 'collection_account' and active = true;
  end if;
  if not found then raise exception 'Choose an active collection account, or create an active Cash Drawer account'; end if;
  insert into transactions (txn_type, txn_date, amount, description, created_by)
  values ('sale', p_txn_date, round(p_amount, 2), nullif(trim(p_description), ''), v_user.id) returning id into v_txn_id;
  insert into ledger_entries (transaction_id, account_id, entry_side, amount, counterparty_type)
  values (v_txn_id, v_account.id, 'debit', round(p_amount, 2), 'revenue'),
         (v_txn_id, null, 'credit', round(p_amount, 2), 'revenue');
  insert into sale_details (transaction_id, payment_method, collection_account_id)
  values (v_txn_id, p_payment_method, case when p_payment_method = 'upi' then v_account.id else null end);
  insert into audit_log (user_id, action, entity_type, entity_id, after)
  values (v_user.id, 'create', 'transaction', v_txn_id,
    jsonb_build_object('txn_type', 'sale', 'amount', round(p_amount,2), 'payment_method', p_payment_method, 'account_id', v_account.id, 'txn_date', p_txn_date));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function create_expense(
  p_category_id uuid, p_paid_from_account_id uuid, p_amount numeric, p_txn_date date default current_date,
  p_description text default null, p_items jsonb default '[]'::jsonb
) returns uuid as $$
declare v_user users%rowtype; v_txn_id uuid; v_category expense_categories%rowtype; v_account accounts%rowtype; v_item jsonb; v_item_total numeric := 0;
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists for this signed-in user'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Expense amount must be greater than zero'; end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then raise exception 'Expense items must be a list'; end if;
  if v_user.role = 'staff' and jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 0 then raise exception 'Staff can record quick expenses only'; end if;
  perform phase3_assert_unlocked(p_txn_date);
  select * into v_category from expense_categories where id = p_category_id and active = true;
  select * into v_account from accounts where id = p_paid_from_account_id and active = true;
  if v_category.id is null or v_account.id is null then raise exception 'Choose an active expense category and payment account'; end if;
  for v_item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if coalesce((v_item->>'description'), '') = '' or coalesce((v_item->>'amount')::numeric, 0) <= 0 then raise exception 'Every expense item needs a description and amount'; end if;
    v_item_total := v_item_total + round((v_item->>'amount')::numeric, 2);
  end loop;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 0 and round(v_item_total,2) <> round(p_amount,2) then
    raise exception 'Detailed expense items must add up exactly to the expense amount';
  end if;
  insert into transactions (txn_type, txn_date, amount, description, created_by)
  values ('expense', p_txn_date, round(p_amount,2), nullif(trim(p_description), ''), v_user.id) returning id into v_txn_id;
  insert into ledger_entries (transaction_id, account_id, entry_side, amount, counterparty_type, counterparty_id)
  values (v_txn_id, null, 'debit', round(p_amount,2), 'expense_category', v_category.id),
         (v_txn_id, v_account.id, 'credit', round(p_amount,2), 'expense_category', v_category.id);
  insert into expense_details (transaction_id, category_id, paid_from_account_id) values (v_txn_id, v_category.id, v_account.id);
  insert into expense_items (transaction_id, description, quantity, unit, rate, amount)
  select v_txn_id, value->>'description', nullif(value->>'quantity','')::numeric, nullif(value->>'unit',''), nullif(value->>'rate','')::numeric, (value->>'amount')::numeric
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb));
  insert into audit_log (user_id, action, entity_type, entity_id, after)
  values (v_user.id, 'create', 'transaction', v_txn_id,
    jsonb_build_object('txn_type','expense','amount',round(p_amount,2),'category_id',v_category.id,'paid_from_account_id',v_account.id,'txn_date',p_txn_date,'item_count',jsonb_array_length(coalesce(p_items,'[]'::jsonb))));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function create_upi_settlement(
  p_collection_account_id uuid, p_settled_to_account_id uuid, p_amount numeric,
  p_txn_date date default current_date, p_description text default null
) returns uuid as $$
declare v_user users%rowtype; v_txn_id uuid; v_pending numeric;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role not in ('owner','manager') then raise exception 'Only an Owner or Manager can settle UPI collections'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Settlement amount must be greater than zero'; end if;
  if p_collection_account_id = p_settled_to_account_id then raise exception 'Choose two different accounts'; end if;
  perform phase3_assert_unlocked(p_txn_date);
  if not exists (select 1 from accounts where id = p_collection_account_id and type = 'collection_account' and active = true)
     or not exists (select 1 from accounts where id = p_settled_to_account_id and type in ('cash','bank') and active = true) then raise exception 'Choose an active collection account and an active Cash or Bank account'; end if;
  select coalesce(sales.total,0) - coalesce(settled.total,0) into v_pending
  from (select sum(t.amount) total from sale_details sd join transactions t on t.id=sd.transaction_id where sd.collection_account_id=p_collection_account_id and sd.payment_method='upi') sales,
       (select sum(t.amount) total from settlement_details sd join transactions t on t.id=sd.transaction_id where sd.collection_account_id=p_collection_account_id) settled;
  if round(p_amount,2) > round(v_pending,2) then raise exception 'Settlement cannot exceed the pending collected amount (%).', v_pending; end if;
  insert into transactions (txn_type, txn_date, amount, description, created_by) values ('settlement',p_txn_date,round(p_amount,2),nullif(trim(p_description),''),v_user.id) returning id into v_txn_id;
  insert into ledger_entries (transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id)
  values (v_txn_id,p_settled_to_account_id,'debit',round(p_amount,2),'account',p_collection_account_id),
         (v_txn_id,p_collection_account_id,'credit',round(p_amount,2),'account',p_settled_to_account_id);
  insert into settlement_details (transaction_id,collection_account_id,settled_to_account_id) values (v_txn_id,p_collection_account_id,p_settled_to_account_id);
  insert into audit_log (user_id,action,entity_type,entity_id,after) values (v_user.id,'settle','transaction',v_txn_id,jsonb_build_object('amount',round(p_amount,2),'collection_account_id',p_collection_account_id,'settled_to_account_id',p_settled_to_account_id,'txn_date',p_txn_date));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function close_daily_operations(
  p_closing_date date, p_actual_cash numeric, p_denominations jsonb default '{}'::jsonb, p_notes text default null
) returns uuid as $$
declare v_user users%rowtype; v_cash_id uuid; v_expected numeric; v_closing_id uuid;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role not in ('owner','manager') then raise exception 'Only an Owner or Manager can close a day'; end if;
  if p_actual_cash is null or p_actual_cash < 0 then raise exception 'Actual cash cannot be negative'; end if;
  if exists (select 1 from daily_closings where closing_date=p_closing_date and reopened_at is null) then raise exception 'This day is already closed'; end if;
  select id into v_cash_id from accounts where name='Cash Drawer' and type='cash' and active=true;
  if v_cash_id is null then raise exception 'Create an active Cash Drawer account first'; end if;
  select coalesce((select opening_balance from accounts where id=v_cash_id),0) + coalesce(sum(case when le.entry_side='debit' then le.amount else -le.amount end),0)
    into v_expected from ledger_entries le join transactions t on t.id=le.transaction_id where le.account_id=v_cash_id and t.txn_date <= p_closing_date;
  insert into daily_closings (closing_date,expected_cash,actual_cash,difference,denomination_breakdown,closed_by,notes)
  values (p_closing_date,round(v_expected,2),round(p_actual_cash,2),round(p_actual_cash-v_expected,2),coalesce(p_denominations,'{}'::jsonb),v_user.id,nullif(trim(p_notes),'')) returning id into v_closing_id;
  update transactions set locked_day=true where txn_date=p_closing_date;
  insert into audit_log (user_id,action,entity_type,entity_id,after) values (v_user.id,'close_day','daily_closing',v_closing_id,jsonb_build_object('closing_date',p_closing_date,'expected_cash',round(v_expected,2),'actual_cash',round(p_actual_cash,2),'difference',round(p_actual_cash-v_expected,2)));
  return v_closing_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function daily_closing_preview(p_closing_date date)
returns table(expected_cash numeric, cash_sales numeric, upi_sales numeric, cash_expenses numeric) as $$
declare v_cash_id uuid;
begin
  select id into v_cash_id from accounts where name='Cash Drawer' and type='cash' and active=true;
  if v_cash_id is null then raise exception 'Create an active Cash Drawer account first'; end if;
  select coalesce((select opening_balance from accounts where id=v_cash_id),0) + coalesce(sum(case when le.entry_side='debit' then le.amount else -le.amount end),0)
    into expected_cash from ledger_entries le join transactions t on t.id=le.transaction_id where le.account_id=v_cash_id and t.txn_date <= p_closing_date;
  select coalesce(sum(t.amount),0) into cash_sales from transactions t join sale_details sd on sd.transaction_id=t.id where t.txn_date=p_closing_date and sd.payment_method='cash';
  select coalesce(sum(t.amount),0) into upi_sales from transactions t join sale_details sd on sd.transaction_id=t.id where t.txn_date=p_closing_date and sd.payment_method='upi';
  select coalesce(sum(le.amount),0) into cash_expenses from ledger_entries le join transactions t on t.id=le.transaction_id where t.txn_date=p_closing_date and t.txn_type='expense' and le.account_id=v_cash_id and le.entry_side='credit';
  return next;
end;
$$ language plpgsql stable security definer set search_path = public;

create or replace function reopen_daily_operations(p_closing_date date, p_reason text) returns void as $$
declare v_user users%rowtype;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role <> 'owner' then raise exception 'Only the Owner can reopen a closed day'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'A reason is required to reopen a day'; end if;
  update daily_closings set reopened_at=now(), reopened_by=v_user.id, reopen_reason=trim(p_reason) where closing_date=p_closing_date and reopened_at is null;
  if not found then raise exception 'No currently locked closing was found for this day'; end if;
  update transactions set locked_day=false where txn_date=p_closing_date;
  insert into audit_log (user_id,action,entity_type,entity_id,after) values (v_user.id,'reopen_day','daily_closing',null,jsonb_build_object('closing_date',p_closing_date,'reason',trim(p_reason)));
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function create_sale(numeric,text,uuid,date,text) to authenticated;
grant execute on function create_expense(uuid,uuid,numeric,date,text,jsonb) to authenticated;
grant execute on function create_upi_settlement(uuid,uuid,numeric,date,text) to authenticated;
grant execute on function close_daily_operations(date,numeric,jsonb,text) to authenticated;
grant execute on function daily_closing_preview(date) to authenticated;
grant execute on function reopen_daily_operations(date,text) to authenticated;
