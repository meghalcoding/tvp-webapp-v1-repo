-- ============================================================================
-- RESTORE ORIGINAL VYAPAR DATES FOR THE 2026-08 SEED
-- Run ONCE after db/vyapar_seed_2026_08.sql if that seed was posted using
-- current_date. It restores the actual source report date from audit metadata.
-- ============================================================================

begin;

do $$
declare
  v_owner_id uuid;
  v_target_count integer;
  v_changed_count integer;
begin
  select id into v_owner_id
  from users
  where role = 'owner' and active = true
  order by created_at
  limit 1;

  if v_owner_id is null then
    raise exception 'Date restoration requires one active owner profile.';
  end if;

  if exists (
    select 1 from audit_log
    where action = 'migration' and entity_type = 'vyapar_seed_2026_08_restore_source_dates'
  ) then
    raise exception 'Vyapar source-date restoration has already been applied.';
  end if;

  select count(*) into v_target_count
  from audit_log a
  join transactions t on t.id = a.entity_id
  where a.action = 'migration_create'
    and a.entity_type = 'transaction'
    and a.after ? 'source_date'
    and (a.after ->> 'source') like 'Vyapar%'
    and t.description like 'Vyapar migration%';

  if v_target_count <> 137 then
    raise exception
      'Expected 137 seeded Vyapar transactions to restore, found %. Stop and review the database before continuing.',
      v_target_count;
  end if;

  insert into audit_log (user_id, action, entity_type, entity_id, before, after)
  select
    v_owner_id,
    'migration_restore_source_date',
    'transaction',
    t.id,
    jsonb_build_object('txn_date', t.txn_date),
    jsonb_build_object(
      'txn_date', to_date(a.after ->> 'source_date', 'DD/MM/YYYY'),
      'source_date', a.after ->> 'source_date',
      'reason', 'Restore original Vyapar report date for historical reporting'
    )
  from audit_log a
  join transactions t on t.id = a.entity_id
  where a.action = 'migration_create'
    and a.entity_type = 'transaction'
    and a.after ? 'source_date'
    and (a.after ->> 'source') like 'Vyapar%'
    and t.description like 'Vyapar migration%';

  update transactions t
  set txn_date = to_date(a.after ->> 'source_date', 'DD/MM/YYYY')
  from audit_log a
  where a.action = 'migration_create'
    and a.entity_type = 'transaction'
    and a.after ? 'source_date'
    and (a.after ->> 'source') like 'Vyapar%'
    and t.id = a.entity_id
    and t.description like 'Vyapar migration%';

  get diagnostics v_changed_count = row_count;

  if v_changed_count <> 137 then
    raise exception 'Expected to update 137 seed dates, but updated %.', v_changed_count;
  end if;

  insert into audit_log (user_id, action, entity_type, after)
  values (
    v_owner_id,
    'migration',
    'vyapar_seed_2026_08_restore_source_dates',
    jsonb_build_object(
      'restored_transactions', v_changed_count,
      'reason', 'Historical reports require original Vyapar transaction dates'
    )
  );
end $$;

commit;
