import { supabase, IS_CONFIGURED } from "./supabase-client.js";
import { canDo } from "./auth.js";
import { withOfflineFallback } from "./offline-queue.js";
import { createHistoryController, fetchTransactionPage, HISTORY_INITIAL_LIMIT } from "./paginated-history.js";
import { decorateDocumentCells, openDocumentModal, uploadDocument } from "./documents.js";
import { loadMasterRelations } from "./master-relations.js";
import { openDocumentOcrReview } from "./document-ocr.js";

const today=()=>{const d=new Date();d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,10);};
const money=n=>`₹${Number(n||0).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const esc=(v="")=>String(v).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const noConfig=()=>`<div class="placeholder-screen"><h2>Connect Supabase first</h2><p>Configure <code>js/config.js</code>, then run the Phase 4 procurement/inventory migration and the current feature migrations.</p></div>`;
const state=(el,text,bad=false)=>{el.textContent=text;el.className=`form-status ${bad?"error":"success"}`;};
const postOutboxSafe=async(kind,payload,rpcName)=>withOfflineFallback(kind,payload,async(entry)=>{const {error}=await supabase.rpc(rpcName,entry);if(error)throw error;});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form?.id !== "wastage-form") return;
  event.preventDefault(); event.stopImmediatePropagation();
  const data = new FormData(form); const feedback = form.querySelector(".form-status");
  const payload = { p_client_uuid: crypto.randomUUID(), p_item_id: data.get("item"), p_quantity: Number(data.get("quantity")), p_reason: data.get("reason"), p_txn_date: data.get("date"), p_description: data.get("note").trim() || null };
  state(feedback, navigator.onLine ? "Recording wastage…" : "Wastage queued for sync.");
  try { await postOutboxSafe("wastage", payload, "record_wastage_idempotent"); }
  catch (error) { state(feedback, error.message, true); return; }
  if (navigator.onLine) form.reset();
}, true);

async function masters(includeInactive=false){
  const itemQuery=supabase.from("items").select("id,name,unit,gst_rate,reorder_level,last_purchase_rate,master_rate,active").order("name");
  const supplierQuery=supabase.from("suppliers").select("id,name,phone,email,contact_person,address,gstin,active").order("name");
  if(!includeInactive){ itemQuery.eq("active",true); supplierQuery.eq("active",true); }
  const [{data:items,error:ierr},{data:suppliers,error:serr},{data:accounts,error:aerr}]=await Promise.all([
    itemQuery, supplierQuery, supabase.from("accounts").select("id,name,type").eq("active",true).order("name")
  ]);
  if(ierr||serr||aerr)throw ierr||serr||aerr;
  return{items:items||[],suppliers:suppliers||[],accounts:accounts||[]};
}
const optionRows=(rows,label=x=>x.name)=>rows.map(x=>`<option value="${x.id}">${esc(label(x))}</option>`).join("");
const roundMoney=n=>Math.round((Number(n)||0)*100)/100;
const itemRate=i=>{const master=Number(i?.master_rate); if(Number.isFinite(master)&&master>=0)return master; const last=Number(i?.last_purchase_rate); return Number.isFinite(last)&&last>=0?last:0;};

export async function renderPurchasesScreen(screen,user){
  if(!IS_CONFIGURED){screen.innerHTML=noConfig();return;}
  const {items,suppliers,accounts}=await masters();
  const masterRelations=await loadMasterRelations();
  const purchases=await fetchTransactionPage({type:"purchase",select:"id,txn_date,amount,description,created_at,purchase_details(supplier_id,paid_amount),purchase_items(id)",limit:HISTORY_INITIAL_LIMIT});
  const supplierName=new Map(suppliers.map(x=>[x.id,x.name]));
  const allowed=canDo(user,"record_purchase");
  const tastySupplier=suppliers.find(s=>/tasty\s*vada\s*pav/i.test(s.name));
  let currentMode="standard";
  let currentTemplate=[];

  screen.innerHTML=`<div class="screen-head"><div><h1>Purchases</h1><p>Itemized purchases add stock automatically; unpaid value remains in supplier dues.</p></div></div>${allowed?`<div class="card"><div class="card-title">New purchase</div><form id="purchase-form"><div class="form-grid"><div class="field"><label>Supplier</label><select name="supplier_id" required><option value="">Choose supplier</option>${optionRows(suppliers)}</select></div><div class="field"><label>Payment</label><select name="paid_from_account_id"><option value="">Unpaid — add to supplier dues</option>${optionRows(accounts.filter(a=>["cash","bank","collection_account"].includes(a.type)))}</select></div><div class="field"><label>Date</label><input name="txn_date" type="date" value="${today()}" required></div><div class="field"><label>Bill note (optional)</label><input name="description" maxlength="500"></div><div class="field"><label>Document type</label><select name="document_type"><option value="invoice">Invoice</option><option value="receipt">Receipt</option><option value="bill">Bill</option><option value="other">Other</option></select></div><div class="field"><label>Invoice / receipt (optional)</label><input name="document_file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"><button type="button" class="btn btn-small document-ocr-button hidden" id="purchase-ocr-button">Extract from document</button><small>PDF/JPG/PNG/WEBP · max 10 MB. You can attach it later from Recent purchases.</small></div></div><div id="purchase-mode-note"></div><div class="card-title">Purchase items</div><div id="purchase-lines" class="line-items"></div><div id="purchase-order-summary"></div><button type="button" class="btn btn-small" id="add-purchase-line">+ Add item</button><p class="purchase-total">Purchase total: <strong id="purchase-total">₹0.00</strong></p><div class="form-status"></div><button class="btn btn-primary">Record purchase</button></form></div>`:""}<div class="card table-wrap"><div class="card-title">Recent purchases</div><table class="ledger"><thead><tr><th>Date</th><th>Supplier</th><th>Items</th><th>Payment</th><th>Note</th><th class="num">Total</th><th>Document</th><th></th></tr></thead><tbody id="purchases-history-body"></tbody></table><div class="history-controls" id="purchases-history-controls"></div></div>`;

  const renderHistoryRow=p=>{
    const d=Array.isArray(p.purchase_details)?p.purchase_details[0]:p.purchase_details;
    const isTasty=!!tastySupplier && d?.supplier_id===tastySupplier.id;
    return `<tr><td>${esc(p.txn_date)}</td><td>${esc(supplierName.get(d?.supplier_id)||"—")}</td><td>${p.purchase_items?.length||0}</td><td>${Number(d?.paid_amount||0)>0?'<span class="stamp paid">Paid</span>':'<span class="stamp unpaid">Unpaid</span>'}</td><td>${esc(p.description||"—")}</td><td class="num">${money(p.amount)}</td><td data-document-cell="${p.id}"></td><td>${isTasty?`<button type="button" class="btn btn-small franchise-order-image" data-txn-id="${p.id}" data-date="${esc(p.txn_date)}" data-supplier-id="${esc(d?.supplier_id||"")}">Order image</button>`:""}</td></tr>`;
  };
  createHistoryController({tbody:screen.querySelector("#purchases-history-body"),controls:screen.querySelector("#purchases-history-controls"),type:"purchase",select:"id,txn_date,amount,description,created_at,purchase_details(supplier_id,paid_amount),purchase_items(id)",initialRows:purchases,colspan:8,renderRow:renderHistoryRow,onRender:async(rows)=>{try{await decorateDocumentCells(screen,rows.map(r=>r.id),canDo(user,"record_purchase"));}catch(error){console.error("Document status load failed",error);}}});

  const host=screen.querySelector("#purchase-lines");
  const summaryHost=screen.querySelector("#purchase-order-summary");
  const modeNote=screen.querySelector("#purchase-mode-note");
  const addButton=screen.querySelector("#add-purchase-line");
  const form=screen.querySelector("#purchase-form");
  if(!form)return;

  const roundMoney=n=>Math.round((Number(n)||0)*100)/100;
  const calcLine=(row)=>{
    const s=row._purchaseState;if(!s)return{base:0,gst:0,total:0};
    const base=roundMoney(Number(s.quantity||0)*Number(s.rate||0));
    const gst=roundMoney(base*Number(s.gstRate||0)/100);
    const total=roundMoney(base+gst);
    row.querySelector("[data-gst-amount]").textContent=`GST ${money(gst)}`;
    row.querySelector("[data-line-total]").textContent=money(total);
    row.querySelector(".rate-warning")?.classList.toggle("hidden",!s.rateOverridden);
    row.querySelector(".gst-warning")?.classList.toggle("hidden",!s.gstOverridden);
    return{base,gst,total};
  };
  const calc=()=>{
    const total=[...host.querySelectorAll(".purchase-line")].reduce((sum,row)=>sum+calcLine(row).total,0);
    screen.querySelector("#purchase-total").textContent=money(total);
    if(currentMode==="tasty"){
      const lines=[...host.querySelectorAll(".purchase-line")].filter(r=>Number(r._purchaseState?.quantity||0)>0&&r._purchaseState?.itemId);
      if(lines.length){
        const summaryRows=lines.map(r=>{const s=r._purchaseState;return `<div><span>${esc(s.displayName)}</span><span>${s.quantity} ${esc(s.unit||"")}</span></div>`;}).join("");
        summaryHost.innerHTML=`<div class="franchise-order-summary"><strong>Order overview</strong>${summaryRows}</div>`;
      }else summaryHost.innerHTML="<div class=\"franchise-order-summary muted\">Enter quantities for the items you want to order. Blank quantities will not be recorded.</div>";
    }else summaryHost.innerHTML="";
  };
  const syncInputLock=(input,button,label,locked)=>{
    input.disabled=locked;
    input.readOnly=locked;
    input.dataset.locked=String(locked);
    input.classList.toggle("is-editable",!locked);
    button.textContent=locked?`Modify ${label}`:`Lock ${label}`;
    button.setAttribute("aria-pressed",String(!locked));
  };
  const syncRow=row=>{
    const s=row._purchaseState;if(!s)return;
    const rate=row.querySelector("[data-rate]"),gst=row.querySelector("[data-gst-rate]"),qty=row.querySelector("[data-qty]");
    if(rate)rate.value=s.rate===""?"":String(s.rate);
    if(gst)gst.value=s.gstRate===""?"":String(s.gstRate);
    if(qty)qty.value=s.quantity===""?"":String(s.quantity);
    if(rate)syncInputLock(rate,row.querySelector(".rate-modify"),"Rate",s.rateLocked);
    if(gst)syncInputLock(gst,row.querySelector(".gst-modify"),"GST",s.gstLocked);
    calcLine(row);calc();
  };

  const attachRowEvents=(row)=>{
    const item=row.querySelector("[data-item]"),search=row.querySelector("[data-item-search]"),qty=row.querySelector("[data-qty]"),rate=row.querySelector("[data-rate]"),gst=row.querySelector("[data-gst-rate]"),rateBtn=row.querySelector(".rate-modify"),gstBtn=row.querySelector(".gst-modify");
    if(search)search.addEventListener("input",()=>{const q=search.value.toLowerCase();[...item.options].forEach(o=>{if(!o.value)return;o.hidden=!o.text.toLowerCase().includes(q);});});
    if(item)item.addEventListener("change",()=>{
      const o=item.selectedOptions[0],s=row._purchaseState;
      s.itemId=o?.value||"";if(search)search.value=o?.textContent?.trim()||"";s.displayName=o?.dataset.displayName||o?.textContent?.trim()||"";s.unit=o?.dataset.unit||"";
      s.masterRate=o?.value?Number(o.dataset.masterRate||0):null;s.masterGstRate=o?.value?Number(o.dataset.masterGst||0):null;s.rate=o?.value?s.masterRate:"";s.gstRate=o?.value?s.masterGstRate:"";s.rateOverridden=false;s.gstOverridden=false;s.rateLocked=true;s.gstLocked=true;syncRow(row);
    });
    qty.addEventListener("input",()=>{row._purchaseState.quantity=qty.value===""?"":Number(qty.value);calc();});
    rate.addEventListener("input",()=>{const s=row._purchaseState;s.rate=rate.value===""?"":Number(rate.value);s.rateOverridden=s.masterRate!==null&&s.rate!==""&&Number(s.rate)!==Number(s.masterRate);calc();});
    gst.addEventListener("input",()=>{const s=row._purchaseState;s.gstRate=gst.value===""?"":Number(gst.value);s.gstOverridden=s.masterGstRate!==null&&s.gstRate!==""&&Number(s.gstRate)!==Number(s.masterGstRate);calc();});
    rateBtn.addEventListener("click",()=>{const s=row._purchaseState;s.rateLocked=!s.rateLocked;syncRow(row);if(!s.rateLocked)requestAnimationFrame(()=>{rate.focus();rate.select();});});
    gstBtn.addEventListener("click",()=>{const s=row._purchaseState;s.gstLocked=!s.gstLocked;syncRow(row);if(!s.gstLocked)requestAnimationFrame(()=>{gst.focus();gst.select();});});
    row.querySelector(".remove-item")?.addEventListener("click",()=>{row.remove();calc();});
  };

  const makeStandardRow=()=>{
    const row=document.createElement("div");row.className="purchase-line line-item-row";
    row.innerHTML=`<div class="search-picker"><input data-item-search placeholder="Search item…" autocomplete="off"><select data-item required><option value="">Item</option>${items.map(i=>`<option value="${i.id}" data-master-rate="${Number(i.master_rate??0)}" data-master-gst="${Number(i.gst_rate??0)}" data-unit="${esc(i.unit)}">${esc(i.name)} (${esc(i.unit)})</option>`).join("")}</select></div><input data-qty type="number" min="0.001" step="0.001" placeholder="Qty" required><div class="rate-wrap"><input data-rate type="number" min="0" step="0.01" placeholder="Rate" required disabled><button type="button" class="rate-modify btn btn-small">Modify Rate</button><span class="rate-warning hidden">Rate differs from master</span></div><div class="gst-wrap"><input data-gst-rate type="number" min="0" max="100" step="0.01" placeholder="GST %" required disabled><button type="button" class="gst-modify btn btn-small">Modify GST</button><span class="gst-warning hidden">GST differs from master</span></div><output data-gst-amount>GST ₹0.00</output><output data-line-total>₹0.00</output><button type="button" class="btn btn-small remove-item">×</button>`;
    row._purchaseState={itemId:"",displayName:"",unit:"",quantity:"",masterRate:null,rate:"",rateLocked:true,rateOverridden:false,masterGstRate:null,gstRate:"",gstLocked:true,gstOverridden:false};
    attachRowEvents(row);host.append(row);return row;
  };

  const loadSupplierMode=async supplierId=>{
    currentTemplate=[];currentMode="standard";host.innerHTML="";summaryHost.innerHTML="";modeNote.innerHTML="";addButton.style.display="";
    if(!supplierId){makeStandardRow();calc();return;}
    const links=(masterRelations.supplierPurchase||[]).filter(x=>x.supplier_id===supplierId);
    const fixed=links.filter(x=>x.is_fixed);
    const categoryId=(fixed[0]||links[0])?.purchase_category_id;
    if(categoryId){
      const category=masterRelations.purchaseCategories.find(c=>c.id===categoryId);
      const linkedIds=new Set((masterRelations.purchaseMap||[]).filter(x=>x.purchase_category_id===categoryId&&x.active!==false).map(x=>x.item_id));
      const categoryItems=masterRelations.items.filter(i=>linkedIds.has(i.id));
      if(categoryItems.length){
        currentMode='tasty'; addButton.style.display='none';
        modeNote.innerHTML=`<div class="franchise-order-banner"><strong>${esc(category?.name||'Category')} purchase</strong><span>Enter only the quantities you are ordering today. Blank quantities will not be recorded.</span></div>`;
        categoryItems.forEach((item)=>makeTastyRow({id:item.id,display_name:item.name,abbreviation:'',items:item},0));calc();return;
      }
    }
    const supplierItemIds=new Set(links.flatMap(x=>[...itemIdsForPurchaseCategory(masterRelations,x.purchase_category_id)]));
    const allowedItems=items.filter(i=>supplierItemIds.has(i.id));
    makeStandardRow();
    // Replace the standard row's item list with supplier/category-scoped items when available.
    const select=host.querySelector('[data-item]');
    if(select && allowedItems.length) select.innerHTML=`<option value="">Item</option>${allowedItems.map(i=>`<option value="${i.id}" data-master-rate="${Number(i.master_rate??0)}" data-master-gst="${Number(i.gst_rate??0)}" data-unit="${esc(i.unit)}">${esc(i.name)} (${esc(i.unit)})</option>`).join('')}`;
    calc();
  };

  const purchaseFileInput = screen.querySelector('[name="document_file"]');
  const purchaseOcrButton = screen.querySelector("#purchase-ocr-button");
  purchaseFileInput?.addEventListener("change", () => { purchaseOcrButton?.classList.toggle("hidden", !purchaseFileInput.files?.[0]); });
  purchaseOcrButton?.addEventListener("click", () => {
    const file = purchaseFileInput?.files?.[0]; if (!file) return;
    openDocumentOcrReview({ screen, file, mode: "purchase", items, suppliers, onApply: result => {
      if (result.date) form.elements.txn_date.value = result.date;
      const applyRows = () => {
        const rowsNow = [...host.querySelectorAll(".purchase-line")];
        result.items.forEach((x, index) => {
          let row = rowsNow.find(r => r._purchaseState?.itemId === x.item.id);
          if (!row && currentMode === "standard") row = makeStandardRow();
          if (!row) return;
          const s = row._purchaseState;
          s.itemId = x.item.id; s.displayName = x.item.name; s.unit = x.item.unit; s.masterRate = Number(x.item.master_rate ?? 0); s.masterGstRate = Number(x.item.gst_rate ?? 0);
          s.quantity = x.quantity ?? "";
          s.rate = x.useRate && x.rate != null ? x.rate : s.masterRate; s.rateLocked = !(x.useRate && x.rate != null); s.rateOverridden = Number(s.rate) !== Number(s.masterRate);
          s.gstRate = x.useGst && x.gstRate != null ? x.gstRate : s.masterGstRate; s.gstLocked = !(x.useGst && x.gstRate != null); s.gstOverridden = Number(s.gstRate) !== Number(s.masterGstRate);
          if (currentMode === "standard") { const select = row.querySelector("[data-item]"); if (select) select.value = x.item.id; }
          syncRow(row);
        });
        calc();
      };
      if (result.supplierId) {
        form.elements.supplier_id.value = result.supplierId;
        loadSupplierMode(result.supplierId).then(applyRows).catch(err => state(form.querySelector(".form-status"), err.message, true));
      } else applyRows();
    }});
  });

  screen.querySelector('[name="supplier_id"]')?.addEventListener("change",async e=>{
    try{await loadSupplierMode(e.currentTarget.value);}catch(err){state(form.querySelector(".form-status"),err.message,true);}
  });
  addButton?.addEventListener("click",makeStandardRow);
  loadSupplierMode(form.elements.supplier_id.value).catch(err=>state(form.querySelector(".form-status"),err.message,true));

  const drawOrderImage=async (txnId,txnDate,supplierId)=>{
    const {data,error}=await supabase.from("purchase_items").select("quantity,item_id,items(name,unit)").eq("transaction_id",txnId).order("id");
    if(error)throw error;
    const rows=(data||[]).map(x=>({item:x.items?.name||"Item",abbr:"",qty:x.quantity,unit:x.items?.unit||""}));
    const width=900,rowH=52,headerH=170,height=headerH+Math.max(1,rows.length)*rowH+40;
    const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const c=canvas.getContext("2d");
    c.fillStyle="#ffffff";c.fillRect(0,0,width,height);c.strokeStyle="#241C14";c.lineWidth=2;c.strokeRect(10,10,width-20,height-20);
    const supplierLabel=supplierName.get(supplierId)||"Tasty Vadapav";
    const displayDate=new Date(`${txnDate}T00:00:00`).toLocaleDateString("en-IN");
    c.fillStyle="#241C14";c.textAlign="center";c.font="700 34px Segoe UI, Arial";c.fillText("To buy from Franchise Owner",width/2,58);c.font="500 18px Segoe UI, Arial";c.fillText(`Supplier: ${supplierLabel}`,width/2,92);c.fillText(`Order date: ${displayDate}`,width/2,122);
    const y0=145;c.textAlign="left";c.font="700 18px Segoe UI, Arial";c.fillText("Item",30,y0);c.fillText("Abbreviation",510,y0);c.fillText("Qty",720,y0);c.beginPath();c.moveTo(20,y0+12);c.lineTo(880,y0+12);c.stroke();
    c.font="500 20px Segoe UI, Arial";rows.forEach((r,i)=>{const y=y0+42+i*rowH;c.fillText(r.item,30,y);c.fillText(r.abbr,510,y);c.textAlign="right";c.fillText(`${r.qty}${r.unit?` ${r.unit}`:""}`,850,y);c.textAlign="left";c.beginPath();c.moveTo(20,y+15);c.lineTo(880,y+15);c.stroke();});
    const a=document.createElement("a");a.download=`Tasty_Vadapav_Order_${txnDate}.png`;a.href=canvas.toDataURL("image/png");a.click();
  };
  screen.addEventListener("click",async e=>{
    const orderButton=e.target.closest(".franchise-order-image");
    if(orderButton){try{orderButton.disabled=true;orderButton.textContent="Preparing…";await drawOrderImage(orderButton.dataset.txnId,orderButton.dataset.date,orderButton.dataset.supplierId);}catch(err){alert(err.message);}finally{orderButton.disabled=false;orderButton.textContent="Order image";}return;}
    const documentButton=e.target.closest(".document-attach");
    if(documentButton){const detail=[...purchases].find(x=>x.id===documentButton.dataset.txnId)?.purchase_details;const d=Array.isArray(detail)?detail[0]:detail;await openDocumentModal({screen,transactionId:documentButton.dataset.txnId,supplierId:d?.supplier_id||null,user,onDone:async()=>{try{await decorateDocumentCells(screen,[documentButton.dataset.txnId],canDo(user,"record_purchase"));}catch(error){console.error(error);}}});}
  });

  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form),feedback=form.querySelector(".form-status");
    const rows=[...host.querySelectorAll(".purchase-line")];
    const activeRows=rows.filter(r=>currentMode!=="tasty"||Number(r._purchaseState?.quantity||0)>0);
    if(currentMode==="tasty"&&activeRows.some(r=>!r._purchaseState.itemId)){state(feedback,"One or more selected order items still need item setup. Map them before entering a quantity.",true);return;}
    const lines=activeRows.map(row=>{const s=row._purchaseState;return{item_id:s.itemId,quantity:Number(s.quantity),rate:Number(s.rate),gst_rate:Number(s.gstRate),master_rate_at_entry:Number(s.masterRate??0),master_gst_rate_at_entry:Number(s.masterGstRate??0),rate_overridden:Boolean(s.rateOverridden),gst_rate_overridden:Boolean(s.gstOverridden)};});
    if(!lines.length||lines.some(x=>!x.item_id||!Number.isFinite(x.quantity)||x.quantity<=0||!Number.isFinite(x.rate)||x.rate<0||!Number.isFinite(x.gst_rate)||x.gst_rate<0||x.gst_rate>100)){state(feedback,"Add at least one item with a valid quantity, rate, and GST percentage (0–100%).",true);return;}
    const rateOverrides=activeRows.map((row,i)=>({line:lines[i],master:Number(row._purchaseState.masterRate),actual:Number(lines[i].rate)})).filter(x=>x.actual!==x.master);
    const gstOverrides=activeRows.map((row,i)=>({line:lines[i],master:Number(row._purchaseState.masterGstRate),actual:Number(lines[i].gst_rate)})).filter(x=>x.actual!==x.master);
    let updateMasterRates=false,updateMasterGstRates=false;
    if(rateOverrides.length&&user.role==="owner")updateMasterRates=window.confirm(`Some purchase rates differ from the master rate.\n\nOK = update master rate(s) from now onward.\nCancel = use the changed rate(s) for this purchase only.`);
    if(gstOverrides.length&&user.role==="owner")updateMasterGstRates=window.confirm(`Some GST rates differ from the master GST rate.\n\nOK = update master GST rate(s) from now onward.\nCancel = use the changed GST rate(s) for this purchase only.`);
    if((rateOverrides.length||gstOverrides.length)&&user.role!=="owner")window.alert("Changed rates/GST percentages will apply to this purchase only. Only the Owner can update master values.");
    state(feedback,"Recording purchase…");
    const documentFile=fd.get("document_file");
    if(documentFile?.size&&!navigator.onLine){state(feedback,"Document uploads require an internet connection. Remove the file or reconnect before recording this purchase.",true);return;}
    const {data:txnId,error}=await supabase.rpc("create_purchase_with_master_rate_updates",{p_supplier_id:fd.get("supplier_id"),p_paid_from_account_id:fd.get("paid_from_account_id")||null,p_txn_date:fd.get("txn_date"),p_description:fd.get("description").trim()||null,p_items:lines,p_update_master_rates:updateMasterRates,p_update_master_gst_rates:updateMasterGstRates});
    if(error){state(feedback,error.message,true);return;}
    if(documentFile?.size){
      try{state(feedback,"Purchase recorded. Uploading invoice/receipt…");await uploadDocument({file:documentFile,documentType:fd.get("document_type")||"invoice",supplierId:fd.get("supplier_id"),documentDate:fd.get("txn_date"),transactionIds:[txnId]});}
      catch(documentError){state(feedback,`Purchase recorded, but the document could not be attached: ${documentError.message}`,true);}
    }
    if(currentMode==="tasty"){await drawOrderImage(txnId,fd.get("txn_date"),fd.get("supplier_id"));await renderPurchasesScreen(screen,user);}
    else await renderPurchasesScreen(screen,user);
  });
}

export async function renderInventoryScreen(screen,user){
  if(!IS_CONFIGURED){screen.innerHTML=noConfig();return;}const {items}=await masters();const {data:stock,error}=await supabase.from("current_stock").select("*").order("name");if(error)throw error;const owner=canDo(user,"edit_masters"),adjust=canDo(user,"stock_adjustment");
  screen.innerHTML=`<div class="screen-head"><div><h1>Inventory</h1><p>Stock is movement-based. Value uses the latest purchase rate for each ingredient.</p></div>${owner?'<button class="btn btn-primary" id="new-item">+ New item</button>':''}</div><div class="card table-wrap"><table class="ledger"><thead><tr><th>Item</th><th>Unit</th><th class="num">Stock</th><th class="num">Master rate</th><th class="num">Last rate</th><th class="num">Value</th><th>Reorder</th><th></th></tr></thead><tbody>${(stock||[]).map(s=>{const master=items.find(i=>i.id===s.item_id);const low=Number(s.quantity)<=Number(s.reorder_level);return`<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(s.unit)}</td><td class="num ${low?"negative":""}">${Number(s.quantity).toLocaleString("en-IN")}</td><td class="num">${money(itemRate(master))}</td><td class="num">${money(s.last_purchase_rate)}</td><td class="num">${money(s.stock_value)}</td><td>${low?'<span class="stamp pending">Low</span>':'<span class="stamp settled">OK</span>'}</td><td><button class="btn btn-small item-stock" data-id="${s.item_id}">Ledger</button>${owner?` <button class="btn btn-small edit-item" data-id="${s.item_id}">Edit</button>`:""}${adjust?` <button class="btn btn-small adjust-stock" data-id="${s.item_id}">Adjust</button>`:""}</td></tr>`;}).join("")||'<tr><td colspan="8">No inventory items yet.</td></tr>'}</tbody></table></div><div id="inventory-modal"></div>`;
  screen.querySelectorAll(".item-stock").forEach(b=>b.addEventListener("click",()=>stockLedger(screen,b.dataset.id,items)));screen.querySelectorAll(".adjust-stock").forEach(b=>b.addEventListener("click",()=>stockAdjustment(screen,user,b.dataset.id,items)));screen.querySelectorAll(".edit-item").forEach(b=>b.addEventListener("click",()=>itemForm(screen,user,items.find(i=>i.id===b.dataset.id))));screen.querySelector("#new-item")?.addEventListener("click",()=>itemForm(screen,user));
}

export async function renderItemMasterScreen(screen,user){
  if(!IS_CONFIGURED){screen.innerHTML=noConfig();return;}
  if(!canDo(user,"edit_masters")){screen.innerHTML='<div class="placeholder-screen"><h2>Owner access required</h2><p>Only the Owner can manage item masters.</p></div>';return;}
  const {data,error}=await supabase.from("items").select("id,name,unit,gst_rate,reorder_level,last_purchase_rate,master_rate,active,created_at").order("active",{ascending:false}).order("name");
  if(error)throw error;
  const rel=await loadMasterRelations();
  const categoryNames=(item,type)=>{const ids=type==='purchase'?(rel.purchaseMap||[]).filter(x=>x.item_id===item.id).map(x=>x.purchase_category_id):(rel.expenseMap||[]).filter(x=>x.item_id===item.id).map(x=>x.expense_category_id);const source=type==='purchase'?rel.purchaseCategories:rel.expenseCategories;return ids.map(id=>source.find(x=>x.id===id)?.name).filter(Boolean).join(', ')};
  screen.innerHTML=`<div class="screen-head"><div><h1>Items</h1><p>One fundamental item master powers Purchase, Expense and Inventory. Sales menu items will remain a separate future model.</p></div><button class="btn btn-primary" id="new-master-item">+ New item</button></div><div class="card table-wrap"><table class="ledger"><thead><tr><th>Item</th><th>Purchase</th><th>Expense</th><th>Unit</th><th class="num">Master rate</th><th class="num">GST</th><th>Status</th><th></th></tr></thead><tbody>${(data||[]).map(i=>`<tr><td><strong>${esc(i.name)}</strong></td><td>${esc(categoryNames(i,'purchase')||'—')}</td><td>${esc(categoryNames(i,'expense')||'—')}</td><td>${esc(i.unit)}</td><td class="num">${money(i.master_rate)}</td><td class="num">${Number(i.gst_rate||0)}%</td><td>${i.active?'<span class="stamp settled">Active</span>':'<span class="stamp pending">Inactive</span>'}</td><td><button class="btn btn-small edit-master-item" data-id="${i.id}">Edit</button><button class="btn btn-small rate-history" data-id="${i.id}">Rate history</button></td></tr>`).join("")||'<tr><td colspan="8">No items yet.</td></tr>'}</tbody></table></div><div id="item-master-modal"></div>`;
  const byId=new Map((data||[]).map(i=>[i.id,i]));
  screen.querySelector("#new-master-item")?.addEventListener("click",()=>itemMasterForm(screen,user));
  screen.querySelectorAll(".edit-master-item").forEach(b=>b.addEventListener("click",()=>itemMasterForm(screen,user,byId.get(b.dataset.id))));
  screen.querySelectorAll(".rate-history").forEach(b=>b.addEventListener("click",()=>showRateHistory(screen,b.dataset.id,byId.get(b.dataset.id))));
}

function itemMasterForm(screen,user,item=null,draft=null){
  const mount=screen.querySelector("#item-master-modal");
  loadMasterRelations().then(rel=>{
    const purchaseSelected=new Set(draft?.purchase_category_ids || (rel.purchaseMap||[]).filter(x=>x.item_id===item?.id).map(x=>x.purchase_category_id));
    const expenseSelected=new Set(draft?.expense_category_ids || (rel.expenseMap||[]).filter(x=>x.item_id===item?.id).map(x=>x.expense_category_id));
    const linkDropdown=(key,title,options,selected,name)=>`<details class="link-dropdown" ${selected.size?'open':''}><summary>${esc(title)} <span class="link-count">${selected.size?`${selected.size} selected`:"Choose…"}</span></summary><div class="link-dropdown-menu"><div class="link-dropdown-search"><input type="search" placeholder="Search ${esc(title.toLowerCase())}…" data-link-search="${key}" autocomplete="off"></div><div class="link-check-list" data-link-list="${key}">${options.map(o=>`<label class="check-label link-option" data-label="${esc(o.name.toLowerCase())}"><input type="checkbox" name="${name}" value="${o.id}" ${selected.has(o.id)?"checked":""}> ${esc(o.name)}</label>`).join("")||'<span class="muted">No options yet.</span>'}<button type="button" class="btn btn-small add-inline-category" data-category-type="${key}">+ Add new Category</button></div></div></details>`;
    const values=draft||{};
    mount.innerHTML=`<div class="modal-backdrop"><form class="modal-card" id="item-master-form"><button type="button" class="modal-close">×</button><h2>${item?"Edit item":"New item"}</h2><div class="field"><label>Name</label><input name="name" maxlength="120" required value="${esc(values.name??item?.name??"")}"></div><div class="form-grid"><div class="field"><label>Unit</label><input name="unit" required value="${esc(values.unit??item?.unit??"")}" placeholder="kg, pack, nos"></div><div class="field"><label>Master rate</label><input name="master_rate" type="number" min="0" step="0.01" required value="${values.master_rate??Number(item?.master_rate||0)}"></div><div class="field"><label>GST %</label><input name="gst" type="number" min="0" max="100" step="0.01" required value="${values.gst??Number(item?.gst_rate||0)}"></div><div class="field"><label>Reorder level</label><input name="reorder" type="number" min="0" step="0.001" value="${values.reorder??Number(item?.reorder_level||0)}"></div>${item?`<div class="field"><label>Status</label><select name="active"><option value="true" ${item.active?"selected":""}>Active</option><option value="false" ${!item.active?"selected":""}>Inactive</option></select></div>`:""}</div><div class="relationship-section"><h3>Link To</h3><p class="muted">Sales is intentionally excluded here: sales channels will later contain Menu Items, not fundamental master items.</p><div class="link-dropdown-grid">${linkDropdown("purchase","Purchase",rel.purchaseCategories,purchaseSelected,"purchase_category")}${linkDropdown("expense","Expense",rel.expenseCategories,expenseSelected,"expense_category")}</div></div><div class="form-status"></div><button class="btn btn-primary">${item?"Save changes":"Create item"}</button></form></div>`;
    const form=mount.querySelector('form');
    form.querySelectorAll('[data-link-search]').forEach(inp=>inp.addEventListener('input',()=>{const q=inp.value.toLowerCase();form.querySelectorAll(`[data-link-list="${inp.dataset.linkSearch}"] .link-option`).forEach(x=>x.style.display=x.dataset.label.includes(q)?'':'none')}));
    form.querySelector('.modal-close').onclick=()=>mount.innerHTML='';
    form.querySelectorAll('.add-inline-category').forEach(btn=>btn.addEventListener('click',async()=>{
      const current={name:form.elements.name.value,unit:form.elements.unit.value,master_rate:form.elements.master_rate.value,gst:form.elements.gst.value,reorder:form.elements.reorder.value,purchase_category_ids:[...form.querySelectorAll("input[name=\"purchase_category\"]:checked")].map(x=>x.value),expense_category_ids:[...form.querySelectorAll("input[name=\"expense_category\"]:checked")].map(x=>x.value)};
      const type=btn.dataset.categoryType;
      mount.innerHTML='';
      const {renderMasterCategoriesScreen}=await import('./master-data.js');
      const categoryHost=screen;
      const returnToItem=async newId=>{itemMasterForm(screen,user,item,{...current, ...(type==='purchase'?{}:{})}); await new Promise(r=>requestAnimationFrame(r)); const f=screen.querySelector('#item-master-form'); if(f){const cb=f.querySelector(`input[name="${type}_category"][value="${newId}"]`);if(cb)cb.checked=true;} };
      const original=screen.innerHTML;
      screen.innerHTML=`<div class="screen-head"><div><h1>Add ${type==='purchase'?'Purchase':'Expense'} Category</h1><p>Created from Item setup. After saving, you will return to your unfinished item.</p></div></div><div class="card"><form id="inline-category-form"><div class="field"><label>Category name</label><input name="name" required autofocus></div>${type==='expense'?'<input type="hidden" name="pl_bucket" value="operating">':''}<div class="form-status"></div><div class="button-row"><button type="submit" class="btn btn-primary">Create and return to Item</button><button type="button" class="btn" id="cancel-inline-category">Cancel</button></div></form></div>`;
      screen.querySelector('#cancel-inline-category').onclick=()=>{screen.innerHTML=original;itemMasterForm(screen,user,item,current)};
      screen.querySelector('#inline-category-form').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.currentTarget);const feedback=e.currentTarget.querySelector('.form-status');const rpc=type==='purchase'?'create_purchase_category':'create_expense_category';const args=type==='purchase'?{p_name:fd.get('name').trim(),p_sort_order:0}:{p_name:fd.get('name').trim(),p_pl_bucket:fd.get('pl_bucket')};const {data,error}=await supabase.rpc(rpc,args);if(error){state(feedback,error.message,true);return;}itemMasterForm(screen,user,item,{...current});await new Promise(r=>requestAnimationFrame(r));const f=screen.querySelector('#item-master-form');const cb=f?.querySelector(`input[name="${type}_category"][value="${data}"]`);if(cb){cb.checked=true;cb.closest('details')?.setAttribute('open','');} };
    }));
    form.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(form),feedback=form.querySelector('.form-status');const args=item?{p_item_id:item.id,p_name:f.get('name').trim(),p_unit:f.get('unit').trim(),p_gst_rate:Number(f.get('gst')),p_reorder_level:Number(f.get('reorder')),p_master_rate:Number(f.get('master_rate')),p_active:f.get('active')==='true'}:{p_name:f.get('name').trim(),p_unit:f.get('unit').trim(),p_gst_rate:Number(f.get('gst')),p_reorder_level:Number(f.get('reorder')),p_master_rate:Number(f.get('master_rate'))};const {data:newId,error}=await supabase.rpc(item?'update_item_master':'create_item_master',args);if(error){state(feedback,error.message,true);return;}const itemId=item?.id||newId;const {error:relError}=await supabase.rpc('set_item_master_relationships',{p_item_id:itemId,p_purchase_category_ids:f.getAll('purchase_category'),p_expense_category_ids:f.getAll('expense_category')});if(relError){state(feedback,relError.message,true);return;}await renderItemMasterScreen(screen,user);});
  });
}

export async function renderItemRelationshipsScreen(screen,user){
  if(!IS_CONFIGURED){screen.innerHTML=noConfig();return;}
  if(!canDo(user,"edit_masters")){screen.innerHTML='<div class="placeholder-screen"><h2>Owner access required</h2><p>Only the Owner can manage item relationships.</p></div>';return;}
  const [rel,itemsResult]=await Promise.all([loadMasterRelations(),supabase.from("items").select("id,name,unit,active").order("name")]);
  if(itemsResult.error)throw itemsResult.error;
  const items=itemsResult.data||[];
  const render=()=>{screen.innerHTML=`<div class="screen-head"><div><h1>Item Relationships</h1><p>Review how each fundamental item is routed into Purchase and Expense. Sales Menu Items will be managed separately.</p></div></div><div class="card"><div class="field"><label>Find an item</label><input id="relation-search" placeholder="Type any item name…" autocomplete="off"></div><div id="relation-results" class="relation-results"></div></div>`;const search=screen.querySelector("#relation-search"),host=screen.querySelector("#relation-results");const paint=()=>{const q=search.value.trim().toLowerCase();const matches=items.filter(i=>!q||i.name.toLowerCase().includes(q)).slice(0,100);host.innerHTML=matches.map(i=>{const purchases=rel.purchaseMap.filter(x=>x.item_id===i.id).map(x=>rel.purchaseCategories.find(c=>c.id===x.purchase_category_id)?.name).filter(Boolean);const expenses=rel.expenseMap.filter(x=>x.item_id===i.id).map(x=>rel.expenseCategories.find(c=>c.id===x.expense_category_id)?.name).filter(Boolean);return `<button type="button" class="relation-result" data-id="${i.id}"><strong>${esc(i.name)}</strong><span>${purchases.length?`Purchase: ${purchases.join(", ")}`:"No purchase category"} · ${expenses.length?`Expense: ${expenses.join(", ")}`:"No expense category"}</span></button>`;}).join("")||'<p class="muted">No matching items.</p>';host.querySelectorAll(".relation-result").forEach(b=>b.onclick=()=>itemMasterForm(screen,user,items.find(i=>i.id===b.dataset.id)));};search.addEventListener("input",paint);paint();};render();
}

async function showRateHistory(screen,id,item){const mount=screen.querySelector("#item-master-modal");mount.innerHTML=`<div class="modal-backdrop"><section class="modal-card"><button class="modal-close">×</button><h2>${esc(item?.name||"Item")} — Rate history</h2><p class="muted">Current master rate: <strong>${money(item?.master_rate)}</strong></p><div class="loading">Loading…</div></section></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";const {data,error}=await supabase.from("item_rate_history").select("old_rate,new_rate,effective_from,reason,users(name)").eq("item_id",id).order("effective_from",{ascending:false});if(error){mount.querySelector(".loading").textContent=error.message;return;}mount.querySelector(".modal-card").innerHTML=`<button class="modal-close">×</button><h2>${esc(item?.name||"Item")} — Rate history</h2><p class="muted">Current master rate: <strong>${money(item?.master_rate)}</strong></p><div class="table-wrap"><table class="ledger"><thead><tr><th>Effective</th><th class="num">Old</th><th class="num">New</th><th>Reason</th><th>User</th></tr></thead><tbody>${(data||[]).map(r=>`<tr><td>${esc(new Date(r.effective_from).toLocaleString("en-IN"))}</td><td class="num">${money(r.old_rate)}</td><td class="num">${money(r.new_rate)}</td><td>${esc(r.reason||"—")}</td><td>${esc(r.users?.name||"—")}</td></tr>`).join("")||'<tr><td colspan="5">No rate changes recorded.</td></tr>'}</tbody></table></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";}

