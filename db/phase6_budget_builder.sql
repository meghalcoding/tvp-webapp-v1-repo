-- ============================================================================
-- PHASE 6A + 6B — BUDGET & FORECASTING FOUNDATION + BUDGET BUILDER
-- Run after the current Phase 5B database migrations.
-- Budget is forecast data only; actuals continue to come from transactions.
-- ============================================================================

create table if not exists budget_periods (
  id uuid primary key default gen_random_uuid(),
  month_start date not null unique,
  created_by uuid references users(id) not null,
  created_at timestamptz not null default now()
);

create table if not exists budget_versions (
  id uuid primary key default gen_random_uuid(),
  budget_period_id uuid references budget_periods(id) on delete cascade not null,
  budget_type text not null check (budget_type in ('sales','purchase','expense','wastage')),
  version_no integer not null check (version_no > 0),
  status text not null default 'draft' check (status in ('draft','active','archived')),
  notes text,
  created_by uuid references users(id) not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (budget_period_id, budget_type, version_no)
);

create unique index if not exists ux_budget_active_version
  on budget_versions(budget_period_id, budget_type)
  where status = 'active';

create table if not exists budget_lines (
  id uuid primary key default gen_random_uuid(),
  budget_version_id uuid references budget_versions(id) on delete cascade not null,
  item_id uuid references items(id),
  category_id uuid references expense_categories(id),
  description text,
  quantity numeric(12,3) not null default 0 check (quantity >= 0),
  rate numeric(12,2) not null default 0 check (rate >= 0),
  amount numeric(14,2) generated always as (round(quantity * rate, 2)) stored,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint budget_line_target_check check (
    (item_id is not null)
    or (category_id is not null and budget_version_id is not null)
  )
);

create index if not exists idx_budget_versions_period_type
  on budget_versions(budget_period_id, budget_type, status);
create index if not exists idx_budget_lines_version
  on budget_lines(budget_version_id, sort_order);
create index if not exists idx_budget_lines_item
  on budget_lines(item_id);
create index if not exists idx_budget_lines_category
  on budget_lines(category_id);

alter table budget_periods enable row level security;
alter table budget_versions enable row level security;
alter table budget_lines enable row level security;

drop policy if exists budget_periods_select on budget_periods;
create policy budget_periods_select on budget_periods for select
  using (auth.uid() is not null);

drop policy if exists budget_versions_select on budget_versions;
create policy budget_versions_select on budget_versions for select
  using (auth.uid() is not null);

drop policy if exists budget_lines_select on budget_lines;
create policy budget_lines_select on budget_lines for select
  using (auth.uid() is not null);

-- Writes are restricted to owner/manager. Financial transactions remain
-- unchanged and actuals are never written into these tables.
drop policy if exists budget_periods_write on budget_periods;
create policy budget_periods_write on budget_periods for all
  using (current_user_role() in ('owner','manager'))
  with check (current_user_role() in ('owner','manager'));

drop policy if exists budget_versions_write on budget_versions;
create policy budget_versions_write on budget_versions for all
  using (current_user_role() in ('owner','manager'))
  with check (current_user_role() in ('owner','manager'));

drop policy if exists budget_lines_write on budget_lines;
create policy budget_lines_write on budget_lines for all
  using (current_user_role() in ('owner','manager'))
  with check (current_user_role() in ('owner','manager'));

