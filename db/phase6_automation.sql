-- ============================================================================
-- PHASE 6 — AUTOMATION AND MASTER COMPLETION
-- Run after phase2_financial_engine.sql, phase3_daily_operations.sql and
-- phase4_procurement_inventory.sql.
-- ============================================================================

create table if not exists recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category_id uuid not null references expense_categories(id),
  paid_from_account_id uuid not null references accounts(id),
  amount numeric(12,2) not null check (amount > 0),
  cadence text not null check (cadence in ('weekly','monthly')),
  due_day integer not null check (due_day between 0 and 31),
  last_run_date date,
  active boolean not null default true,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table if not exists salary_profiles (
  id uuid primary key default gen_random_uuid(),
  employee_name text not null,
  category_id uuid not null references expense_categories(id),
  paid_from_account_id uuid not null references accounts(id),
  monthly_amount numeric(12,2) not null check (monthly_amount > 0),
  payday integer not null default 1 check (payday between 1 and 31),
  last_paid_date date,
  active boolean not null default true,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table if not exists salary_payments (
  id uuid primary key default gen_random_uuid(),
  salary_profile_id uuid not null references salary_profiles(id),
  transaction_id uuid not null unique references transactions(id),
  payment_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists monthly_closings (
  id uuid primary key default gen_random_uuid(),
  period_start date not null unique,
  period_end date not null,
  sales_total numeric(12,2) not null default 0,
  purchase_total numeric(12,2) not null default 0,
  expense_total numeric(12,2) not null default 0,
  wastage_total numeric(12,2) not null default 0,
  notes text,
  closed_by uuid not null references users(id),
  closed_at timestamptz not null default now(),
  check (period_end >= period_start)
);

alter table recurring_expenses enable row level security;
alter table salary_profiles enable row level security;
alter table salary_payments enable row level security;
alter table monthly_closings enable row level security;

drop policy if exists "automation data visible to managers" on recurring_expenses;
create policy "automation data visible to managers" on recurring_expenses for select
  using (current_user_role() in ('owner','manager'));
drop policy if exists "salary data visible to managers" on salary_profiles;
create policy "salary data visible to managers" on salary_profiles for select
  using (current_user_role() in ('owner','manager'));
drop policy if exists "salary payment data visible to managers" on salary_payments;
create policy "salary payment data visible to managers" on salary_payments for select
  using (current_user_role() in ('owner','manager'));
drop policy if exists "monthly closings visible to managers" on monthly_closings;
create policy "monthly closings visible to managers" on monthly_closings for select
  using (current_user_role() in ('owner','manager'));

create or replace function phase6_manager_user() returns users as $$
  select u from users u where u.auth_id = auth.uid() and u.active = true and u.role in ('owner','manager');
$$ language sql stable security definer set search_path = public;

create or replace function phase6_owner_user() returns users as $$
  select u from users u where u.auth_id = auth.uid() and u.active = true and u.role = 'owner';
$$ language sql stable security definer set search_path = public;

create or replace function create_expense_category_master(p_name text, p_pl_bucket text default 'operating') returns uuid as $$
declare v_user users%rowtype; v_id uuid;
begin
  select * into v_user from phase6_owner_user(); if not found then raise exception 'Only the Owner can manage expense categories'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Category name is required'; end if;
  if p_pl_bucket not in ('direct','operating','other') then raise exception 'Choose a valid P&L bucket'; end if;
  insert into expense_categories(name,pl_bucket) values(trim(p_name),p_pl_bucket) returning id into v_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','expense_category',v_id,jsonb_build_object('name',trim(p_name),'pl_bucket',p_pl_bucket));
  return v_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function update_expense_category_master(p_category_id uuid, p_name text, p_pl_bucket text, p_active boolean default true) returns void as $$
declare v_user users%rowtype; v_before jsonb;
begin
  select * into v_user from phase6_owner_user(); if not found then raise exception 'Only the Owner can manage expense categories'; end if;
  if nullif(trim(p_name),'') is null or p_pl_bucket not in ('direct','operating','other') then raise exception 'Enter a category name and valid P&L bucket'; end if;
  select jsonb_build_object('name',name,'pl_bucket',pl_bucket,'active',active) into v_before from expense_categories where id=p_category_id;
  if v_before is null then raise exception 'Expense category not found'; end if;
  update expense_categories set name=trim(p_name),pl_bucket=p_pl_bucket,active=coalesce(p_active,true) where id=p_category_id;
  insert into audit_log(user_id,action,entity_type,entity_id,before,after) values(v_user.id,'edit_master','expense_category',p_category_id,v_before,jsonb_build_object('name',trim(p_name),'pl_bucket',p_pl_bucket,'active',coalesce(p_active,true)));
end;
$$ language plpgsql security definer set search_path = public;

create or replace function create_app_user_profile(p_auth_id uuid, p_name text, p_role text) returns uuid as $$
declare v_user users%rowtype; v_id uuid;
begin
  select * into v_user from phase6_owner_user(); if not found then raise exception 'Only the Owner can manage users'; end if;
  if nullif(trim(p_name),'') is null or p_role not in ('owner','manager','staff') then raise exception 'Enter a name and valid role'; end if;
  if not exists(select 1 from auth.users where id=p_auth_id) then raise exception 'No Supabase Auth user exists with that ID. Create or invite the user first.'; end if;
  insert into users(auth_id,name,role) values(p_auth_id,trim(p_name),p_role) returning id into v_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','user',v_id,jsonb_build_object('name',trim(p_name),'role',p_role,'auth_id',p_auth_id));
  return v_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function update_app_user_profile(p_user_id uuid, p_name text, p_role text, p_active boolean) returns void as $$
declare v_user users%rowtype; v_before jsonb; v_auth_id uuid;
begin
  select * into v_user from phase6_owner_user(); if not found then raise exception 'Only the Owner can manage users'; end if;
  if nullif(trim(p_name),'') is null or p_role not in ('owner','manager','staff') then raise exception 'Enter a name and valid role'; end if;
  select auth_id,jsonb_build_object('name',name,'role',role,'active',active) into v_auth_id,v_before from users where id=p_user_id;
  if v_before is null then raise exception 'User profile not found'; end if;
  if v_auth_id=auth.uid() and (not p_active or p_role <> 'owner') then raise exception 'You cannot deactivate yourself or remove your own Owner role'; end if;
  update users set name=trim(p_name),role=p_role,active=p_active where id=p_user_id;
  insert into audit_log(user_id,action,entity_type,entity_id,before,after) values(v_user.id,'edit_master','user',p_user_id,v_before,jsonb_build_object('name',trim(p_name),'role',p_role,'active',p_active));
end;
$$ language plpgsql security definer set search_path = public;

create or replace function create_recurring_expense(p_name text,p_category_id uuid,p_paid_from_account_id uuid,p_amount numeric,p_cadence text,p_due_day integer) returns uuid as $$
declare v_user users%rowtype; v_id uuid;
begin
  select * into v_user from phase6_manager_user(); if not found then raise exception 'Only an Owner or Manager can manage recurring expenses'; end if;
  if nullif(trim(p_name),'') is null or p_amount is null or p_amount<=0 or p_cadence not in ('weekly','monthly') then raise exception 'Enter a name, positive amount, and cadence'; end if;
  if (p_cadence='weekly' and p_due_day not between 0 and 6) or (p_cadence='monthly' and p_due_day not between 1 and 31) then raise exception 'Choose a valid due day'; end if;
  if not exists(select 1 from expense_categories where id=p_category_id and active) or not exists(select 1 from accounts where id=p_paid_from_account_id and active) then raise exception 'Choose active category and payment account'; end if;
  insert into recurring_expenses(name,category_id,paid_from_account_id,amount,cadence,due_day,created_by) values(trim(p_name),p_category_id,p_paid_from_account_id,round(p_amount,2),p_cadence,p_due_day,v_user.id) returning id into v_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','recurring_expense',v_id,jsonb_build_object('name',trim(p_name),'amount',round(p_amount,2),'cadence',p_cadence,'due_day',p_due_day));
  return v_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function record_recurring_expense(p_recurring_id uuid,p_txn_date date default current_date) returns uuid as $$
declare v_user users%rowtype; v_row recurring_expenses%rowtype; v_txn_id uuid;
begin
  select * into v_user from phase6_manager_user(); if not found then raise exception 'Only an Owner or Manager can run recurring expenses'; end if;
  select * into v_row from recurring_expenses where id=p_recurring_id and active; if not found then raise exception 'Recurring expense not found or inactive'; end if;
  if v_row.last_run_date=p_txn_date then raise exception 'This recurring expense was already recorded today'; end if;
  select create_expense(v_row.category_id,v_row.paid_from_account_id,v_row.amount,p_txn_date,'Recurring: ' || v_row.name,'[]'::jsonb) into v_txn_id;
  update recurring_expenses set last_run_date=p_txn_date where id=p_recurring_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'run','recurring_expense',p_recurring_id,jsonb_build_object('transaction_id',v_txn_id,'txn_date',p_txn_date));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function create_salary_profile(p_employee_name text,p_category_id uuid,p_paid_from_account_id uuid,p_monthly_amount numeric,p_payday integer default 1) returns uuid as $$
declare v_user users%rowtype; v_id uuid;
begin
  select * into v_user from phase6_manager_user(); if not found then raise exception 'Only an Owner or Manager can manage salary profiles'; end if;
  if nullif(trim(p_employee_name),'') is null or p_monthly_amount is null or p_monthly_amount<=0 or p_payday not between 1 and 31 then raise exception 'Enter employee, positive monthly amount, and a valid payday'; end if;
  if not exists(select 1 from expense_categories where id=p_category_id and active) or not exists(select 1 from accounts where id=p_paid_from_account_id and active) then raise exception 'Choose active category and payment account'; end if;
  insert into salary_profiles(employee_name,category_id,paid_from_account_id,monthly_amount,payday,created_by) values(trim(p_employee_name),p_category_id,p_paid_from_account_id,round(p_monthly_amount,2),p_payday,v_user.id) returning id into v_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'create','salary_profile',v_id,jsonb_build_object('employee_name',trim(p_employee_name),'monthly_amount',round(p_monthly_amount,2),'payday',p_payday));
  return v_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function record_salary_payment(p_salary_profile_id uuid,p_txn_date date default current_date) returns uuid as $$
