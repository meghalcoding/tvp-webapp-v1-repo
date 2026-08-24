import { supabase, IS_CONFIGURED } from "./supabase-client.js";
import { canDo } from "./auth.js";
import { withOfflineFallback } from "./offline-queue.js";
import { createHistoryController, fetchTransactionPage, HISTORY_INITIAL_LIMIT } from "./paginated-history.js";
import { decorateDocumentCells, openDocumentModal, uploadDocument } from "./documents.js";

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
  const itemQuery=supabase.from("items").select("id,name,category,unit,gst_rate,reorder_level,last_purchase_rate,master_rate,active").order("name");
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
  const purchases=await fetchTransactionPage({type:"purchase",select:"id,txn_date,amount,description,created_at,purchase_details(supplier_id,paid_amount),purchase_items(id)",limit:HISTORY_INITIAL_LIMIT});
  const supplierName=new Map(suppliers.map(x=>[x.id,x.name]));
  const allowed=canDo(user,"record_purchase");
  const tastySupplier=suppliers.find(s=>/tasty\s*vada\s*pav/i.test(s.name));
  let currentMode="standard";
  let currentTemplate=[];

  screen.innerHTML=`<div class="screen-head"><div><h1>Purchases</h1><p>Itemized purchases add stock automatically; unpaid value remains in supplier dues.</p></div></div>${allowed?`<div class="card"><div class="card-title">New purchase</div><form id="purchase-form"><div class="form-grid"><div class="field"><label>Supplier</label><select name="supplier_id" required><option value="">Choose supplier</option>${optionRows(suppliers)}</select></div><div class="field"><label>Payment</label><select name="paid_from_account_id"><option value="">Unpaid — add to supplier dues</option>${optionRows(accounts.filter(a=>["cash","bank","collection_account"].includes(a.type)))}</select></div><div class="field"><label>Date</label><input name="txn_date" type="date" value="${today()}" required></div><div class="field"><label>Bill note (optional)</label><input name="description" maxlength="500"></div><div class="field"><label>Document type</label><select name="document_type"><option value="invoice">Invoice</option><option value="receipt">Receipt</option><option value="bill">Bill</option><option value="other">Other</option></select></div><div class="field"><label>Invoice / receipt (optional)</label><input name="document_file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"><small>PDF/JPG/PNG/WEBP · max 10 MB. You can attach it later from Recent purchases.</small></div></div><div id="purchase-mode-note"></div><div class="card-title">Purchase items</div><div id="purchase-lines" class="line-items"></div><div id="purchase-order-summary"></div><button type="button" class="btn btn-small" id="add-purchase-line">+ Add item</button><p class="purchase-total">Purchase total: <strong id="purchase-total">₹0.00</strong></p><div class="form-status"></div><button class="btn btn-primary">Record purchase</button></form></div>`:""}<div class="card table-wrap"><div class="card-title">Recent purchases</div><table class="ledger"><thead><tr><th>Date</th><th>Supplier</th><th>Items</th><th>Payment</th><th>Note</th><th class="num">Total</th><th>Document</th><th></th></tr></thead><tbody id="purchases-history-body"></tbody></table><div class="history-controls" id="purchases-history-controls"></div></div>`;

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
    const item=row.querySelector("[data-item]"),qty=row.querySelector("[data-qty]"),rate=row.querySelector("[data-rate]"),gst=row.querySelector("[data-gst-rate]"),rateBtn=row.querySelector(".rate-modify"),gstBtn=row.querySelector(".gst-modify");
    if(item)item.addEventListener("change",()=>{
      const o=item.selectedOptions[0],s=row._purchaseState;
      s.itemId=o?.value||"";s.displayName=o?.dataset.displayName||o?.textContent?.trim()||"";s.unit=o?.dataset.unit||"";
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
    row.innerHTML=`<select data-item required><option value="">Item</option>${items.map(i=>`<option value="${i.id}" data-master-rate="${Number(i.master_rate??0)}" data-master-gst="${Number(i.gst_rate??0)}" data-unit="${esc(i.unit)}">${esc(i.name)} (${esc(i.unit)})</option>`).join("")}</select><input data-qty type="number" min="0.001" step="0.001" placeholder="Qty" required><div class="rate-wrap"><input data-rate type="number" min="0" step="0.01" placeholder="Rate" required disabled><button type="button" class="rate-modify btn btn-small">Modify Rate</button><span class="rate-warning hidden">Rate differs from master</span></div><div class="gst-wrap"><input data-gst-rate type="number" min="0" max="100" step="0.01" placeholder="GST %" required disabled><button type="button" class="gst-modify btn btn-small">Modify GST</button><span class="gst-warning hidden">GST differs from master</span></div><output data-gst-amount>GST ₹0.00</output><output data-line-total>₹0.00</output><button type="button" class="btn btn-small remove-item">×</button>`;
    row._purchaseState={itemId:"",displayName:"",unit:"",quantity:"",masterRate:null,rate:"",rateLocked:true,rateOverridden:false,masterGstRate:null,gstRate:"",gstLocked:true,gstOverridden:false};
    attachRowEvents(row);host.append(row);return row;
  };

  const templateItemsForSupplier=async supplierId=>{
    const {data,error}=await supabase.from("supplier_purchase_templates").select("id,supplier_id,item_id,display_name,abbreviation,display_order,active,items(id,name,unit,master_rate,gst_rate,active)").eq("supplier_id",supplierId).eq("active",true).order("display_order");
    if(error)throw error;return data||[];
  };

  const mapTemplateItem=async(templateId,itemId)=>{
    const {error}=await supabase.rpc("update_supplier_purchase_template_item",{p_template_id:templateId,p_item_id:itemId});
    if(error)throw error;
  };

  const makeTastyRow=(tpl,index)=>{
    const linked=tpl.items&&tpl.items.active!==false?tpl.items:null;
    const row=document.createElement("div");row.className="purchase-line franchise-template-row";row.dataset.templateId=tpl.id;
    const itemLabel=linked?`${tpl.display_name}`:`${tpl.display_name}`;
    const mappingControl=linked?`<span class="template-mapped">Mapped to ${esc(linked.name)}</span>`:(user.role==="owner"?`<select class="template-map" data-map><option value="">Map item…</option>${items.map(i=>`<option value="${i.id}">${esc(i.name)} (${esc(i.unit)})</option>`).join("")}</select>`:`<span class="template-unmapped">Item setup required</span>`);
    row.innerHTML=`<div class="franchise-item-name"><strong>${esc(itemLabel)}</strong><small>${esc(tpl.abbreviation||"")}</small></div><div class="franchise-unit">${linked?esc(linked.unit):"—"}</div><input data-qty type="number" min="0.001" step="0.001" placeholder="Qty" ${linked?"":"disabled"}><div class="rate-wrap"><input data-rate type="number" min="0" step="0.01" placeholder="Rate" ${linked?"required disabled":"disabled"}><button type="button" class="rate-modify btn btn-small" ${linked?"":"disabled"}>Modify Rate</button><span class="rate-warning hidden">Rate differs</span></div><div class="gst-wrap"><input data-gst-rate type="number" min="0" max="100" step="0.01" placeholder="GST %" ${linked?"required disabled":"disabled"}><button type="button" class="gst-modify btn btn-small" ${linked?"":"disabled"}>Modify GST</button><span class="gst-warning hidden">GST differs</span></div><output data-gst-amount>GST ₹0.00</output><output data-line-total>₹0.00</output>${mappingControl}`;
    row._purchaseState={templateId:tpl.id,itemId:linked?.id||"",displayName:tpl.display_name,unit:linked?.unit||"",quantity:"",masterRate:linked?Number(linked.master_rate??0):null,rate:linked?Number(linked.master_rate??0):"",rateLocked:true,rateOverridden:false,masterGstRate:linked?Number(linked.gst_rate??0):null,gstRate:linked?Number(linked.gst_rate??0):"",gstLocked:true,gstOverridden:false};
    if(linked){attachRowEvents(row);}else{
      row.querySelector("[data-map]")?.addEventListener("change",async e=>{const itemId=e.currentTarget.value;if(!itemId)return;try{e.currentTarget.disabled=true;await mapTemplateItem(tpl.id,itemId);await loadSupplierMode(form.elements.supplier_id.value);}catch(err){alert(err.message);e.currentTarget.disabled=false;}});
    }
    host.append(row);syncRow(row);return row;
  };

  const loadSupplierMode=async supplierId=>{
    currentTemplate=[];currentMode="standard";host.innerHTML="";summaryHost.innerHTML="";modeNote.innerHTML="";addButton.style.display="";
    if(!supplierId){makeStandardRow();calc();return;}
    const templates=await templateItemsForSupplier(supplierId);
    if(templates.length){
      currentMode="tasty";currentTemplate=templates;addButton.style.display="none";
      modeNote.innerHTML=`<div class="franchise-order-banner"><strong>Franchise owner order</strong><span>Enter only the quantities you are ordering today. Blank items will not be recorded.</span></div>`;
      templates.forEach(makeTastyRow);calc();return;
    }
    makeStandardRow();calc();
  };

  screen.querySelector('[name="supplier_id"]')?.addEventListener("change",async e=>{
    try{await loadSupplierMode(e.currentTarget.value);}catch(err){state(form.querySelector(".form-status"),err.message,true);}
  });
  addButton?.addEventListener("click",makeStandardRow);
  loadSupplierMode(form.elements.supplier_id.value).catch(err=>state(form.querySelector(".form-status"),err.message,true));

  const drawOrderImage=async (txnId,txnDate,supplierId)=>{
    const {data,error}=await supabase.from("purchase_items").select("quantity,item_id,items(name,unit)").eq("transaction_id",txnId).order("id");
    if(error)throw error;
    const {data:templateRows,error:templateError}=await supabase.from("supplier_purchase_templates").select("item_id,display_name,abbreviation").eq("supplier_id",supplierId).eq("active",true).order("display_order");
    if(templateError)throw templateError;
    const byId=new Map((templateRows||[]).map(x=>[x.item_id,{displayName:x.display_name,abbreviation:x.abbreviation}]));
    const rows=(data||[]).map(x=>{const t=byId.get(x.item_id);return{item:t?.displayName||x.items?.name||"Item",abbr:t?.abbreviation||"",qty:x.quantity,unit:x.items?.unit||""};});
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
  screen.innerHTML=`<div class="screen-head"><div><h1>Inventory</h1><p>Stock is movement-based. Value uses the latest purchase rate for each ingredient.</p></div>${owner?'<button class="btn btn-primary" id="new-item">+ New item</button>':''}</div><div class="card table-wrap"><table class="ledger"><thead><tr><th>Item</th><th>Category</th><th>Unit</th><th class="num">Stock</th><th class="num">Master rate</th><th class="num">Last rate</th><th class="num">Value</th><th>Reorder</th><th></th></tr></thead><tbody>${(stock||[]).map(s=>{const master=items.find(i=>i.id===s.item_id);const low=Number(s.quantity)<=Number(s.reorder_level);return`<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(master?.category||"—")}</td><td>${esc(s.unit)}</td><td class="num ${low?"negative":""}">${Number(s.quantity).toLocaleString("en-IN")}</td><td class="num">${money(itemRate(master))}</td><td class="num">${money(s.last_purchase_rate)}</td><td class="num">${money(s.stock_value)}</td><td>${low?'<span class="stamp pending">Low</span>':'<span class="stamp settled">OK</span>'}</td><td><button class="btn btn-small item-stock" data-id="${s.item_id}">Ledger</button>${owner?` <button class="btn btn-small edit-item" data-id="${s.item_id}">Edit</button>`:""}${adjust?` <button class="btn btn-small adjust-stock" data-id="${s.item_id}">Adjust</button>`:""}</td></tr>`;}).join("")||'<tr><td colspan="9">No inventory items yet.</td></tr>'}</tbody></table></div><div id="inventory-modal"></div>`;
  screen.querySelectorAll(".item-stock").forEach(b=>b.addEventListener("click",()=>stockLedger(screen,b.dataset.id,items)));screen.querySelectorAll(".adjust-stock").forEach(b=>b.addEventListener("click",()=>stockAdjustment(screen,user,b.dataset.id,items)));screen.querySelectorAll(".edit-item").forEach(b=>b.addEventListener("click",()=>itemForm(screen,user,items.find(i=>i.id===b.dataset.id))));screen.querySelector("#new-item")?.addEventListener("click",()=>itemForm(screen,user));
}

