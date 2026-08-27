-- ============================================================================
-- PHASE 4A — DOCUMENT MANAGEMENT
-- Run AFTER the Phase 2/3 migrations.
--
-- Purpose:
--   * Store invoice/receipt metadata separately from financial transactions.
--   * Support one document linked to many Purchase/Expense transactions.
--   * Support one transaction linked to many documents.
--   * Keep files in a private Supabase Storage bucket, not PostgreSQL.
--   * Preserve auditability without modifying historical transactions.
--   * Prepare the schema for Phase 4B OCR/extraction.
-- ============================================================================

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  document_type text not null default 'other'
    check (document_type in ('invoice','receipt','bill','other')),
  uploaded_by uuid not null references users(id),
  supplier_id uuid references suppliers(id),
  invoice_number text,
  document_date date,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists transaction_documents (
  document_id uuid not null references documents(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  linked_by uuid not null references users(id),
  linked_at timestamptz not null default now(),
  primary key (document_id, transaction_id)
);

create index if not exists idx_documents_supplier on documents(supplier_id, created_at desc);
create index if not exists idx_documents_created on documents(created_at desc);
create index if not exists idx_transaction_documents_transaction on transaction_documents(transaction_id);
create index if not exists idx_transaction_documents_document on transaction_documents(document_id);

-- --------------------------------------------------------------------------
-- Private Storage bucket. Files are never public.
-- 10 MB/file keeps the feature lightweight and protects the free tier.
-- --------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'financial-documents',
  'financial-documents',
  false,
  10485760,
  array['application/pdf','image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = excluded.allowed_mime_types;

-- --------------------------------------------------------------------------
-- RLS helpers
-- --------------------------------------------------------------------------
create or replace function can_access_transaction(p_transaction_id uuid)
returns boolean as $$
  select exists (
    select 1 from transactions t
    where t.id = p_transaction_id
      and (
        current_user_role() in ('owner','manager')
        or t.created_by = current_app_user_id()
      )
  );
$$ language sql stable security definer set search_path = public;

create or replace function can_access_document(p_document_id uuid)
returns boolean as $$
  select exists (
    select 1 from documents d
    where d.id = p_document_id
      and (
        current_user_role() in ('owner','manager')
        or d.uploaded_by = current_app_user_id()
        or exists (
          select 1 from transaction_documents td
          where td.document_id = d.id
            and can_access_transaction(td.transaction_id)
        )
      )
  );
$$ language sql stable security definer set search_path = public;

create or replace function can_access_document_path(p_storage_path text)
returns boolean as $$
  select exists (
    select 1 from documents d
    where d.storage_path = p_storage_path
      and can_access_document(d.id)
  )
  or split_part(p_storage_path, '/', 1) = auth.uid()::text;
$$ language sql stable security definer set search_path = public;

-- --------------------------------------------------------------------------
-- Documents RLS
-- --------------------------------------------------------------------------
alter table documents enable row level security;
alter table transaction_documents enable row level security;

drop policy if exists documents_select on documents;
create policy documents_select on documents for select
  using (can_access_document(id));

drop policy if exists documents_insert on documents;
create policy documents_insert on documents for insert
  with check (uploaded_by = current_app_user_id());

drop policy if exists documents_update on documents;
create policy documents_update on documents for update
  using (current_user_role() in ('owner','manager') or uploaded_by = current_app_user_id())
  with check (current_user_role() in ('owner','manager') or uploaded_by = current_app_user_id());

drop policy if exists documents_delete on documents;
create policy documents_delete on documents for delete
  using (current_user_role() in ('owner','manager') or uploaded_by = current_app_user_id());

drop policy if exists transaction_documents_select on transaction_documents;
create policy transaction_documents_select on transaction_documents for select
  using (can_access_transaction(transaction_id));

drop policy if exists transaction_documents_insert on transaction_documents;
create policy transaction_documents_insert on transaction_documents for insert
  with check (
    can_access_transaction(transaction_id)
    and exists (select 1 from documents d where d.id = document_id and can_access_document(d.id))
    and linked_by = current_app_user_id()
  );

drop policy if exists transaction_documents_delete on transaction_documents;
create policy transaction_documents_delete on transaction_documents for delete
  using (
    current_user_role() in ('owner','manager')
    or linked_by = current_app_user_id()
  );

-- --------------------------------------------------------------------------
-- Storage RLS
-- --------------------------------------------------------------------------
drop policy if exists financial_documents_select on storage.objects;
create policy financial_documents_select
  on storage.objects for select
  using (
    bucket_id = 'financial-documents'
    and can_access_document_path(name)
  );

drop policy if exists financial_documents_insert on storage.objects;
create policy financial_documents_insert
  on storage.objects for insert
  with check (
    bucket_id = 'financial-documents'
    and auth.uid() is not null
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists financial_documents_update on storage.objects;
create policy financial_documents_update
  on storage.objects for update
  using (
    bucket_id = 'financial-documents'
    and can_access_document_path(name)
  )
  with check (
    bucket_id = 'financial-documents'
    and can_access_document_path(name)
  );

drop policy if exists financial_documents_delete on storage.objects;
create policy financial_documents_delete
  on storage.objects for delete
  using (
    bucket_id = 'financial-documents'
    and can_access_document_path(name)
  );

grant execute on function can_access_transaction(uuid) to authenticated;
grant execute on function can_access_document(uuid) to authenticated;
grant execute on function can_access_document_path(text) to authenticated;

-- --------------------------------------------------------------------------
-- Audit helpers
-- --------------------------------------------------------------------------
create or replace function link_document_to_transaction(
  p_document_id uuid,
  p_transaction_id uuid
) returns void as $$
declare
  v_user users%rowtype;
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists'; end if;
  if not can_access_document(p_document_id) then raise exception 'You cannot access this document'; end if;
  if not can_access_transaction(p_transaction_id) then raise exception 'You cannot access this transaction'; end if;

  insert into transaction_documents(document_id, transaction_id, linked_by)
  values (p_document_id, p_transaction_id, v_user.id)
  on conflict (document_id, transaction_id) do nothing;

  insert into audit_log(user_id, action, entity_type, entity_id, after)
  values (v_user.id, 'link_financial_document', 'transaction', p_transaction_id,
          jsonb_build_object('document_id', p_document_id));
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function link_document_to_transaction(uuid,uuid) to authenticated;

create or replace function unlink_document_from_transaction(
  p_document_id uuid,
  p_transaction_id uuid
) returns void as $$
declare
  v_user users%rowtype;
begin
  select * into v_user from phase3_current_user();
  if not found then raise exception 'No active application profile exists'; end if;
  if not can_access_transaction(p_transaction_id) then raise exception 'You cannot access this transaction'; end if;

  delete from transaction_documents
  where document_id = p_document_id and transaction_id = p_transaction_id;

  insert into audit_log(user_id, action, entity_type, entity_id, after)
  values (v_user.id, 'unlink_financial_document', 'transaction', p_transaction_id,
          jsonb_build_object('document_id', p_document_id));
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function unlink_document_from_transaction(uuid,uuid) to authenticated;
