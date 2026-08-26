import { supabase, IS_CONFIGURED } from "./supabase-client.js";
import { canDo } from "./auth.js";
import { openDocumentOcrReview } from "./document-ocr.js";
import { withOfflineFallback } from "./offline-queue.js";
import { createHistoryController, fetchTransactionPage, HISTORY_INITIAL_LIMIT } from "./paginated-history.js";
import { decorateDocumentCells, openDocumentModal, uploadDocument } from "./documents.js";
import { loadMasterRelations, expenseItemIdsForCategory, expenseCategoriesForItem } from "./master-relations.js";

const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (v = "") => String(v).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const noConfig = () => `<div class="placeholder-screen"><h2>Connect Supabase first</h2><p>Configure <code>js/config.js</code>, then run <code>db/phase3_daily_operations.sql</code> in Supabase SQL Editor.</p></div>`;
const status = (el, text, bad = false) => { el.textContent = text; el.className = `form-status ${bad ? "error" : "success"}`; };
const postOutboxSafe = async (kind, payload, rpcName) => withOfflineFallback(kind, payload, async (entry) => { const { error } = await supabase.rpc(rpcName, entry); if (error) throw error; });

async function masters() {
  const [{ data: accounts, error: accountError }, { data: categories, error: categoryError }] = await Promise.all([
    supabase.from("accounts").select("id,name,type,active").eq("active", true).order("name"),
    supabase.from("expense_categories").select("id,name").eq("active", true).order("name"),
  ]);
  if (accountError || categoryError) throw accountError || categoryError;
  return { accounts: accounts || [], categories: categories || [] };
}
function accountOptions(rows, type = null) { return rows.filter((a) => !type || type.includes(a.type)).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join(""); }

export async function renderSalesScreen(screen, user) {
  if (!IS_CONFIGURED) { screen.innerHTML = noConfig(); return; }

  const { accounts } = await masters();
  const sales = await fetchTransactionPage({
    type: "sale",
    select: "id,txn_date,amount,description,created_at,sale_details(payment_method,collection_account_id,sales_channel,external_order_id)",
    limit: HISTORY_INITIAL_LIMIT,
  });

  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const allowed = canDo(user, "record_sale");
  const collectionAccounts = accounts.filter((a) => a.type === "collection_account");
  const zomatoAccount = collectionAccounts.find((a) => a.name === "Zomato Collections");
  const swiggyAccount = collectionAccounts.find((a) => a.name === "Swiggy Collections");

  screen.innerHTML = `<div class="screen-head"><div>
    <h1>Sales</h1>
    <p>Walk-in sales use Cash or UPI. Zomato and Swiggy sales are recorded into their platform collection accounts for later settlement.</p>
  </div><div class="screen-actions"><a class="btn" href="#/marketplace-imports">Import Zomato / Swiggy</a></div></div>
  ${allowed ? `<div class="card"><div class="card-title">New sale</div>
    <form id="sale-form" class="form-grid">
      <div class="field">
        <label>Sales channel</label>
        <select name="sales_channel" id="sale-channel" required>
          <option value="walk_in">Walk-in</option>
          <option value="zomato">Zomato</option>
          <option value="swiggy">Swiggy</option>
        </select>
      </div>
      <div class="field">
        <label>Payment / collection</label>
        <select name="payment_method" id="sale-payment" required>
          <option value="cash">Cash — Cash Drawer</option>
          <option value="upi">UPI — Collection account</option>
        </select>
      </div>
      <div class="field hidden" id="sale-collection">
        <label>Collection account</label>
        <select name="collection_account_id" id="sale-collection-account">
          <option value="">Choose account</option>
          ${accountOptions(collectionAccounts)}
        </select>
      </div>
      <div class="field">
        <label>Amount</label>
        <input name="amount" type="number" min="0.01" step="0.01" required />
      </div>
      <div class="field">
        <label>Date</label>
        <input name="txn_date" type="date" value="${today()}" required />
      </div>
      <div class="field field-wide">
        <label>Note (optional)</label>
        <input name="description" maxlength="500" placeholder="Optional sale note" />
      </div>
      <div class="field field-wide">
        <div class="form-status"></div>
        <button class="btn btn-primary">Record sale</button>
      </div>
    </form>
  </div>` : ""}
  <div class="card table-wrap"><div class="card-title">Recent sales</div>
    <table class="ledger">
      <thead><tr>
        <th>Date</th><th>Channel</th><th>Payment / collection</th>
        <th>Collection account</th><th>Note</th><th class="num">Amount</th>
      </tr></thead>
      <tbody id="sales-history-body"></tbody>
    </table>
    <div class="history-controls" id="sales-history-controls"></div>
  </div>`;

  createHistoryController({
    tbody: screen.querySelector("#sales-history-body"),
    controls: screen.querySelector("#sales-history-controls"),
    type: "sale",
    select: "id,txn_date,amount,description,created_at,sale_details(payment_method,collection_account_id,sales_channel,external_order_id)",
    initialRows: sales,
    colspan: 6,
    renderRow: (s) => {
      const detail = Array.isArray(s.sale_details) ? s.sale_details[0] : s.sale_details;
      const channel = detail?.sales_channel || "walk_in";
      const payment = detail?.payment_method || "—";
      const accountName = detail?.collection_account_id
        ? (names.get(detail.collection_account_id) || "—")
        : channel === "walk_in" && payment === "cash" ? "Cash Drawer" : "—";
      return `<tr>
        <td>${esc(s.txn_date)}</td>
        <td><span class="stamp">${esc(channel === "walk_in" ? "Walk-in" : channel)}</span></td>
        <td>${esc(payment)}</td>
        <td>${esc(accountName)}</td>
        <td>${esc(s.description || "—")}</td>
        <td class="num">${money(s.amount)}</td>
      </tr>`;
    },
  });

  const channel = screen.querySelector("#sale-channel");
  const method = screen.querySelector("#sale-payment");
  const collection = screen.querySelector("#sale-collection");
  const collectionSelect = screen.querySelector("#sale-collection-account");

  function configureSaleFields() {
    const value = channel.value;

    if (value === "walk_in") {
      method.innerHTML = `
        <option value="cash">Cash — Cash Drawer</option>
        <option value="upi">UPI — Collection account</option>`;
      collection.classList.toggle("hidden", method.value !== "upi");
      collectionSelect.value = "";
      return;
    }

    method.innerHTML = `<option value="marketplace">${value === "zomato" ? "Zomato" : "Swiggy"} — Marketplace collection</option>`;
    collection.classList.remove("hidden");
    const preferred = value === "zomato" ? zomatoAccount : swiggyAccount;
    collectionSelect.value = preferred?.id || "";
  }

  channel?.addEventListener("change", configureSaleFields);
  method?.addEventListener("change", () => {
    collection.classList.toggle("hidden", method.value === "cash");
  });
  configureSaleFields();

  screen.querySelector("#sale-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const feedback = event.currentTarget.querySelector(".form-status");
    const salesChannel = form.get("sales_channel");
    const paymentMethod = form.get("payment_method");
    const collectionAccountId = form.get("collection_account_id") || null;

    if (paymentMethod !== "cash" && !collectionAccountId) {
      status(feedback, "Choose a collection account.", true);
      return;
    }

    const payload = {
      p_client_uuid: crypto.randomUUID(),
      p_amount: Number(form.get("amount")),
      p_payment_method: paymentMethod,
      p_collection_account_id: collectionAccountId,
      p_txn_date: form.get("txn_date"),
      p_description: form.get("description").trim() || null,
      p_sales_channel: salesChannel,
    };

    status(feedback, navigator.onLine ? "Recording sale…" : "Sale queued for sync.");

    try {
      await postOutboxSafe("sale", payload, "create_sale_idempotent");
    } catch (err) {
      status(feedback, err.message, true);
      return;
    }

    if (!navigator.onLine) return;
    await renderSalesScreen(screen, user);
  });
}