export async function renderItemMasterScreen(screen,user){
  if(!IS_CONFIGURED){screen.innerHTML=noConfig();return;}if(!canDo(user,"edit_masters")){screen.innerHTML='<div class="placeholder-screen"><h2>Owner access required</h2><p>Only the Owner can manage item masters.</p></div>';return;}
  const {data,error}=await supabase.from("items").select("id,name,category,unit,gst_rate,reorder_level,last_purchase_rate,master_rate,active,created_at").order("active",{ascending:false}).order("name");if(error)throw error;
  screen.innerHTML=`<div class="screen-head"><div><h1>Items</h1><p>Master rates are suggestions for new purchases. Last purchase rate remains historical and is used for stock valuation.</p></div><button class="btn btn-primary" id="new-master-item">+ New item</button></div><div class="card table-wrap"><table class="ledger"><thead><tr><th>Item</th><th>Category</th><th>Unit</th><th class="num">Master rate</th><th class="num">Last purchase</th><th class="num">GST</th><th class="num">Reorder</th><th>Status</th><th></th></tr></thead><tbody>${(data||[]).map(i=>`<tr><td><strong>${esc(i.name)}</strong></td><td>${esc(i.category)}</td><td>${esc(i.unit)}</td><td class="num">${money(i.master_rate)}</td><td class="num">${money(i.last_purchase_rate)}</td><td class="num">${Number(i.gst_rate||0)}%</td><td class="num">${Number(i.reorder_level||0).toLocaleString("en-IN")}</td><td>${i.active?'<span class="stamp settled">Active</span>':'<span class="stamp pending">Inactive</span>'}</td><td><button class="btn btn-small edit-master-item" data-id="${i.id}">Edit</button><button class="btn btn-small rate-history" data-id="${i.id}">Rate history</button></td></tr>`).join("")||'<tr><td colspan="9">No items yet.</td></tr>'}</tbody></table></div><div id="item-master-modal"></div>`;
  const byId=new Map((data||[]).map(i=>[i.id,i]));screen.querySelector("#new-master-item")?.addEventListener("click",()=>itemMasterForm(screen,user));screen.querySelectorAll(".edit-master-item").forEach(b=>b.addEventListener("click",()=>itemMasterForm(screen,user,byId.get(b.dataset.id))));screen.querySelectorAll(".rate-history").forEach(b=>b.addEventListener("click",()=>showRateHistory(screen,b.dataset.id,byId.get(b.dataset.id))));
}

