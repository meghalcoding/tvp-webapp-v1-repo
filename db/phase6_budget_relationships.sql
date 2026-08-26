-- PHASE 6 — BUDGET CONTEXT RELATIONSHIPS
alter table public.budget_lines add column if not exists sales_channel_id uuid references public.sales_channels(id);
alter table public.budget_lines add column if not exists purchase_category_id uuid references public.purchase_categories(id);
alter table public.budget_lines add column if not exists expense_item_id uuid references public.expense_item_catalog(id);

-- Recreate the budget writers with context-aware fields while retaining old payload compatibility.
drop function if exists public.create_budget_version(date,text,text,jsonb);
create or replace function public.create_budget_version(p_month_start date,p_budget_type text,p_notes text,p_lines jsonb) returns uuid language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype; v_period_id uuid; v_version_id uuid; v_next int; v_line jsonb; v_item_id uuid; v_category_id uuid; v_sales_channel_id uuid; v_purchase_category_id uuid; v_expense_item_id uuid;
begin
 select * into v_user from phase3_current_user(); if not found or v_user.role not in ('owner','manager') then raise exception 'Only Owner or Manager can manage budgets'; end if;
 if p_budget_type not in ('sales','purchase','expense','wastage') then raise exception 'Invalid budget type'; end if;
 insert into budget_periods(month_start,created_by) values(date_trunc('month',p_month_start)::date,v_user.id) on conflict(month_start) do nothing;
 select id into v_period_id from budget_periods where month_start=date_trunc('month',p_month_start)::date;
 select coalesce(max(version_no),0)+1 into v_next from budget_versions where budget_period_id=v_period_id and budget_type=p_budget_type;
 insert into budget_versions(budget_period_id,budget_type,version_no,status,notes,created_by) values(v_period_id,p_budget_type,v_next,'draft',nullif(trim(p_notes),''),v_user.id) returning id into v_version_id;
 for v_line in select value from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) loop
  v_item_id:=nullif(v_line->>'item_id','')::uuid; v_category_id:=nullif(v_line->>'category_id','')::uuid; v_sales_channel_id:=nullif(v_line->>'sales_channel_id','')::uuid; v_purchase_category_id:=nullif(v_line->>'purchase_category_id','')::uuid; v_expense_item_id:=nullif(v_line->>'expense_item_id','')::uuid;
  if p_budget_type='sales' and v_sales_channel_id is null then raise exception 'Sales budget line needs a sales channel'; end if;
  if p_budget_type='purchase' and v_purchase_category_id is null then raise exception 'Purchase budget line needs a purchase category'; end if;
  if p_budget_type='purchase' and v_item_id is null then raise exception 'Purchase budget line needs an item'; end if;
  if p_budget_type='wastage' and v_item_id is null then raise exception 'Wastage budget line needs an item'; end if;
  if p_budget_type='expense' and v_category_id is null then raise exception 'Expense budget line needs an expense category'; end if;
  insert into budget_lines(budget_version_id,item_id,category_id,sales_channel_id,purchase_category_id,expense_item_id,description,quantity,rate,sort_order)
  values(v_version_id,v_item_id,v_category_id,v_sales_channel_id,v_purchase_category_id,v_expense_item_id,nullif(trim(v_line->>'description'),''),greatest(coalesce((v_line->>'quantity')::numeric,0),0),greatest(coalesce((v_line->>'rate')::numeric,0),0),coalesce((v_line->>'sort_order')::int,0));
 end loop; return v_version_id;
end; $$;

drop function if exists public.replace_budget_version_lines(uuid,jsonb,text);
create or replace function public.replace_budget_version_lines(p_version_id uuid,p_lines jsonb,p_notes text) returns void language plpgsql security definer set search_path=public as $$
declare v_user users%rowtype; v_version budget_versions%rowtype; v_line jsonb; v_item_id uuid; v_category_id uuid; v_sales_channel_id uuid; v_purchase_category_id uuid; v_expense_item_id uuid;
begin
 select * into v_user from phase3_current_user(); if not found or v_user.role not in ('owner','manager') then raise exception 'Only Owner or Manager can manage budgets'; end if;
 select * into v_version from budget_versions where id=p_version_id; if v_version.id is null then raise exception 'Budget version not found'; end if; if v_version.status<>'draft' then raise exception 'Only draft budget versions can be edited'; end if;
 delete from budget_lines where budget_version_id=p_version_id; update budget_versions set notes=nullif(trim(p_notes),'' ) where id=p_version_id;
 for v_line in select value from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) loop
  v_item_id:=nullif(v_line->>'item_id','')::uuid; v_category_id:=nullif(v_line->>'category_id','')::uuid; v_sales_channel_id:=nullif(v_line->>'sales_channel_id','')::uuid; v_purchase_category_id:=nullif(v_line->>'purchase_category_id','')::uuid; v_expense_item_id:=nullif(v_line->>'expense_item_id','')::uuid;
  if v_version.budget_type='sales' and v_sales_channel_id is null then raise exception 'Sales budget line needs a sales channel'; end if;
  if v_version.budget_type='purchase' and (v_purchase_category_id is null or v_item_id is null) then raise exception 'Purchase budget lines need category and item'; end if;
  if v_version.budget_type='wastage' and v_item_id is null then raise exception 'Wastage budget line needs an item'; end if;
  if v_version.budget_type='expense' and v_category_id is null then raise exception 'Expense budget line needs an expense category'; end if;
  insert into budget_lines(budget_version_id,item_id,category_id,sales_channel_id,purchase_category_id,expense_item_id,description,quantity,rate,sort_order)
  values(p_version_id,v_item_id,v_category_id,v_sales_channel_id,v_purchase_category_id,v_expense_item_id,nullif(trim(v_line->>'description'),''),greatest(coalesce((v_line->>'quantity')::numeric,0),0),greatest(coalesce((v_line->>'rate')::numeric,0),0),coalesce((v_line->>'sort_order')::int,0));
 end loop;
end; $$;
grant execute on function public.create_budget_version(date,text,text,jsonb) to authenticated;
grant execute on function public.replace_budget_version_lines(uuid,jsonb,text) to authenticated;
