-- ============================================================================
-- PHASE 4A CORRECTIONS
-- Fixes document permissions/uploading, refreshes PostgREST schema cache,
-- adds true unpaid-expense accounting, and adds expense-due settlement.
-- Run AFTER phase4a_documents.sql.
-- ============================================================================

-- --------------------------------------------------------------------------
-- Document table grants. The original migration enabled RLS but did not grant
-- the authenticated API role table privileges, causing 403/RLS failures.
-- --------------------------------------------------------------------------
grant select, insert, update, delete on documents to authenticated;
grant select, insert, delete on transaction_documents to authenticated;

-- Keep the row policies, but make their intent explicit and avoid depending on
-- PostgREST's nested-resource policy evaluation for basic ownership checks.
drop policy if exists documents_select on documents;
create policy documents_select on documents for select
using (
  current_user_role() in ('owner','manager')
  or uploaded_by = current_app_user_id()
  or can_access_document(id)
);

drop policy if exists documents_insert on documents;
create policy documents_insert on documents for insert
with check (uploaded_by = current_app_user_id());

drop policy if exists transaction_documents_select on transaction_documents;
create policy transaction_documents_select on transaction_documents for select
using (
  current_user_role() in ('owner','manager')
  or exists (
    select 1 from transactions t
    where t.id = transaction_id
      and t.created_by = current_app_user_id()
  )
);

drop policy if exists transaction_documents_insert on transaction_documents;
create policy transaction_documents_insert on transaction_documents for insert
with check (
  linked_by = current_app_user_id()
  and (
    current_user_role() in ('owner','manager')
    or exists (select 1 from transactions t where t.id = transaction_id and t.created_by = current_app_user_id())
  )
  and exists (select 1 from documents d where d.id = document_id)
);

-- --------------------------------------------------------------------------
-- Atomic document creation. The browser uploads the file to private Storage,
-- then this security-definer function creates metadata + links in one DB tx.
-- This removes frontend dependence on direct documents INSERT RLS behavior.
-- --------------------------------------------------------------------------
create or replace function create_financial_document(
  p_file_name text,
  p_storage_path text,
  p_mime_type text,
  p_size_bytes bigint,
  p_document_type text default 'other',
  p_supplier_id uuid default null,
  p_invoice_number text default null,
  p_document_date date default null,
  p_notes text default null,
  p_transaction_ids uuid[] default '{}'
) returns documents as $$
declare
  v_user users%rowtype;
  v_document documents%rowtype;
  v_txn_id uuid;
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists for this account.'; end if;
  if nullif(trim(p_file_name),'') is null then raise exception 'Document file name is required.'; end if;
  if nullif(trim(p_storage_path),'') is null then raise exception 'Document storage path is required.'; end if;
  if p_mime_type not in ('application/pdf','image/jpeg','image/png','image/webp') then raise exception 'Unsupported document type.'; end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 10485760 then raise exception 'Document must be between 1 byte and 10 MB.'; end if;
  if p_document_type not in ('invoice','receipt','bill','other') then raise exception 'Invalid document type.'; end if;

  insert into documents(file_name,storage_path,mime_type,size_bytes,document_type,uploaded_by,supplier_id,invoice_number,document_date,notes)
  values(trim(p_file_name),p_storage_path,p_mime_type,p_size_bytes,p_document_type,v_user.id,p_supplier_id,
         nullif(trim(p_invoice_number),''),p_document_date,nullif(trim(p_notes),''))
  returning * into v_document;

  foreach v_txn_id in array coalesce(p_transaction_ids,'{}'::uuid[]) loop
    if not can_access_transaction(v_txn_id) then
      raise exception 'You cannot link this document to transaction %.', v_txn_id;
    end if;
    insert into transaction_documents(document_id,transaction_id,linked_by)
    values(v_document.id,v_txn_id,v_user.id)
    on conflict (document_id,transaction_id) do nothing;
    insert into audit_log(user_id,action,entity_type,entity_id,after)
    values(v_user.id,'link_financial_document','transaction',v_txn_id,jsonb_build_object('document_id',v_document.id));
  end loop;

  insert into audit_log(user_id,action,entity_type,entity_id,after)
  values(v_user.id,'create','document',v_document.id,jsonb_build_object(
    'file_name',v_document.file_name,'document_type',v_document.document_type,
    'supplier_id',v_document.supplier_id,'invoice_number',v_document.invoice_number,
    'transaction_count',coalesce(array_length(p_transaction_ids,1),0)));
  return v_document;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function create_financial_document(text,text,text,bigint,text,uuid,text,date,text,uuid[]) to authenticated;

-- Force PostgREST to refresh its generated relationship/schema cache after the
-- new tables/functions were created.
notify pgrst, 'reload schema';

-- --------------------------------------------------------------------------
-- TRUE UNPAID EXPENSE SUPPORT
-- --------------------------------------------------------------------------
alter table accounts drop constraint if exists accounts_type_check;
alter table accounts add constraint accounts_type_check
  check (type in ('cash','bank','collection_account','payable'));

