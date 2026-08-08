import { supabase } from "./supabase-client.js";

// All tables that make up a complete backup, in an order safe for restore
// (masters before transactions before ledger detail before stock/audit).
const BACKUP_TABLES = [
  "users",
  "accounts",
  "expense_categories",
  "suppliers",
  "items",
  "transactions",
  "ledger_entries",
  "sale_details",
  "purchase_details",
  "purchase_items",
  "expense_details",
  "expense_items",
  "transfer_details",
  "settlement_details",
  "stock_movements",
  "daily_closings",
  "recurring_expenses",
  "salary_profiles",
  "salary_payments",
  "monthly_closings",
  "audit_log",
];

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Export Full Backup -> Cravory_Backup_<date>.json (spec §13)
export async function exportFullBackup() {
  const backup = { schema_version: 1, exported_at: new Date().toISOString(), tables: {} };

  for (const table of BACKUP_TABLES) {
    const { data, error } = await supabase.from(table).select("*");
    if (error) throw new Error(`Backup failed reading "${table}": ${error.message}`);
    backup.tables[table] = data;
  }

  download(`Cravory_Backup_${todayStamp()}.json`, JSON.stringify(backup, null, 2), "application/json");
  localStorage.setItem("tvp-last-backup-at", new Date().toISOString());
  return backup;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))].join("\n");
}

// Export Module Backups -> Sales.xlsx / Purchases.xlsx / Expenses.xlsx /
// Stock.xlsx / Ledger.xlsx (spec §13). Shipped here as CSV for the
// foundation phase (zero-dependency, no xlsx library required yet); the
// Reporting phase (Phase 5) can upgrade these to true .xlsx via SheetJS
// without changing this module's public API.
export async function exportModuleBackups() {
  const queries = {
    Sales: supabase.from("transactions").select("*, sale_details(*)").eq("txn_type", "sale"),
    Purchases: supabase.from("transactions").select("*, purchase_details(*), purchase_items(*)").eq("txn_type", "purchase"),
    Expenses: supabase.from("transactions").select("*, expense_details(*), expense_items(*)").eq("txn_type", "expense"),
    Stock: supabase.from("current_stock").select("*"),
    Ledger: supabase.from("ledger_entries").select("*"),
  };

  for (const [name, query] of Object.entries(queries)) {
    const { data, error } = await query;
    if (error) throw new Error(`Backup failed reading "${name}": ${error.message}`);
    download(`${name}_${todayStamp()}.csv`, toCsv(data ?? []), "text/csv");
  }
  localStorage.setItem("tvp-last-backup-at", new Date().toISOString());
}

// Restore from Backup — Owner only (also gated by RLS). Wipes and reloads
// every table inside one flow. The caller (UI) is responsible for taking a
// fresh exportFullBackup() snapshot immediately before calling this, so a
// restore itself can be undone (spec §13).
export async function restoreFromBackup(backupJson) {
  const backup = typeof backupJson === "string" ? JSON.parse(backupJson) : backupJson;
  if (!backup?.tables) throw new Error("This file doesn't look like a Tasty Vadapav backup.");

  // Delete in reverse dependency order, then insert in forward order.
  for (const table of [...BACKUP_TABLES].reverse()) {
    const { error } = await supabase.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) throw new Error(`Restore failed clearing "${table}": ${error.message}`);
  }
  for (const table of BACKUP_TABLES) {
    const rows = backup.tables[table];
    if (!rows?.length) continue;
    const { error } = await supabase.from(table).insert(rows);
    if (error) throw new Error(`Restore failed writing "${table}": ${error.message}`);
  }
  return true;
}
