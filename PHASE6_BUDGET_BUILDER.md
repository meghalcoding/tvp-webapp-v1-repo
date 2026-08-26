# Phase 6A + 6B — Budget & Forecasting Foundation + Budget Builder

## Scope

This phase establishes monthly, versioned forecast data for Tasty Vadapav. It does **not** write or replace actual financial transactions.

### Business rules locked for this phase

- Sales budgets are item-level.
- Purchase forecast rates are prefilled from the current Item Master `last_purchase_rate` and can be modified for the forecast only.
- Expense budgets support category-only and category + item lines.
- Wastage budgets are item-level.
- Sales budgets are not split by sales channel initially; actuals can still be analysed by channel later.
- Actual values will be calculated from the existing transaction system in the next budget phase.
- Budget versions are month-specific and versioned. Active versions are protected from editing; create a new draft to revise a budget.

## Database

`db/phase6_budget_builder.sql`

Tables:

- `budget_periods`
- `budget_versions`
- `budget_lines`

RPCs:

- `create_budget_version`
- `replace_budget_version_lines`
- `activate_budget_version`

## Builder workflow

1. Open **Budget & Forecasting**.
2. Select month and budget type.
3. Click **New Draft**.
4. Add budget lines.
5. For purchases, the current master purchase rate is prefilled when an item is selected; the value is editable and remains forecast-only.
6. Save draft.
7. Activate the version when the forecast is ready.
8. Active versions are read-only. Create another draft to revise them.

## Budget types

### Sales
Item + forecast quantity + forecast selling rate.

### Purchases
Item + forecast quantity + forecast purchase rate.

### Expenses
Category-only or category + item.

### Wastage
Item + forecast quantity + forecast rate.

## Deliberate non-scope

- Budget vs Actual calculations are not part of 6A/6B yet.
- Copy previous month is a later sub-phase.
- AI/LLM functionality is unrelated and remains deferred.

## Validation

Run:

```powershell
npm run check
npm run dev
```

Manual acceptance:

- Create a Sales draft and add several items.
- Create a Purchase draft and verify the master purchase rate is prefilled and editable.
- Create an Expense draft using a category-only line.
- Create an Expense draft using category + item lines.
- Create a Wastage draft with item quantities.
- Save each draft.
- Activate one version.
- Verify the active version is read-only and remains in the database.
