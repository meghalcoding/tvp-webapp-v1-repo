# Phase 4 setup — Procurement & Inventory

Run `db/phase4_procurement_inventory.sql` after the previous migrations.
It enables itemized purchases, supplier payments, movement-based stock,
wastage, stock adjustments, supplier balances, and Owner-only creation of
items and suppliers. Purchases and inventory changes are atomic and audited.
