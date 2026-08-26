-- ============================================================================
-- PHASE 2 CORRECTION — CANONICAL PURCHASE ROW STATE + MASTER/RATE RPC CLEANUP
-- Run AFTER:
--   phase2_supplier_rate_management.sql
--   phase2_supplier_rate_gst_fix.sql
--
-- Purpose:
--   1. Keep master_rate and last_purchase_rate strictly separate.
--   2. Snapshot both master GST and actual GST at purchase entry.
--   3. Remove obsolete overloaded purchase-wrapper signatures.
--   4. Leave historical purchase transactions untouched.
--
-- IMPORTANT:
--   This migration does NOT delete or reverse any test transactions. Test
--   transactions created while debugging the previous Phase 2 build remain
--   financial records and should be reversed through the existing reversal
--   workflow if they are not genuine purchases.
-- ============================================================================

-- --------------------------------------------------------------------------
-- PURCHASE-LINE MASTER GST SNAPSHOT
-- --------------------------------------------------------------------------
alter table purchase_items
  add column if not exists master_gst_rate_at_entry numeric(5,2);

create or replace function fn_snapshot_purchase_gst_rate() returns trigger as $$
declare
  v_master_gst numeric(5,2);
begin
  select gst_rate into v_master_gst
  from items
  where id = new.item_id;

  new.master_gst_rate_at_entry := round(coalesce(v_master_gst, 0), 2);
  new.gst_rate_at_entry := round(coalesce(new.gst_rate_at_entry, v_master_gst, 0), 2);
  new.gst_rate_overridden :=
    round(coalesce(new.gst_rate_at_entry, 0), 2) <>
    round(coalesce(v_master_gst, 0), 2);

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_snapshot_purchase_gst_rate on purchase_items;
create trigger trg_snapshot_purchase_gst_rate
  before insert on purchase_items
  for each row execute function fn_snapshot_purchase_gst_rate();

-- --------------------------------------------------------------------------
-- PURCHASE-LINE MASTER RATE SNAPSHOT
-- master_rate is authoritative; last_purchase_rate is only historical/current
-- operational information about the most recent actual purchase.
-- --------------------------------------------------------------------------
create or replace function fn_snapshot_purchase_master_rate() returns trigger as $$
declare
  v_master_rate numeric(10,2);
begin
  select master_rate into v_master_rate
  from items
  where id = new.item_id;

  new.master_rate_at_entry := round(coalesce(v_master_rate, new.rate, 0), 2);
  new.rate_overridden :=
    round(coalesce(new.rate, 0), 2) <>
    round(coalesce(v_master_rate, 0), 2);

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_snapshot_purchase_master_rate on purchase_items;
create trigger trg_snapshot_purchase_master_rate
  before insert on purchase_items
  for each row execute function fn_snapshot_purchase_master_rate();

-- --------------------------------------------------------------------------
-- REMOVE OBSOLETE OVERLOADED PURCHASE WRITERS
-- There must be exactly one public wrapper for purchase entry decisions.
-- --------------------------------------------------------------------------
drop function if exists create_purchase_with_master_rate_updates(uuid,uuid,date,text,jsonb,boolean);
drop function if exists create_purchase_with_master_rate_updates(uuid,uuid,date,text,jsonb,boolean,boolean);

-- --------------------------------------------------------------------------
-- CANONICAL PURCHASE WRITER
--
-- The underlying create_purchase() remains the financial transaction writer.
-- This wrapper optionally updates item master rate and/or GST after the
-- purchase has been created, within the same database transaction.
-- --------------------------------------------------------------------------
create or replace function create_purchase_with_master_rate_updates(
  p_supplier_id uuid,
  p_paid_from_account_id uuid default null,
  p_txn_date date default current_date,
  p_description text default null,
  p_items jsonb default '[]'::jsonb,
  p_update_master_rates boolean default false,
  p_update_master_gst_rates boolean default false
) returns uuid as $$
declare
  v_user users%rowtype;
  v_txn_id uuid;
  v_item jsonb;
  v_item_row items%rowtype;
  v_new_rate numeric(10,2);
  v_new_gst numeric(5,2);
