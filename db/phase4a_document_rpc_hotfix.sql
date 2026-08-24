-- PHASE 4A DOCUMENT RPC HOTFIX
-- Run AFTER phase4a_documents.sql and phase4a_corrections.sql.
-- Purpose: remove any stale/older create_financial_document overload with the
-- same argument types but different parameter names, then recreate the exact
-- RPC contract used by the browser and force PostgREST to reload its schema.

DROP FUNCTION IF EXISTS public.create_financial_document(text,text,text,bigint,text,uuid,text,date,text,uuid[]);

CREATE OR REPLACE FUNCTION public.create_financial_document(
  p_file_name text,
  p_storage_path text,
  p_mime_type text,
  p_size_bytes bigint,
  p_document_type text DEFAULT 'other',
  p_supplier_id uuid DEFAULT NULL,
  p_invoice_number text DEFAULT NULL,
  p_document_date date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_transaction_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS public.documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_document public.documents%ROWTYPE;
  v_txn_id uuid;
BEGIN
  SELECT * INTO v_user FROM public.phase3_current_user();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active application profile exists for this account.';
  END IF;

  IF NULLIF(TRIM(p_file_name), '') IS NULL THEN
    RAISE EXCEPTION 'Document file name is required.';
  END IF;
  IF NULLIF(TRIM(p_storage_path), '') IS NULL THEN
    RAISE EXCEPTION 'Document storage path is required.';
  END IF;
  IF p_mime_type NOT IN ('application/pdf','image/jpeg','image/png','image/webp') THEN
    RAISE EXCEPTION 'Unsupported document type.';
  END IF;
  IF p_size_bytes IS NULL OR p_size_bytes <= 0 OR p_size_bytes > 10485760 THEN
    RAISE EXCEPTION 'Document must be between 1 byte and 10 MB.';
  END IF;
  IF p_document_type NOT IN ('invoice','receipt','bill','other') THEN
    RAISE EXCEPTION 'Invalid document type.';
  END IF;

  INSERT INTO public.documents(
    file_name, storage_path, mime_type, size_bytes, document_type,
    uploaded_by, supplier_id, invoice_number, document_date, notes
  )
  VALUES (
    TRIM(p_file_name), p_storage_path, p_mime_type, p_size_bytes,
    p_document_type, v_user.id, p_supplier_id,
    NULLIF(TRIM(p_invoice_number), ''), p_document_date,
    NULLIF(TRIM(p_notes), '')
  )
  RETURNING * INTO v_document;

  FOREACH v_txn_id IN ARRAY COALESCE(p_transaction_ids, '{}'::uuid[]) LOOP
    IF NOT public.can_access_transaction(v_txn_id) THEN
      RAISE EXCEPTION 'You cannot link this document to transaction %.', v_txn_id;
    END IF;

    INSERT INTO public.transaction_documents(document_id, transaction_id, linked_by)
    VALUES (v_document.id, v_txn_id, v_user.id)
    ON CONFLICT (document_id, transaction_id) DO NOTHING;

    INSERT INTO public.audit_log(user_id, action, entity_type, entity_id, after)
    VALUES (
      v_user.id,
      'link_financial_document',
      'transaction',
      v_txn_id,
      jsonb_build_object('document_id', v_document.id)
    );
  END LOOP;

  INSERT INTO public.audit_log(user_id, action, entity_type, entity_id, after)
  VALUES (
    v_user.id,
    'create',
    'document',
    v_document.id,
    jsonb_build_object(
      'file_name', v_document.file_name,
      'document_type', v_document.document_type,
      'supplier_id', v_document.supplier_id,
      'invoice_number', v_document.invoice_number,
      'transaction_count', COALESCE(array_length(p_transaction_ids, 1), 0)
    )
  );

  RETURN v_document;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_financial_document(
  text,text,text,bigint,text,uuid,text,date,text,uuid[]
) TO authenticated;

NOTIFY pgrst, 'reload schema';
