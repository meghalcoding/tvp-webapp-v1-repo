# Phase 2 setup — Financial Engine

Run `db/phase2_financial_engine.sql` in the Supabase SQL Editor after the
Phase 1 scripts (`schema.sql`, `rls_policies.sql`, and `seed.sql`).

This migration installs the atomic database operations used by the Phase 2
screens:

- Owner-only account creation, with an audit entry.
- Owner/Manager account transfers, which create the transaction, both
  double-entry ledger legs, transfer detail, and audit record together.
- Append-only transaction reversals, subject to the role and same-day rules
  from the financial specification.

The Phase 2 web screens are Cash & Accounts, Transaction Ledger, Transfers,
and the Owner-only Audit Trail. Sales, expenses, UPI settlement, purchasing,
and inventory remain intentionally scheduled for Phases 3 and 4.
