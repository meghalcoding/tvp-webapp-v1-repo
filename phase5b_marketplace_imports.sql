-- ============================================================================
-- PHASE 5B — ZOMATO + SWIGGY MARKETPLACE IMPORT STAGING
-- Also fixes UPI Reconciliation so marketplace collection accounts are settled
-- from the same dedicated reconciliation screen.
-- ============================================================================

-- 1. Import batches
create table if not exists sales_import_batches (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('zomato','swiggy')),
  file_name text not null,
  file_hash text,
  imported_by uuid references users(id) not null,
  imported_at timestamptz not null default now(),
  status text not null default 'uploaded'
    check (status in ('uploaded','parsed','review','committed','failed')),
  total_rows integer not null default 0,
  new_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  invalid_rows integer not null default 0,
  committed_rows integer not null default 0,
  error_message text
);

-- 2. Staging rows. Raw JSON is retained so parser changes never destroy
-- the original merchant-export row.
create table if not exists sales_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references sales_import_batches(id) on delete cascade not null,
  row_number integer not null,
  external_order_id text,
  order_date date,
  order_time text,
  description text,
  gross_amount numeric(12,2),
  discount_amount numeric(12,2) default 0,
  tax_amount numeric(12,2) default 0,
  platform_fee numeric(12,2) default 0,
  net_amount numeric(12,2),
  import_amount numeric(12,2),
  payment_status text,
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  validation_status text not null default 'valid'
    check (validation_status in ('valid','invalid','duplicate')),
  validation_errors jsonb not null default '[]'::jsonb,
  duplicate_of uuid references transactions(id),
  action text not null default 'import'
    check (action in ('import','skip')),
  committed_transaction_id uuid references transactions(id),
  created_at timestamptz not null default now(),
  unique(batch_id, row_number)
);

create index if not exists idx_sales_import_rows_batch
  on sales_import_rows(batch_id);

create index if not exists idx_sales_import_rows_external
  on sales_import_rows(external_order_id);

-- 3. Production sale details retain the source import batch.
alter table sale_details
  add column if not exists import_batch_id uuid references sales_import_batches(id);

create index if not exists idx_sale_details_import_batch
  on sale_details(import_batch_id);

-- 4. RLS for staging data.
alter table sales_import_batches enable row level security;
alter table sales_import_rows enable row level security;

drop policy if exists sales_import_batches_owner_manager on sales_import_batches;
create policy sales_import_batches_owner_manager
on sales_import_batches
for all
to authenticated
using (
  exists (
    select 1 from users u
    where u.auth_id = auth.uid()
      and u.active = true
      and u.role in ('owner','manager')
  )
)
with check (
  exists (
    select 1 from users u
    where u.auth_id = auth.uid()
      and u.active = true
      and u.role in ('owner','manager')
  )
);

drop policy if exists sales_import_rows_owner_manager on sales_import_rows;
create policy sales_import_rows_owner_manager
on sales_import_rows
for all
to authenticated
using (
  exists (
    select 1 from users u
    where u.auth_id = auth.uid()
      and u.active = true
      and u.role in ('owner','manager')
  )
)
with check (
  exists (
    select 1 from users u
    where u.auth_id = auth.uid()
      and u.active = true
      and u.role in ('owner','manager')
  )
);

grant select, insert, update, delete on sales_import_batches to authenticated;
grant select, insert, update, delete on sales_import_rows to authenticated;

-- 5. Create a staging batch.
create or replace function create_sales_import_batch(
  p_platform text,
  p_file_name text,
  p_file_hash text default null,
  p_total_rows integer default 0,
  p_new_rows integer default 0,
  p_duplicate_rows integer default 0,
  p_invalid_rows integer default 0
) returns uuid as $$
declare
  v_user users%rowtype;
  v_id uuid;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role not in ('owner','manager') then
    raise exception 'Only an Owner or Manager can import marketplace sales';
  end if;

  if p_platform not in ('zomato','swiggy') then
    raise exception 'Choose Zomato or Swiggy';
  end if;

  insert into sales_import_batches(
    platform,file_name,file_hash,imported_by,status,
    total_rows,new_rows,duplicate_rows,invalid_rows
  )
  values(
    p_platform,p_file_name,nullif(trim(p_file_hash),''),
    v_user.id,'review',
    greatest(coalesce(p_total_rows,0),0),
    greatest(coalesce(p_new_rows,0),0),
    greatest(coalesce(p_duplicate_rows,0),0),
    greatest(coalesce(p_invalid_rows,0),0)
  )
  returning id into v_id;

  return v_id;
