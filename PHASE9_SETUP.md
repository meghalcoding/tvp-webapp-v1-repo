# Phase 9 — Master relationship fixes + Expense rate/GST parity

Run:

```sql
db/phase9_master_relationship_and_expense_rate_gst.sql
```

This migration:

- makes Edit Item category assignments true replacements: removed Purchase/Expense categories are removed from the bridge and newly selected categories become the complete assignment;
- ensures the frontend only loads active category-item relationships;
- adds atomic Expense wrappers for the same Modify Rate / Modify GST master-update workflow used by Purchase;
- records item rate/GST history and audit entries when an Owner elects to update master values from an Expense.

No transaction history is deleted by the item relationship change. Only the current master relationship rows are replaced.
