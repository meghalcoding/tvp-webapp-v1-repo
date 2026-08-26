-- ============================================================================
-- PHASE 2 — FINANCIAL ENGINE
-- Run after schema.sql, rls_policies.sql, and seed.sql.
--
-- Financial writes are performed here rather than as a sequence of browser
-- inserts. This keeps a transaction, both ledger legs, and its audit record
-- atomic: either all of them are committed, or none are.
-- ============================================================================

create or replace function assert_finance_operator() returns uuid as $$
declare
  app_user users%rowtype;
begin
  select * into app_user from users where auth_id = auth.uid() and active = true;
  if not found then
    raise exception 'No active application profile exists for this signed-in user';
  end if;
  if app_user.role not in ('owner', 'manager') then
    raise exception 'Only an Owner or Manager can record account transfers';
  end if;
  return app_user.id;
end;
$$ language plpgsql stable security definer set search_path = public;

create or replace function create_account_transfer(
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_amount numeric,
  p_txn_date date default current_date,
  p_description text default null
) returns uuid as $$
declare
  v_user_id uuid;
  v_transaction_id uuid;
  v_from accounts%rowtype;
  v_to accounts%rowtype;
begin
  v_user_id := assert_finance_operator();
  if p_amount is null or p_amount <= 0 then raise exception 'Transfer amount must be greater than zero'; end if;
  if p_from_account_id is null or p_to_account_id is null or p_from_account_id = p_to_account_id then
    raise exception 'Choose two different accounts';
  end if;
  if exists (select 1 from daily_closings where closing_date = p_txn_date and reopened_at is null) then
    raise exception 'This day is locked. An Owner must reopen it before recording a transfer.';
  end if;
  select * into v_from from accounts where id = p_from_account_id and active = true;
  select * into v_to from accounts where id = p_to_account_id and active = true;
  if not found or v_from.id is null or v_to.id is null then raise exception 'Both transfer accounts must be active'; end if;

  insert into transactions (txn_type, txn_date, amount, description, created_by)
  values ('transfer', p_txn_date, round(p_amount, 2), nullif(trim(p_description), ''), v_user_id)
  returning id into v_transaction_id;

  insert into ledger_entries (transaction_id, account_id, entry_side, amount, counterparty_type, counterparty_id)
  values
    (v_transaction_id, p_to_account_id, 'debit', round(p_amount, 2), 'account', p_from_account_id),
    (v_transaction_id, p_from_account_id, 'credit', round(p_amount, 2), 'account', p_to_account_id);
  insert into transfer_details (transaction_id, from_account_id, to_account_id)
  values (v_transaction_id, p_from_account_id, p_to_account_id);
  insert into audit_log (user_id, action, entity_type, entity_id, after)
  values (v_user_id, 'create', 'transaction', v_transaction_id,
    jsonb_build_object('txn_type', 'transfer', 'from_account_id', p_from_account_id,
      'to_account_id', p_to_account_id, 'amount', round(p_amount, 2), 'txn_date', p_txn_date));
  return v_transaction_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function create_finance_account(
  p_name text,
  p_type text,
  p_holder_name text default null,
  p_opening_balance numeric default 0
) returns uuid as $$
declare
  v_user_id uuid;
  v_account_id uuid;
begin
  select id into v_user_id from users where auth_id = auth.uid() and active = true and role = 'owner';
  if v_user_id is null then raise exception 'Only the Owner can create accounts'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Account name is required'; end if;
  if p_type not in ('cash', 'bank', 'collection_account') then raise exception 'Invalid account type'; end if;
  if p_opening_balance is null or p_opening_balance < 0 then raise exception 'Opening balance cannot be negative'; end if;
  insert into accounts (name, type, holder_name, opening_balance)
  values (trim(p_name), p_type, nullif(trim(p_holder_name), ''), round(p_opening_balance, 2))
  returning id into v_account_id;
  insert into audit_log (user_id, action, entity_type, entity_id, after)
  values (v_user_id, 'create', 'account', v_account_id,
    jsonb_build_object('name', trim(p_name), 'type', p_type, 'holder_name', nullif(trim(p_holder_name), ''),
      'opening_balance', round(p_opening_balance, 2)));
  return v_account_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function update_finance_account(
  p_account_id uuid,
  p_name text,
  p_type text,
  p_holder_name text default null,
  p_active boolean default true
) returns void as $$
declare
  v_user_id uuid;
  v_before jsonb;
