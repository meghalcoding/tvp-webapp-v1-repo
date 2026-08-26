# Phase 6 — Universal Master Item Relationships

## Objective
Create one canonical many-to-many relationship layer connecting Master Items to Sales Channels, Purchase Categories, and Expense Categories. All downstream selectors and workflows should use these relationships instead of unrelated hard-coded item lists.

## UX rule
When no category/channel is selected, item search starts from the full relevant item universe. The user can type an item name, select it, and the system resolves the related context. If an item has multiple relationships, the user chooses the intended context. Once a context is selected, item choices are filtered to that context.

## Implemented
- Sales Channels: Cash, UPI, Zomato, Swiggy.
- Purchase Categories: TASTY Vada Pav Raw Material, Beverage Vendor, Amul Items, Packaging.
- Expense category → expense item catalog relationships.
- Many-to-many item relationships.
- Item Master relationship editor.
- Searchable Item Relationships master screen.
- Budget context-aware builders.
- Expense detailed item selector filtered by selected expense category.
- Searchable purchase item selector.
- Searchable wastage item selector.
- Purchase and expense category/item routing can be reused by future imports, settlements, and Vyapar integrations.

## Seed changes
- Singh renamed to Sing.
- Water Bottle Vendor retired from future use; Beverage Vendor introduced.
- Extra Bun Packet retired from future use.
- Requested Amul and Packaging purchase items added.
- Expense categories consolidated as requested.
- Requested expense items added.

## Database
Run, in order after the existing Phase 5/6 migrations:
1. `db/phase6_master_relationships.sql`
2. `db/phase6_budget_relationships.sql`

Historical transaction rows are preserved. Removed/renamed operational categories are deactivated or renamed rather than deleting records that historical transactions may reference.

## Next
Phase 6C — Budget vs Actual and Forecast Dashboard.
