-- ============================================================================
-- PHASE 3 — TASTY VADAPAV FRANCHISE PURCHASE WORKFLOW
-- Run AFTER the Phase 2 supplier/rate/GST correction migrations.
--
-- Purpose:
--   * Define the supplier-specific purchase template for the TASTY Vada Pav
--     Raw Material supplier.
--   * Keep the template separate from the general item master.
--   * Preserve display name/abbreviation/order from the franchise-owner list.
--   * Link template rows to the existing item master where the relationship is
--     known. Unmatched rows remain mappable rather than silently inventing a
--     rate or GST value.
--   * Allow only an Owner to change a template's item mapping.
-- ============================================================================

create table if not exists supplier_purchase_templates (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id) on delete cascade,
  item_id uuid references items(id) on delete restrict,
  display_name text not null,
  abbreviation text,
  display_order integer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (supplier_id, display_order)
);

create index if not exists idx_supplier_purchase_templates_supplier
  on supplier_purchase_templates(supplier_id, active, display_order);

create index if not exists idx_supplier_purchase_templates_item
  on supplier_purchase_templates(item_id);

alter table supplier_purchase_templates enable row level security;

drop policy if exists supplier_purchase_templates_select on supplier_purchase_templates;
create policy supplier_purchase_templates_select
  on supplier_purchase_templates for select
  using (auth.uid() is not null);

drop policy if exists supplier_purchase_templates_owner_insert on supplier_purchase_templates;
create policy supplier_purchase_templates_owner_insert
  on supplier_purchase_templates for insert
  with check (current_user_role() = 'owner');

drop policy if exists supplier_purchase_templates_owner_update on supplier_purchase_templates;
create policy supplier_purchase_templates_owner_update
  on supplier_purchase_templates for update
  using (current_user_role() = 'owner')
  with check (current_user_role() = 'owner');

drop policy if exists supplier_purchase_templates_owner_delete on supplier_purchase_templates;
create policy supplier_purchase_templates_owner_delete
  on supplier_purchase_templates for delete
  using (current_user_role() = 'owner');

-- Owner-only mapping helper. This does not create an item or change its rate/GST.
create or replace function update_supplier_purchase_template_item(
  p_template_id uuid,
  p_item_id uuid
) returns void as $$
declare
  v_user users%rowtype;
  v_template supplier_purchase_templates%rowtype;
  v_item items%rowtype;
begin
  select * into v_user from phase3_current_user();
  if not found or v_user.role <> 'owner' then
    raise exception 'Only the Owner can map franchise purchase template items';
  end if;

  select * into v_template
  from supplier_purchase_templates
  where id = p_template_id and active = true;
  if v_template.id is null then
    raise exception 'Purchase template row not found';
  end if;

  select * into v_item
  from items
  where id = p_item_id and active = true;
  if v_item.id is null then
    raise exception 'Choose an active item from the Item Master';
  end if;

  update supplier_purchase_templates
  set item_id = p_item_id
  where id = p_template_id;

  insert into audit_log(user_id, action, entity_type, entity_id, before, after)
  values (
    v_user.id,
    'map_supplier_purchase_template_item',
    'supplier_purchase_template',
    v_template.id,
    jsonb_build_object('item_id', v_template.item_id),
    jsonb_build_object('item_id', p_item_id, 'item_name', v_item.name)
  );
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function update_supplier_purchase_template_item(uuid,uuid) to authenticated;

-- --------------------------------------------------------------------------
-- TASTY VADAPAV TEMPLATE
-- Source: user-provided "To buy from Franchise Owner" list.
-- The quantities visible in the source image are example/order quantities;
-- they are NOT stored as defaults. The application starts every quantity blank.
--
-- Known item-master aliases are intentional:
--   Vada Pav Masala -> Vada Masalo Aalu
--   Butter           -> Vimal Butter Packet 500Gms
--   Cheese           -> Vimal Cheese
--   Mayo             -> Mayonnaise
--   Sing             -> Singh
--   Green Chutney    -> Green Chatni
--   Dabeli Masala    -> Dabeli Masalo
--   Tikki/Roti       -> Roti/Tikki
--   Shezwan          -> Schezwan
--
-- Meethi Chutney has no known matching item in the supplied current master
-- data, so it is intentionally left unmapped if no variant exists. The UI
-- will show "Item setup required" and the Owner can map it later.
-- --------------------------------------------------------------------------

do $$
declare
  v_supplier uuid;
begin
  select id into v_supplier
  from suppliers
  where lower(name) = lower('TASTY Vada Pav Raw Material')
  limit 1;

  if v_supplier is null then
    raise notice 'TASTY Vada Pav Raw Material supplier not found; template rows were not seeded.';
    return;
  end if;

  insert into supplier_purchase_templates
    (supplier_id,item_id,display_name,abbreviation,display_order,active)
  values
    (v_supplier,(select id from items where lower(name)=lower('Pav (18 pcs)') and active=true limit 1),'Pav (18 nos)','',1,true),
    (v_supplier,(select id from items where lower(name)=lower('Vada Masalo Aalu') and active=true limit 1),'Vadapav Masala','VM',2,true),
    (v_supplier,(select id from items where lower(name) in ('meethi chutney','meethi chatni') and active=true order by name limit 1),'Meethi Chutney','MC',3,true),
    (v_supplier,(select id from items where lower(name)=lower('Green Chatni') and active=true limit 1),'Green Chutney','GC',4,true),
    (v_supplier,(select id from items where lower(name)=lower('Dabeli Masalo') and active=true limit 1),'Dabeli Masala','',5,true),
    (v_supplier,(select id from items where lower(name)=lower('Red Kora Masala') and active=true limit 1),'Red Kora Masala','RKM',6,true),
    (v_supplier,(select id from items where lower(name)=lower('Roti/Tikki') and active=true limit 1),'Tikki/Roti','TR',7,true),
    (v_supplier,(select id from items where lower(name)=lower('Vimal Butter Packet 500Gms') and active=true limit 1),'Butter','',8,true),
    (v_supplier,(select id from items where lower(name)=lower('Vimal Cheese') and active=true limit 1),'Cheese','',9,true),
    (v_supplier,(select id from items where lower(name)=lower('Singh') and active=true limit 1),'Sing','',10,true),
    (v_supplier,(select id from items where lower(name)=lower('Sev') and active=true limit 1),'Sev','',11,true),
    (v_supplier,(select id from items where lower(name)=lower('Mayonnaise') and active=true limit 1),'Mayo','',12,true),
    (v_supplier,(select id from items where lower(name)=lower('White Cheese') and active=true limit 1),'White Cheese','',13,true),
    (v_supplier,(select id from items where lower(name)=lower('Ketchup') and active=true limit 1),'Ketchup','',14,true),
    (v_supplier,(select id from items where lower(name)=lower('Schezwan') and active=true limit 1),'Shezwan','',15,true),
    (v_supplier,(select id from items where lower(name)=lower('Chat Masala') and active=true limit 1),'Chat Masala','',16,true)
  on conflict (supplier_id, display_order) do update set
    item_id = excluded.item_id,
    display_name = excluded.display_name,
    abbreviation = excluded.abbreviation,
    active = true;
end $$;

-- No audit row is inserted by the migration itself because migrations do not
-- have a stable application user. Future mapping changes are audited by the RPC.
