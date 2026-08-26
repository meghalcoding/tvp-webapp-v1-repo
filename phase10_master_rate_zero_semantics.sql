-- PHASE 10 — Master Rate = 0 means "no master rate configured"
--
-- A zero master rate is intentionally different from a configured rate of
-- zero. The application treats items.master_rate = 0 as "no master rate".
-- Purchase line snapshots must follow the same rule so a first-time rate is
-- not marked as an override merely because the master rate is 0.

create or replace function public.fn_snapshot_purchase_master_rate() returns trigger as $$
declare
  v_master_rate numeric(10,2);
begin
  select master_rate into v_master_rate
  from public.items
  where id = new.item_id;

  new.master_rate_at_entry := case
    when round(coalesce(v_master_rate, 0), 2) > 0 then round(v_master_rate, 2)
    else 0
  end;
  new.rate_overridden := round(coalesce(v_master_rate, 0), 2) > 0
    and round(coalesce(new.rate, 0), 2) <> round(coalesce(v_master_rate, 0), 2);

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_snapshot_purchase_master_rate on public.purchase_items;
create trigger trg_snapshot_purchase_master_rate
before insert on public.purchase_items
for each row execute function public.fn_snapshot_purchase_master_rate();

-- Keep historical rows as they are. This update only normalizes the derived
-- flag for rows whose master rate was zero at entry.
update public.purchase_items
set rate_overridden = false
where coalesce(master_rate_at_entry, 0) = 0;
