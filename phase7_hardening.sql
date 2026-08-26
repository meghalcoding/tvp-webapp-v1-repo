-- ============================================================================
-- PHASE 7 — FINANCIAL HARDENING
-- Run after db/phase6_automation.sql. This migration closes audit findings
-- without changing historical rows.
-- ============================================================================

-- Stock must never become negative silently (Specification §20 invariant 5).
-- A transaction-scoped advisory lock prevents two simultaneous removals from
-- both passing the availability check.
create or replace function fn_prevent_negative_stock() returns trigger as $$
declare v_on_hand numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.item_id::text, 0));
  select coalesce(sum(quantity), 0) into v_on_hand from stock_movements where item_id = new.item_id;
  if v_on_hand + new.quantity < 0 then
    raise exception 'Insufficient stock: item % has % available; this movement needs %', new.item_id, v_on_hand, abs(new.quantity);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_prevent_negative_stock on stock_movements;
create trigger trg_prevent_negative_stock
  before insert on stock_movements
  for each row execute function fn_prevent_negative_stock();

-- Reversal is a true correction: it must also mirror stock movements, rather
-- than leaving an already-reversed purchase/waste in inventory.
create or replace function reverse_financial_transaction(p_transaction_id uuid, p_reason text default null)
returns uuid as $$
declare v_user_id uuid; v_role text; v_original transactions%rowtype; v_reversal_id uuid;
begin
  select id, role into v_user_id, v_role from users where auth_id = auth.uid() and active = true;
  if v_user_id is null or v_role not in ('owner','manager') then raise exception 'Only an Owner or Manager can reverse a transaction'; end if;
  select * into v_original from transactions where id = p_transaction_id;
  if not found then raise exception 'Transaction not found'; end if;
  if v_original.reversal_of is not null then raise exception 'A reversal cannot itself be reversed'; end if;
  if exists (select 1 from transactions where reversal_of = p_transaction_id) then raise exception 'This transaction has already been reversed'; end if;
  if v_original.locked_day then raise exception 'Locked-day transactions can only be reopened by the Owner before correction'; end if;
  if v_role = 'manager' and (v_original.created_by <> v_user_id or v_original.txn_date <> current_date) then raise exception 'Managers can reverse only their own transactions recorded today'; end if;

  insert into transactions (txn_type, txn_date, amount, description, reversal_of, created_by)
  values ('reversal', current_date, v_original.amount,
    concat('Reversal of ', v_original.id, case when nullif(trim(p_reason), '') is null then '' else ': ' || trim(p_reason) end),
    v_original.id, v_user_id) returning id into v_reversal_id;
  insert into ledger_entries (transaction_id, account_id, entry_side, amount, counterparty_type, counterparty_id)
  select v_reversal_id, account_id, case when entry_side = 'debit' then 'credit' else 'debit' end, amount, counterparty_type, counterparty_id
  from ledger_entries where transaction_id = p_transaction_id;
  insert into stock_movements(item_id, transaction_id, movement_type, quantity, rate, reason)
  select item_id, v_reversal_id, 'adjustment', -quantity, rate, 'Reversal of ' || coalesce(reason, movement_type)
  from stock_movements where transaction_id = p_transaction_id;
  insert into audit_log (user_id, action, entity_type, entity_id, before, after)
  values (v_user_id, 'reverse', 'transaction', v_reversal_id,
    jsonb_build_object('original_transaction_id', p_transaction_id),
    jsonb_build_object('reason', nullif(trim(p_reason), ''), 'reversal_of', p_transaction_id));
  return v_reversal_id;
end;
$$ language plpgsql security definer set search_path = public;

