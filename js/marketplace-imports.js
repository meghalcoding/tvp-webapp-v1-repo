import { supabase, IS_CONFIGURED } from "./supabase-client.js";
import { canDo } from "./auth.js";

const esc = (v = "") => String(v).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
const status = (el, text, bad=false) => { if (!el) return; el.textContent=text; el.className=`form-status ${bad?"error":"success"}`; };

let xlsxPromise;
async function loadXlsx() {
  if (window.XLSX) return window.XLSX;
  if (!xlsxPromise) {
    xlsxPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
      script.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error("Excel parser loaded without XLSX."));
      script.onerror = () => reject(new Error("Excel parser could not be loaded. Connect to the internet and try again."));
      document.head.appendChild(script);
    });
  }
  return xlsxPromise;
}

function normalizeHeader(value) {
  return String(value ?? "").toLowerCase().replace(/[\s_\-\/().]+/g, " ").trim();
}
function rowValue(row, aliases) {
  const keys = Object.keys(row);
  const normalized = new Map(keys.map(k => [normalizeHeader(k), row[k]]));
  for (const alias of aliases) {
    const hit = normalized.get(normalizeHeader(alias));
    if (hit !== undefined && hit !== null && String(hit).trim() !== "") return hit;
  }
  const aliasNorm = aliases.map(normalizeHeader);
  for (const key of keys) {
    const nk = normalizeHeader(key);
    if (aliasNorm.some(a => nk.includes(a) || a.includes(nk))) {
      const value = row[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
  }
  return null;
}
function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/₹/g,"").replace(/,/g,"").replace(/[^\d().\-]/g,"").trim();
  if (!cleaned) return null;
  const n = Number(cleaned.replace(/[()]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function dateValue(value, XLSX) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0,10);
  }
  if (typeof value === "number" && XLSX?.SSF?.parse_date_code) {
    const p = XLSX.SSF.parse_date_code(value);
    if (p) return `${p.y}-${String(p.m).padStart(2,"0")}-${String(p.d).padStart(2,"0")}`;
  }
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2,"0")}-${String(iso[3]).padStart(2,"0")}`;
  const dmy = text.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/);
  if (dmy) {
    let year = Number(dmy[3]); if (year < 100) year += 2000;
    return `${year}-${String(dmy[2]).padStart(2,"0")}-${String(dmy[1]).padStart(2,"0")}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0,10);
}

function detectPlatform(rows, fileName) {
  const headers = Object.keys(rows[0] || {}).map(normalizeHeader).join(" ");
  const name = String(fileName || "").toLowerCase();
  const zomatoScore = (name.includes("zomato") ? 4 : 0) +
    (headers.includes("zomato") ? 3 : 0) +
    (headers.includes("restaurant order") ? 1 : 0) +
    (headers.includes("order id") ? 1 : 0);
  const swiggyScore = (name.includes("swiggy") ? 4 : 0) +
    (headers.includes("swiggy") ? 3 : 0) +
    (headers.includes("order id") ? 1 : 0);
  if (zomatoScore > swiggyScore && zomatoScore >= 4) return "zomato";
  if (swiggyScore > zomatoScore && swiggyScore >= 4) return "swiggy";
  return "";
}

