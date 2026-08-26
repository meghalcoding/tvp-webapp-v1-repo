# Master Data Foundation — M1/M2/M3/M4

This is the canonical master-data layer after the clean reset.

## Core model

- `items` = fundamental operational items only.
- Purchase categories ↔ items = `purchase_category_items`.
- Expense categories ↔ items = `expense_category_items`.
- Suppliers ↔ purchase categories = `supplier_purchase_categories`.
- Suppliers ↔ expense categories = `supplier_expense_categories`.
- Sales channels are retained as infrastructure. Fundamental items are **not** assigned to sales channels; customer-facing menu items will be a separate future model.

## UX rules

1. Item search is search-first and category-independent.
2. Selecting an item can infer a unique category and route the rest of the form accordingly.
3. Category pickers support `+ Add new Category`.
4. Creating a category from an unfinished Item form returns to the item form with the new category selected and the draft restored.
5. Supplier creation supports the same return-to-workflow pattern in later master screens.
6. No legacy `expense_item_catalog` routing is used.

## Deployment

Run `db/master_data_foundation.sql` once after the clean reset. Do not run the old Phase 6 relationship seed files afterward.