-- Do not allow an overpayment to turn a supplier due into an untracked credit.
create or replace function record_supplier_payment(p_supplier_id uuid,p_from_account_id uuid,p_amount numeric,p_txn_date date default current_date,p_description text default null) returns uuid as $$
declare v_user users%rowtype; v_txn_id uuid; v_due numeric;
begin
  select * into v_user from phase4_manager_user(); if not found then raise exception 'Only an Owner or Manager can pay a supplier'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Payment amount must be greater than zero'; end if;
  perform phase3_assert_unlocked(p_txn_date);
  if not exists(select 1 from suppliers where id=p_supplier_id and active=true) or not exists(select 1 from accounts where id=p_from_account_id and active=true) then raise exception 'Choose an active supplier and payment account'; end if;
  select coalesce(sum(case when entry_side='credit' then amount else -amount end),0) into v_due
  from ledger_entries where counterparty_type='supplier' and counterparty_id=p_supplier_id;
  if round(p_amount,2) > round(v_due,2) then raise exception 'Payment cannot exceed the current supplier due (%).', v_due; end if;
  insert into transactions(txn_type,txn_date,amount,description,created_by) values('supplier_payment',p_txn_date,round(p_amount,2),nullif(trim(p_description),''),v_user.id) returning id into v_txn_id;
  insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id) values
    (v_txn_id,null,'debit',round(p_amount,2),'supplier',p_supplier_id),
    (v_txn_id,p_from_account_id,'credit',round(p_amount,2),'supplier',p_supplier_id);
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'supplier_payment','transaction',v_txn_id,jsonb_build_object('supplier_id',p_supplier_id,'from_account_id',p_from_account_id,'amount',round(p_amount,2),'txn_date',p_txn_date));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

-- Reversal-aware balances. Ledger signs, rather than report rows, are the
-- source of truth for supplier and UPI pending values.
create or replace view supplier_balances with (security_invoker = true) as
select s.id as supplier_id, s.name,
  coalesce(sum(case when le.counterparty_type='supplier' and le.entry_side='credit' then le.amount else 0 end),0) as total_purchased,
  coalesce(sum(case when le.counterparty_type='supplier' and le.entry_side='debit' then le.amount else 0 end),0) as total_paid,
  coalesce(sum(case when le.counterparty_type='supplier' then case when le.entry_side='credit' then le.amount else -le.amount end else 0 end),0) as outstanding
from suppliers s left join ledger_entries le on le.counterparty_id=s.id and le.counterparty_type='supplier'
group by s.id,s.name;

create or replace view upi_reconciliation with (security_invoker = true) as
with sale_effects as (
  select sd.collection_account_id account_id, case when t.reversal_of is null then t.amount else -t.amount end amount
  from transactions t join transactions original on original.id=coalesce(t.reversal_of,t.id)
  join sale_details sd on sd.transaction_id=original.id where original.txn_type='sale' and sd.payment_method='upi'
), settlement_effects as (
  select sd.collection_account_id account_id, case when t.reversal_of is null then t.amount else -t.amount end amount
  from transactions t join transactions original on original.id=coalesce(t.reversal_of,t.id)
  join settlement_details sd on sd.transaction_id=original.id where original.txn_type='settlement'
)
select a.id account_id,a.name,coalesce(sales.total,0) sales,coalesce(settled.total,0) settled,coalesce(sales.total,0)-coalesce(settled.total,0) pending
from accounts a left join (select account_id,sum(amount) total from sale_effects group by account_id) sales on sales.account_id=a.id
left join (select account_id,sum(amount) total from settlement_effects group by account_id) settled on settled.account_id=a.id
where a.type='collection_account';

alter view account_balances set (security_invoker = true);
alter view current_stock set (security_invoker = true);

-- Browser clients must use the audited security-definer RPCs. These policies
-- previously allowed direct detail/master edits that could bypass audit logs.
drop policy if exists users_owner_write on users;
drop policy if exists masters_write_accounts on accounts;
drop policy if exists masters_write_categories on expense_categories;
drop policy if exists masters_write_suppliers on suppliers;
drop policy if exists masters_write_items on items;
drop policy if exists sale_details_all on sale_details;
drop policy if exists purchase_details_all on purchase_details;
drop policy if exists purchase_items_all on purchase_items;
drop policy if exists expense_details_all on expense_details;
drop policy if exists expense_items_all on expense_items;
drop policy if exists transfer_details_all on transfer_details;
drop policy if exists settlement_details_all on settlement_details;
drop policy if exists stock_movements_insert on stock_movements;
drop policy if exists audit_log_insert on audit_log;
drop policy if exists transactions_insert on transactions;
drop policy if exists ledger_entries_insert on ledger_entries;
drop policy if exists daily_closings_insert on daily_closings;
drop policy if exists daily_closings_update_owner_only on daily_closings;