alter table transactions drop constraint if exists transactions_txn_type_check;
alter table transactions add constraint transactions_txn_type_check
  check (txn_type in ('sale','purchase','expense','expense_payment','transfer','settlement','supplier_payment','stock_adjustment','wastage','opening_balance','reversal'));

alter table ledger_entries drop constraint if exists ledger_entries_counterparty_type_check;
alter table ledger_entries add constraint ledger_entries_counterparty_type_check
  check (counterparty_type in ('revenue','expense_category','supplier','expense','account','wastage','inventory'));

insert into accounts(name,type,holder_name,opening_balance,active)
values ('Expense Payables','payable','Cravory',0,true)
on conflict (name) do nothing;

-- Extend account master RPCs so payable is a legitimate owner-managed type.
create or replace function create_finance_account(p_name text,p_type text,p_holder_name text default null,p_opening_balance numeric default 0)
returns uuid as $$
declare v_user_id uuid; v_account_id uuid;
begin
  select id into v_user_id from users where auth_id=auth.uid() and active=true and role='owner';
  if v_user_id is null then raise exception 'Only the Owner can create accounts'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Account name is required'; end if;
  if p_type not in ('cash','bank','collection_account','payable') then raise exception 'Invalid account type'; end if;
  if p_opening_balance is null or p_opening_balance < 0 then raise exception 'Opening balance cannot be negative'; end if;
  insert into accounts(name,type,holder_name,opening_balance) values(trim(p_name),p_type,nullif(trim(p_holder_name),''),round(p_opening_balance,2)) returning id into v_account_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user_id,'create','account',v_account_id,jsonb_build_object('name',trim(p_name),'type',p_type,'opening_balance',round(p_opening_balance,2)));
  return v_account_id;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function create_finance_account(text,text,text,numeric) to authenticated;

create or replace function update_finance_account(p_account_id uuid,p_name text,p_type text,p_holder_name text default null,p_active boolean default true)
returns void as $$
declare v_user_id uuid; v_before jsonb;
begin
  select id into v_user_id from users where auth_id=auth.uid() and active=true and role='owner';
  if v_user_id is null then raise exception 'Only the Owner can update accounts'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Account name is required'; end if;
  if p_type not in ('cash','bank','collection_account','payable') then raise exception 'Invalid account type'; end if;
  select jsonb_build_object('name',name,'type',type,'holder_name',holder_name,'active',active) into v_before from accounts where id=p_account_id;
  if v_before is null then raise exception 'Account not found'; end if;
  if exists(select 1 from ledger_entries where account_id=p_account_id) and (v_before->>'type')<>p_type then raise exception 'An account type cannot change after it has ledger movements'; end if;
  update accounts set name=trim(p_name),type=p_type,holder_name=nullif(trim(p_holder_name),''),active=coalesce(p_active,true) where id=p_account_id;
  insert into audit_log(user_id,action,entity_type,entity_id,before,after) values(v_user_id,'update','account',p_account_id,v_before,jsonb_build_object('name',trim(p_name),'type',p_type,'active',coalesce(p_active,true)));
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function update_finance_account(uuid,text,text,text,boolean) to authenticated;

-- Replace expense writer to support either a real payment account or the
-- Expense Payables liability account. Expense recognition is immediate; cash
-- moves only when the payable is later settled.
create or replace function create_expense(
  p_category_id uuid,p_paid_from_account_id uuid,p_amount numeric,p_txn_date date default current_date,
  p_description text default null,p_items jsonb default '[]'::jsonb
) returns uuid as $$
declare v_user users%rowtype; v_txn_id uuid; v_category expense_categories%rowtype; v_account accounts%rowtype; v_payable accounts%rowtype; v_item jsonb; v_item_total numeric:=0;
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists for this signed-in user'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Expense amount must be greater than zero'; end if;
  if jsonb_typeof(coalesce(p_items,'[]'::jsonb))<>'array' then raise exception 'Expense items must be a list'; end if;
  if v_user.role='staff' and jsonb_array_length(coalesce(p_items,'[]'::jsonb))>0 then raise exception 'Staff can record quick expenses only'; end if;
  perform phase3_assert_unlocked(p_txn_date);
  select * into v_category from expense_categories where id=p_category_id and active=true;
  if v_category.id is null then raise exception 'Choose an active expense category'; end if;
  if p_paid_from_account_id is not null then
    select * into v_account from accounts where id=p_paid_from_account_id and active=true and type in ('cash','bank','collection_account');
    if v_account.id is null then raise exception 'Choose an active payment account'; end if;
  else
    select * into v_payable from accounts where name='Expense Payables' and type='payable' and active=true;
    if v_payable.id is null then raise exception 'Expense Payables account is not configured'; end if;
  end if;
  for v_item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    if coalesce(v_item->>'description','')='' or coalesce((v_item->>'amount')::numeric,0)<=0 then raise exception 'Every expense item needs a description and amount'; end if;
    v_item_total:=v_item_total+round((v_item->>'amount')::numeric,2);
  end loop;
  if jsonb_array_length(coalesce(p_items,'[]'::jsonb))>0 and round(v_item_total,2)<>round(p_amount,2) then raise exception 'Detailed expense items must add up exactly to the expense amount'; end if;
  insert into transactions(txn_type,txn_date,amount,description,created_by) values('expense',p_txn_date,round(p_amount,2),nullif(trim(p_description),''),v_user.id) returning id into v_txn_id;
  insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id) values
    (v_txn_id,null,'debit',round(p_amount,2),'expense_category',v_category.id),
    (v_txn_id,coalesce(v_account.id,v_payable.id),'credit',round(p_amount,2),case when v_account.id is null then 'expense' else 'expense_category' end,case when v_account.id is null then v_txn_id else v_category.id end);
  insert into expense_details(transaction_id,category_id,paid_from_account_id) values(v_txn_id,v_category.id,v_account.id);
  insert into expense_items(transaction_id,description,quantity,unit,rate,amount)
  select v_txn_id,value->>'description',nullif(value->>'quantity','')::numeric,nullif(value->>'unit',''),nullif(value->>'rate','')::numeric,(value->>'amount')::numeric from jsonb_array_elements(coalesce(p_items,'[]'::jsonb));
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','transaction',v_txn_id,jsonb_build_object('txn_type','expense','amount',round(p_amount,2),'category_id',v_category.id,'paid_from_account_id',v_account.id,'unpaid',v_account.id is null,'txn_date',p_txn_date));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function create_expense(uuid,uuid,numeric,date,text,jsonb) to authenticated;