begin
  select * into v_user from phase3_current_user();
  if not found then
    raise exception 'No active application profile exists';
  end if;

  if (p_update_master_rates or p_update_master_gst_rates)
     and v_user.role <> 'owner' then
    raise exception 'Only the Owner can update master rates or GST percentages from a purchase';
  end if;

  v_txn_id := create_purchase(
    p_supplier_id,
    p_paid_from_account_id,
    p_txn_date,
    p_description,
    p_items
  );

  for v_item in
    select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    select * into v_item_row
    from items
    where id = (v_item->>'item_id')::uuid;

    if v_item_row.id is null then
      raise exception 'Purchase item not found';
    end if;

    if p_update_master_rates then
      v_new_rate := round((v_item->>'rate')::numeric, 2);
      if v_new_rate < 0 then
        raise exception 'Master rate cannot be negative';
      end if;

      if round(coalesce(v_item_row.master_rate, 0), 2) <> v_new_rate then
        insert into item_rate_history(
          item_id, old_rate, new_rate, changed_by, reason
        ) values (
          v_item_row.id,
          round(coalesce(v_item_row.master_rate, 0), 2),
          v_new_rate,
          v_user.id,
          'Updated from purchase entry ' || v_txn_id
        );

        update items
        set master_rate = v_new_rate
        where id = v_item_row.id;

        insert into audit_log(
          user_id, action, entity_type, entity_id, before, after
        ) values (
          v_user.id,
          'rate_update_from_purchase',
          'item',
          v_item_row.id,
          jsonb_build_object(
            'master_rate', round(coalesce(v_item_row.master_rate, 0), 2),
            'source_transaction_id', v_txn_id
          ),
          jsonb_build_object(
            'master_rate', v_new_rate,
            'source_transaction_id', v_txn_id
          )
        );
      end if;
    end if;

    if p_update_master_gst_rates then
      v_new_gst := round(
        coalesce((v_item->>'gst_rate')::numeric, v_item_row.gst_rate, 0),
        2
      );

      if v_new_gst < 0 or v_new_gst > 100 then
        raise exception 'GST percentage must be between 0 and 100';
      end if;

      if round(coalesce(v_item_row.gst_rate, 0), 2) <> v_new_gst then
        insert into item_gst_rate_history(
          item_id, old_rate, new_rate, changed_by, reason
        ) values (
          v_item_row.id,
          round(coalesce(v_item_row.gst_rate, 0), 2),
          v_new_gst,
          v_user.id,
          'Updated from purchase entry ' || v_txn_id
        );

        update items
        set gst_rate = v_new_gst
        where id = v_item_row.id;

        insert into audit_log(
          user_id, action, entity_type, entity_id, before, after
        ) values (
          v_user.id,
          'gst_rate_update_from_purchase',
          'item',
          v_item_row.id,
          jsonb_build_object(
            'gst_rate', round(coalesce(v_item_row.gst_rate, 0), 2),
            'source_transaction_id', v_txn_id
          ),
          jsonb_build_object(
            'gst_rate', v_new_gst,
            'source_transaction_id', v_txn_id
          )
        );
      end if;
    end if;
  end loop;

  return v_txn_id;
end;
$$ language plpgsql security definer set search_path=public;

grant execute on function create_purchase_with_master_rate_updates(
  uuid, uuid, date, text, jsonb, boolean, boolean
) to authenticated;

-- --------------------------------------------------------------------------
-- Helpful index for purchase-line auditing.
-- --------------------------------------------------------------------------
create index if not exists idx_purchase_items_item_master_snapshot
  on purchase_items(item_id, master_rate_at_entry, master_gst_rate_at_entry);

-- --------------------------------------------------------------------------
-- Verification query (safe / read-only):
-- SELECT proname, pg_get_function_identity_arguments(oid)
-- FROM pg_proc
-- WHERE proname = 'create_purchase_with_master_rate_updates';
-- Expected: exactly one row with the 7-argument signature.
-- --------------------------------------------------------------------------