async function stockLedger(screen,id,items){const item=items.find(i=>i.id===id);const mount=screen.querySelector("#inventory-modal");mount.innerHTML=`<div class="modal-backdrop"><section class="modal-card"><button class="modal-close">×</button><h2>${esc(item.name)} stock ledger</h2><p class="muted">Loading movements…</p></section></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";const {data,error}=await supabase.from("stock_movements").select("movement_type,quantity,rate,reason,created_at,transactions(txn_date)").eq("item_id",id).order("created_at",{ascending:false});if(error){mount.querySelector("p").textContent=error.message;return;}mount.querySelector(".modal-card").innerHTML=`<button class="modal-close">×</button><h2>${esc(item.name)} stock ledger</h2><div class="table-wrap"><table class="ledger"><thead><tr><th>Date</th><th>Movement</th><th>Reason</th><th class="num">Qty</th><th class="num">Rate</th></tr></thead><tbody>${(data||[]).map(m=>`<tr><td>${esc(m.transactions?.txn_date||new Date(m.created_at).toISOString().slice(0,10))}</td><td>${esc(m.movement_type)}</td><td>${esc(m.reason||"—")}</td><td class="num ${Number(m.quantity)<0?"negative":""}">${Number(m.quantity).toLocaleString("en-IN")}</td><td class="num">${money(m.rate)}</td></tr>`).join("")||'<tr><td colspan="5">No stock movements.</td></tr>'}</tbody></table></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";}

function itemForm(screen,user,item=null){const mount=screen.querySelector("#inventory-modal");mount.innerHTML=`<div class="modal-backdrop"><form class="modal-card"><button type="button" class="modal-close">×</button><h2>${item?"Edit item":"New item"}</h2><div class="field"><label>Name</label><input name="name" required value="${esc(item?.name||"")}"></div><div class="form-grid"><div class="field"><label>Category</label><input name="category" value="${esc(item?.category||"Raw Material")}" required></div><div class="field"><label>Unit</label><input name="unit" placeholder="kg, pack, nos" value="${esc(item?.unit||"")}" required></div><div class="field"><label>Master rate</label><input name="master_rate" type="number" min="0" step="0.01" value="${Number(item?.master_rate||0)}" required></div><div class="field"><label>GST %</label><input name="gst" type="number" min="0" max="100" step="0.01" required value="${Number(item?.gst_rate||0)}"></div><div class="field"><label>Reorder level</label><input name="reorder" type="number" min="0" step="0.001" value="${Number(item?.reorder_level||0)}"></div>${item?`<div class="field"><label>Status</label><select name="active"><option value="true" ${item.active?"selected":""}>Active</option><option value="false" ${!item.active?"selected":""}>Inactive</option></select></div>`:""}</div><div class="form-status"></div><button class="btn btn-primary">${item?"Save changes":"Create item"}</button></form></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";mount.querySelector("form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget),feedback=e.currentTarget.querySelector(".form-status");const args=item?{p_item_id:item.id,p_name:f.get("name").trim(),p_category:f.get("category").trim(),p_unit:f.get("unit").trim(),p_gst_rate:Number(f.get("gst")),p_reorder_level:Number(f.get("reorder")),p_master_rate:Number(f.get("master_rate")),p_active:f.get("active")==="true"}:{p_name:f.get("name").trim(),p_category:f.get("category").trim(),p_unit:f.get("unit").trim(),p_gst_rate:Number(f.get("gst")),p_reorder_level:Number(f.get("reorder")),p_master_rate:Number(f.get("master_rate"))};const {error}=await supabase.rpc(item?"update_item_master":"create_item_master",args);if(error){state(feedback,error.message,true);return;}await renderInventoryScreen(screen,user);});}

function stockAdjustment(screen,user,id,items){const item=items.find(i=>i.id===id),mount=screen.querySelector("#inventory-modal");mount.innerHTML=`<div class="modal-backdrop"><form class="modal-card"><button type="button" class="modal-close">×</button><h2>Adjust ${esc(item.name)}</h2><p class="muted">Use a positive quantity to add stock and a negative quantity to remove it.</p><div class="field"><label>Quantity adjustment</label><input name="quantity" type="number" step="0.001" required></div><div class="field"><label>Reason</label><select name="reason"><option>Manual Count Correction</option><option>Opening Balance</option><option>Other</option></select></div><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Note</label><input name="note"></div><div class="form-status"></div><button class="btn btn-primary">Record adjustment</button></form></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";mount.querySelector("form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget),feedback=e.currentTarget.querySelector(".form-status");const {error}=await supabase.rpc("record_stock_adjustment",{p_item_id:id,p_quantity:Number(f.get("quantity")),p_reason:f.get("reason"),p_txn_date:f.get("date"),p_description:f.get("note").trim()||null});if(error){state(feedback,error.message,true);return;}await renderInventoryScreen(screen,user);});}