export async function renderExpensesScreen(screen, user) {
  if (!IS_CONFIGURED) { screen.innerHTML = noConfig(); return; }
  const { accounts, categories } = await masters();
  const relations = await loadMasterRelations();
  const expenses = await fetchTransactionPage({ type: "expense", select: "id,txn_date,amount,description,created_at,expense_details(category_id,paid_from_account_id,item_id,supplier_id),expense_items(id,item_id)", limit: HISTORY_INITIAL_LIMIT });
  const { data: expenseBalanceRows } = await supabase.from("expense_balances").select("expense_id,paid_amount,outstanding").in("expense_id", expenses.map(e => e.id));
  const expenseBalances = new Map((expenseBalanceRows || []).map(x => [x.expense_id, x]));
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));

  screen.innerHTML = `<div class="screen-head"><div><h1>Expenses</h1><p>Choose a category or search an item. Only items where you enter a value become expense lines. Supplier is optional.</p></div></div>
  <div class="card"><div class="card-title">New expense</div>
    <form id="expense-form">
      <div class="expense-entry-toolbar">
        <div class="field">
          <label>Category</label>
          <select name="category_id" id="expense-category" required><option value="">Choose category</option>${categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
        </div>
        <div class="field expense-item-search-field">
          <label>Search item</label>
          <input id="expense-item-search" list="expense-master-item-options" placeholder="Type an item name…" autocomplete="off">
          <datalist id="expense-master-item-options">${relations.items.filter(i => (relations.expenseMap || []).some(x => x.item_id === i.id)).map(i => `<option value="${esc(i.name)}">${esc(i.unit || "")}</option>`).join("")}</datalist>
          <small class="muted">Selecting an item automatically selects its Expense Category when there is one unambiguous match.</small>
        </div>
      </div>
      <div id="expense-item-category-choice" class="expense-item-category-choice hidden"></div>
      <div id="expense-category-items" class="expense-category-items">
        <div class="empty-state muted">Choose a category or search for an item to load its linked master items.</div>
      </div>
      <div class="expense-entry-summary">
        <div><span>Total expense</span><strong id="expense-total">₹0.00</strong></div>
        <small class="muted">Blank item rows are ignored. Enter quantity, rate, or amount only for items you actually incurred.</small>
      </div>
      <div class="expense-secondary-fields">
        <div class="field"><label>Supplier / Vendor <span class="muted">(optional)</span></label><select name="supplier_id" id="expense-supplier"><option value="">Choose vendor</option></select><small class="muted">Supplier is optional and does not determine the category or items.</small></div>
        <div class="field"><label>Paid from</label><select name="paid_from_account_id"><option value="">Unpaid — add to expense dues</option>${accountOptions(accounts, ["cash", "bank", "collection_account"])}</select></div>
        <div class="field"><label>Date</label><input name="txn_date" type="date" value="${today()}" required></div>
        <div class="field"><label>Document type</label><select name="document_type"><option value="receipt">Receipt</option><option value="invoice">Invoice</option><option value="bill">Bill</option><option value="other">Other</option></select></div>
        <div class="field field-wide"><label>Invoice / receipt (optional)</label><input name="document_file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"><button type="button" class="btn btn-small document-ocr-button hidden" id="expense-ocr-button">Extract details from document</button><small>PDF/JPG/PNG/WEBP · max 10 MB. You can attach it later from Recent expenses.</small></div>
        <div class="field field-wide"><label>Note (optional)</label><input name="description" maxlength="500" placeholder="Optional expense note"></div>
      </div>
      <div class="form-status"></div><button class="btn btn-primary">Record expense</button>
    </form>
  </div>
  <div class="card table-wrap"><div class="card-title">Recent expenses</div><table class="ledger"><thead><tr><th>Date</th><th>Category</th><th>Paid from</th><th>Note</th><th>Entry</th><th class="num">Amount</th><th>Payment</th><th>Document</th></tr></thead><tbody id="expenses-history-body"></tbody></table><div class="history-controls" id="expenses-history-controls"></div></div>`;

  createHistoryController({
    tbody: screen.querySelector("#expenses-history-body"), controls: screen.querySelector("#expenses-history-controls"), type: "expense",
    select: "id,txn_date,amount,description,created_at,expense_details(category_id,paid_from_account_id,item_id,supplier_id),expense_items(id,item_id)", initialRows: expenses, colspan: 8,
    renderRow: (e) => {
      const d = Array.isArray(e.expense_details) ? e.expense_details[0] : e.expense_details;
      const due = expenseBalances.get(e.id); const unpaid = !d?.paid_from_account_id;
      const paymentHtml = unpaid ? `<span class="stamp unpaid">Unpaid</span>${due && Number(due.outstanding)>0 && canDo(user,"supplier_payment") ? ` <button type="button" class="btn btn-small pay-expense-due" data-id="${e.id}" data-due="${due.outstanding}">Pay</button>` : ""}` : `<span class="stamp paid">Paid</span>`;
      return `<tr><td>${esc(e.txn_date)}</td><td>${esc(categoryNames.get(d?.category_id) || "—")}</td><td>${esc(unpaid ? "Expense Due" : (accountNames.get(d?.paid_from_account_id) || "—"))}</td><td>${esc(e.description || "—")}</td><td>${e.expense_items?.length ? `${e.expense_items.length} item${e.expense_items.length===1?"":"s"}` : "—"}</td><td class="num">${money(e.amount)}</td><td>${paymentHtml}</td><td data-document-cell="${e.id}"></td></tr>`;
    },
    onRender: async(rows) => { try { await decorateDocumentCells(screen, rows.map(r => r.id), canDo(user, "record_quick_expense")); } catch(error) { console.error("Document status load failed", error); } }
  });

  const form = screen.querySelector("#expense-form");
  const categorySelect = screen.querySelector("#expense-category");
  const itemSearch = screen.querySelector("#expense-item-search");
  const categoryChoice = screen.querySelector("#expense-item-category-choice");
  const itemHost = screen.querySelector("#expense-category-items");
  const totalEl = screen.querySelector("#expense-total");
  const supplierSelect = screen.querySelector("#expense-supplier");
  let activeCategoryId = "";

  const linkedItemsForCategory = categoryId => {
    const ids = expenseItemIdsForCategory(relations, categoryId);
    return relations.items.filter(i => ids.has(i.id));
  };

  const refreshSuppliers = (preserveId = "") => {
    const categoryId = categorySelect.value || "";
    const allowed = categoryId ? new Set((relations.supplierExpense || []).filter(x => x.expense_category_id === categoryId).map(x => x.supplier_id)) : null;
    const candidates = allowed ? relations.suppliers.filter(s => allowed.has(s.id)) : relations.suppliers;
    supplierSelect.innerHTML = `<option value="">Choose vendor</option>${candidates.map(s => `<option value="${s.id}" ${s.id===preserveId?"selected":""}>${esc(s.name)}</option>`).join("")}`;
  };

  const calculateTotal = () => {
    const total = [...itemHost.querySelectorAll(".expense-item-row")].reduce((sum, row) => sum + Number(row._expenseState?.amount || 0), 0);
    totalEl.textContent = money(total);
    return Math.round(total * 100) / 100;
  };