function normalizeRows(rawRows, platform, XLSX) {
  return rawRows.map((row, index) => {
    const external = rowValue(row, [
      "order id","order_id","order number","order no","order reference","reference id",
      "restaurant order id","customer order id","swiggy order id","zomato order id"
    ]);
    const orderDate = dateValue(rowValue(row, ["order date","order_date","date","created date","order placed date"]), XLSX);
    const orderTime = rowValue(row, ["order time","order_time","time","created time"]);
    const gross = numberValue(rowValue(row, ["gross amount","gross sales","order total","total order value","item total","subtotal","gross order amount"]));
    const discount = numberValue(rowValue(row, ["discount","discount amount","customer discount"])) || 0;
    const tax = numberValue(rowValue(row, ["tax","tax amount","gst","gst amount","total tax"])) || 0;
    const fee = numberValue(rowValue(row, ["platform fee","commission","commission amount","zomato commission","swiggy commission","platform charges"])) || 0;
    const net = numberValue(rowValue(row, ["net amount","net sales","restaurant payout","restaurant share","merchant payable","settlement amount","net order value"]));
    const paymentStatus = rowValue(row, ["payment status","order status","status","settlement status"]);
    const description = rowValue(row, ["description","restaurant name","order description","customer name"]);
    const importAmount = net ?? gross ?? null;
    const errors = [];
    if (!external) errors.push("Missing external order/reference ID");
    if (!orderDate) errors.push("Missing or invalid order date");
    if (importAmount === null || importAmount <= 0) errors.push("Missing or invalid sales amount");
    return {
      row_number: index + 2,
      external_order_id: String(external ?? "").trim() || null,
      order_date: orderDate,
      order_time: orderTime == null ? null : String(orderTime).trim(),
      description: description == null ? null : String(description).trim(),
      gross_amount: gross,
      discount_amount: discount,
      tax_amount: tax,
      platform_fee: fee,
      net_amount: net,
      import_amount: importAmount,
      payment_status: paymentStatus == null ? null : String(paymentStatus).trim(),
      raw_data: row,
      normalized_data: { platform, external_order_id: external, order_date: orderDate, order_time: orderTime, gross_amount: gross, discount_amount: discount, tax_amount: tax, platform_fee: fee, net_amount: net, import_amount: importAmount, payment_status: paymentStatus },
      validation_status: errors.length ? "invalid" : "valid",
      validation_errors: errors,
      action: errors.length ? "skip" : "import",
    };
  });
}

