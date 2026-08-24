import { supabase, IS_CONFIGURED } from "./supabase-client.js";

const TYPES = [
  { key: "sales", label: "Sales", description: "Forecast revenue by item." },
  { key: "purchase", label: "Purchases", description: "Forecast purchase quantity and cost." },
  { key: "expense", label: "Expenses", description: "Budget a category or a category + item." },
  { key: "wastage", label: "Wastage", description: "Forecast wastage by item." },
];

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthStart = (value) => {
  const d = value ? new Date(`${value}T00:00:00`) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`;
};
const monthInput = (value) => {
  const d = value ? new Date(`${value}T00:00:00`) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
};
const monthLabel = (value) => new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { month:"long", year:"numeric" });
const num = (v) => Math.max(0, Number(v || 0));

export async function renderBudgetScreen(screen, user) {
  if (!IS_CONFIGURED) {
    screen.innerHTML = `<div class="placeholder-screen"><h2>Budget & Forecasting</h2><p>Connect Supabase first.</p></div>`;
    return;
  }
  if (!user || !["owner","manager"].includes(user.role)) {
    screen.innerHTML = `<div class="placeholder-screen"><h2>Budget & Forecasting</h2><p>Only Owner and Manager can create or edit budgets.</p></div>`;
    return;
  }

  const [{ data: items, error: itemErr }, { data: categories, error: catErr }] = await Promise.all([
    supabase.from("items").select("id,name,unit,last_purchase_rate,active").eq("active", true).order("name"),
    supabase.from("expense_categories").select("id,name,active").eq("active", true).order("name"),
  ]);
  if (itemErr) throw itemErr;
  if (catErr) throw catErr;

  const state = { month: monthInput(), type: "sales", versionId: null, status: null, lines: [], items: items || [], categories: categories || [] };

  screen.innerHTML = `
    <div class="screen-head">
      <div><h1>Budget & Forecasting</h1><p>Create monthly forecasts without changing actual financial records.</p></div>
      <div class="button-row"><button class="btn" id="budget-refresh">Refresh</button><button class="btn btn-primary" id="budget-new">New Draft</button></div>
    </div>
    <div class="card">
      <div class="form-grid">
        <label>Budget month<input id="budget-month" type="month" value="${state.month}"></label>
        <label>Budget type<select id="budget-type">${TYPES.map(t=>`<option value="${t.key}">${t.label}</option>`).join("")}</select></label>
        <label>Version<select id="budget-version"><option value="">No version loaded</option></select></label>
      </div>
      <div id="budget-status" class="muted" style="margin-top:10px;"></div>
    </div>
    <div id="budget-builder"></div>
  `;

  const monthEl = screen.querySelector("#budget-month");
  const typeEl = screen.querySelector("#budget-type");
  const versionEl = screen.querySelector("#budget-version");
  const builder = screen.querySelector("#budget-builder");
  const statusEl = screen.querySelector("#budget-status");

  async function loadVersions() {
    state.month = monthEl.value;
    state.type = typeEl.value;
    const period = monthStart(state.month);
    const { data: periods, error: pe } = await supabase.from("budget_periods").select("id,month_start").eq("month_start", period).limit(1);
    if (pe) throw pe;
    const periodId = periods?.[0]?.id;
    let versions = [];
    if (periodId) {
      const { data, error } = await supabase.from("budget_versions").select("id,version_no,status,notes,created_at,activated_at").eq("budget_period_id", periodId).eq("budget_type", state.type).order("version_no", { ascending: false });
      if (error) throw error;
      versions = data || [];
    }
    versionEl.innerHTML = `<option value="">Select version</option>${versions.map(v=>`<option value="${v.id}">v${v.version_no} — ${v.status}</option>`).join("")}`;
    const active = versions.find(v=>v.status === "active") || versions[0];
    if (active) {
      versionEl.value = active.id;
      state.versionId = active.id;
      await loadVersion(active.id);
    } else {
      state.versionId = null; state.status = null; state.lines = [];
      renderBuilder();
    }
    statusEl.textContent = versions.length ? `${monthLabel(period)} · ${versions.length} version${versions.length===1?"":"s"}` : `${monthLabel(period)} · No budget created yet`;
  }

  async function loadVersion(id) {
    const { data: version, error: ve } = await supabase.from("budget_versions").select("id,version_no,status,notes,budget_type").eq("id", id).single();
    if (ve) throw ve;
    const { data: lines, error: le } = await supabase.from("budget_lines").select("id,item_id,category_id,description,quantity,rate,amount,sort_order").eq("budget_version_id", id).order("sort_order");
    if (le) throw le;
    state.versionId = id; state.status = version.status;
    state.lines = (lines || []).map(l=>({...l, quantity:num(l.quantity), rate:num(l.rate), amount:num(l.amount)}));
    renderBuilder(version);
  }

  function defaultRate(item) {
    return state.type === "purchase" ? num(item?.last_purchase_rate) : 0;
  }

  function renderBuilder(version = null) {
    const readOnly = state.status === "active" || state.status === "archived";
    const type = TYPES.find(t=>t.key===state.type);
    const isExpense = state.type === "expense";
    builder.innerHTML = `
      <div class="card">
        <div class="screen-head" style="margin-bottom:12px;">
          <div><h2>${type.label} Budget</h2><p>${type.description}</p></div>
          <div class="button-row">
            ${state.versionId && state.status === "draft" ? `<button class="btn" id="budget-add-line">+ Add line</button>` : ""}
            ${state.versionId && state.status === "draft" ? `<button class="btn btn-primary" id="budget-save">Save draft</button>` : ""}
            ${state.versionId && state.status === "draft" ? `<button class="btn" id="budget-activate">Activate</button>` : ""}
          </div>
        </div>
        ${!state.versionId ? `<div class="empty-state"><strong>No ${type.label.toLowerCase()} budget yet.</strong><p>Click New Draft to start.</p></div>` : `
          <div class="table-wrap"><table class="ledger"><thead><tr>
            <th>${isExpense ? "Category / Item" : "Item"}</th><th>Qty</th><th>Unit</th><th>Forecast Rate</th><th class="num">Budget</th><th></th>
          </tr></thead><tbody id="budget-lines"></tbody><tfoot><tr><th colspan="4">Total</th><th class="num" id="budget-total">${money(state.lines.reduce((s,l)=>s+num(l.quantity)*num(l.rate),0))}</th><th></th></tr></tfoot></table></div>
          <div class="form-grid" style="margin-top:14px;"><label>Version notes<textarea id="budget-notes" rows="2" ${readOnly?"disabled":""}>${esc(version?.notes || "")}</textarea></label></div>
          <p class="muted">${readOnly ? `This version is ${state.status}. Create a new draft to make changes.` : "Rates are forecast values only. Changing a forecast rate never changes the Item Master."}</p>
        `}
      </div>`;
    if (!state.versionId) return;
    const body = builder.querySelector("#budget-lines");
    body.innerHTML = state.lines.map((line, idx) => lineHtml(line, idx, readOnly)).join("") || `<tr><td colspan="6" class="muted">No lines yet. Add an item.</td></tr>`;
    if (!readOnly) wireEditableLines(body);
    const add = builder.querySelector("#budget-add-line");
    if (add) add.onclick = () => { state.lines.push({item_id:null,category_id:null,description:"",quantity:0,rate:0,sort_order:state.lines.length}); renderBuilder(version); };
    const save = builder.querySelector("#budget-save");
    if (save) save.onclick = saveDraft;
    const activate = builder.querySelector("#budget-activate");
    if (activate) activate.onclick = activateVersion;
  }

  function lineHtml(line, idx, readOnly) {
    const isExpense = state.type === "expense";
    const item = state.items.find(i=>i.id===line.item_id);
    const category = state.categories.find(c=>c.id===line.category_id);
    const target = isExpense ? `
      <div style="display:grid;gap:6px;">
        <select data-field="category" data-index="${idx}" ${readOnly?"disabled":""}>
          <option value="">Category (optional)</option>
          ${state.categories.map(c=>`<option value="${c.id}" ${line.category_id===c.id?"selected":""}>${esc(c.name)}</option>`).join("")}
        </select>
        <select data-field="item" data-index="${idx}" ${readOnly?"disabled":""}>
          <option value="">Item (optional)</option>
          ${state.items.map(i=>`<option value="${i.id}" ${line.item_id===i.id?"selected":""}>${esc(i.name)}</option>`).join("")}
        </select>
        ${line.category_id && line.item_id ? `<div class="muted">Category + item</div>` : ""}
      </div>` : `
      <select data-field="item" data-index="${idx}" ${readOnly?"disabled":""}>
        <option value="">Select item</option>
        ${state.items.map(i=>`<option value="${i.id}" ${line.item_id===i.id?"selected":""}>${esc(i.name)}</option>`).join("")}
      </select>`;
    return `<tr>
      <td>${target}${isExpense && line.item_id && category ? `<div class="muted">Category: ${esc(category.name)}</div>` : ""}</td>
      <td><input type="number" min="0" step="0.001" value="${line.quantity ?? 0}" data-field="quantity" data-index="${idx}" ${readOnly?"disabled":""}></td>
      <td>${esc(item?.unit || (line.item_id ? "" : "—"))}</td>
      <td><input type="number" min="0" step="0.01" value="${line.rate ?? 0}" data-field="rate" data-index="${idx}" ${readOnly?"disabled":""}></td>
      <td class="num">${money(num(line.quantity)*num(line.rate))}</td>
      <td>${readOnly?"":`<button class="btn btn-danger-outline" data-remove="${idx}">Remove</button>`}</td>
    </tr>`;
  }

  function wireEditableLines(body) {
    body.querySelectorAll("[data-field]").forEach(el => el.addEventListener("change", () => {
      const idx = Number(el.dataset.index); const line = state.lines[idx]; const field = el.dataset.field;
      if (field === "item") { line.item_id = el.value || null; const item=state.items.find(i=>i.id===line.item_id); if(state.type==='purchase' && line.rate===0) line.rate=defaultRate(item); }
      else if (field === "category") { line.category_id = el.value || null; }
      else if (field === "quantity") line.quantity=num(el.value);
      else if (field === "rate") line.rate=num(el.value);
      renderBuilder();
    }));
    body.querySelectorAll("[data-remove]").forEach(btn=>btn.addEventListener("click",()=>{state.lines.splice(Number(btn.dataset.remove),1);renderBuilder();}));
  }

  async function newDraft() {
    const type = typeEl.value; const month = monthStart(monthEl.value); const payload = state.lines.length ? state.lines.map((l,i)=>({...l,sort_order:i})) : [];
    const { data, error } = await supabase.rpc("create_budget_version", { p_month_start: month, p_budget_type:type, p_notes:null, p_lines:payload });
    if (error) throw error;
    await loadVersions();
    versionEl.value = data;
    await loadVersion(data);
  }

  async function saveDraft() {
    if (!state.versionId || state.status !== "draft") return;
    const notes = builder.querySelector("#budget-notes")?.value || null;
    const lines = state.lines.map((l,i)=>({item_id:l.item_id,category_id:l.category_id,description:l.description||null,quantity:num(l.quantity),rate:num(l.rate),sort_order:i}));
    const { error } = await supabase.rpc("replace_budget_version_lines", { p_version_id:state.versionId, p_lines:lines, p_notes:notes });
    if (error) throw error;
    await loadVersion(state.versionId);
    statusEl.textContent = "Draft saved.";
  }

  async function activateVersion() {
    if (!state.versionId || state.status !== "draft") return;
    await saveDraft();
    const { error } = await supabase.rpc("activate_budget_version", { p_version_id:state.versionId });
    if (error) throw error;
    await loadVersions();
    statusEl.textContent = "Budget version activated.";
  }

  screen.querySelector("#budget-new").onclick = () => newDraft().catch(e=>alert(e.message));
  screen.querySelector("#budget-refresh").onclick = () => loadVersions().catch(e=>alert(e.message));
  monthEl.onchange = () => loadVersions().catch(e=>alert(e.message));
  typeEl.onchange = () => loadVersions().catch(e=>alert(e.message));
  versionEl.onchange = () => { if(versionEl.value) loadVersion(versionEl.value).catch(e=>alert(e.message)); };

  await loadVersions();
}