<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 915a45b6855a9fe6da4ddbd198a9bccabe4b908a
  const syncExpenseInputLock = (input, button, label, locked) => {
    if (!input || !button) return;
    input.disabled = locked;
    input.readOnly = locked;
    input.dataset.locked = String(locked);
    input.classList.toggle("is-editable", !locked);
    button.textContent = locked ? `Modify ${label}` : `Lock ${label}`;
    button.setAttribute("aria-pressed", String(!locked));
  };
  const syncExpenseRateControl = (input, button, state) => {
    const hasMaster = Number(state?.masterRate || 0) > 0;
    button.classList.toggle("hidden", !hasMaster);
    if (!hasMaster) {
      input.disabled = false; input.readOnly = false; input.dataset.locked = "false"; input.classList.add("is-editable");
      state.rateLocked = false;
      return;
    }
    syncExpenseInputLock(input, button, "Rate", Boolean(state.rateLocked));
  };

<<<<<<< HEAD
=======
=======
>>>>>>> 85113897e4af68fa8c9bb83c5b90664562897551
>>>>>>> 915a45b6855a9fe6da4ddbd198a9bccabe4b908a
  const makeItemRow = item => {
    const row = document.createElement("div");
    row.className = "expense-item-row";
    const masterRate = Number(item.master_rate ?? item.last_purchase_rate ?? 0);
    const masterGst = Number(item.gst_rate || 0);
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 915a45b6855a9fe6da4ddbd198a9bccabe4b908a
    row._expenseState = {
      itemId: item.id, amount: 0, manualAmount: false,
      masterRate, rate: masterRate > 0 ? masterRate : "", rateLocked: masterRate > 0, rateOverridden: false,
      masterGstRate: masterGst, gstRate: masterGst, gstLocked: true, gstOverridden: false
    };
    row.innerHTML = `<div class="expense-item-main"><strong>${esc(item.name)}</strong><span>${esc(item.unit || "—")}</span></div>
      <label><span>Qty</span><input data-qty type="number" min="0" step="0.001" inputmode="decimal" placeholder="—"></label>
      <label class="rate-wrap"><span>Rate</span><div class="rate-control"><input data-rate type="number" min="0" step="0.01" inputmode="decimal" value="${masterRate > 0 ? masterRate : ""}" placeholder="Rate" disabled><button type="button" class="rate-modify btn btn-small">Modify Rate</button></div></label>
      <label class="gst-wrap"><span>GST %</span><div class="gst-control"><input data-gst type="number" min="0" max="100" step="0.01" inputmode="decimal" value="${masterGst}" placeholder="GST" disabled><button type="button" class="gst-modify btn btn-small">Modify GST</button></div></label>
      <label class="expense-amount-field"><span>Amount</span><input data-amount type="number" min="0" step="0.01" inputmode="decimal" placeholder="Amount"></label>`;

    const qty = row.querySelector("[data-qty]");
    const rate = row.querySelector("[data-rate]");
    const gst = row.querySelector("[data-gst]");
    const amount = row.querySelector("[data-amount]");
    const rateBtn = row.querySelector(".rate-modify");
    const gstBtn = row.querySelector(".gst-modify");

    const syncAmount = () => {
      if (row._expenseState.manualAmount) {
        row._expenseState.amount = Number(amount.value || 0);
        calculateTotal();
        return;
      }
<<<<<<< HEAD
=======
=======
    row._expenseState = { itemId: item.id, amount: 0, manualAmount: false };
    row.innerHTML = `<div class="expense-item-main"><strong>${esc(item.name)}</strong><span>${esc(item.unit || "—")}</span></div>
      <label><span>Qty</span><input data-qty type="number" min="0" step="0.001" inputmode="decimal" placeholder="—"></label>
      <label><span>Rate</span><input data-rate type="number" min="0" step="0.01" inputmode="decimal" value="${masterRate || ""}" placeholder="Rate"></label>
      <label><span>GST %</span><input data-gst type="number" min="0" max="100" step="0.01" inputmode="decimal" value="${masterGst}" placeholder="GST"></label>
      <label class="expense-amount-field"><span>Amount</span><input data-amount type="number" min="0" step="0.01" inputmode="decimal" placeholder="Amount"></label>`;

    const qty = row.querySelector("[data-qty]"), rate = row.querySelector("[data-rate]"), gst = row.querySelector("[data-gst]"), amount = row.querySelector("[data-amount]");
    const syncAmount = () => {
      if (row._expenseState.manualAmount) { row._expenseState.amount = Number(amount.value || 0); calculateTotal(); return; }
>>>>>>> 85113897e4af68fa8c9bb83c5b90664562897551
>>>>>>> 915a45b6855a9fe6da4ddbd198a9bccabe4b908a
      const q = Number(qty.value || 0), r = Number(rate.value || 0), g = Number(gst.value || 0);
      const calculated = q > 0 && r >= 0 ? Math.round((q * r * (1 + g / 100)) * 100) / 100 : 0;
      amount.value = calculated ? calculated.toFixed(2) : "";
      row._expenseState.amount = calculated;
      calculateTotal();
    };
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 915a45b6855a9fe6da4ddbd198a9bccabe4b908a

    qty.addEventListener("input", syncAmount);
    rate.addEventListener("input", () => {
      const st = row._expenseState;
      st.rate = rate.value === "" ? "" : Number(rate.value);
      st.rateOverridden = Number(st.masterRate) > 0 && st.rate !== "" && Number(st.rate) !== Number(st.masterRate);
      row._expenseState.manualAmount = false;
      syncAmount();
    });
    gst.addEventListener("input", () => {
      const st = row._expenseState;
      st.gstRate = gst.value === "" ? "" : Number(gst.value);
      st.gstOverridden = st.masterGstRate !== null && st.gstRate !== "" && Number(st.gstRate) !== Number(st.masterGstRate);
      row._expenseState.manualAmount = false;
      syncAmount();
    });
    amount.addEventListener("input", () => {
      row._expenseState.manualAmount = true;
      row._expenseState.amount = Number(amount.value || 0);
      calculateTotal();
    });
    rateBtn.addEventListener("click", () => {
      const st = row._expenseState;
      st.rateLocked = !st.rateLocked;
      syncExpenseInputLock(rate, rateBtn, "Rate", st.rateLocked);
      if (!st.rateLocked) requestAnimationFrame(() => { rate.focus(); rate.select(); });
    });
    gstBtn.addEventListener("click", () => {
      const st = row._expenseState;
      st.gstLocked = !st.gstLocked;
      syncExpenseInputLock(gst, gstBtn, "GST", st.gstLocked);
      if (!st.gstLocked) requestAnimationFrame(() => { gst.focus(); gst.select(); });
    });

    syncExpenseRateControl(rate, rateBtn, row._expenseState);
    syncExpenseInputLock(gst, gstBtn, "GST", true);
<<<<<<< HEAD
=======
=======
    qty.addEventListener("input", syncAmount); rate.addEventListener("input", syncAmount); gst.addEventListener("input", syncAmount);
    amount.addEventListener("input", () => { row._expenseState.manualAmount = true; row._expenseState.amount = Number(amount.value || 0); calculateTotal(); });
>>>>>>> 85113897e4af68fa8c9bb83c5b90664562897551
>>>>>>> 915a45b6855a9fe6da4ddbd198a9bccabe4b908a
    itemHost.append(row);
    return row;
  };

<<<<<<< HEAD

=======
<<<<<<< HEAD

=======
>>>>>>> 85113897e4af68fa8c9bb83c5b90664562897551
>>>>>>> 915a45b6855a9fe6da4ddbd198a9bccabe4b908a
  const renderCategoryItems = (categoryId, focusItemId = "") => {
    activeCategoryId = categoryId || "";
    const items = categoryId ? linkedItemsForCategory(categoryId) : [];
    if (!items.length) {
      itemHost.innerHTML = categoryId ? `<div class="empty-state muted">No Master Items are linked to this Expense Category yet.</div>` : `<div class="empty-state muted">Choose a category or search for an item to load its linked master items.</div>`;
      calculateTotal(); refreshSuppliers(supplierSelect.value || ""); return;
    }
    itemHost.innerHTML = `<div class="expense-items-heading"><div><strong>${esc(categories.find(c=>c.id===categoryId)?.name || "Expense items")}</strong><span>${items.length} linked item${items.length===1?"":"s"}</span></div><span class="muted">Enter only the items you actually incurred.</span></div>`;
    items.forEach(item => makeItemRow(item));
    refreshSuppliers(supplierSelect.value || "");
    if (focusItemId) {
      const target = [...itemHost.querySelectorAll(".expense-item-row")].find(r => r._expenseState.itemId === focusItemId);
      if (target) { target.classList.add("is-focused"); requestAnimationFrame(() => target.scrollIntoView({ block: "nearest", behavior: "smooth" })); target.querySelector("[data-qty]")?.focus(); }
    }
    calculateTotal();
  };

  const setCategoryFromItem = itemId => {
    const categoryIds = expenseCategoriesForItem(relations, itemId);
    categoryChoice.classList.add("hidden"); categoryChoice.innerHTML = "";
    if (categoryIds.length === 1) {
      categorySelect.value = categoryIds[0];
      renderCategoryItems(categoryIds[0], itemId);
      return;
    }
    if (categoryIds.length > 1) {
      categoryChoice.classList.remove("hidden");
      categoryChoice.innerHTML = `<div><strong>This item belongs to multiple Expense Categories.</strong><span>Choose the category for this expense.</span></div><div class="expense-category-choice-buttons">${categoryIds.map(id => `<button type="button" class="btn btn-small" data-category-choice="${id}">${esc(categoryNames.get(id) || "Category")}</button>`).join("")}</div>`;
      categoryChoice.querySelectorAll("[data-category-choice]").forEach(btn => btn.addEventListener("click", () => { categorySelect.value = btn.dataset.categoryChoice; categoryChoice.classList.add("hidden"); renderCategoryItems(btn.dataset.categoryChoice, itemId); }));
    }
  };

<<<<<<< HEAD
  categorySelect.addEventListener("change", async () => {
    const currentHasValues = [...itemHost.querySelectorAll(".expense-item-row")].some(r => Number(r._expenseState?.amount || 0) > 0);
    if (currentHasValues && categorySelect.value !== activeCategoryId && !(await window.__confirmDialog({title:"Change expense category?",body:"Changing the category will clear the item entries you have already entered.",confirmLabel:"Change category",cancelLabel:"Keep current entries"}))) { categorySelect.value = activeCategoryId; return; }
=======
<<<<<<< HEAD
  categorySelect.addEventListener("change", async () => {
    const currentHasValues = [...itemHost.querySelectorAll(".expense-item-row")].some(r => Number(r._expenseState?.amount || 0) > 0);
    if (currentHasValues && categorySelect.value !== activeCategoryId && !(await window.__confirmDialog({title:"Change expense category?",body:"Changing the category will clear the item entries you have already entered.",confirmLabel:"Change category",cancelLabel:"Keep current entries"}))) { categorySelect.value = activeCategoryId; return; }
=======
  categorySelect.addEventListener("change", () => {
    const currentHasValues = [...itemHost.querySelectorAll(".expense-item-row")].some(r => Number(r._expenseState?.amount || 0) > 0);
    if (currentHasValues && categorySelect.value !== activeCategoryId && !window.confirm("Changing category will clear the current item entries. Continue?")) { categorySelect.value = activeCategoryId; return; }
>>>>>>> 85113897e4af68fa8c9bb83c5b90664562897551
>>>>>>> 915a45b6855a9fe6da4ddbd198a9bccabe4b908a
    categoryChoice.classList.add("hidden"); itemSearch.value = ""; renderCategoryItems(categorySelect.value); 
  });

  itemSearch.addEventListener("input", () => {
    const query = itemSearch.value.trim().toLowerCase();
    const picked = relations.items.find(i => i.name.toLowerCase() === query && (relations.expenseMap || []).some(x => x.item_id === i.id));
    if (!picked) return;
    setCategoryFromItem(picked.id);
  });

  refreshSuppliers();

  const expenseFileInput = form.querySelector('[name="document_file"]');
  const expenseOcrButton = form.querySelector("#expense-ocr-button");
  expenseFileInput?.addEventListener("change", () => { expenseOcrButton?.classList.toggle("hidden", !expenseFileInput.files?.[0]); });
  expenseOcrButton?.addEventListener("click", () => {
    const file = expenseFileInput?.files?.[0]; if (!file) return;
    openDocumentOcrReview({ screen, file, mode: "expense", onApply: result => {
      if (result.date) form.elements.txn_date.value = result.date;
      if (result.invoiceNumber) { const note = form.elements.description.value.trim(); form.elements.description.value = note || `Invoice ${result.invoiceNumber}`; }
      if (result.items?.length) {
        const first = result.items.find(x => x.item?.id);
        if (first) { itemSearch.value = first.item.name; setCategoryFromItem(first.item.id); }
        setTimeout(() => {
          result.items.forEach(x => {
            const row = [...itemHost.querySelectorAll(".expense-item-row")].find(r => r._expenseState.itemId === x.item?.id);
            if (!row) return;
            if (x.quantity != null) row.querySelector("[data-qty]").value = x.quantity;
            if (x.rate != null) row.querySelector("[data-rate]").value = x.rate;
            if (x.gstRate != null) row.querySelector("[data-gst]").value = x.gstRate;
            if (x.amount != null) { row.querySelector("[data-amount]").value = x.amount; row._expenseState.manualAmount = true; row._expenseState.amount = Number(x.amount); }
          });
          calculateTotal();
        }, 0);
      }
    }});
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const formData = new FormData(form); const feedback = form.querySelector(".form-status");
    const categoryId = formData.get("category_id");
    const lines = [...itemHost.querySelectorAll(".expense-item-row")].map(row => ({ row, state: row._expenseState })).filter(x => Number(x.state?.amount || 0) > 0);
    const amount = Math.round(lines.reduce((sum, x) => sum + Number(x.state.amount || 0), 0) * 100) / 100;
    if (!categoryId) { status(feedback, "Choose an Expense Category.", true); return; }
    if (!lines.length || amount <= 0) { status(feedback, "Enter a quantity or amount for at least one item.", true); return; }
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 915a45b6855a9fe6da4ddbd198a9bccabe4b908a
    const items = lines.map(({row,state}) => ({
      item_id: state.itemId,
      description: row.querySelector(".expense-item-main strong")?.textContent || "",
      quantity: row.querySelector("[data-qty]")?.value || "",
      unit: row.querySelector(".expense-item-main span")?.textContent || "",
      rate: row.querySelector("[data-rate]")?.value || "",
      gst_rate: row.querySelector("[data-gst]")?.value || "",
      amount: Number(state.amount || 0)
    }));
    const rateOverrides = lines.map(({row,state}, index) => ({
      line: items[index],
      master: Number(state.masterRate),
      actual: Number(items[index].rate)
    })).filter(x => x.master > 0 && x.line.rate !== "" && Number.isFinite(x.actual) && x.actual !== x.master);
    const gstOverrides = lines.map(({row,state}, index) => ({
      line: items[index],
      master: Number(state.masterGstRate),
      actual: Number(items[index].gst_rate)
    })).filter(x => x.line.gst_rate !== "" && Number.isFinite(x.actual) && x.actual !== x.master);

    let updateMasterRates = false;
    let updateMasterGstRates = false;
    if (rateOverrides.length && user.role === "owner") {
      updateMasterRates = await window.__confirmDialog({title:"Expense rate differs from master",body:"Choose whether this rate should become the new master rate or apply only to this expense.",confirmLabel:"Update master rate",cancelLabel:"Use for this expense only"});
<<<<<<< HEAD
    }
    if (gstOverrides.length && user.role === "owner") {
      updateMasterGstRates = await window.__confirmDialog({title:"GST differs from master",body:"Choose whether this GST rate should become the new master GST rate or apply only to this expense.",confirmLabel:"Update master GST",cancelLabel:"Use for this expense only"});
    }
    if ((rateOverrides.length || gstOverrides.length) && user.role !== "owner") {
      window.__toast("Changed rates/GST percentages will apply to this expense only. Only the Owner can update master values.",{type:"info"});
    }
    if ((updateMasterRates || updateMasterGstRates) && !navigator.onLine) {
      status(feedback, "Reconnect to update master rates/GST from this expense. The expense was not recorded.", true);
      return;
    }

    const documentFile = formData.get("document_file");
    if (documentFile?.size && !navigator.onLine) { status(feedback, "Document uploads require an internet connection. Remove the file or reconnect before recording this expense.", true); return; }
    const payload = { p_client_uuid: crypto.randomUUID(), p_category_id: categoryId, p_paid_from_account_id: formData.get("paid_from_account_id") || null, p_amount: amount, p_txn_date: formData.get("txn_date"), p_description: formData.get("description").trim() || null, p_items: items };
    status(feedback, navigator.onLine ? "Recording expense…" : "Expense queued for sync.");
    let txnId = null;
    try {
      if (!navigator.onLine && documentFile?.size) throw new Error("Reconnect before attaching a document.");
      const isUnpaid = !payload.p_paid_from_account_id;

      if (updateMasterRates || updateMasterGstRates) {
        const rpcName = isUnpaid ? "create_unpaid_expense_idempotent_with_master_rate_updates" : "create_expense_idempotent_with_master_rate_updates";
        const rpcPayload = isUnpaid
          ? { p_client_uuid: payload.p_client_uuid, p_category_id: payload.p_category_id, p_amount: payload.p_amount, p_txn_date: payload.p_txn_date, p_description: payload.p_description, p_items: payload.p_items, p_update_master_rates: updateMasterRates, p_update_master_gst_rates: updateMasterGstRates }
          : { ...payload, p_update_master_rates: updateMasterRates, p_update_master_gst_rates: updateMasterGstRates };
        const { data, error } = await supabase.rpc(rpcName, rpcPayload);
        if (error) throw error;
        txnId = data;
      } else if (documentFile?.size || isUnpaid) {
        const rpcName = isUnpaid ? "create_unpaid_expense_idempotent" : "create_expense_idempotent";
        const rpcPayload = isUnpaid ? { p_client_uuid: payload.p_client_uuid, p_category_id: payload.p_category_id, p_amount: payload.p_amount, p_txn_date: payload.p_txn_date, p_description: payload.p_description, p_items: payload.p_items } : payload;
        const { data, error } = await supabase.rpc(rpcName, rpcPayload); if (error) throw error; txnId = data;
      } else {
        const result = await postOutboxSafe("expense", payload, "create_expense_idempotent"); txnId = typeof result === "string" ? result : result?.data || null;
      }
    } catch (err) { status(feedback, err.message, true); return; }
    const supplierId = formData.get("supplier_id") || null;
    if (txnId && supplierId && navigator.onLine) {
      try { const { error } = await supabase.rpc("set_expense_supplier", { p_transaction_id: txnId, p_supplier_id: supplierId }); if (error) throw error; }
      catch (error) { status(feedback, `Expense recorded, but the vendor link could not be saved: ${error.message}`, true); return; }
    }
    if (documentFile?.size && txnId) {
      try { status(feedback, "Expense recorded. Uploading invoice/receipt…"); await uploadDocument({ file: documentFile, documentType: formData.get("document_type") || "receipt", documentDate: formData.get("txn_date"), transactionIds: [txnId] }); }
      catch (documentError) { status(feedback, `Expense recorded, but the document could not be attached: ${documentError.message}`, true); }
    }
=======
    }
    if (gstOverrides.length && user.role === "owner") {
      updateMasterGstRates = await window.__confirmDialog({title:"GST differs from master",body:"Choose whether this GST rate should become the new master GST rate or apply only to this expense.",confirmLabel:"Update master GST",cancelLabel:"Use for this expense only"});
    }
    if ((rateOverrides.length || gstOverrides.length) && user.role !== "owner") {
      window.__toast("Changed rates/GST percentages will apply to this expense only. Only the Owner can update master values.",{type:"info"});
    }
    if ((updateMasterRates || updateMasterGstRates) && !navigator.onLine) {
      status(feedback, "Reconnect to update master rates/GST from this expense. The expense was not recorded.", true);
      return;
    }

    const documentFile = formData.get("document_file");
    if (documentFile?.size && !navigator.onLine) { status(feedback, "Document uploads require an internet connection. Remove the file or reconnect before recording this expense.", true); return; }
    const payload = { p_client_uuid: crypto.randomUUID(), p_category_id: categoryId, p_paid_from_account_id: formData.get("paid_from_account_id") || null, p_amount: amount, p_txn_date: formData.get("txn_date"), p_description: formData.get("description").trim() || null, p_items: items };
    status(feedback, navigator.onLine ? "Recording expense…" : "Expense queued for sync.");
    let txnId = null;
    try {
      if (!navigator.onLine && documentFile?.size) throw new Error("Reconnect before attaching a document.");
      const isUnpaid = !payload.p_paid_from_account_id;

      if (updateMasterRates || updateMasterGstRates) {
        const rpcName = isUnpaid ? "create_unpaid_expense_idempotent_with_master_rate_updates" : "create_expense_idempotent_with_master_rate_updates";
        const rpcPayload = isUnpaid
          ? { p_client_uuid: payload.p_client_uuid, p_category_id: payload.p_category_id, p_amount: payload.p_amount, p_txn_date: payload.p_txn_date, p_description: payload.p_description, p_items: payload.p_items, p_update_master_rates: updateMasterRates, p_update_master_gst_rates: updateMasterGstRates }
          : { ...payload, p_update_master_rates: updateMasterRates, p_update_master_gst_rates: updateMasterGstRates };
        const { data, error } = await supabase.rpc(rpcName, rpcPayload);
        if (error) throw error;
        txnId = data;
      } else if (documentFile?.size || isUnpaid) {
        const rpcName = isUnpaid ? "create_unpaid_expense_idempotent" : "create_expense_idempotent";
        const rpcPayload = isUnpaid ? { p_client_uuid: payload.p_client_uuid, p_category_id: payload.p_category_id, p_amount: payload.p_amount, p_txn_date: payload.p_txn_date, p_description: payload.p_description, p_items: payload.p_items } : payload;
        const { data, error } = await supabase.rpc(rpcName, rpcPayload); if (error) throw error; txnId = data;
      } else {
        const result = await postOutboxSafe("expense", payload, "create_expense_idempotent"); txnId = typeof result === "string" ? result : result?.data || null;
      }
    } catch (err) { status(feedback, err.message, true); return; }
    const supplierId = formData.get("supplier_id") || null;
    if (txnId && supplierId && navigator.onLine) {
      try { const { error } = await supabase.rpc("set_expense_supplier", { p_transaction_id: txnId, p_supplier_id: supplierId }); if (error) throw error; }
      catch (error) { status(feedback, `Expense recorded, but the vendor link could not be saved: ${error.message}`, true); return; }
    }
    if (documentFile?.size && txnId) {
      try { status(feedback, "Expense recorded. Uploading invoice/receipt…"); await uploadDocument({ file: documentFile, documentType: formData.get("document_type") || "receipt", documentDate: formData.get("txn_date"), transactionIds: [txnId] }); }
      catch (documentError) { status(feedback, `Expense recorded, but the document could not be attached: ${documentError.message}`, true); }
    }
=======
    const items = lines.map(({row,state}) => ({ item_id: state.itemId, description: row.querySelector(".expense-item-main strong")?.textContent || "", quantity: row.querySelector("[data-qty]")?.value || "", unit: row.querySelector(".expense-item-main span")?.textContent || "", rate: row.querySelector("[data-rate]")?.value || "", gst_rate: row.querySelector("[data-gst]")?.value || "", amount: Number(state.amount || 0) }));
    const documentFile = formData.get("document_file");
    if (documentFile?.size && !navigator.onLine) { status(feedback, "Document uploads require an internet connection. Remove the file or reconnect before recording this expense.", true); return; }
    const payload = { p_client_uuid: crypto.randomUUID(), p_category_id: categoryId, p_paid_from_account_id: formData.get("paid_from_account_id") || null, p_amount: amount, p_txn_date: formData.get("txn_date"), p_description: formData.get("description").trim() || null, p_items: items };
    status(feedback, navigator.onLine ? "Recording expense…" : "Expense queued for sync.");
    let txnId = null;
    try {
      if (!navigator.onLine && documentFile?.size) throw new Error("Reconnect before attaching a document.");
      const isUnpaid = !payload.p_paid_from_account_id;
      if (documentFile?.size || isUnpaid) {
        const rpcName = isUnpaid ? "create_unpaid_expense_idempotent" : "create_expense_idempotent";
        const rpcPayload = isUnpaid ? { p_client_uuid: payload.p_client_uuid, p_category_id: payload.p_category_id, p_amount: payload.p_amount, p_txn_date: payload.p_txn_date, p_description: payload.p_description, p_items: payload.p_items } : payload;
        const { data, error } = await supabase.rpc(rpcName, rpcPayload); if (error) throw error; txnId = data;
      } else {
        const result = await postOutboxSafe("expense", payload, "create_expense_idempotent"); txnId = typeof result === "string" ? result : result?.data || null;
      }
    } catch (err) { status(feedback, err.message, true); return; }
    const supplierId = formData.get("supplier_id") || null;
    if (txnId && supplierId && navigator.onLine) {
      try { const { error } = await supabase.rpc("set_expense_supplier", { p_transaction_id: txnId, p_supplier_id: supplierId }); if (error) throw error; }
      catch (error) { status(feedback, `Expense recorded, but the vendor link could not be saved: ${error.message}`, true); return; }
    }
    if (documentFile?.size && txnId) {
      try { status(feedback, "Expense recorded. Uploading invoice/receipt…"); await uploadDocument({ file: documentFile, documentType: formData.get("document_type") || "receipt", documentDate: formData.get("txn_date"), transactionIds: [txnId] }); }
      catch (documentError) { status(feedback, `Expense recorded, but the document could not be attached: ${documentError.message}`, true); }
    }
>>>>>>> 85113897e4af68fa8c9bb83c5b90664562897551
>>>>>>> 915a45b6855a9fe6da4ddbd198a9bccabe4b908a
    if (navigator.onLine) await renderExpensesScreen(screen, user);
  });

  screen.addEventListener("click", async (event) => {
    const docButton = event.target.closest(".document-attach");
<<<<<<< HEAD
    if (docButton) { try { await openDocumentModal({ screen, transactionId: docButton.dataset.txnId, user, onDone: async () => { try { await decorateDocumentCells(screen, [docButton.dataset.txnId], canDo(user, "record_quick_expense")); } catch(error) { console.error(error); } } }); } catch (error) { window.__toast(window.__friendlyError(error.message),{type:"error"}); } return; }
=======
<<<<<<< HEAD
    if (docButton) { try { await openDocumentModal({ screen, transactionId: docButton.dataset.txnId, user, onDone: async () => { try { await decorateDocumentCells(screen, [docButton.dataset.txnId], canDo(user, "record_quick_expense")); } catch(error) { console.error(error); } } }); } catch (error) { window.__toast(window.__friendlyError(error.message),{type:"error"}); } return; }
=======
    if (docButton) { try { await openDocumentModal({ screen, transactionId: docButton.dataset.txnId, user, onDone: async () => { try { await decorateDocumentCells(screen, [docButton.dataset.txnId], canDo(user, "record_quick_expense")); } catch(error) { console.error(error); } } }); } catch (error) { alert(error.message); } return; }
>>>>>>> 85113897e4af68fa8c9bb83c5b90664562897551
>>>>>>> 915a45b6855a9fe6da4ddbd198a9bccabe4b908a
    const payButton = event.target.closest(".pay-expense-due");
    if (!payButton) return;
    const amount = Number(payButton.dataset.due || 0); const accountOptionsHtml = accountOptions(accounts, ["cash", "bank", "collection_account"]); const mount = document.createElement("div"); mount.className = "document-modal-mount";
    mount.innerHTML = `<div class="modal-backdrop"><form class="modal-card" id="expense-payment-form"><button type="button" class="modal-close">×</button><h2>Pay expense due</h2><p class="muted">Outstanding: <strong>${money(amount)}</strong></p><div class="field"><label>Paid from</label><select name="account" required><option value="">Choose account</option>${accountOptionsHtml}</select></div><div class="field"><label>Amount</label><input name="amount" type="number" min="0.01" max="${amount}" step="0.01" value="${amount}" required></div><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Note (optional)</label><input name="note" maxlength="500"></div><div class="form-status"></div><button class="btn btn-primary">Record payment</button></form></div>`;
    screen.append(mount); const paymentForm = mount.querySelector("form"); mount.querySelector(".modal-close").onclick = () => mount.remove();
    paymentForm.addEventListener("submit", async e => { e.preventDefault(); const fd = new FormData(paymentForm); const feedback = paymentForm.querySelector(".form-status"); status(feedback, "Recording payment…"); const { error } = await supabase.rpc("record_expense_payment", { p_expense_transaction_id: payButton.dataset.id, p_from_account_id: fd.get("account"), p_amount: Number(fd.get("amount")), p_txn_date: fd.get("date"), p_description: fd.get("note").trim() || null }); if (error) { status(feedback, error.message, true); return; } mount.remove(); await renderExpensesScreen(screen, user); });
  });
}

export async function renderUpiScreen(screen, user) {
  if (!IS_CONFIGURED) { screen.innerHTML = noConfig(); return; }

  const { accounts } = await masters();
  const { data, error } = await supabase.from("upi_reconciliation").select("*").order("name");
  if (error) throw error;

  const allowed = canDo(user, "mark_settlement");
  const platformName = (name) => name === "Zomato Collections" ? "Zomato" : name === "Swiggy Collections" ? "Swiggy" : "UPI";

  screen.innerHTML = `<div class="screen-head"><div>
    <h1>UPI & Marketplace Reconciliation</h1>
    <p>Settle UPI, Zomato and Swiggy collection accounts when funds reach Cash or Bank.</p>
  </div><div class="screen-actions"><a class="btn" href="#/marketplace-imports">Import Zomato / Swiggy</a></div></div>
  <div class="card table-wrap"><table class="ledger"><thead><tr>
    <th>Collection account</th><th>Channel</th><th class="num">Collected</th><th class="num">Settled</th><th class="num">Pending</th><th></th>
  </tr></thead><tbody>${(data || []).map((r) => `<tr>
    <td>${esc(r.name)}</td>
    <td><span class="stamp">${platformName(r.name)}</span></td>
    <td class="num">${money(r.sales)}</td>
    <td class="num">${money(r.settled)}</td>
    <td class="num ${Number(r.pending) > 0 ? "negative" : ""}">${money(r.pending)}</td>
    <td>${allowed && Number(r.pending) > 0
      ? `<button class="btn btn-small settle-upi" data-id="${r.account_id}" data-name="${esc(r.name)}" data-pending="${r.pending}">Mark settlement</button>`
      : Number(r.pending) <= 0 && Number(r.sales) > 0
        ? '<span class="stamp settled">Settled</span>'
        : '<span class="muted">—</span>'}</td>
  </tr>`).join("") || '<tr><td colspan="6">No collection accounts yet.</td></tr>'}</tbody></table></div><div id="upi-modal"></div>`;

  screen.querySelectorAll(".settle-upi").forEach((button) =>
    button.addEventListener("click", () => settlementForm(screen, user, accounts, button.dataset))
  );
}

function settlementForm(screen, user, accounts, data) {
  const mount = screen.querySelector("#upi-modal");
  mount.innerHTML = `<div class="modal-backdrop"><form class="modal-card" id="settlement-form">
    <button type="button" class="modal-close">×</button>
    <h2>Settle ${data.name}</h2>
    <p class="muted">Pending collected amount: <strong>${money(data.pending)}</strong></p>
    <div class="field"><label>Move to</label><select name="to" required>${accountOptions(accounts,["cash","bank"])}</select></div>
    <div class="field"><label>Amount</label><input name="amount" type="number" min="0.01" max="${data.pending}" step="0.01" value="${Number(data.pending)}" required /></div>
    <div class="field"><label>Date</label><input name="txn_date" type="date" value="${today()}" required /></div>
    <div class="field"><label>Note (optional)</label><input name="description" maxlength="500" /></div>
    <div class="form-status"></div><button class="btn btn-primary">Record settlement</button>
  </form></div>`;

  mount.querySelector(".modal-close").addEventListener("click", () => mount.innerHTML = "");
  mount.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const feedback=e.currentTarget.querySelector(".form-status");
    status(feedback,"Recording settlement…");
    const {error}=await supabase.rpc("create_upi_settlement",{
      p_collection_account_id:data.id,
      p_settled_to_account_id:form.get("to"),
      p_amount:Number(form.get("amount")),
      p_txn_date:form.get("txn_date"),
      p_description:form.get("description").trim()||null
    });
    if(error){status(feedback,error.message,true);return;}
    await renderUpiScreen(screen,user);
  });
}

export async function renderDailyClosingScreen(screen, user) {
  if (!IS_CONFIGURED) { screen.innerHTML = noConfig(); return; }
  const allowed = canDo(user, "run_daily_closing"); const date = today();
  screen.innerHTML = `<div class="screen-head"><div><h1>Daily Closing</h1><p>Confirm the cash count, preserve the difference, and lock the day against accidental back-dating.</p></div></div>${allowed ? `<div class="card"><div class="card-title">Close the day</div><form id="closing-form"><div class="form-grid"><div class="field"><label>Closing date</label><input name="closing_date" type="date" value="${date}" required /></div><div class="field"><label>Physical cash counted</label><input name="actual_cash" type="number" min="0" step="0.01" required /></div></div><div class="closing-preview" id="closing-preview">Loading cash position…</div><div class="card-title">Denomination count (optional)</div><div class="denomination-grid">${[500,200,100,50,20,10,5,2,1].map((n) => `<label>₹${n}<input data-denomination="${n}" type="number" min="0" step="1" value="0" /></label>`).join("")}</div><p class="muted" id="denomination-total">Denomination total: ₹0.00</p><div class="field"><label>Notes (optional)</label><textarea name="notes" rows="3"></textarea></div><div class="form-status"></div><button class="btn btn-primary">Close and lock day</button></form></div>` : '<div class="card"><p class="muted">Only an Owner or Manager can run Daily Closing.</p></div>'}<div class="card" id="closing-summary"><div class="card-title">Closing history</div><p class="muted">Loading…</p></div>`;
  await loadClosingHistory(screen, user); const form = screen.querySelector("#closing-form"); const total = screen.querySelector("#denomination-total"); const preview = async () => { const mount=screen.querySelector("#closing-preview"); if(!mount)return; const {data,error}=await supabase.rpc("daily_closing_preview",{p_closing_date:form.elements.closing_date.value}); if(error){mount.textContent=error.message;return;}const p=data?.[0];mount.innerHTML=`<div class="stat-row"><span class="stat-label">Expected Cash Drawer balance</span><span class="stat-value">${money(p?.expected_cash)}</span></div><div class="closing-metrics"><span>Cash sales: <strong>${money(p?.cash_sales)}</strong></span><span>UPI sales: <strong>${money(p?.upi_sales)}</strong></span><span>Cash expenses: <strong>${money(p?.cash_expenses)}</strong></span></div>`; }; await preview(); form?.elements.closing_date.addEventListener("change",preview); const calc = () => { const sum = [...screen.querySelectorAll("[data-denomination]")].reduce((s,input)=>s+Number(input.dataset.denomination)*Number(input.value||0),0); total.textContent=`Denomination total: ${money(sum)}`; form.elements.actual_cash.value=sum || ""; }; screen.querySelectorAll("[data-denomination]").forEach((input)=>input.addEventListener("input",calc)); form?.addEventListener("submit", async(e)=>{e.preventDefault();const fd=new FormData(form);const feedback=form.querySelector(".form-status");const denominations=Object.fromEntries([...screen.querySelectorAll("[data-denomination]")].map(i=>[i.dataset.denomination,Number(i.value||0)]));status(feedback,"Closing and locking day…");const {error}=await supabase.rpc("close_daily_operations",{p_closing_date:fd.get("closing_date"),p_actual_cash:Number(fd.get("actual_cash")),p_denominations:denominations,p_notes:fd.get("notes").trim()||null});if(error){status(feedback,error.message,true);return;}await renderDailyClosingScreen(screen,user);});
}
async function loadClosingHistory(screen,user){const mount=screen.querySelector("#closing-summary");const {data,error}=await supabase.from("daily_closings").select("closing_date,expected_cash,actual_cash,difference,reopened_at,notes").order("closing_date",{ascending:false}).limit(31);if(error){mount.innerHTML=`<div class="card-title">Closing history</div><p class="form-status error">${esc(error.message)}</p>`;return;}mount.innerHTML=`<div class="card-title">Closing history</div><div class="table-wrap"><table class="ledger"><thead><tr><th>Date</th><th class="num">Expected</th><th class="num">Actual</th><th class="num">Difference</th><th>Status</th><th></th></tr></thead><tbody>${(data||[]).map(r=>`<tr><td>${esc(r.closing_date)}</td><td class="num">${money(r.expected_cash)}</td><td class="num">${money(r.actual_cash)}</td><td class="num ${Number(r.difference)?"negative":""}">${money(r.difference)}</td><td>${r.reopened_at?'<span class="stamp pending">Reopened</span>':'<span class="stamp settled">Locked</span>'}</td><td>${user.role==='owner'&&!r.reopened_at?`<button class="btn btn-small reopen-day" data-date="${r.closing_date}">Reopen</button>`:''}</td></tr>`).join("")||'<tr><td colspan="6">No days closed yet.</td></tr>'}</tbody></table></div>`;mount.querySelectorAll('.reopen-day').forEach(button=>button.addEventListener('click',async()=>{const reason=await window.__promptDialog({title:`Reopen ${button.dataset.date}`,label:"Reason for reopening",submitLabel:"Reopen day",required:true});if(reason===null)return;const {error:err}=await supabase.rpc('reopen_daily_operations',{p_closing_date:button.dataset.date,p_reason:reason});if(err){window.__toast("Could not reopen this day. Please check your permissions and try again.",{type:"error"});return;}await renderDailyClosingScreen(screen,user);}));}