function itemMasterForm(screen,user,item=null){const mount=screen.querySelector("#item-master-modal");mount.innerHTML=`<div class="modal-backdrop"><form class="modal-card" id="item-master-form"><button type="button" class="modal-close">×</button><h2>${item?"Edit item":"New item"}</h2><div class="field"><label>Name</label><input name="name" maxlength="120" required value="${esc(item?.name||"")}"></div><div class="form-grid"><div class="field"><label>Category</label><input name="category" required value="${esc(item?.category||"Raw Material")}"></div><div class="field"><label>Unit</label><input name="unit" required value="${esc(item?.unit||"")}" placeholder="kg, pack, nos"></div><div class="field"><label>Master rate</label><input name="master_rate" type="number" min="0" step="0.01" required value="${Number(item?.master_rate||0)}"></div><div class="field"><label>GST %</label><input name="gst" type="number" min="0" max="100" step="0.01" required value="${Number(item?.gst_rate||0)}"></div><div class="field"><label>Reorder level</label><input name="reorder" type="number" min="0" step="0.001" value="${Number(item?.reorder_level||0)}"></div>${item?`<div class="field"><label>Status</label><select name="active"><option value="true" ${item.active?"selected":""}>Active</option><option value="false" ${!item.active?"selected":""}>Inactive</option></select></div>`:""}</div>${item?`<p class="muted">Last purchase rate: <strong>${money(item.last_purchase_rate)}</strong>. Editing the master rate does not rewrite purchase history.</p>`:""}<div class="form-status"></div><button class="btn btn-primary">${item?"Save changes":"Create item"}</button></form></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";mount.querySelector("form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget),feedback=e.currentTarget.querySelector(".form-status");const args=item?{p_item_id:item.id,p_name:f.get("name").trim(),p_category:f.get("category").trim(),p_unit:f.get("unit").trim(),p_gst_rate:Number(f.get("gst")),p_reorder_level:Number(f.get("reorder")),p_master_rate:Number(f.get("master_rate")),p_active:f.get("active")==="true"}:{p_name:f.get("name").trim(),p_category:f.get("category").trim(),p_unit:f.get("unit").trim(),p_gst_rate:Number(f.get("gst")),p_reorder_level:Number(f.get("reorder")),p_master_rate:Number(f.get("master_rate"))};const {error}=await supabase.rpc(item?"update_item_master":"create_item_master",args);if(error){state(feedback,error.message,true);return;}await renderItemMasterScreen(screen,user);});}

async function showRateHistory(screen,id,item){const mount=screen.querySelector("#item-master-modal");mount.innerHTML=`<div class="modal-backdrop"><section class="modal-card"><button class="modal-close">×</button><h2>${esc(item?.name||"Item")} — Rate history</h2><p class="muted">Current master rate: <strong>${money(item?.master_rate)}</strong></p><div class="loading">Loading…</div></section></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";const {data,error}=await supabase.from("item_rate_history").select("old_rate,new_rate,effective_from,reason,users(name)").eq("item_id",id).order("effective_from",{ascending:false});if(error){mount.querySelector(".loading").textContent=error.message;return;}mount.querySelector(".modal-card").innerHTML=`<button class="modal-close">×</button><h2>${esc(item?.name||"Item")} — Rate history</h2><p class="muted">Current master rate: <strong>${money(item?.master_rate)}</strong></p><div class="table-wrap"><table class="ledger"><thead><tr><th>Effective</th><th class="num">Old</th><th class="num">New</th><th>Reason</th><th>User</th></tr></thead><tbody>${(data||[]).map(r=>`<tr><td>${esc(new Date(r.effective_from).toLocaleString("en-IN"))}</td><td class="num">${money(r.old_rate)}</td><td class="num">${money(r.new_rate)}</td><td>${esc(r.reason||"—")}</td><td>${esc(r.users?.name||"—")}</td></tr>`).join("")||'<tr><td colspan="5">No rate changes recorded.</td></tr>'}</tbody></table></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";}