export async function renderWastageScreen(screen,user){if(!IS_CONFIGURED){screen.innerHTML=noConfig();return;}const {items}=await masters();const {data,error}=await supabase.from("transactions").select("id,txn_date,amount,description,stock_movements(item_id,quantity,reason)").eq("txn_type","wastage").order("created_at",{ascending:false}).limit(100);if(error)throw error;const names=new Map(items.map(i=>[i.id,i.name]));const allowed=canDo(user,"record_wastage");screen.innerHTML=`<div class="screen-head"><div><h1>Wastage</h1><p>Wastage removes stock at the last purchase rate and records the financial value.</p></div></div>${allowed?`<div class="card"><div class="card-title">New wastage entry</div><form id="wastage-form" class="form-grid"><div class="field"><label>Item</label><div class="search-picker"><input id="wastage-item-search" placeholder="Search item…" autocomplete="off"><select name="item" id="wastage-item-select" required><option value="">Choose item</option>${optionRows(items)}</select></div></div><div class="field"><label>Quantity</label><input name="quantity" type="number" min="0.001" step="0.001" required></div><div class="field"><label>Reason</label><select name="reason"><option>Spoiled</option><option>Expired</option><option>Burnt</option><option>Preparation Waste</option><option>Overproduction</option><option>Customer Return</option><option>Damaged</option><option>Other</option></select></div><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field field-wide"><label>Note (optional)</label><input name="note"></div><div class="field field-wide"><div class="form-status"></div><button class="btn btn-primary">Record wastage</button></div></form></div>`:""}<div class="card table-wrap"><div class="card-title">Wastage history</div><table class="ledger"><thead><tr><th>Date</th><th>Item</th><th>Reason</th><th class="num">Qty</th><th>Note</th><th class="num">Value</th></tr></thead><tbody>${(data||[]).map(t=>{const m=Array.isArray(t.stock_movements)?t.stock_movements[0]:t.stock_movements;return`<tr><td>${esc(t.txn_date)}</td><td>${esc(names.get(m?.item_id)||"—")}</td><td>${esc(m?.reason||"—")}</td><td class="num">${Math.abs(Number(m?.quantity||0)).toLocaleString("en-IN")}</td><td>${esc(t.description||"—")}</td><td class="num">${money(t.amount)}</td></tr>`;}).join("")||'<tr><td colspan="6">No wastage recorded.</td></tr>'}</tbody></table></div>`;screen.querySelector("#wastage-item-search")?.addEventListener("input",e=>{const q=e.target.value.toLowerCase();const sel=screen.querySelector("#wastage-item-select");[...sel.options].forEach(o=>{if(!o.value)return;o.hidden=!o.text.toLowerCase().includes(q);});}); screen.querySelector("#wastage-item-select")?.addEventListener("change",e=>{const o=e.target.selectedOptions[0];screen.querySelector("#wastage-item-search").value=o?.textContent?.trim()||"";});
  screen.querySelector("#wastage-form")?.addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget),feedback=e.currentTarget.querySelector(".form-status");state(feedback,"Recording wastage…");const {error:err}=await supabase.rpc("record_wastage",{p_item_id:f.get("item"),p_quantity:Number(f.get("quantity")),p_reason:f.get("reason"),p_txn_date:f.get("date"),p_description:f.get("note").trim()||null});if(err){state(feedback,err.message,true);return;}await renderWastageScreen(screen,user);});}

