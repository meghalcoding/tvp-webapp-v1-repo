import { toast, confirmDialog, promptDialog, friendlyError, setButtonLoading } from "./ui.js";
import { supabase, IS_CONFIGURED } from "./supabase-client.js";
import { canDo } from "./auth.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const datalist = (id, options) => `<datalist id="${id}">${options.map(x=>`<option value="${esc(x.name)}"></option>`).join("")}</datalist>`;

export async function renderRelationshipMapsScreen(screen, user) {
  if (!IS_CONFIGURED) { screen.innerHTML = `<div class="placeholder-screen"><h2>Channel & Category Mapping</h2><p>Connect Supabase first.</p></div>`; return; }
  if (!user || !["owner","manager"].includes(user.role)) {
    screen.innerHTML = `<div class="placeholder-screen"><h2>Channel & Category Mapping</h2><p>Only Owner and Manager can manage these relationships.</p></div>`;
    return;
  }

  const [{data:channels,error:ce},{data:purchaseCategories,error:pe},{data:expenseCategories,error:ee},{data:items,error:ie},{data:expenseItems,error:eie}] = await Promise.all([
    supabase.from("sales_channels").select("id,key,name,active,display_order").eq("active",true).order("display_order"),
    supabase.from("purchase_categories").select("id,name,active,display_order").eq("active",true).order("display_order").order("name"),
    supabase.from("expense_categories").select("id,name,active").eq("active",true).order("name"),
    supabase.from("items").select("id,name,unit,active").eq("active",true).order("name"),
    supabase.from("expense_item_catalog").select("id,category_id,name,unit,default_rate,active").eq("active",true).order("name")
  ]);
  const err=[ce,pe,ee,ie,eie].find(Boolean); if(err) throw err;

  let mode="sales", selectedId=channels?.[0]?.id||null, search="";
  let selectedExpenseItems=expenseItems||[];

  screen.innerHTML=`
    <div class="screen-head"><div><h1>Channel & Category Mapping</h1><p>One relationship layer powers Sales, Purchases, Expenses and Budgeting.</p></div><button class="btn" id="rel-refresh">Refresh</button></div>
    <div class="card">
      <div class="button-row relationship-toolbar">
        <button class="btn rel-mode active" data-mode="sales">Sales Channel → Items</button>
        <button class="btn rel-mode" data-mode="purchase">Purchase Category → Items</button>
        <button class="btn rel-mode" data-mode="expense">Expense Category → Items</button>
      </div>
      <div class="form-grid">
        <div class="field"><label id="rel-target-label">Sales channel</label><input id="rel-target" list="rel-target-list" placeholder="Type to search…" autocomplete="off">${datalist("rel-target-list",channels||[])}</div>
        <div class="field"><label>Search items</label><input id="rel-item-search" placeholder="Type item name…" autocomplete="off"></div>
      </div>
      <div id="rel-summary" class="muted relationship-summary"></div>
      <div id="rel-list"></div>
    </div>
    <div id="expense-item-manager"></div>
  `;

  const targetInput=screen.querySelector("#rel-target"), searchInput=screen.querySelector("#rel-item-search"), list=screen.querySelector("#rel-list"), summary=screen.querySelector("#rel-summary");

  function targets(){return mode==="sales"?channels:mode==="purchase"?purchaseCategories:expenseCategories;}
  function targetName(){return targets()?.find(x=>x.id===selectedId)?.name||"";}

  async function loadMapped() {
    search=searchInput.value.trim().toLowerCase();
    if(!selectedId){list.innerHTML=`<p class="muted">Select a ${mode==="sales"?"sales channel":mode==="purchase"?"purchase category":"expense category"}.</p>`;return;}
    if(mode==="expense"){
      selectedExpenseItems=(expenseItems||[]).filter(x=>x.category_id===selectedId);
      renderExpenseItems();
      return;
    }
    const table=mode==="sales"?"sales_channel_items":"purchase_category_items";
    const fk=mode==="sales"?"sales_channel_id":"purchase_category_id";
    const {data,error}=await supabase.from(table).select("item_id,active").eq(fk,selectedId);
    if(error)throw error;
    const mapped=new Set((data||[]).filter(x=>x.active).map(x=>x.item_id));
    const visible=(items||[]).filter(i=>!search||i.name.toLowerCase().includes(search));
    summary.textContent=`${mapped.size} of ${items.length} items linked.`;
    list.innerHTML=`<div class="mapping-grid">${visible.map(i=>`<label class="mapping-row"><input type="checkbox" data-item-id="${i.id}" ${mapped.has(i.id)?"checked":""}><span><strong>${esc(i.name)}</strong><small>${esc(i.unit||"")}</small></span></label>`).join("")}</div>`;
    list.querySelectorAll("[data-item-id]").forEach(cb=>cb.addEventListener("change",()=>toggleItem(cb.dataset.itemId,cb.checked)));
  }

  async function toggleItem(itemId,enabled){
    const table=mode==="sales"?"sales_channel_items":"purchase_category_items";
    const fk=mode==="sales"?"sales_channel_id":"purchase_category_id";
    if(enabled){
      const payload={};payload[fk]=selectedId;payload.item_id=itemId;payload.active=true;
      const {error}=await supabase.from(table).upsert(payload,{onConflict:`${fk},item_id`}); if(error)throw error;
    }else{
      const {error}=await supabase.from(table).update({active:false}).eq(fk,selectedId).eq("item_id",itemId); if(error)throw error;
    }
    await loadMapped();
  }

  function renderExpenseItems(){
    const visible=selectedExpenseItems.filter(i=>!search||i.name.toLowerCase().includes(search));
    summary.textContent=`${selectedExpenseItems.length} expense items linked to ${targetName()}.`;
    list.innerHTML=`<div class="mapping-list">${visible.map(i=>`<div class="mapping-row"><span><strong>${esc(i.name)}</strong><small>${esc(i.unit||"")}${Number(i.default_rate)?` · ${money(i.default_rate)}`:""}</small></span><button class="btn btn-small btn-danger-outline" data-remove-exp="${i.id}">Remove</button></div>`).join("")||`<p class="muted">No linked expense items yet.</p>`}</div>
      <div class="card relationship-add-card"><div class="card-title">Add expense item to ${esc(targetName())}</div><div class="form-grid"><input id="new-exp-item-name" placeholder="e.g. Staff Salary"><input id="new-exp-item-unit" placeholder="Unit (optional)"><input id="new-exp-item-rate" type="number" min="0" step="0.01" placeholder="Default rate"></div><button class="btn btn-primary" id="add-exp-item">Add item</button></div>`;
    list.querySelectorAll("[data-remove-exp]").forEach(b=>b.addEventListener("click",()=>removeExpenseItem(b.dataset.removeExp)));
    list.querySelector("#add-exp-item")?.addEventListener("click",addExpenseItem);
  }

  async function addExpenseItem(){
    const name=screen.querySelector("#new-exp-item-name")?.value.trim();
    const unit=screen.querySelector("#new-exp-item-unit")?.value.trim()||null;
    const rate=Number(screen.querySelector("#new-exp-item-rate")?.value||0);
    if(!name){toast(friendlyError("Enter an expense item name."),{type:"error"});return;}
    const {data,error}=await supabase.from("expense_item_catalog").insert({category_id:selectedId,name,unit,default_rate:rate,active:true}).select("id,category_id,name,unit,default_rate,active").single();
    if(error)throw error;
    expenseItems.push(data); selectedExpenseItems.push(data); await loadMapped();
  }

  async function removeExpenseItem(id){
    const {error}=await supabase.from("expense_item_catalog").update({active:false}).eq("id",id); if(error)throw error;
    const x=expenseItems.find(i=>i.id===id); if(x)x.active=false;
    await loadMapped();
  }

  function setMode(next){
    mode=next; selectedId=targets()?.[0]?.id||null; searchInput.value=""; targetInput.value=targetName();
    screen.querySelectorAll(".rel-mode").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));
    screen.querySelector("#rel-target-label").textContent=mode==="sales"?"Sales channel":mode==="purchase"?"Purchase category":"Expense category";
    targetInput.setAttribute("list","rel-target-list");
    const listId="rel-target-list"; const opts=targets()||[];
    let dl=screen.querySelector("#"+listId); if(dl)dl.outerHTML=datalist(listId,opts);
    loadMapped().catch(e=>toast(friendlyError(e.message),{type:"error"}));
  }

  targetInput.addEventListener("change",()=>{const x=targets()?.find(t=>t.name.toLowerCase()===targetInput.value.trim().toLowerCase());if(!x){targetInput.value=targetName();return;}selectedId=x.id;loadMapped().catch(e=>toast(friendlyError(e.message),{type:"error"}));});
  searchInput.addEventListener("input",()=>loadMapped().catch(e=>toast(friendlyError(e.message),{type:"error"})));
  screen.querySelectorAll(".rel-mode").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.mode)));
  screen.querySelector("#rel-refresh").onclick=()=>renderRelationshipMapsScreen(screen,user).catch(e=>toast(friendlyError(e.message),{type:"error"}));

  await loadMapped();
}

const money = (n) => `₹${Number(n||0).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