end;
$$ language plpgsql security definer set search_path = public;

-- 6. Commit only rows explicitly marked for import. This is the only route
-- from staging into production sales.
create or replace function commit_sales_import_batch(
  p_batch_id uuid
) returns integer as $$
declare
  v_user users%rowtype;
  v_batch sales_import_batches%rowtype;
  v_row sales_import_rows%rowtype;
  v_txn_id uuid;
  v_account accounts%rowtype;
  v_count integer := 0;
  v_existing uuid;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role not in ('owner','manager') then
    raise exception 'Only an Owner or Manager can commit marketplace imports';
  end if;

  perform pg_advisory_xact_lock(hashtext('sales-import:' || p_batch_id::text));

  select * into v_batch
  from sales_import_batches
  where id = p_batch_id
  for update;

  if not found then raise exception 'Import batch not found'; end if;
  if v_batch.status = 'committed' then
    return v_batch.committed_rows;
  end if;

  for v_row in
    select * from sales_import_rows
    where batch_id = p_batch_id
      and action = 'import'
      and validation_status = 'valid'
      and committed_transaction_id is null
    order by row_number
    for update
  loop
    if v_row.external_order_id is null or trim(v_row.external_order_id) = '' then
      raise exception 'Row % is missing an external order ID', v_row.row_number;
    end if;

    if v_row.import_amount is null or v_row.import_amount <= 0 then
      raise exception 'Row % has no valid import amount', v_row.row_number;
    end if;

    -- Final duplicate check happens inside the same transaction as the insert.
    select sd.transaction_id into v_existing
    from sale_details sd
    where sd.sales_channel = v_batch.platform
      and sd.external_order_id = v_row.external_order_id
    limit 1;

    if v_existing is not null then
      update sales_import_rows
      set validation_status='duplicate', duplicate_of=v_existing, action='skip'
      where id=v_row.id;
      continue;
    end if;

    select * into v_account
    from accounts
    where name = case
      when v_batch.platform='zomato' then 'Zomato Collections'
      else 'Swiggy Collections'
    end
      and type='collection_account'
      and active=true;

    if not found then
      raise exception '% Collections account is not configured', initcap(v_batch.platform);
    end if;

    perform phase3_assert_unlocked(coalesce(v_row.order_date, current_date));

    insert into transactions(
      txn_type,txn_date,amount,description,created_by
    )
    values(
      'sale',
      coalesce(v_row.order_date,current_date),
      round(v_row.import_amount,2),
      nullif(trim(coalesce(v_row.description,'')),''),
      v_user.id
    )
    returning id into v_txn_id;

    insert into ledger_entries(
      transaction_id,account_id,entry_side,amount,counterparty_type
    )
    values
      (v_txn_id,v_account.id,'debit',round(v_row.import_amount,2),'revenue'),
      (v_txn_id,null,'credit',round(v_row.import_amount,2),'revenue');

    insert into sale_details(
      transaction_id,payment_method,collection_account_id,
      sales_channel,external_order_id,import_batch_id
    )
    values(
      v_txn_id,'marketplace',v_account.id,
      v_batch.platform,v_row.external_order_id,p_batch_id
    );

    insert into audit_log(user_id,action,entity_type,entity_id,after)
    values(
      v_user.id,'create','transaction',v_txn_id,
      jsonb_build_object(
        'txn_type','sale',
        'sales_channel',v_batch.platform,
        'external_order_id',v_row.external_order_id,
        'amount',round(v_row.import_amount,2),
        'import_batch_id',p_batch_id,
        'source_row',v_row.row_number
      )
    );

    update sales_import_rows
    set committed_transaction_id=v_txn_id
    where id=v_row.id;

    v_count := v_count + 1;
  end loop;

  update sales_import_batches
  set status='committed',
      committed_rows=v_count,
      new_rows=v_count
  where id=p_batch_id;

  return v_count;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function create_sales_import_batch(text,text,text,integer,integer,integer,integer) to authenticated;