export async function renderSupplierDuesScreen(screen,user){if(!IS_CONFIGURED){screen.innerHTML=noConfig();return;}const {suppliers,accounts}=await masters(true);const {data,error}=await supabase.from("supplier_balances").select("*").order("name");if(error)throw error;const allowed=canDo(user,"supplier_payment");screen.innerHTML=`<div class="screen-head"><div><h1>Supplier Dues</h1><p>Outstanding purchase balances are derived live from purchases and payments.</p></div></div><div class="card table-wrap"><table class="ledger"><thead><tr><th>Supplier</th><th>Status</th><th class="num">Purchased</th><th class="num">Paid</th><th class="num">Outstanding</th><th></th></tr></thead><tbody>${(data||[]).map(s=>`<tr><td>${esc(s.name)}</td><td>${suppliers.find(x=>x.id===s.supplier_id)?.active!==false?'<span class="stamp settled">Active</span>':'<span class="stamp pending">Inactive</span>'}</td><td class="num">${money(s.total_purchased)}</td><td class="num">${money(s.total_paid)}</td><td class="num ${Number(s.outstanding)>0?"negative":""}">${money(s.outstanding)}</td><td>${allowed&&Number(s.outstanding)>0?`<button class="btn btn-small pay-supplier" data-id="${s.supplier_id}" data-name="${esc(s.name)}" data-due="${s.outstanding}">Record payment</button>`:'<span class="stamp settled">Clear</span>'}</td></tr>`).join("")||'<tr><td colspan="6">No supplier balances yet.</td></tr>'}</tbody></table></div><div id="supplier-modal"></div>`;screen.querySelectorAll(".pay-supplier").forEach(b=>b.addEventListener("click",()=>supplierPayment(screen,user,accounts,b.dataset)));}

