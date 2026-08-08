import { supabase, IS_CONFIGURED } from "./supabase-client.js";
import { canDo } from "./auth.js";

const money = (value) => `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (value = "") => String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const configuredNotice = () => `<div class="placeholder-screen"><h2>Connect Supabase first</h2><p>Configure the project in <code>js/config.js</code>, then run <code>db/phase2_financial_engine.sql</code> in Supabase SQL Editor.</p></div>`;

async function accountsWithBalances() {
  const [{ data: accounts, error: accountsError }, { data: balances, error: balancesError }] = await Promise.all([
    supabase.from("accounts").select("id,name,type,holder_name,opening_balance,active").order("name"),
    supabase.from("account_balances").select("account_id,balance"),
  ]);
  if (accountsError || balancesError) throw accountsError || balancesError;
  const byId = new Map((balances || []).map((row) => [row.account_id, row.balance]));
  return (accounts || []).map((account) => ({ ...account, balance: byId.get(account.id) || 0 }));
}

function accountOptions(accounts, selected = "") {
  return accounts.filter((a) => a.active).map((a) => `<option value="${a.id}" ${a.id === selected ? "selected" : ""}>${esc(a.name)} — ${money(a.balance)}</option>`).join("");
}

function showStatus(el, message, bad = false) {
  el.textContent = message;
  el.className = bad ? "form-status error" : "form-status success";
}

export async function renderAccountsScreen(screen, user) {
  if (!IS_CONFIGURED) { screen.innerHTML = configuredNotice(); return; }
  const accounts = await accountsWithBalances();
  const visibleAccounts = user.role === "staff" ? accounts.filter((account) => account.name === "Cash Drawer") : accounts;
  const owner = canDo(user, "edit_masters");
  screen.innerHTML = `
    <div class="screen-head"><div><h1>Cash & Accounts</h1><p>Live balances are computed from the append-only ledger.</p></div>
      ${owner ? '<button class="btn btn-primary" id="new-account">+ New Account</button>' : ""}</div>
    <div class="card table-wrap"><table class="ledger"><thead><tr><th>Account</th><th>Type</th><th>Holder</th><th class="num">Opening</th><th class="num">Live balance</th><th>Status</th><th></th></tr></thead><tbody>
      ${visibleAccounts.map((a) => `<tr><td><strong>${esc(a.name)}</strong></td><td>${esc(a.type.replaceAll("_", " "))}</td><td>${esc(a.holder_name || "—")}</td><td class="num">${money(a.opening_balance)}</td><td class="num ${Number(a.balance) < 0 ? "negative" : ""}">${money(a.balance)}</td><td>${a.active ? '<span class="stamp settled">Active</span>' : '<span class="stamp pending">Inactive</span>'}</td><td><button class="btn btn-small account-ledger" data-id="${a.id}">Ledger</button>${owner ? ` <button class="btn btn-small edit-account" data-id="${a.id}">Edit</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="7">No permitted account balances.</td></tr>'}
    </tbody></table></div><div id="account-modal"></div>`;
  screen.querySelectorAll(".account-ledger").forEach((button) => button.addEventListener("click", () => showAccountLedger(screen, button.dataset.id, visibleAccounts)));
  screen.querySelectorAll(".edit-account").forEach((button) => button.addEventListener("click", () => accountForm(screen, visibleAccounts.find((account) => account.id === button.dataset.id))));
  screen.querySelector("#new-account")?.addEventListener("click", () => accountForm(screen, null));
}

async function showAccountLedger(screen, accountId, accounts) {
  const account = accounts.find((a) => a.id === accountId);
  const mount = screen.querySelector("#account-modal");
  mount.innerHTML = `<div class="modal-backdrop"><section class="modal-card"><button class="modal-close" aria-label="Close">×</button><h2>${esc(account.name)} ledger</h2><p class="muted">Current balance: <strong>${money(account.balance)}</strong></p><div class="loading">Loading movements…</div></section></div>`;
  mount.querySelector(".modal-close").addEventListener("click", () => { mount.innerHTML = ""; });
  const { data, error } = await supabase.from("ledger_entries").select("id,entry_side,amount,counterparty_type,transactions(id,txn_date,txn_type,description,reversal_of)").eq("account_id", accountId).order("id", { ascending: false });
  if (error) { mount.querySelector(".loading").textContent = error.message; return; }
  const rows = data || [];
  mount.querySelector(".modal-card").innerHTML = `<button class="modal-close" aria-label="Close">×</button><h2>${esc(account.name)} ledger</h2><p class="muted">Current balance: <strong>${money(account.balance)}</strong></p><div class="table-wrap"><table class="ledger"><thead><tr><th>Date</th><th>Type</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>${rows.map((e) => `<tr><td>${esc(e.transactions?.txn_date || "—")}</td><td>${esc(e.transactions?.txn_type || "—")}</td><td>${esc(e.transactions?.description || e.counterparty_type || "—")}</td><td class="num">${e.entry_side === "debit" ? money(e.amount) : "—"}</td><td class="num">${e.entry_side === "credit" ? money(e.amount) : "—"}</td></tr>`).join("") || '<tr><td colspan="5">No movements recorded.</td></tr>'}</tbody></table></div>`;
  mount.querySelector(".modal-close").addEventListener("click", () => { mount.innerHTML = ""; });
}

function accountForm(screen, account) {
  const mount = screen.querySelector("#account-modal");
  const selected = (type) => account?.type === type ? "selected" : "";
  mount.innerHTML = `<div class="modal-backdrop"><form class="modal-card" id="account-form"><button type="button" class="modal-close" aria-label="Close">×</button><h2>${account ? "Edit account" : "New account"}</h2>
    <div class="field"><label>Name</label><input name="name" required maxlength="80" placeholder="e.g. Outlet Cash Drawer" value="${esc(account?.name || "")}" /></div>
    <div class="field"><label>Account type</label><select name="type"><option value="cash" ${selected("cash")}>Cash</option><option value="bank" ${selected("bank")}>Bank</option><option value="collection_account" ${selected("collection_account")}>Collection account (UPI)</option></select></div>
    <div class="field"><label>Account holder (optional)</label><input name="holder_name" maxlength="80" value="${esc(account?.holder_name || "")}" /></div>
    ${account ? `<div class="field"><label>Status</label><select name="active"><option value="true" ${account.active ? "selected" : ""}>Active</option><option value="false" ${!account.active ? "selected" : ""}>Inactive</option></select></div><p class="muted">Opening balances cannot be altered here; use an auditable transfer instead.</p>` : '<div class="field"><label>Opening balance</label><input name="opening_balance" type="number" min="0" step="0.01" value="0" required /></div>'}<div class="form-status"></div><button class="btn btn-primary" type="submit">${account ? "Save changes" : "Create account"}</button></form></div>`;
  mount.querySelector(".modal-close").addEventListener("click", () => { mount.innerHTML = ""; });
  mount.querySelector("#account-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const status = mount.querySelector(".form-status");
    const row = { name: form.get("name").trim(), type: form.get("type"), holder_name: form.get("holder_name").trim() || null, opening_balance: Number(form.get("opening_balance")) };
    const args = account ? { p_account_id: account.id, p_name: row.name, p_type: row.type, p_holder_name: row.holder_name, p_active: form.get("active") === "true" } : { p_name: row.name, p_type: row.type, p_holder_name: row.holder_name, p_opening_balance: row.opening_balance };
    const { error } = await supabase.rpc(account ? "update_finance_account" : "create_finance_account", args);
    if (error) { showStatus(status, error.message, true); return; }
    await renderAccountsScreen(screen, window.__appUser);
  });
}

export async function renderTransfersScreen(screen, user) {
  if (!IS_CONFIGURED) { screen.innerHTML = configuredNotice(); return; }
  const accounts = await accountsWithBalances();
  const allowed = canDo(user, "money_transfer");
  const { data: transfers, error } = await supabase.from("transactions").select("id,txn_date,amount,description,reversal_of,created_by,transfer_details(from_account_id,to_account_id)").eq("txn_type", "transfer").order("created_at", { ascending: false }).limit(100);
  if (error) throw error;
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  screen.innerHTML = `<div class="screen-head"><div><h1>Money Transfers</h1><p>Move money between cash, bank, and collection accounts with balanced ledger entries.</p></div></div>
    ${allowed ? `<div class="card"><div class="card-title">New transfer</div><form id="transfer-form" class="form-grid"><div class="field"><label>From account</label><select name="from" required><option value="">Choose account</option>${accountOptions(accounts)}</select></div><div class="field"><label>To account</label><select name="to" required><option value="">Choose account</option>${accountOptions(accounts)}</select></div><div class="field"><label>Amount</label><input name="amount" type="number" min="0.01" step="0.01" required /></div><div class="field"><label>Date</label><input name="txn_date" type="date" value="${today()}" required /></div><div class="field field-wide"><label>Note (optional)</label><input name="description" maxlength="500" placeholder="e.g. Harsh transfer to Vansh Kotak" /></div><div class="field field-wide"><div class="form-status"></div><button class="btn btn-primary" type="submit">Record transfer</button></div></form></div>` : '<div class="card"><p class="muted">Only an Owner or Manager can record transfers.</p></div>'}
    <div class="card table-wrap"><div class="card-title">Transfer history</div><table class="ledger"><thead><tr><th>Date</th><th>From</th><th>To</th><th>Description</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody>
      ${(transfers || []).map((t) => { const d = Array.isArray(t.transfer_details) ? t.transfer_details[0] : t.transfer_details; return `<tr><td>${esc(t.txn_date)}</td><td>${esc(names.get(d?.from_account_id) || "—")}</td><td>${esc(names.get(d?.to_account_id) || "—")}</td><td>${esc(t.description || "—")}</td><td class="num">${money(t.amount)}</td><td>${t.reversal_of ? '<span class="stamp pending">Reversal</span>' : '<span class="stamp settled">Posted</span>'}</td><td>${allowed && !t.reversal_of ? `<button class="btn btn-small reverse-transaction" data-id="${t.id}">Reverse</button>` : ""}</td></tr>`; }).join("") || '<tr><td colspan="7">No transfers recorded.</td></tr>'}
    </tbody></table></div>`;
  screen.querySelector("#transfer-form")?.addEventListener("submit", (event) => saveTransfer(event, screen));
  screen.querySelectorAll(".reverse-transaction").forEach((button) => button.addEventListener("click", () => reverse(button.dataset.id, screen)));
}

async function saveTransfer(event, screen) {
  event.preventDefault(); const form = new FormData(event.currentTarget); const status = event.currentTarget.querySelector(".form-status");
  if (form.get("from") === form.get("to")) { showStatus(status, "Choose two different accounts.", true); return; }
  showStatus(status, "Posting balanced transfer…");
  const { error } = await supabase.rpc("create_account_transfer", { p_from_account_id: form.get("from"), p_to_account_id: form.get("to"), p_amount: Number(form.get("amount")), p_txn_date: form.get("txn_date"), p_description: form.get("description").trim() || null });
  if (error) { showStatus(status, error.message, true); return; }
  await renderTransfersScreen(screen, window.__appUser);
}

async function reverse(transactionId, screen) {
  const reason = window.prompt("Reason for this reversal (optional):");
  if (reason === null) return;
  const { error } = await supabase.rpc("reverse_financial_transaction", { p_transaction_id: transactionId, p_reason: reason || null });
  if (error) { window.alert(`Reversal failed: ${error.message}`); return; }
  await renderTransfersScreen(screen, window.__appUser);
}

export async function renderLedgerScreen(screen, user) {
  if (!IS_CONFIGURED) { screen.innerHTML = configuredNotice(); return; }
  const { data, error } = await supabase.from("transactions").select("id,txn_type,txn_date,amount,description,reversal_of,created_at,users(name)").order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  const allowed = canDo(user, "money_transfer");
  screen.innerHTML = `<div class="screen-head"><div><h1>Transaction Ledger</h1><p>Financial events are append-only. Corrections are recorded as reversals.</p></div></div><div class="card table-wrap"><table class="ledger"><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Recorded by</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody>${(data || []).map((t) => `<tr><td>${esc(t.txn_date)}</td><td>${esc(t.txn_type.replaceAll("_", " "))}</td><td>${esc(t.description || "—")}</td><td>${esc(t.users?.name || "—")}</td><td class="num">${money(t.amount)}</td><td>${t.reversal_of ? '<span class="stamp pending">Reversal</span>' : '<span class="stamp settled">Posted</span>'}</td><td>${allowed && !t.reversal_of ? `<button class="btn btn-small reverse-transaction" data-id="${t.id}">Reverse</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="7">No transactions recorded.</td></tr>'}</tbody></table></div>`;
  screen.querySelectorAll(".reverse-transaction").forEach((button) => button.addEventListener("click", () => reverse(button.dataset.id, screen)));
}

export async function renderAuditLogScreen(screen, user) {
  if (!canDo(user, "view_audit_log")) { screen.innerHTML = '<div class="placeholder-screen"><h2>Owner access required</h2><p>The audit trail is visible only to the Owner.</p></div>'; return; }
  const { data, error } = await supabase.from("audit_log").select("id,action,entity_type,entity_id,before,after,created_at,users(name)").order("created_at", { ascending: false }).limit(250);
  if (error) throw error;
  screen.innerHTML = `<div class="screen-head"><div><h1>Audit Trail</h1><p>A permanent record of financial and master-data changes.</p></div></div><div class="card table-wrap"><table class="ledger"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>${(data || []).map((r) => `<tr><td>${new Date(r.created_at).toLocaleString("en-IN")}</td><td>${esc(r.users?.name || "—")}</td><td><span class="stamp ${r.action === "reverse" ? "pending" : "settled"}">${esc(r.action)}</span></td><td>${esc(r.entity_type)}<br><small>${esc(r.entity_id || "—")}</small></td><td><details><summary>View</summary><pre>${esc(JSON.stringify({ before: r.before, after: r.after }, null, 2))}</pre></details></td></tr>`).join("") || '<tr><td colspan="5">No audit records yet.</td></tr>'}</tbody></table></div>`;
}