grant execute on function commit_sales_import_batch(uuid) to authenticated;

-- 7. Fix the existing settlement RPC so it settles BOTH UPI and marketplace
-- collection accounts from the dedicated reconciliation screen.
create or replace function create_upi_settlement(
  p_collection_account_id uuid,
  p_settled_to_account_id uuid,
  p_amount numeric,
  p_txn_date date default current_date,
  p_description text default null
) returns uuid as $$
declare
  v_user users%rowtype;
  v_txn_id uuid;
  v_pending numeric;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role not in ('owner','manager') then
    raise exception 'Only an Owner or Manager can settle collections';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Settlement amount must be greater than zero';
  end if;

  if p_collection_account_id = p_settled_to_account_id then
    raise exception 'Choose two different accounts';
  end if;

  perform phase3_assert_unlocked(p_txn_date);

  if not exists (
    select 1 from accounts
    where id=p_collection_account_id
      and type='collection_account'
      and active=true
  ) or not exists (
    select 1 from accounts
    where id=p_settled_to_account_id
      and type in ('cash','bank')
      and active=true
  ) then
    raise exception 'Choose an active collection account and an active Cash or Bank account';
  end if;

  select
    coalesce((
      select sum(t.amount)
      from sale_details sd
      join transactions t on t.id=sd.transaction_id
      where sd.collection_account_id=p_collection_account_id
        and sd.payment_method in ('upi','marketplace')
    ),0)
    -
    coalesce((
      select sum(t.amount)
      from settlement_details sd
      join transactions t on t.id=sd.transaction_id
      where sd.collection_account_id=p_collection_account_id
    ),0)
  into v_pending;

  if round(p_amount,2) > round(v_pending,2) then
    raise exception 'Settlement cannot exceed the pending collected amount (%).', v_pending;
  end if;

  insert into transactions(
    txn_type,txn_date,amount,description,created_by
  )
  values(
    'settlement',p_txn_date,round(p_amount,2),
    nullif(trim(p_description),''),
    v_user.id
  )
  returning id into v_txn_id;

  insert into ledger_entries(
    transaction_id,account_id,entry_side,amount,counterparty_type,counterparty_id
  )
  values
    (v_txn_id,p_settled_to_account_id,'debit',round(p_amount,2),'account',p_collection_account_id),
    (v_txn_id,p_collection_account_id,'credit',round(p_amount,2),'account',p_settled_to_account_id);

  insert into settlement_details(
    transaction_id,collection_account_id,settled_to_account_id
  )
  values(v_txn_id,p_collection_account_id,p_settled_to_account_id);

  insert into audit_log(user_id,action,entity_type,entity_id,after)
  values(
    v_user.id,'settle','transaction',v_txn_id,
    jsonb_build_object(
      'amount',round(p_amount,2),
      'collection_account_id',p_collection_account_id,
      'settled_to_account_id',p_settled_to_account_id,
      'txn_date',p_txn_date
    )
  );

  return v_txn_id;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function create_upi_settlement(uuid,uuid,numeric,date,text) to authenticated;

-- 8. Rebuild reconciliation view: UPI + Zomato + Swiggy collection accounts.
create or replace view upi_reconciliation as
select
  a.id as account_id,
  a.name,
  coalesce(sales.total,0) as sales,
  coalesce(settled.total,0) as settled,
  coalesce(sales.total,0) - coalesce(settled.total,0) as pending
from accounts a
left join (
  select sd.collection_account_id, sum(t.amount) as total
  from sale_details sd
  join transactions t on t.id=sd.transaction_id
  where sd.payment_method in ('upi','marketplace')
  group by sd.collection_account_id
) sales on sales.collection_account_id=a.id
left join (
  select sdet.collection_account_id, sum(t.amount) as total
  from settlement_details sdet
  join transactions t on t.id=sdet.transaction_id
  group by sdet.collection_account_id
) settled on settled.collection_account_id=a.id
where a.type='collection_account';

grant select on upi_reconciliation to authenticated;

notify pgrst, 'reload schema';

-- ============================================================================
-- END PHASE 5B
-- ============================================================================