function supplierPayment(screen,user,accounts,data){const mount=screen.querySelector("#supplier-modal");mount.innerHTML=`<div class="modal-backdrop"><form class="modal-card"><button type="button" class="modal-close">×</button><h2>Pay ${data.name}</h2><p class="muted">Outstanding: <strong>${money(data.due)}</strong></p><div class="field"><label>Paid from</label><select name="account">${optionRows(accounts.filter(a=>["cash","bank","collection_account"].includes(a.type)))}</select></div><div class="field"><label>Amount</label><input name="amount" type="number" min="0.01" step="0.01" max="${data.due}" value="${data.due}" required></div><div class="field"><label>Date</label><input name="date" type="date" value="${today()}"></div><div class="field"><label>Note</label><input name="note"></div><div class="form-status"></div><button class="btn btn-primary">Record payment</button></form></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";mount.querySelector("form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget),feedback=e.currentTarget.querySelector(".form-status");const{error}=await supabase.rpc("record_supplier_payment",{p_supplier_id:data.id,p_from_account_id:f.get("account"),p_amount:Number(f.get("amount")),p_txn_date:f.get("date"),p_description:f.get("note").trim()||null});if(error){state(feedback,error.message,true);return;}await renderSupplierDuesScreen(screen,user);});}

export async function renderSupplierMasterScreen(screen,user){
  if(!IS_CONFIGURED){screen.innerHTML=noConfig();return;}if(!canDo(user,"edit_masters")){screen.innerHTML='<div class="placeholder-screen"><h2>Owner access required</h2><p>Only the Owner can manage supplier masters.</p></div>';return;}
  const {data,error}=await supabase.from("suppliers").select("id,name,phone,email,contact_person,address,gstin,active,created_at").order("active",{ascending:false}).order("name");if(error)throw error;
  const {data:balances,balanceError}=await supabase.from("supplier_balances").select("supplier_id,outstanding");if(balanceError)throw balanceError;const bal=new Map((balances||[]).map(x=>[x.supplier_id,x.outstanding]));
  screen.innerHTML=`<div class="screen-head"><div><h1>Suppliers</h1><p>Manage supplier profiles without deleting historical financial relationships.</p></div><button class="btn btn-primary" id="new-supplier">+ New supplier</button></div><div class="card table-wrap"><table class="ledger"><thead><tr><th>Supplier</th><th>Contact</th><th>Phone</th><th>GSTIN</th><th class="num">Outstanding</th><th>Status</th><th></th></tr></thead><tbody>${(data||[]).map(s=>`<tr><td><strong>${esc(s.name)}</strong><br><small>${esc(s.contact_person||s.email||"")}</small></td><td>${esc(s.contact_person||"—")}</td><td>${esc(s.phone||"—")}</td><td>${esc(s.gstin||"—")}</td><td class="num ${Number(bal.get(s.id)||0)>0?"negative":""}">${money(bal.get(s.id)||0)}</td><td>${s.active?'<span class="stamp settled">Active</span>':'<span class="stamp pending">Inactive</span>'}</td><td><button class="btn btn-small supplier-detail" data-id="${s.id}">View</button><button class="btn btn-small edit-supplier" data-id="${s.id}">Edit</button></td></tr>`).join("")||'<tr><td colspan="7">No suppliers yet.</td></tr>'}</tbody></table></div><div id="supplier-master-modal"></div>`;
  const byId=new Map((data||[]).map(s=>[s.id,s]));screen.querySelector("#new-supplier")?.addEventListener("click",()=>supplierForm(screen,user));screen.querySelectorAll(".edit-supplier").forEach(b=>b.addEventListener("click",()=>supplierForm(screen,user,byId.get(b.dataset.id))));screen.querySelectorAll(".supplier-detail").forEach(b=>b.addEventListener("click",()=>supplierDetail(screen,b.dataset.id,byId.get(b.dataset.id))));
}

function supplierForm(screen,user,supplier=null){const mount=screen.querySelector("#supplier-master-modal")||screen.querySelector("#supplier-modal");mount.innerHTML=`<div class="modal-backdrop"><form class="modal-card" id="supplier-master-form"><button type="button" class="modal-close">×</button><h2>${supplier?"Edit supplier":"New supplier"}</h2><div class="field"><label>Name</label><input name="name" maxlength="120" required value="${esc(supplier?.name||"")}"></div><div class="form-grid"><div class="field"><label>Contact person</label><input name="contact_person" value="${esc(supplier?.contact_person||"")}"></div><div class="field"><label>Phone</label><input name="phone" value="${esc(supplier?.phone||"")}"></div><div class="field"><label>Email</label><input name="email" type="email" value="${esc(supplier?.email||"")}"></div><div class="field"><label>GSTIN</label><input name="gstin" maxlength="15" value="${esc(supplier?.gstin||"")}"></div><div class="field field-wide"><label>Address</label><textarea name="address" rows="3">${esc(supplier?.address||"")}</textarea></div>${supplier?`<div class="field"><label>Status</label><select name="active"><option value="true" ${supplier.active?"selected":""}>Active</option><option value="false" ${!supplier.active?"selected":""}>Inactive</option></select></div>`:""}</div><div class="form-status"></div><button class="btn btn-primary">${supplier?"Save changes":"Create supplier"}</button></form></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";mount.querySelector("form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget),feedback=e.currentTarget.querySelector(".form-status");const args=supplier?{p_supplier_id:supplier.id,p_name:f.get("name").trim(),p_phone:f.get("phone").trim()||null,p_contact_person:f.get("contact_person").trim()||null,p_email:f.get("email").trim()||null,p_address:f.get("address").trim()||null,p_gstin:f.get("gstin").trim()||null,p_active:f.get("active")==="true"}:{p_name:f.get("name").trim(),p_phone:f.get("phone").trim()||null,p_contact_person:f.get("contact_person").trim()||null,p_email:f.get("email").trim()||null,p_address:f.get("address").trim()||null,p_gstin:f.get("gstin").trim()||null};const {error}=await supabase.rpc(supplier?"update_supplier_master":"create_supplier_master",args);if(error){state(feedback,error.message,true);return;}await renderSupplierMasterScreen(screen,user);});}