create or replace function create_expense_idempotent(p_client_uuid uuid,p_category_id uuid,p_paid_from_account_id uuid,p_amount numeric,p_txn_date date default current_date,p_description text default null,p_items jsonb default '[]'::jsonb)
returns uuid as $$
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

grant execute on function create_expense_idempotent(uuid,uuid,uuid,numeric,date,text,jsonb) to authenticated;

create or replace function record_expense_payment(p_expense_transaction_id uuid,p_from_account_id uuid,p_amount numeric,p_txn_date date default current_date,p_description text default null)
returns uuid as $$
declare v_user users%rowtype; v_txn_id uuid; v_due numeric; v_payable accounts%rowtype; v_from accounts%rowtype; v_expense transactions%rowtype; v_detail expense_details%rowtype;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role not in ('owner','manager') then raise exception 'Only an Owner or Manager can pay an expense due'; end if;
  select * into v_expense from transactions where id=p_expense_transaction_id and txn_type='expense';
  if v_expense.id is null then raise exception 'Expense transaction not found'; end if;
  select * into v_detail from expense_details where transaction_id=p_expense_transaction_id;
  if v_detail.paid_from_account_id is not null then raise exception 'This expense was already paid at entry.'; end if;
  select * into v_from from accounts where id=p_from_account_id and active=true and type in ('cash','bank','collection_account');
  if v_from.id is null then raise exception 'Choose an active payment account'; end if;
  select * into v_payable from accounts where name='Expense Payables' and type='payable' and active=true;
  select coalesce(sum(case when entry_side='debit' and counterparty_type='expense' and counterparty_id=p_expense_transaction_id then amount else 0 end),0) into v_due from ledger_entries;
  v_due:=round(v_expense.amount-v_due,2);
  if v_due<=0 then raise exception 'This expense has no outstanding balance'; end if;
  if p_amount is null or p_amount<=0 or round(p_amount,2)>v_due then raise exception 'Payment must be greater than zero and cannot exceed the outstanding due (%)',v_due; end if;
  perform phase3_assert_unlocked(p_txn_date);
  insert into transactions(txn_type,txn_date,amount,description,created_by) values('expense_payment',p_txn_date,round(p_amount,2),nullif(trim(p_description),''),v_user.id) returning id into v_txn_id;
  insert into ledger_entries(transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id) values
    (v_txn_id,v_payable.id,'debit',round(p_amount,2),'expense',p_expense_transaction_id),
    (v_txn_id,v_from.id,'credit',round(p_amount,2),'expense',p_expense_transaction_id);
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'expense_payment','transaction',v_txn_id,jsonb_build_object('expense_transaction_id',p_expense_transaction_id,'from_account_id',p_from_account_id,'amount',round(p_amount,2),'txn_date',p_txn_date));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function record_expense_payment(uuid,uuid,numeric,date,text) to authenticated;

-- A small read model for the UI: only unpaid expenses have meaningful dues.
create or replace view expense_balances as
select t.id as expense_id,
       t.txn_date,
       t.amount as original_amount,
       coalesce(sum(case when le.entry_side='debit' and le.counterparty_type='expense' and le.counterparty_id=t.id then le.amount else 0 end),0) as paid_amount,
       round(t.amount-coalesce(sum(case when le.entry_side='debit' and le.counterparty_type='expense' and le.counterparty_id=t.id then le.amount else 0 end),0),2) as outstanding
from transactions t
join expense_details ed on ed.transaction_id=t.id
left join ledger_entries le on le.counterparty_type='expense' and le.counterparty_id=t.id
where t.txn_type='expense' and ed.paid_from_account_id is null
  and (current_user_role() in ('owner','manager') or t.created_by=current_app_user_id())
group by t.id,t.txn_date,t.amount;

grant select on expense_balances to authenticated;

notify pgrst, 'reload schema';