-- Create a new version and optionally seed it with lines. The caller supplies
-- month_start as any date in the target month; it is normalized to month start.
drop function if exists create_budget_version(date,text,text,jsonb);
create or replace function create_budget_version(
  p_month_start date,
  p_budget_type text,
  p_notes text default null,
  p_lines jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_user users%rowtype;
  v_period_id uuid;
  v_version_id uuid;
  v_next integer;
  v_line jsonb;
  v_item_id uuid;
  v_category_id uuid;
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists for this signed-in user'; end if;
  if v_user.role not in ('owner','manager') then raise exception 'Only Owner or Manager can manage budgets'; end if;
  if p_budget_type not in ('sales','purchase','expense','wastage') then raise exception 'Invalid budget type'; end if;
  if p_month_start is null then raise exception 'Budget month is required'; end if;
  if jsonb_typeof(coalesce(p_lines,'[]'::jsonb)) <> 'array' then raise exception 'Budget lines must be a list'; end if;

  insert into budget_periods(month_start,created_by)
  values(date_trunc('month',p_month_start)::date,v_user.id)
  on conflict(month_start) do nothing;
  select id into v_period_id from budget_periods where month_start=date_trunc('month',p_month_start)::date;

  select coalesce(max(version_no),0)+1 into v_next
  from budget_versions where budget_period_id=v_period_id and budget_type=p_budget_type;

  insert into budget_versions(budget_period_id,budget_type,version_no,status,notes,created_by)
  values(v_period_id,p_budget_type,v_next,'draft',nullif(trim(p_notes),''),v_user.id)
  returning id into v_version_id;

  for v_line in select value from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) loop
    v_item_id := nullif(v_line->>'item_id','')::uuid;
    v_category_id := nullif(v_line->>'category_id','')::uuid;
    if p_budget_type in ('sales','purchase','wastage') and v_item_id is null then
      raise exception 'Item is required for % budget lines', p_budget_type;
    end if;
    if p_budget_type='expense' and v_item_id is null and v_category_id is null then
      raise exception 'Expense budget line needs a category or item';
    end if;
    insert into budget_lines(budget_version_id,item_id,category_id,description,quantity,rate,sort_order)
    values(
      v_version_id,
      v_item_id,
      v_category_id,
      nullif(trim(v_line->>'description'),''),
      greatest(coalesce((v_line->>'quantity')::numeric,0),0),
      greatest(coalesce((v_line->>'rate')::numeric,0),0),
      coalesce((v_line->>'sort_order')::integer,0)
    );
  end loop;
  return v_version_id;
end;
$$;

drop function if exists replace_budget_version_lines(uuid,jsonb,text);
create or replace function replace_budget_version_lines(
  p_version_id uuid,
  p_lines jsonb,
  p_notes text default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_user users%rowtype;
  v_version budget_versions%rowtype;
  v_line jsonb;
  v_item_id uuid;
  v_category_id uuid;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role not in ('owner','manager') then raise exception 'Only Owner or Manager can manage budgets'; end if;
  select * into v_version from budget_versions where id=p_version_id;
  if v_version.id is null then raise exception 'Budget version not found'; end if;
  if v_version.status <> 'draft' then raise exception 'Only draft budget versions can be edited'; end if;
  if jsonb_typeof(coalesce(p_lines,'[]'::jsonb)) <> 'array' then raise exception 'Budget lines must be a list'; end if;

  delete from budget_lines where budget_version_id=p_version_id;
  update budget_versions set notes=nullif(trim(p_notes),'' ) where id=p_version_id;

  for v_line in select value from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) loop
    v_item_id := nullif(v_line->>'item_id','')::uuid;
    v_category_id := nullif(v_line->>'category_id','')::uuid;
    if v_version.budget_type in ('sales','purchase','wastage') and v_item_id is null then
      raise exception 'Item is required for % budget lines', v_version.budget_type;
    end if;
    if v_version.budget_type='expense' and v_item_id is null and v_category_id is null then
      raise exception 'Expense budget line needs a category or item';
    end if;
    insert into budget_lines(budget_version_id,item_id,category_id,description,quantity,rate,sort_order)
    values(p_version_id,v_item_id,v_category_id,nullif(trim(v_line->>'description'),''),
      greatest(coalesce((v_line->>'quantity')::numeric,0),0),
      greatest(coalesce((v_line->>'rate')::numeric,0),0),
      coalesce((v_line->>'sort_order')::integer,0));
  end loop;
end;
$$;

drop function if exists activate_budget_version(uuid);
create or replace function activate_budget_version(p_version_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_user users%rowtype;
  v_version budget_versions%rowtype;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role not in ('owner','manager') then raise exception 'Only Owner or Manager can activate budgets'; end if;
  select * into v_version from budget_versions where id=p_version_id;
  if v_version.id is null then raise exception 'Budget version not found'; end if;
  if v_version.status <> 'draft' then raise exception 'Only draft versions can be activated'; end if;
  update budget_versions
  set status='archived'
  where budget_period_id=v_version.budget_period_id
    and budget_type=v_version.budget_type
    and status='active';
  update budget_versions
  set status='active', activated_at=now()
  where id=p_version_id;
end;
$$;

grant execute on function create_budget_version(date,text,text,jsonb) to authenticated;
grant execute on function replace_budget_version_lines(uuid,jsonb,text) to authenticated;
grant execute on function activate_budget_version(uuid) to authenticated;

notify pgrst, 'reload schema';