async function stockLedger(screen,id,items){const item=items.find(i=>i.id===id);const mount=screen.querySelector("#inventory-modal");mount.innerHTML=`<div class="modal-backdrop"><section class="modal-card"><button class="modal-close">×</button><h2>${esc(item.name)} stock ledger</h2><p class="muted">Loading movements…</p></section></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";const {data,error}=await supabase.from("stock_movements").select("movement_type,quantity,rate,reason,created_at,transactions(txn_date)").eq("item_id",id).order("created_at",{ascending:false});if(error){mount.querySelector("p").textContent=error.message;return;}mount.querySelector(".modal-card").innerHTML=`<button class="modal-close">×</button><h2>${esc(item.name)} stock ledger</h2><div class="table-wrap"><table class="ledger"><thead><tr><th>Date</th><th>Movement</th><th>Reason</th><th class="num">Qty</th><th class="num">Rate</th></tr></thead><tbody>${(data||[]).map(m=>`<tr><td>${esc(m.transactions?.txn_date||new Date(m.created_at).toISOString().slice(0,10))}</td><td>${esc(m.movement_type)}</td><td>${esc(m.reason||"—")}</td><td class="num ${Number(m.quantity)<0?"negative":""}">${Number(m.quantity).toLocaleString("en-IN")}</td><td class="num">${money(m.rate)}</td></tr>`).join("")||'<tr><td colspan="5">No stock movements.</td></tr>'}</tbody></table></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";}

function itemForm(screen,user,item=null){const mount=screen.querySelector("#inventory-modal");mount.innerHTML=`<div class="modal-backdrop"><form class="modal-card"><button type="button" class="modal-close">×</button><h2>${item?"Edit item":"New item"}</h2><div class="field"><label>Name</label><input name="name" required value="${esc(item?.name||"")}"></div><div class="form-grid"><div class="field"><label>Category</label><input name="category" value="${esc(item?.category||"Raw Material")}" required></div><div class="field"><label>Unit</label><input name="unit" placeholder="kg, pack, nos" value="${esc(item?.unit||"")}" required></div><div class="field"><label>Master rate</label><input name="master_rate" type="number" min="0" step="0.01" value="${Number(item?.master_rate||0)}" required></div><div class="field"><label>GST %</label><input name="gst" type="number" min="0" max="100" step="0.01" required value="${Number(item?.gst_rate||0)}"></div><div class="field"><label>Reorder level</label><input name="reorder" type="number" min="0" step="0.001" value="${Number(item?.reorder_level||0)}"></div>${item?`<div class="field"><label>Status</label><select name="active"><option value="true" ${item.active?"selected":""}>Active</option><option value="false" ${!item.active?"selected":""}>Inactive</option></select></div>`:""}</div><div class="form-status"></div><button class="btn btn-primary">${item?"Save changes":"Create item"}</button></form></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";mount.querySelector("form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget),feedback=e.currentTarget.querySelector(".form-status");const args=item?{p_item_id:item.id,p_name:f.get("name").trim(),p_category:f.get("category").trim(),p_unit:f.get("unit").trim(),p_gst_rate:Number(f.get("gst")),p_reorder_level:Number(f.get("reorder")),p_master_rate:Number(f.get("master_rate")),p_active:f.get("active")==="true"}:{p_name:f.get("name").trim(),p_category:f.get("category").trim(),p_unit:f.get("unit").trim(),p_gst_rate:Number(f.get("gst")),p_reorder_level:Number(f.get("reorder")),p_master_rate:Number(f.get("master_rate"))};const {error}=await supabase.rpc(item?"update_item_master":"create_item_master",args);if(error){state(feedback,error.message,true);return;}await renderInventoryScreen(screen,user);});}

function stockAdjustment(screen,user,id,items){const item=items.find(i=>i.id===id),mount=screen.querySelector("#inventory-modal");mount.innerHTML=`<div class="modal-backdrop"><form class="modal-card"><button type="button" class="modal-close">×</button><h2>Adjust ${esc(item.name)}</h2><p class="muted">Use a positive quantity to add stock and a negative quantity to remove it.</p><div class="field"><label>Quantity adjustment</label><input name="quantity" type="number" step="0.001" required></div><div class="field"><label>Reason</label><select name="reason"><option>Manual Count Correction</option><option>Opening Balance</option><option>Other</option></select></div><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Note</label><input name="note"></div><div class="form-status"></div><button class="btn btn-primary">Record adjustment</button></form></div>`;mount.querySelector(".modal-close").onclick=()=>mount.innerHTML="";mount.querySelector("form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget),feedback=e.currentTarget.querySelector(".form-status");const {error}=await supabase.rpc("record_stock_adjustment",{p_item_id:id,p_quantity:Number(f.get("quantity")),p_reason:f.get("reason"),p_txn_date:f.get("date"),p_description:f.get("note").trim()||null});if(error){state(feedback,error.message,true);return;}await renderInventoryScreen(screen,user);});}

export async function renderWastageScreen(screen,user){if(!IS_CONFIGURED){screen.innerHTML=noConfig();return;}const {items}=await masters();const {data,error}=await supabase.from("transactions").select("id,txn_date,amount,description,stock_movements(item_id,quantity,reason)").eq("txn_type","wastage").order("created_at",{ascending:false}).limit(100);if(error)throw error;const names=new Map(items.map(i=>[i.id,i.name]));const allowed=canDo(user,"record_wastage");screen.innerHTML=`<div class="screen-head"><div><h1>Wastage</h1><p>Wastage removes stock at the last purchase rate and records the financial value.</p></div></div>${allowed?`<div class="card"><div class="card-title">New wastage entry</div><form id="wastage-form" class="form-grid"><div class="field"><label>Item</label><select name="item" required><option value="">Choose item</option>${optionRows(items)}</select></div><div class="field"><label>Quantity</label><input name="quantity" type="number" min="0.001" step="0.001" required></div><div class="field"><label>Reason</label><select name="reason"><option>Spoiled</option><option>Expired</option><option>Burnt</option><option>Preparation Waste</option><option>Overproduction</option><option>Customer Return</option><option>Damaged</option><option>Other</option></select></div><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field field-wide"><label>Note (optional)</label><input name="note"></div><div class="field field-wide"><div class="form-status"></div><button class="btn btn-primary">Record wastage</button></div></form></div>`:""}<div class="card table-wrap"><div class="card-title">Wastage history</div><table class="ledger"><thead><tr><th>Date</th><th>Item</th><th>Reason</th><th class="num">Qty</th><th>Note</th><th class="num">Value</th></tr></thead><tbody>${(data||[]).map(t=>{const m=Array.isArray(t.stock_movements)?t.stock_movements[0]:t.stock_movements;return`<tr><td>${esc(t.txn_date)}</td><td>${esc(names.get(m?.item_id)||"—")}</td><td>${esc(m?.reason||"—")}</td><td class="num">${Math.abs(Number(m?.quantity||0)).toLocaleString("en-IN")}</td><td>${esc(t.description||"—")}</td><td class="num">${money(t.amount)}</td></tr>`;}).join("")||'<tr><td colspan="6">No wastage recorded.</td></tr>'}</tbody></table></div>`;screen.querySelector("#wastage-form")?.addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.currentTarget),feedback=e.currentTarget.querySelector(".form-status");state(feedback,"Recording wastage…");const {error:err}=await supabase.rpc("record_wastage",{p_item_id:f.get("item"),p_quantity:Number(f.get("quantity")),p_reason:f.get("reason"),p_txn_date:f.get("date"),p_description:f.get("note").trim()||null});if(err){state(feedback,err.message,true);return;}await renderWastageScreen(screen,user);});}

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