create policy sale_details_select on sale_details for select using (auth.uid() is not null);
create policy purchase_details_select on purchase_details for select using (current_user_role() in ('owner','manager'));
create policy purchase_items_select on purchase_items for select using (current_user_role() in ('owner','manager'));
create policy expense_details_select on expense_details for select using (current_user_role() in ('owner','manager') or exists(select 1 from transactions t where t.id=transaction_id and t.created_by=current_app_user_id()));
create policy expense_items_select on expense_items for select using (current_user_role() in ('owner','manager'));
create policy transfer_details_select on transfer_details for select using (current_user_role() in ('owner','manager'));
create policy settlement_details_select on settlement_details for select using (current_user_role() in ('owner','manager'));

grant execute on function reverse_financial_transaction(uuid,text) to authenticated;
grant execute on function record_supplier_payment(uuid,uuid,numeric,date,text) to authenticated;

-- Idempotent entry points for the PWA outbox. A retry after a lost network
-- response returns the original transaction instead of posting it twice.
create or replace function create_sale_idempotent(p_client_uuid uuid,p_amount numeric,p_payment_method text,p_collection_account_id uuid default null,p_txn_date date default current_date,p_description text default null) returns uuid as $$
declare v_id uuid;
begin
  if p_client_uuid is null then raise exception 'Offline-safe sale requires a client UUID'; end if;
  select id into v_id from transactions where client_uuid=p_client_uuid;
  if v_id is not null then return v_id; end if;
  select create_sale(p_amount,p_payment_method,p_collection_account_id,p_txn_date,p_description) into v_id;
  update transactions set client_uuid=p_client_uuid where id=v_id;
  return v_id;
end;
$$ language plpgsql security definer set search_path=public;

create or replace function create_expense_idempotent(p_client_uuid uuid,p_category_id uuid,p_paid_from_account_id uuid,p_amount numeric,p_txn_date date default current_date,p_description text default null,p_items jsonb default '[]'::jsonb) returns uuid as $$
declare v_id uuid;
begin
  if p_client_uuid is null then raise exception 'Offline-safe expense requires a client UUID'; end if;
  select id into v_id from transactions where client_uuid=p_client_uuid;
  if v_id is not null then return v_id; end if;
  select create_expense(p_category_id,p_paid_from_account_id,p_amount,p_txn_date,p_description,p_items) into v_id;
  update transactions set client_uuid=p_client_uuid where id=v_id;
  return v_id;
end;
$$ language plpgsql security definer set search_path=public;

create or replace function record_wastage_idempotent(p_client_uuid uuid,p_item_id uuid,p_quantity numeric,p_reason text,p_txn_date date default current_date,p_description text default null) returns uuid as $$
declare v_id uuid;
begin
  if p_client_uuid is null then raise exception 'Offline-safe wastage requires a client UUID'; end if;
  select id into v_id from transactions where client_uuid=p_client_uuid;
  if v_id is not null then return v_id; end if;
  select record_wastage(p_item_id,p_quantity,p_reason,p_txn_date,p_description) into v_id;
  update transactions set client_uuid=p_client_uuid where id=v_id;
  return v_id;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function create_sale_idempotent(uuid,numeric,text,uuid,date,text) to authenticated;
grant execute on function create_expense_idempotent(uuid,uuid,uuid,numeric,date,text,jsonb) to authenticated;
grant execute on function record_wastage_idempotent(uuid,uuid,numeric,text,date,text) to authenticated;
