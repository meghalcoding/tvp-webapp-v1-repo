# Master Data Implementation

Implemented M1–M4 against the clean operational database.

## Implemented

- Canonical universal `items` master with no category routing column used by the application.
- Purchase category ↔ item many-to-many relationships.
- Expense category ↔ item many-to-many relationships.
- Supplier ↔ Purchase Category and Supplier ↔ Expense Category relationships.
- Fixed supplier support for Purchase categories.
- Organic Item creation/editing.
- Organic Category creation.
- Organic Supplier creation/editing.
- Search-first item selection in Expense.
- Expense supplier filtering by Expense Category.
- Purchase supplier/category-scoped item routing.
- Tasty Vadapav/franchise purchase workflow now derives its item list from the supplier's fixed Purchase Category rather than legacy supplier templates.
- Order image generation now reads the committed purchase items directly.
- Unified Categories master screen.
- Category editing and active/inactive status controls.
- Category-scoped supplier routing that preserves each supplier's other links.
- Universal relationship loading uses the master `items` table.
- Sales channel fundamental-item mapping is no longer used by the Item Master UI. Menu Items remain a future sales-specific model.

## Inline creation

From Item creation, `+ Add new Category` opens the category creation workflow, preserves the item draft, returns to the Item form, and selects the newly created category.

## Supabase migration

Run:

`db/master_data_foundation.sql`

This migration also restores the Supplier create/update RPCs required by the
Supplier master screen and creates the category-scoped supplier-link RPC.

Do not run the legacy Phase 6 relationship seed/migration files afterward.