async function sha256(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

async function existingOrderIds(platform, ids) {
  const result = new Set();
  const clean = [...new Set(ids.filter(Boolean))];
  for (let i=0; i<clean.length; i+=100) {
    const chunk = clean.slice(i,i+100);
    const { data, error } = await supabase.from("sale_details")
      .select("external_order_id")
      .eq("sales_channel", platform)
      .in("external_order_id", chunk);
    if (error) throw error;
    (data || []).forEach(r => result.add(r.external_order_id));
  }
  return result;
}

async function stageImport(platform, file, rows) {
  const hash = await sha256(file);
  const { data: batchId, error: batchError } = await supabase.rpc("create_sales_import_batch", {
    p_platform: platform,
    p_file_name: file.name,
    p_file_hash: hash,
    p_total_rows: rows.length,
    p_new_rows: rows.filter(r=>r.validation_status==="valid").length,
    p_duplicate_rows: 0,
    p_invalid_rows: rows.filter(r=>r.validation_status==="invalid").length,
  });
  if (batchError) throw batchError;

  const existing = await existingOrderIds(platform, rows.map(r=>r.external_order_id));
  const staged = rows.map(r => {
    if (r.validation_status === "valid" && r.external_order_id && existing.has(r.external_order_id)) {
      return {...r, validation_status:"duplicate", validation_errors:["Already imported"], action:"skip"};
    }
    return r;
  });
  const duplicates = staged.filter(r=>r.validation_status==="duplicate").length;
  const newRows = staged.filter(r=>r.validation_status==="valid").length;
  const { error: rowError } = await supabase.from("sales_import_rows").insert(
    staged.map(r => ({...r, batch_id: batchId}))
  );
  if (rowError) throw rowError;
  await supabase.from("sales_import_batches").update({
    new_rows:newRows, duplicate_rows:duplicates, invalid_rows:staged.filter(r=>r.validation_status==="invalid").length
  }).eq("id", batchId);
  return { batchId, rows: staged };
}

function rowStatus(row) {
  if (row.validation_status === "duplicate") return `<span class="stamp">Duplicate</span>`;
  if (row.validation_status === "invalid") return `<span class="stamp negative">Invalid</span>`;
  return `<span class="stamp success">New</span>`;
}

export async function renderMarketplaceImportScreen(screen, user) {
  if (!IS_CONFIGURED) {
    screen.innerHTML = `<div class="placeholder-screen"><h2>Connect Supabase first</h2></div>`;
    return;
  }
  if (!canDo(user, "record_sale")) {
    screen.innerHTML = `<div class="placeholder-screen"><h2>Permission denied</h2><p>Only an Owner or Manager can import marketplace sales.</p></div>`;
    return;
  }

  const { data: batches, error: batchError } = await supabase.from("sales_import_batches")
    .select("id,platform,file_name,imported_at,status,total_rows,new_rows,duplicate_rows,invalid_rows,committed_rows")
    .order("imported_at",{ascending:false}).limit(20);
  if (batchError) throw batchError;

  screen.innerHTML = `
    <div class="screen-head">
      <div><h1>Marketplace Imports</h1><p>Import Zomato or Swiggy Excel reports through a reviewable staging layer. Nothing reaches Sales until you commit it.</p></div>
    </div>
    <div class="card">
      <div class="card-title">New marketplace import</div>
      <form id="marketplace-import-form" class="form-grid">
        <div class="field">
          <label>Platform</label>
          <select name="platform" id="import-platform">
            <option value="">Auto-detect</option>
            <option value="zomato">Zomato</option>
            <option value="swiggy">Swiggy</option>
          </select>
        </div>
        <div class="field field-wide">
          <label>Excel report</label>
          <input name="file" id="marketplace-file" type="file" accept=".xlsx,.xls,.csv" required />
        </div>
        <div class="field field-wide">
          <div class="form-status"></div>
          <button class="btn btn-primary">Read & stage report</button>
        </div>
      </form>
    </div>
    <div id="marketplace-preview"></div>
    <div class="card table-wrap">
      <div class="card-title">Recent imports</div>
      <table class="ledger"><thead><tr><th>Imported</th><th>Platform</th><th>File</th><th>Rows</th><th>New</th><th>Duplicates</th><th>Invalid</th><th>Status</th></tr></thead>
      <tbody>${(batches||[]).map(b=>`<tr><td>${esc(new Date(b.imported_at).toLocaleString("en-IN"))}</td><td>${esc(b.platform)}</td><td>${esc(b.file_name)}</td><td class="num">${b.total_rows}</td><td class="num">${b.new_rows}</td><td class="num">${b.duplicate_rows}</td><td class="num">${b.invalid_rows}</td><td>${esc(b.status)}</td></tr>`).join("")||'<tr><td colspan="8">No imports yet.</td></tr>'}</tbody></table>
    </div>`;

  const form = screen.querySelector("#marketplace-import-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const feedback = form.querySelector(".form-status");
    const file = form.file.files[0];
    if (!file) return;
    try {
      status(feedback,"Loading Excel parser…");
      const XLSX = await loadXlsx();
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer,{type:"array",cellDates:true});
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(firstSheet,{defval:""});
      if (!rawRows.length) throw new Error("The first worksheet contains no data.");
      let platform = form.platform.value || detectPlatform(rawRows,file.name);
      if (!platform) throw new Error("Could not confidently detect Zomato or Swiggy. Select the platform manually and retry.");
      const rows = normalizeRows(rawRows,platform,XLSX);
      status(feedback,`Detected ${platform === "zomato" ? "Zomato" : "Swiggy"} • ${rows.length} rows. Checking duplicates…`);
      const staged = await stageImport(platform,file,rows);
      status(feedback,`Staged ${staged.rows.length} rows. Review before committing.`);
      await renderBatchPreview(screen,user,staged.batchId);
      form.reset();
    } catch (err) {
      console.error("Marketplace import failed",err);
      status(feedback,err.message || "Import failed",true);
    }
  });
}

