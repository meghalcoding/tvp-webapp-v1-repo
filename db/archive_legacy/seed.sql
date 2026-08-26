-- ============================================================================
-- SEED DATA — masters derived from the actual Vyapar exports (spec §18 Step 1)
-- Run after schema.sql + rls_policies.sql, using the Supabase service role
-- (RLS restricts these inserts to 'owner' — run this once as an admin, or
-- temporarily via the SQL editor which bypasses RLS).
-- Opening balances are left at 0 — set them to real figures on cutover day.
-- ============================================================================

-- ===== ACCOUNTS =====
insert into accounts (name, type, holder_name) values
  ('Cash Drawer',   'cash',               null),
  ('Vansh HDFC',    'collection_account', 'Vansh'),
  ('Vansh Kotak',   'collection_account', 'Vansh'),
  ('Meghal IDFC',   'collection_account', 'Meghal'),
  ('Harsh SBI',     'collection_account', 'Harsh'),
  ('Kinchit HSBC',  'collection_account', 'Kinchit'),
  ('Cravory Bank',  'bank',               null),
  ('Petty Cash',    'cash',               null);

-- ===== EXPENSE CATEGORIES ===== (from Expense Category Report; pl_bucket per spec §11.1)
insert into expense_categories (name, pl_bucket) values
  ('Salary',                        'operating'),
  ('Kitchen Operations',            'direct'),
  ('Staff Tiffin / Food Allowance', 'direct'),
  ('Staff Transport',               'direct'),
  ('Amul Items',                    'direct'),
  ('Vegetables',                    'direct'),
  ('Satguru Water Supply',          'operating'),
  ('Chass Masala',                  'direct'),
  ('Electrician',                   'operating'),
  ('Staff Padiki',                  'direct'),
  ('Porter',                        'operating'),
  ('Packaging',                     'direct'),
  ('Printing & Stationery',         'operating'),
  ('Tea',                           'direct');

-- ===== SUPPLIERS =====
insert into suppliers (name, phone) values
  ('TASTY Vada Pav Raw Material', '9327276042'),
  ('Water Bottle Vendor', null);

-- ===== ITEMS ===== (from Purchase Report / Item Report By Party; gst_rate as observed)
insert into items (name, category, unit, gst_rate, reorder_level) values
  ('Vada Masalo Aalu',           'Raw Material', 'kg',   5.00, 5),
  ('Lal Chatni',                 'Raw Material', 'kg',   5.00, 5),
  ('Green Chatni',               'Raw Material', 'kg',   5.00, 1),
  ('Dabeli Masalo',              'Raw Material', 'kg',   5.00, 1),
  ('Roti/Tikki',                 'Raw Material', 'nos',  5.00, 20),
  ('Pav (18 pcs)',               'Grocery',      'pack', 0.00, 8),
  ('Sev',                        'Grocery',      'pack', 0.00, 1),
  ('Singh',                      'Grocery',      'pack', 0.00, 1),
  ('Mayonnaise',                 'Grocery',      'pack', 0.00, 1),
  ('White Cheese',               'Grocery',      'pack', 0.00, 1),
  ('Vimal Cheese',               'Grocery',      'pack', 0.00, 2),
  ('Vimal Butter Packet 500Gms', 'Grocery',      'pack', 0.00, 2),
  ('Schezwan',                   'Grocery',      'pack', 0.00, 1),
  ('Ketchup',                    'Grocery',      'pack', 0.00, 1),
  ('Chat Masala',                'Raw Material', 'kg',   0.00, 0.5),
  ('Red Kora Masala',            'Raw Material', 'kg',   5.00, 2),
  ('Swaminarayan Vada Masalo',   'Raw Material', 'kg',   5.00, 1),
  ('Tikki Only',                 'Grocery',      'nos',  0.00, 10),
  ('Bottle',                     'Grocery',      'nos',  0.00, 5),
  ('Coca-Cola',                  'Grocery',      'nos',  0.00, 5),
  ('Extra Bun Packet',           'Grocery',      'pack', 0.00, 2);
