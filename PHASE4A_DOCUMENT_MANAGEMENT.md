# Phase 4A — Document Management & Invoice/Receipt Attachments

## Status
Implemented.

Phase 4A establishes the document layer for Cravory/Tasty Vadapav. It intentionally does **not** perform OCR or automatic invoice extraction; that belongs to Phase 4B.

## Goals

- Attach invoices, receipts, bills, and supporting documents to Purchase and Expense transactions.
- Show a clear `No Invoice/Receipt` status when a Purchase/Expense has no linked document.
- Allow documents to be uploaded during transaction entry.
- Allow documents to be attached later from transaction history.
- Support one document linked to multiple Purchase/Expense transactions.
- Support one transaction linked to multiple documents.
- Keep financial documents in private Supabase Storage rather than PostgreSQL.
- Preserve existing financial transaction records; document operations never rewrite transaction amounts.
- Keep the design ready for Phase 4B extraction/OCR.

## Supported files

- PDF
- JPG/JPEG
- PNG
- WEBP
- Maximum 10 MB per file

## Document lifecycle

```text
Upload
  ↓
Private Storage object
  ↓
Document metadata row
  ↓
Link to zero, one, or many transactions
```

A document can remain unlinked and be linked later from the Documents screen.

## Transaction entry workflow

Purchase and Expense forms now contain:

- Document type
- Optional file upload

The transaction is committed first. The uploaded document is then stored and linked to the returned transaction ID. If document upload fails, the financial transaction remains recorded and the UI reports the document failure explicitly.

Document uploads require an active internet connection. Existing offline Sales/Expense/Wastage behavior is otherwise unchanged.

## Later attachment workflow

Recent Purchase/Expense history shows:

- Green document count when documents are attached.
- Red `No Invoice/Receipt` tag when none are attached.
- `Attach` / `Manage` action.

The document modal supports:

- Viewing existing linked documents.
- Opening a document through a short-lived signed URL.
- Unlinking a document from the current transaction.
- Uploading a new document.
- Linking the new document to multiple Purchase/Expense transactions.

## Documents screen

A new `Documents` screen provides:

- Document library
- Upload & link workflow
- Open document
- Link an existing document to additional transactions
- Document type, invoice number, date, supplier metadata, and notes
- Number of linked financial entries

## Database model

### `documents`

Stores metadata only:

- file name
- private Storage path
- MIME type
- size
- document type
- uploader
- supplier (optional)
- invoice/receipt number (optional)
- document date (optional)
- notes
- created timestamp

### `transaction_documents`

Many-to-many junction:

```text
Document ←→ Purchase/Expense transaction
```

This is intentionally not a single `invoice_id` column on a transaction.

## Security

- Storage bucket: `financial-documents`
- Bucket is private.
- Files are accessed through signed URLs.
- Uploads are limited to authenticated users and 10 MB.
- Transaction visibility follows existing Owner/Manager/Staff transaction visibility rules.
- Document linking is performed through audited database functions.
- No public document URLs are generated.

## Audit

Link and unlink actions are recorded in `audit_log`.

Uploading a document does not alter the financial transaction itself.

## Phase 4B boundary

Phase 4A does **not**:

- OCR invoices
- Parse invoice line items
- Match invoice text to Item Master
- Compare invoice rates with master rates
- Automatically create purchase/expense drafts

Those capabilities are reserved for Phase 4B, which will use this document layer as its source.

## Acceptance criteria

- [x] Purchase supports optional document upload during entry.
- [x] Expense supports optional document upload during entry.
- [x] Purchase/Expense history shows missing-document status.
- [x] Existing transaction can receive a document later.
- [x] One document can link to multiple transactions.
- [x] One transaction can link to multiple documents.
- [x] Documents screen exists.
- [x] Private Supabase Storage is used.
- [x] Signed URLs are used for opening documents.
- [x] No financial transaction is changed by attachment operations.
- [x] OCR is deferred to Phase 4B.


## Phase 4A Corrections

`db/phase4a_corrections.sql` is required after the original Phase 4A migration. It corrects the initial implementation in four areas:

1. Grants the authenticated API role the required privileges on `documents` and `transaction_documents`.
2. Adds `create_financial_document(...)`, a security-definer transaction that creates document metadata and all requested transaction links atomically after the private Storage upload.
3. Reloads the PostgREST schema cache so the new relationship is visible to the REST API.
4. Adds true unpaid-expense accounting through an `Expense Payables` liability account and a controlled `record_expense_payment(...)` workflow.

### Session/form preservation

Supabase `TOKEN_REFRESHED` events are deliberately ignored by the application router. Returning to an existing browser tab must not re-render the current route because that would destroy in-progress form values, dynamic purchase/expense rows, and selected file objects.

### Acceptance tests

- Upload an invoice while creating an expense and confirm the transaction and document are both present.
- Upload a document from Recent Expenses/Purchases and confirm it links successfully.
- Open the same document from the Documents library and from its transaction.
- Link one document to multiple transactions.
- Verify an entry without a document shows `No Invoice/Receipt`.
- Record an unpaid expense and verify `Unpaid — add to expense dues` plus an outstanding balance.
- Pay the expense due from Cash/Bank/UPI collection account and verify the outstanding amount decreases to zero.
- Switch to another browser tab and return while filling a purchase/expense; the form must remain intact.
- Trigger a normal auth token refresh and verify the current screen is not rebuilt.
