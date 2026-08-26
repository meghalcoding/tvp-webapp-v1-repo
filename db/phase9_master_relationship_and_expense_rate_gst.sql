-- PHASE 9 — Master relationship removal + Expense rate/GST parity
--
-- 1) Item category relationships are true assignments. Removing a category
--    from Edit Item removes that bridge row; it does not affect transactions.
-- 2) Expense entry gets the same Modify Rate / Modify GST master-update
--    workflow already used by Purchase.

create or replace function public.set_item_master_relationships(
  p_item_id uuid,
  p_purchase_category_ids uuid[] default '{}',
  p_expense_category_ids uuid[] default '{}'
) returns void
language plpgsql security definer set search_path=public
as $$
declare
  v_user users%rowtype;
begin
  select * into v_user from phase4_owner_user();
  if not found then raise exception 'Only the Owner can manage item relationships'; end if;
  if not exists(select 1 from items where id=p_item_id) then raise exception 'Item not found'; end if;

  delete from purchase_category_items where item_id=p_item_id;
  delete from expense_category_items where item_id=p_item_id;

  insert into purchase_category_items(purchase_category_id,item_id,active)
  select x,p_item_id,true
  from unnest(coalesce(p_purchase_category_ids,'{}')) x
  on conflict(purchase_category_id,item_id) do update set active=true;

  insert into expense_category_items(expense_category_id,item_id,active)
  select x,p_item_id,true
  from unnest(coalesce(p_expense_category_ids,'{}')) x
  on conflict(expense_category_id,item_id) do update set active=true;
end $$;

grant execute on function public.set_item_master_relationships(uuid,uuid[],uuid[]) to authenticated;


create or replace function public.create_expense_with_master_rate_updates(
  p_category_id uuid,
  p_paid_from_account_id uuid,
  p_amount numeric,
  p_txn_date date default current_date,
  p_description text default null,
  p_items jsonb default '[]'::jsonb,
  p_update_master_rates boolean default false,
  p_update_master_gst_rates boolean default false
) returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_user users%rowtype;
  v_txn_id uuid;
  v_item jsonb;
  v_item_row items%rowtype;
  v_new_rate numeric;
  v_new_gst numeric;
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists'; end if;

  if (p_update_master_rates or p_update_master_gst_rates) and v_user.role <> 'owner' then
    raise exception 'Only the Owner can update master rates or GST percentages from an expense';
  end if;

  v_txn_id := public.create_expense(
    p_category_id,
    p_paid_from_account_id,
    p_amount,
    p_txn_date,
    p_description,
    p_items
  );

  for v_item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    select * into v_item_row from items where id=(v_item->>'item_id')::uuid;
    if v_item_row.id is null then raise exception 'Expense item not found'; end if;

    if p_update_master_rates then
      v_new_rate := round((v_item->>'rate')::numeric,2);
      if v_new_rate < 0 then raise exception 'Master rate cannot be negative'; end if;

      if round(coalesce(v_item_row.master_rate,0),2) <> v_new_rate then
        insert into item_rate_history(item_id,old_rate,new_rate,changed_by,reason)
        values(v_item_row.id,round(coalesce(v_item_row.master_rate,0),2),v_new_rate,v_user.id,
               'Updated from expense entry ' || v_txn_id);

        update items set master_rate=v_new_rate where id=v_item_row.id;

        insert into audit_log(user_id,action,entity_type,entity_id,before,after)
        values(
          v_user.id,'rate_update_from_expense','item',v_item_row.id,
          jsonb_build_object('master_rate',round(coalesce(v_item_row.master_rate,0),2),'source_transaction_id',v_txn_id),
          jsonb_build_object('master_rate',v_new_rate,'source_transaction_id',v_txn_id)
        );
      end if;
    end if;

    if p_update_master_gst_rates then
      v_new_gst := round(coalesce((v_item->>'gst_rate')::numeric,v_item_row.gst_rate,0),2);
      if v_new_gst < 0 or v_new_gst > 100 then
        raise exception 'GST percentage must be between 0 and 100';
      end if;

      if round(coalesce(v_item_row.gst_rate,0),2) <> v_new_gst then
        insert into item_gst_rate_history(item_id,old_rate,new_rate,changed_by,reason)
        values(v_item_row.id,round(coalesce(v_item_row.gst_rate,0),2),v_new_gst,v_user.id,
               'Updated from expense entry ' || v_txn_id);

        update items set gst_rate=v_new_gst where id=v_item_row.id;

        insert into audit_log(user_id,action,entity_type,entity_id,before,after)
        values(
          v_user.id,'gst_rate_update_from_expense','item',v_item_row.id,
          jsonb_build_object('gst_rate',round(coalesce(v_item_row.gst_rate,0),2),'source_transaction_id',v_txn_id),
          jsonb_build_object('gst_rate',v_new_gst,'source_transaction_id',v_txn_id)
        );
      end if;
    end if;
  end loop;

  return v_txn_id;
end $$;

grant execute on function public.create_expense_with_master_rate_updates(uuid,uuid,numeric,date,text,jsonb,boolean,boolean) to authenticated;


create or replace function public.create_expense_idempotent_with_master_rate_updates(
  p_client_uuid uuid,
  p_category_id uuid,
  p_paid_from_account_id uuid,
  p_amount numeric,
  p_txn_date date default current_date,
  p_description text default null,
  p_items jsonb default '[]'::jsonb,
  p_update_master_rates boolean default false,
  p_update_master_gst_rates boolean default false
) returns uuid
language plpgsql security definer set search_path=public
as $$
declare v_id uuid;
begin
  if p_client_uuid is null then raise exception 'Expense requires a client UUID'; end if;
  select id into v_id from transactions where client_uuid=p_client_uuid;
  if v_id is not null then return v_id; end if;

  select public.create_expense_with_master_rate_updates(
    p_category_id,p_paid_from_account_id,p_amount,p_txn_date,p_description,p_items,
    p_update_master_rates,p_update_master_gst_rates
  ) into v_id;

  update transactions set client_uuid=p_client_uuid where id=v_id;
  return v_id;
end $$;

grant execute on function public.create_expense_idempotent_with_master_rate_updates(uuid,uuid,uuid,numeric,date,text,jsonb,boolean,boolean) to authenticated;


create or replace function public.create_unpaid_expense_idempotent_with_master_rate_updates(
  p_client_uuid uuid,
  p_category_id uuid,
  p_amount numeric,
  p_txn_date date default current_date,
  p_description text default null,
  p_items jsonb default '[]'::jsonb,
  p_update_master_rates boolean default false,
  p_update_master_gst_rates boolean default false
) returns uuid
language plpgsql security definer set search_path=public
as $$
declare v_id uuid;
begin
  if p_client_uuid is null then raise exception 'Expense requires a client UUID'; end if;
  select id into v_id from transactions where client_uuid=p_client_uuid;
  if v_id is not null then return v_id; end if;

  select public.create_expense_with_master_rate_updates(
    p_category_id,null,p_amount,p_txn_date,p_description,p_items,
    p_update_master_rates,p_update_master_gst_rates
  ) into v_id;

  update transactions set client_uuid=p_client_uuid where id=v_id;
  return v_id;
end $$;

grant execute on function public.create_unpaid_expense_idempotent_with_master_rate_updates(uuid,uuid,numeric,date,text,jsonb,boolean,boolean) to authenticated;
