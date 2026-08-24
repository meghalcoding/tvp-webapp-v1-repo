-- ============================================================================
-- PHASE 5A — SALES CHANNEL FOUNDATION
-- Adds marketplace-aware sales metadata without introducing the import staging
-- layer yet. Run after the current Phase 4/7 database migrations.
-- ============================================================================

-- 1. Sales channel + marketplace-ready metadata.
alter table sale_details
  add column if not exists sales_channel text not null default 'walk_in';

alter table sale_details
  add column if not exists external_order_id text;

alter table sale_details
  drop constraint if exists sale_details_sales_channel_check;

alter table sale_details
  add constraint sale_details_sales_channel_check
  check (sales_channel in ('walk_in','zomato','swiggy'));

-- Existing data is walk-in unless explicitly changed later.
create index if not exists idx_sale_details_sales_channel
  on sale_details (sales_channel);

-- Production-level duplicate protection for marketplace orders.
create unique index if not exists ux_sale_details_marketplace_order
  on sale_details (sales_channel, external_order_id)
  where external_order_id is not null
    and sales_channel in ('zomato','swiggy');

-- 2. Marketplace collections are separate collection accounts so later
-- settlement/reconciliation can move money from the platform to the bank.
insert into accounts (name, type, active)
values
  ('Zomato Collections', 'collection_account', true),
  ('Swiggy Collections', 'collection_account', true)
on conflict (name) do nothing;

-- 3. Replace sale RPC with channel-aware validation.
drop function if exists create_sale(numeric,text,uuid,date,text);

create or replace function create_sale(
  p_amount numeric,
  p_payment_method text,
  p_collection_account_id uuid default null,
  p_txn_date date default current_date,
  p_description text default null,
  p_sales_channel text default 'walk_in'
) returns uuid as $$
declare
  v_user users%rowtype;
  v_txn_id uuid;
  v_account accounts%rowtype;
begin
  select * into v_user from phase3_current_user();
  if not found then
    raise exception 'No active application profile exists for this signed-in user';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Sale amount must be greater than zero';
  end if;

  if p_sales_channel not in ('walk_in','zomato','swiggy') then
    raise exception 'Choose a valid sales channel';
  end if;

  if p_sales_channel = 'walk_in' and p_payment_method not in ('cash','upi') then
    raise exception 'Walk-in sales must use Cash or UPI';
  end if;

  if p_sales_channel in ('zomato','swiggy') and p_payment_method <> 'marketplace' then
    raise exception 'Zomato and Swiggy sales must use Marketplace collection';
  end if;

  perform phase3_assert_unlocked(p_txn_date);

  if p_payment_method = 'cash' then
    select * into v_account
    from accounts
    where name = 'Cash Drawer'
      and type = 'cash'
      and active = true;

  else
    select * into v_account
    from accounts
    where id = p_collection_account_id
      and type = 'collection_account'
      and active = true;

    if not found then
      raise exception 'Choose an active collection account';
    end if;

    if p_sales_channel = 'zomato' and v_account.name <> 'Zomato Collections' then
      raise exception 'Zomato sales must use the Zomato Collections account';
    end if;

    if p_sales_channel = 'swiggy' and v_account.name <> 'Swiggy Collections' then
      raise exception 'Swiggy sales must use the Swiggy Collections account';
    end if;
  end if;

  if not found then
    raise exception 'Create an active Cash Drawer account first';
  end if;

  insert into transactions (
    txn_type, txn_date, amount, description, created_by
  )
  values (
    'sale',
    p_txn_date,
    round(p_amount, 2),
    nullif(trim(p_description), ''),
    v_user.id
  )
  returning id into v_txn_id;

  insert into ledger_entries (
    transaction_id,
    account_id,
    entry_side,
    amount,
    counterparty_type
  )
  values
    (v_txn_id, v_account.id, 'debit', round(p_amount, 2), 'revenue'),
    (v_txn_id, null, 'credit', round(p_amount, 2), 'revenue');

  insert into sale_details (
    transaction_id,
    payment_method,
    collection_account_id,
    sales_channel
  )
  values (
    v_txn_id,
    p_payment_method,
    case when p_payment_method = 'cash' then null else v_account.id end,
    p_sales_channel
  );

  insert into audit_log (
    user_id, action, entity_type, entity_id, after
  )
  values (
    v_user.id,
    'create',
    'transaction',
    v_txn_id,
    jsonb_build_object(
      'txn_type', 'sale',
      'amount', round(p_amount,2),
      'payment_method', p_payment_method,
      'sales_channel', p_sales_channel,
      'account_id', v_account.id,
      'txn_date', p_txn_date
    )
  );

  return v_txn_id;
end;
$$ language plpgsql security definer set search_path = public;

-- 4. Replace the offline-safe sale entry point with the channel-aware version.
drop function if exists create_sale_idempotent(uuid,numeric,text,uuid,date,text);

create or replace function create_sale_idempotent(
  p_client_uuid uuid,
  p_amount numeric,
  p_payment_method text,
  p_collection_account_id uuid default null,
  p_txn_date date default current_date,
  p_description text default null,
  p_sales_channel text default 'walk_in'
) returns uuid as $$
declare
  v_id uuid;
begin
  if p_client_uuid is null then
    raise exception 'Offline-safe sale requires a client UUID';
  end if;

  select id into v_id
  from transactions
  where client_uuid = p_client_uuid;

  if v_id is not null then
    return v_id;
  end if;

  select create_sale(
    p_amount,
    p_payment_method,
    p_collection_account_id,
    p_txn_date,
    p_description,
    p_sales_channel
  ) into v_id;

  update transactions
  set client_uuid = p_client_uuid
  where id = v_id;

  return v_id;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function create_sale(numeric,text,uuid,date,text,text) to authenticated;
grant execute on function create_sale_idempotent(uuid,numeric,text,uuid,date,text,text) to authenticated;

-- The old check was only cash/upi. Marketplace is now a valid collection mode,
-- but only through the channel-aware RPC above.
alter table sale_details
  drop constraint if exists sale_details_payment_method_check;

alter table sale_details
  add constraint sale_details_payment_method_check
  check (payment_method in ('cash','upi','marketplace'));

-- ============================================================================
-- END PHASE 5A
-- ============================================================================