async function supplierDetail(screen,id,supplier){const mount=screen.querySelector("#supplier-master-modal");mount.innerHTML=`<div class="modal-backdrop"><section class="modal-card"><button class="modal-close">×</button><h2>${esc(supplier.name)}</h2><p class="muted">Loading supplier history…</p></section></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";const [{data:bal,error:be},{data:purchases,error:pe},{data:payments,error:payerr}]=await Promise.all([
    supabase.from("supplier_balances").select("total_purchased,total_paid,outstanding").eq("supplier_id",id).maybeSingle(),
    supabase.from("transactions").select("id,txn_date,amount,description,purchase_details!inner(supplier_id)").eq("txn_type","purchase").eq("purchase_details.supplier_id",id).order("txn_date",{ascending:false}).limit(100),
    supabase.from("transactions").select("id,txn_date,amount,description,ledger_entries!inner(counterparty_id,counterparty_type,entry_side)").eq("txn_type","supplier_payment").eq("ledger_entries.counterparty_id",id).eq("ledger_entries.counterparty_type","supplier").eq("ledger_entries.entry_side","debit").order("txn_date",{ascending:false}).limit(100)
  ]);if(be||pe||payerr){mount.querySelector("p").textContent=(be||pe||payerr).message;return;}
  mount.querySelector(".modal-card").innerHTML=`<button class="modal-close">×</button><h2>${esc(supplier.name)}</h2><div class="report-kpis"><div><span>Purchased</span><strong>${money(bal?.total_purchased)}</strong></div><div><span>Paid</span><strong>${money(bal?.total_paid)}</strong></div><div><span>Outstanding</span><strong>${money(bal?.outstanding)}</strong></div><div><span>Status</span><strong>${supplier.active?"Active":"Inactive"}</strong></div></div><h3>Profile</h3><p class="muted">${esc(supplier.contact_person||"No contact person")} · ${esc(supplier.phone||"No phone")} · ${esc(supplier.email||"No email")}</p><p class="muted">GSTIN: ${esc(supplier.gstin||"—")} · Address: ${esc(supplier.address||"—")}</p><h3>Purchase history</h3><div class="table-wrap"><table class="ledger"><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>${(purchases||[]).map(t=>`<tr><td>${esc(t.txn_date)}</td><td>${esc(t.description||"Purchase")}</td><td class="num">${money(t.amount)}</td></tr>`).join("")||'<tr><td colspan="3">No purchases.</td></tr>'}</tbody></table></div><h3>Payment history</h3><div class="table-wrap"><table class="ledger"><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>${(payments||[]).map(t=>`<tr><td>${esc(t.txn_date)}</td><td>${esc(t.description||"Supplier payment")}</td><td class="num">${money(t.amount)}</td></tr>`).join("")||'<tr><td colspan="3">No payments.</td></tr>'}</tbody></table></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";}