begin
  select id into v_user_id from users where auth_id = auth.uid() and active = true and role = 'owner';
  if v_user_id is null then raise exception 'Only the Owner can update accounts'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Account name is required'; end if;
  if p_type not in ('cash', 'bank', 'collection_account') then raise exception 'Invalid account type'; end if;
  select jsonb_build_object('name', name, 'type', type, 'holder_name', holder_name, 'active', active)
    into v_before from accounts where id = p_account_id;
  if v_before is null then raise exception 'Account not found'; end if;
  if exists (select 1 from ledger_entries where account_id = p_account_id)
     and (v_before->>'type') <> p_type then
    raise exception 'An account type cannot change after it has ledger movements';
  end if;
  update accounts set name = trim(p_name), type = p_type,
    holder_name = nullif(trim(p_holder_name), ''), active = p_active
    where id = p_account_id;
  insert into audit_log (user_id, action, entity_type, entity_id, before, after)
  values (v_user_id, 'edit_master', 'account', p_account_id, v_before,
    jsonb_build_object('name', trim(p_name), 'type', p_type, 'holder_name', nullif(trim(p_holder_name), ''), 'active', p_active));
end;
$$ language plpgsql security definer set search_path = public;

create or replace function reverse_financial_transaction(p_transaction_id uuid, p_reason text default null)
returns uuid as $$
declare
  v_user_id uuid;
  v_role text;
  v_original transactions%rowtype;
  v_reversal_id uuid;
begin
  select id, role into v_user_id, v_role from users where auth_id = auth.uid() and active = true;
  if v_user_id is null or v_role not in ('owner', 'manager') then raise exception 'Only an Owner or Manager can reverse a transaction'; end if;
  select * into v_original from transactions where id = p_transaction_id;
  if not found then raise exception 'Transaction not found'; end if;
  if v_original.reversal_of is not null then raise exception 'A reversal cannot itself be reversed'; end if;
  if exists (select 1 from transactions where reversal_of = p_transaction_id) then raise exception 'This transaction has already been reversed'; end if;
  if v_original.locked_day then raise exception 'Locked-day transactions can only be reopened by the Owner before correction'; end if;
  if v_role = 'manager' and (v_original.created_by <> v_user_id or v_original.txn_date <> current_date) then
    raise exception 'Managers can reverse only their own transactions recorded today';
  end if;

  insert into transactions (txn_type, txn_date, amount, description, reversal_of, created_by)
  values ('reversal', current_date, v_original.amount,
    concat('Reversal of ', v_original.id, case when nullif(trim(p_reason), '') is null then '' else ': ' || trim(p_reason) end),
    v_original.id, v_user_id)
  returning id into v_reversal_id;
  insert into ledger_entries (transaction_id, account_id, entry_side, amount, counterparty_type, counterparty_id)
  select v_reversal_id, account_id,
    case when entry_side = 'debit' then 'credit' else 'debit' end,
    amount, counterparty_type, counterparty_id
  from ledger_entries where transaction_id = p_transaction_id;
  insert into audit_log (user_id, action, entity_type, entity_id, before, after)
  values (v_user_id, 'reverse', 'transaction', v_reversal_id,
    jsonb_build_object('original_transaction_id', p_transaction_id),
    jsonb_build_object('reason', nullif(trim(p_reason), ''), 'reversal_of', p_transaction_id));
  return v_reversal_id;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function create_account_transfer(uuid, uuid, numeric, date, text) to authenticated;
grant execute on function create_finance_account(text, text, text, numeric) to authenticated;
grant execute on function update_finance_account(uuid, text, text, text, boolean) to authenticated;
grant execute on function reverse_financial_transaction(uuid, text) to authenticated;
