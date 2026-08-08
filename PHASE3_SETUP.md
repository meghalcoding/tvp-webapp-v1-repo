# Phase 3 setup — Daily Operations

Run `db/phase3_daily_operations.sql` in the Supabase SQL Editor after the
Phase 1 and Phase 2 SQL scripts.

This enables the live Phase 3 screens: Cash and UPI sales, quick/detailed
expenses, UPI collection-account settlement and reconciliation, and Daily
Closing. Each operation writes the transaction, balanced ledger entries,
its detail record, and audit row as one atomic database action. Daily Closing
locks that date against new operations until the Owner reopens it.