async function renderBatchPreview(screen,user,batchId) {
  const mount=screen.querySelector("#marketplace-preview");
  const [{data:batch,error:be},{data:rows,error:re}]=await Promise.all([
    supabase.from("sales_import_batches").select("*").eq("id",batchId).single(),
    supabase.from("sales_import_rows").select("*").eq("batch_id",batchId).order("row_number")
  ]);
  if(be||re) throw be||re;
  mount.innerHTML=`
    <div class="card">
      <div class="card-title">${esc(batch.platform.toUpperCase())} Import Review</div>
      <div class="report-kpis">
        <div><span>Total</span><strong>${rows.length}</strong></div>
        <div><span>New</span><strong>${rows.filter(r=>r.validation_status==="valid").length}</strong></div>
        <div><span>Duplicates</span><strong>${rows.filter(r=>r.validation_status==="duplicate").length}</strong></div>
        <div><span>Invalid</span><strong>${rows.filter(r=>r.validation_status==="invalid").length}</strong></div>
      </div>
      <div class="table-wrap"><table class="ledger"><thead><tr>
        <th>Use</th><th>Row</th><th>External Order ID</th><th>Date</th><th>Amount</th><th>Status</th><th>Reason</th>
      </tr></thead><tbody>
      ${rows.map(r=>`<tr data-row="${r.id}">
        <td><input type="checkbox" class="import-use" ${r.action==="import"?"checked":""} ${r.validation_status!=="valid"?"disabled":""}></td>
        <td>${r.row_number}</td>
        <td><input class="import-order-id" value="${esc(r.external_order_id||"")}" ${r.validation_status==="duplicate"?"disabled":""}></td>
        <td><input class="import-date" type="date" value="${esc(r.order_date||"")}"></td>
        <td><input class="import-amount" type="number" min="0.01" step="0.01" value="${r.import_amount==null?"":Number(r.import_amount)}"></td>
        <td class="import-status">${rowStatus(r)}</td>
        <td>${esc((r.validation_errors||[]).join("; ")||"—")}</td>
      </tr>`).join("")}
      </tbody></table></div>
      <div class="form-status" id="batch-status"></div>
      <div class="inline-actions-end">
        <button class="btn" id="save-import-review">Save edits</button>
        <button class="btn btn-primary" id="commit-import">Commit selected new sales</button>
      </div>
    </div>`;

  mount.querySelector("#save-import-review").addEventListener("click",()=>saveReview(mount,batchId));
  mount.querySelector("#commit-import").addEventListener("click",async()=>{
    const feedback=mount.querySelector("#batch-status");
    try {
      await saveReview(mount,batchId);
      status(feedback,"Committing import…");
      const {data,error}=await supabase.rpc("commit_sales_import_batch",{p_batch_id:batchId});
      if(error) throw error;
      status(feedback,`${data || 0} sales committed successfully.`);
      await renderBatchPreview(screen,user,batchId);
    } catch(err) { status(feedback,err.message||"Commit failed",true); }
  });
}

async function saveReview(mount,batchId) {
  const updates=[];
  mount.querySelectorAll("tbody tr[data-row]").forEach(tr=>{
    const id=tr.dataset.row;
    const checkbox=tr.querySelector(".import-use");
    const orderId=tr.querySelector(".import-order-id")?.value.trim()||null;
    const date=tr.querySelector(".import-date")?.value||null;
    const amount=Number(tr.querySelector(".import-amount")?.value);
    const validationErrors=[];
    if(!orderId) validationErrors.push("Missing external order/reference ID");
    if(!date) validationErrors.push("Missing or invalid order date");
    if(!Number.isFinite(amount)||amount<=0) validationErrors.push("Missing or invalid sales amount");
    updates.push({
      id, external_order_id:orderId, order_date:date,
      import_amount:Number.isFinite(amount)?amount:null,
      validation_status:validationErrors.length?"invalid":"valid",
      validation_errors:validationErrors,
      action:checkbox?.checked && !validationErrors.length ? "import":"skip"
    });
  });
  for(const u of updates) {
    const {error}=await supabase.from("sales_import_rows").update(u).eq("id",u.id).eq("batch_id",batchId);
    if(error) throw error;
  }
  const {data:rows,error}=await supabase.from("sales_import_rows").select("validation_status,action").eq("batch_id",batchId);
  if(error) throw error;
  await supabase.from("sales_import_batches").update({
    new_rows:rows.filter(r=>r.validation_status==="valid"&&r.action==="import").length,
    duplicate_rows:rows.filter(r=>r.validation_status==="duplicate").length,
    invalid_rows:rows.filter(r=>r.validation_status==="invalid").length,
    status:"review"
  }).eq("id",batchId);
}
