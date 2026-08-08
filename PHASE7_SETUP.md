# Phase 7 — Financial Hardening and Responsive UI

Run `db/phase7_hardening.sql` in the Supabase SQL Editor after the Phase 6 migration.

It prevents negative inventory, mirrors stock movements during a financial reversal, blocks supplier overpayments, makes UPI and supplier balances reversal-aware, removes direct browser write policies that could bypass the audit trail, and activates idempotent offline sync for sales, quick expenses, and wastage. All browser financial writes continue through audited RPCs.
