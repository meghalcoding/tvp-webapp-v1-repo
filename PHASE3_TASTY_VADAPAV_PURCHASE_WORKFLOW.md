# Phase 3 — Tasty Vadapav Purchase Workflow

Status: **Implemented — requires database migration before functional testing**

## Objective

Create a supplier-specific purchase workflow for **TASTY Vada Pav Raw Material** based on the user-provided franchise-owner order list.

The general purchase workflow remains available for all other suppliers.

## Source order list

The supplied source image contains these template rows:

| Display item | Abbreviation |
|---|---|
| Pav (18 nos) | — |
| Vadapav Masala | VM |
| Meethi Chutney | MC |
| Green Chutney | GC |
| Dabeli Masala | — |
| Red Kora Masala | RKM |
| Tikki/Roti | TR |
| Butter | — |
| Cheese | — |
| Sing | — |
| Sev | — |
| Mayo | — |
| White Cheese | — |
| Ketchup | — |
| Shezwan | — |
| Chat Masala | — |

The quantities visible in the supplied image are treated as example/order quantities only. They are **not** saved as default quantities in the application.

## Supplier-specific behavior

When the supplier is `TASTY Vada Pav Raw Material` and the Phase 3 template exists:

- The normal add-item purchase list is replaced by the predefined franchise order list.
- Every template row starts with a blank quantity.
- Blank quantity means the item is not included in today's purchase.
- Entered quantities are the only template rows submitted as purchase lines.
- Master rate and master GST are populated from the linked Item Master.
- Rate and GST remain locked by default and use the Phase 2 Modify/Lock workflow.
- Existing Phase 2 override and master-update protections remain active.
- A live order overview displays only items with a quantity entered.

## Item mapping

The template stores its display name/abbreviation separately from the Item Master so the vendor-facing order can use the franchise terminology.

Known mappings in the migration include:

- `Vadapav Masala` → `Vada Masalo Aalu`
- `Butter` → `Vimal Butter Packet 500Gms`
- `Cheese` → `Vimal Cheese`
- `Mayo` → `Mayonnaise`
- `Sing` → `Singh`
- `Green Chutney` → `Green Chatni`
- `Dabeli Masala` → `Dabeli Masalo`
- `Tikki/Roti` → `Roti/Tikki`
- `Shezwan` → `Schezwan`

If a template row cannot be matched to an active Item Master record, it is shown as **Item setup required** rather than silently creating a zero-rate item. An Owner can map the row to an active item from the Item Master.

## Purchase recording

The same canonical Phase 2 purchase RPC is used:

`create_purchase_with_master_rate_updates`

Only rows with a positive quantity are submitted.

The existing financial behavior remains unchanged:

- GST is calculated from percentage.
- Purchase total includes GST.
- Supplier outstanding/paid amount uses the calculated purchase total.
- Stock is updated through the existing purchase writer.
- Rate/GST master updates remain Owner-only.

## Vendor order image

Every purchase recorded against the Tasty Vadapav supplier receives an **Order image** action in Recent Purchases.

The image is generated client-side as PNG and includes:

- `To buy from Franchise Owner`
- Supplier
- Transaction date
- Item
- Abbreviation
- Quantity
- Unit where available

The image does not include purchase rates or GST because it is a vendor-facing order slip.

No image storage service is required for this feature.

## Database

Migration:

`db/phase3_tasty_vadapav_purchase_workflow.sql`

It creates:

`supplier_purchase_templates`

with:

- supplier
- item mapping
- franchise display name
- abbreviation
- display order
- active status

It also creates the Owner-only mapping RPC:

`update_supplier_purchase_template_item`

## Security

- Template rows are readable by authenticated users.
- Template maintenance is Owner-only.
- Item mappings are changed through an audited Owner-only RPC.
- Existing purchase permissions and Phase 2 financial controls remain unchanged.

## Acceptance criteria

### Supplier selection

- Selecting `TASTY Vada Pav Raw Material` loads the predefined list immediately.
- Selecting another supplier restores the normal purchase-entry workflow.

### Quantities

- All template quantities start blank.
- User can enter decimal quantities where the Item Master unit requires it.
- Blank rows are excluded from the transaction.
- At least one positive quantity is required to record the Tasty purchase.

### Rate/GST

- Linked items show master rate and GST automatically.
- Rate/GST are locked initially.
- Modify/Lock behavior from Phase 2 remains functional.
- Override warnings only appear after an actual change.
- Purchase-only vs master-update behavior remains intact.

### Order overview

- Only selected items appear.
- Quantities are visible before recording.
- Purchase total updates live.

### Order image

- New Tasty purchase automatically produces the vendor order image.
- Historical Tasty purchases have an `Order image` button.
- Generated image uses the transaction's date and actual recorded quantities.
- Image does not require Supabase Storage.

### Mapping

- Missing item mapping is explicit.
- Owner can map an unmatched template row.
- Mapping immediately causes the Item Master rate/GST to populate.

## Local validation

Run:

```powershell
npm run check
npm run dev
```

Before browser testing, run the Phase 3 SQL migration in Supabase.


## Post-implementation auth hotfix

Phase 3 does not modify Supabase Auth or the existing `users` policies. A follow-up hardening change adds explicit bootstrap/auth-state error handling and bumps the service-worker shell cache to v14 so authentication/profile-loading failures are surfaced instead of appearing as an unexplained sign-in failure.
