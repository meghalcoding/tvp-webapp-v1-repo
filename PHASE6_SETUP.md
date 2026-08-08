# Phase 6 — Automation

Run `db/phase6_automation.sql` in the Supabase SQL Editor after the Phase 2, 3, and 4 migrations.

This migration completes the two remaining Masters screens and adds the Phase 6 tables and atomic RPCs. Expense category and user-profile changes are owner-only; recurring expenses, salary payments, and monthly closing are available to Owners and Managers. A user must first exist in Supabase Auth before the Owner can create their app profile.

The Automation screen provides next-day purchase suggestions based on the previous 14 days of purchases, due recurring expenses and salaries, low-stock alerts, monthly-close snapshots, and the backup-reminder state. A backup reminder clears automatically whenever a backup is exported from the app.