declare v_user users%rowtype; v_row salary_profiles%rowtype; v_txn_id uuid;
begin
  select * into v_user from phase6_manager_user(); if not found then raise exception 'Only an Owner or Manager can record salary'; end if;
  select * into v_row from salary_profiles where id=p_salary_profile_id and active; if not found then raise exception 'Salary profile not found or inactive'; end if;
  if date_trunc('month',v_row.last_paid_date)=date_trunc('month',p_txn_date) then raise exception 'Salary is already recorded for this month'; end if;
  select create_expense(v_row.category_id,v_row.paid_from_account_id,v_row.monthly_amount,p_txn_date,'Salary: ' || v_row.employee_name,'[]'::jsonb) into v_txn_id;
  insert into salary_payments(salary_profile_id,transaction_id,payment_date) values(p_salary_profile_id,v_txn_id,p_txn_date);
  update salary_profiles set last_paid_date=p_txn_date where id=p_salary_profile_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'pay','salary_profile',p_salary_profile_id,jsonb_build_object('transaction_id',v_txn_id,'payment_date',p_txn_date));
  return v_txn_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function close_monthly_period(p_period_start date,p_notes text default null) returns uuid as $$
declare v_user users%rowtype; v_start date; v_end date; v_id uuid; v_sales numeric; v_purchases numeric; v_expenses numeric; v_wastage numeric;
begin
  select * into v_user from phase6_manager_user(); if not found then raise exception 'Only an Owner or Manager can close a month'; end if;
  v_start:=date_trunc('month',p_period_start)::date; v_end:=(v_start + interval '1 month - 1 day')::date;
  if exists(select 1 from monthly_closings where period_start=v_start) then raise exception 'This month is already closed'; end if;
  select coalesce(sum(amount),0) into v_sales from transactions where txn_type='sale' and txn_date between v_start and v_end;
  select coalesce(sum(amount),0) into v_purchases from transactions where txn_type='purchase' and txn_date between v_start and v_end;
  select coalesce(sum(amount),0) into v_expenses from transactions where txn_type='expense' and txn_date between v_start and v_end;
  select coalesce(sum(amount),0) into v_wastage from transactions where txn_type='wastage' and txn_date between v_start and v_end;
  insert into monthly_closings(period_start,period_end,sales_total,purchase_total,expense_total,wastage_total,notes,closed_by) values(v_start,v_end,v_sales,v_purchases,v_expenses,v_wastage,nullif(trim(p_notes),''),v_user.id) returning id into v_id;
  insert into audit_log(user_id,action,entity_type,entity_id,after) values(v_user.id,'close_month','monthly_closing',v_id,jsonb_build_object('period_start',v_start,'period_end',v_end,'sales_total',v_sales,'purchase_total',v_purchases,'expense_total',v_expenses,'wastage_total',v_wastage));
  return v_id;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function create_expense_category_master(text,text) to authenticated;
grant execute on function update_expense_category_master(uuid,text,text,boolean) to authenticated;
grant execute on function create_app_user_profile(uuid,text,text) to authenticated;
grant execute on function update_app_user_profile(uuid,text,text,boolean) to authenticated;
grant execute on function create_recurring_expense(text,uuid,uuid,numeric,text,integer) to authenticated;
grant execute on function record_recurring_expense(uuid,date) to authenticated;
grant execute on function create_salary_profile(text,uuid,uuid,numeric,integer) to authenticated;
grant execute on function record_salary_payment(uuid,date) to authenticated;
grant execute on function close_monthly_period(date,text) to authenticated;
