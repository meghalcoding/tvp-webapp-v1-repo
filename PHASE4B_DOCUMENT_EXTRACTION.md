# Phase 4B — Invoice / Receipt Extraction & Review

## Scope

Phase 4B adds a zero-API-cost, browser-side document extraction workflow on top of Phase 4A document management.

### Purchase extraction
- Reads uploaded PDF/image documents using PDF.js and Tesseract.js.
- Detects document date, invoice number, supplier where confidently matched, and purchase-item candidates.
- Matches common invoice names against the existing Item Master, including known Tasty Vadapav aliases.
- Shows a review screen before changing the purchase form.
- Quantity is proposed automatically.
- Invoice rate and GST can be explicitly accepted per line; otherwise the existing master rate/GST remains the value used by the purchase form.
- A master-rate mismatch remains visible through the existing Modify Rate workflow.

### Expense extraction
- Detects document date, invoice number, and total amount.
- Applies only after user review.
- It does not guess an expense category from OCR.

## Important limitation

OCR is assistive. Printed invoices are expected to be much more reliable than handwritten or photographed documents. Gujarati extraction is available, but handwritten Gujarati should always be manually verified.

No OCR text is stored automatically. The extracted values exist in the browser until the user applies them and records the transaction.

## Phase 4A correction included

The expense entry now converts an empty Paid-from selection into SQL `NULL` before calling `create_expense_idempotent`. This prevents PostgreSQL from attempting to cast `""` to UUID and allows `Unpaid — add to expense dues` to be recorded correctly.

## Testing

1. Select an invoice/receipt in Purchases and click **Extract from document**.
2. Review the detected supplier/date/items/rates/GST.
3. Apply the values.
4. Confirm master rates/GST remain locked unless the review explicitly selects the invoice value.
5. Record the purchase.
6. Repeat in Expenses and verify an unpaid expense can now be recorded.
