# Phase 10 — Master Rate Zero Semantics

Run `db/phase10_master_rate_zero_semantics.sql` in Supabase after the existing Phase 9 migration.

Behavior:
- `items.master_rate > 0`: master rate exists; transaction rate starts locked and Modify Rate is shown.
- `items.master_rate = 0`: no master rate is configured; transaction Rate is immediately editable and no Rate differs from master warning/override prompt is generated.
- GST behavior is unchanged: `0%` remains a valid configured GST value.
