# Clean master-data build

This checkpoint intentionally removes the dummy operating data and retires the legacy separate expense-item catalog.

## What remains

- Supabase Authentication / `auth.users`
- `public.users`
- `public.accounts`
- financial/accounting tables and functions
- audit-log structure
- document tables / storage bucket configuration
- daily-closing structure
- budget structure
- RLS/security policies
- Sales Channel master records

## What is reset

All dummy transactions, ledger history, purchases, expenses, sales, settlements, transfers, stock movements, documents, budgets, automation profiles, item histories, suppliers, items, purchase categories and expense categories.

Storage files inside `financial-documents` are also deleted, while the bucket itself remains.

## Canonical master model

`items` is the one universal master-item table.

An item may be linked to multiple Purchase Categories and Expense Categories.

Sales Channels will have their own future Menu Item master. Do not link these
fundamental operational items to Sales Channels.

Suppliers may be linked to multiple Purchase Categories and Expense Categories. A supplier can be marked fixed for a Purchase Category.

There is no separate Expense Item Catalog.

## Organic creation UX

When a user creates an item and cannot find the required Purchase/Expense Category:

1. Select `+ Add new Category`.
2. The current item form is saved in session state.
3. The relevant category screen opens.
4. Create the category.
5. The application returns to the item form.
6. The new category is already selected.
7. Previously entered item information is restored.

The same pattern should be reused for Supplier and Item creation from operational screens.

## Supabase deployment

Run `db/CLEAN_RESET_AND_CANONICAL.sql` once against the current development Supabase database.

Do not run the archived dummy seed scripts afterward.
