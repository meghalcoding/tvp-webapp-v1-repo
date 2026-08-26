import { supabase, IS_CONFIGURED } from "./supabase-client.js";
import { canDo } from "./auth.js";

export const DOCUMENT_BUCKET = "financial-documents";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

const esc = (v = "") => String(v).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const docTypeLabel = (type) => ({ invoice: "Invoice", receipt: "Receipt", bill: "Bill", other: "Other" }[type] || "Other");
const status = (el, text, bad = false) => { if (!el) return; el.textContent = text; el.className = `form-status ${bad ? "error" : "success"}`; };

export async function fetchTransactionDocuments(transactionIds = []) {
  const ids = [...new Set(transactionIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from("transaction_documents")
    .select("transaction_id,document_id,documents(id,file_name,storage_path,document_type,mime_type,size_bytes,invoice_number,document_date,supplier_id,created_at)")
    .in("transaction_id", ids);
  if (error) throw error;
  const map = new Map(ids.map((id) => [id, []]));
  (data || []).forEach((row) => {
    if (!map.has(row.transaction_id)) map.set(row.transaction_id, []);
    if (row.documents) map.get(row.transaction_id).push(row.documents);
  });
  return map;
}

export function documentCellHtml(transactionId, docs = [], canAttach = true) {
  const tag = docs.length
    ? `<span class="document-tag uploaded">${docs.length} document${docs.length === 1 ? "" : "s"}</span>`
    : `<span class="document-tag missing">No Invoice/Receipt</span>`;
  return `<div class="document-actions" data-document-cell="${esc(transactionId)}">${tag}${canAttach ? `<button type="button" class="btn btn-small document-attach" data-txn-id="${esc(transactionId)}">${docs.length ? "Manage" : "Attach"}</button>` : ""}</div>`;
}

export async function decorateDocumentCells(root, transactionIds, canAttach = true) {
  const map = await fetchTransactionDocuments(transactionIds);
  root.querySelectorAll("[data-document-cell]").forEach((cell) => {
    const id = cell.dataset.documentCell;
    cell.outerHTML = documentCellHtml(id, map.get(id) || [], canAttach);
  });
}

async function getAuthId() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!data?.user?.id) throw new Error("Your Supabase session has expired. Sign in again before uploading documents.");
  return data.user.id;
}

function extFor(file) {
  const map = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  return map[file.type] || "bin";
}

export async function uploadDocument({ file, documentType = "other", supplierId = null, invoiceNumber = null, documentDate = null, notes = null, transactionIds = [] }) {
  if (!IS_CONFIGURED) throw new Error("Supabase is not configured.");
  if (!file) throw new Error("Choose an invoice, receipt, bill, PDF, or image first.");
  if (!ALLOWED_TYPES.has(file.type)) throw new Error("Unsupported file type. Use PDF, JPG, PNG, or WEBP.");
  if (file.size <= 0 || file.size > MAX_FILE_SIZE) throw new Error("Document must be between 1 byte and 10 MB.");
  if (!navigator.onLine) throw new Error("Document uploads require an internet connection.");

  const authId = await getAuthId();
  const storagePath = `${authId}/${crypto.randomUUID()}.${extFor(file)}`;
  const { error: uploadError } = await supabase.storage.from(DOCUMENT_BUCKET).upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadError) throw uploadError;

  try {
    const { data: document, error: documentError } = await supabase.rpc("create_financial_document", {
      p_file_name: file.name,
      p_storage_path: storagePath,
      p_mime_type: file.type,
      p_size_bytes: file.size,
      p_document_type: documentType,
      p_supplier_id: supplierId || null,
      p_invoice_number: invoiceNumber?.trim() || null,
      p_document_date: documentDate || null,
      p_notes: notes?.trim() || null,
      p_transaction_ids: [...new Set(transactionIds.filter(Boolean))],
    });
    if (documentError) {
      const message = String(documentError.message || documentError.details || documentError);
      if (/Could not find the function public\.create_financial_document/i.test(message) || /schema cache/i.test(message)) {
        throw new Error('The document-upload RPC is not loaded in Supabase yet. Run db/phase4a_document_rpc_hotfix.sql in the Supabase SQL Editor, then refresh this page.');
      }
      throw documentError;
    }
    return document;
  } catch (error) {
    await supabase.storage.from(DOCUMENT_BUCKET).remove([storagePath]);
    throw error;
  }
}

async function signedUrl(storagePath) {
  const { data, error } = await supabase.storage.from(DOCUMENT_BUCKET).createSignedUrl(storagePath, 300);
  if (error) throw error;
  return data.signedUrl;
}

async function unlinkDocument(documentId, transactionId) {
  const { error } = await supabase.rpc("unlink_document_from_transaction", { p_document_id: documentId, p_transaction_id: transactionId });
  if (error) throw error;
}

async function loadTransactionsForPicker() {
  const { data: txns, error } = await supabase.from("transactions")
    .select("id,txn_type,txn_date,amount,description,created_at")
    .in("txn_type", ["purchase", "expense"])
    .order("txn_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const rows = txns || [];
  const ids = rows.map((x) => x.id);
  const [{ data: purchases, error: pe }, { data: expenses, error: ee }] = await Promise.all([
    supabase.from("purchase_details").select("transaction_id,supplier_id,suppliers(name)").in("transaction_id", ids),
    supabase.from("expense_details").select("transaction_id,category_id,expense_categories(name)").in("transaction_id", ids),
  ]);
  if (pe || ee) throw pe || ee;
  const pMap = new Map((purchases || []).map((x) => [x.transaction_id, x]));
  const eMap = new Map((expenses || []).map((x) => [x.transaction_id, x]));
  return rows.map((t) => {
    const p = pMap.get(t.id); const e = eMap.get(t.id);
    const label = t.txn_type === "purchase"
      ? `Purchase · ${p?.suppliers?.name || "Supplier"}`
      : `Expense · ${e?.expense_categories?.name || "Expense"}`;
    return { ...t, label };
  });
}

export async function openDocumentModal({ screen, transactionId = null, supplierId = null, user, onDone }) {
  let pickerTransactions = [];
  try { pickerTransactions = await loadTransactionsForPicker(); } catch (error) { console.error(error); }
  const mount = document.createElement("div");
  mount.className = "document-modal-mount";
  const transactionOptions = pickerTransactions.map((t) => `<label class="document-link-option"><input type="checkbox" value="${t.id}" ${t.id === transactionId ? "checked" : ""}><span>${esc(t.label)} · ${esc(t.txn_date)} · ${money(t.amount)}</span></label>`).join("");
  mount.innerHTML = `<div class="modal-backdrop"><div class="modal-card document-modal">
    <button type="button" class="modal-close" aria-label="Close">×</button>
    <h2>Documents</h2>
    <p class="muted">Attach invoices, receipts, bills, or other supporting documents. One document can be linked to multiple Purchase/Expense entries.</p>
    <div class="document-existing" id="document-existing"><p class="muted">Loading linked documents…</p></div>
    <hr>
    <h3>Upload document</h3>
    <form id="document-upload-form">
      <div class="form-grid">
        <div class="field"><label>Document type</label><select name="document_type"><option value="invoice">Invoice</option><option value="receipt">Receipt</option><option value="bill">Bill</option><option value="other">Other</option></select></div>
        <div class="field"><label>File</label><input name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required><small>PDF/JPG/PNG/WEBP · max 10 MB</small></div>
        <div class="field"><label>Invoice / receipt number (optional)</label><input name="invoice_number" maxlength="100"></div>
        <div class="field"><label>Document date (optional)</label><input name="document_date" type="date"></div>
        <div class="field field-wide"><label>Notes (optional)</label><input name="notes" maxlength="500"></div>
      </div>
      <details class="document-link-picker" ${transactionId ? "open" : ""}><summary>Link this document to transactions</summary><div class="document-link-list" id="document-link-list">${transactionOptions || '<p class="muted">No Purchase/Expense transactions available.</p>'}</div></details>
      <div class="form-status"></div><button class="btn btn-primary">Upload & Link</button>
    </form>
  </div></div>`;
  screen.append(mount);

  const close = () => { mount.remove(); };
  mount.querySelector(".modal-close").addEventListener("click", close);
  mount.querySelector(".modal-backdrop").addEventListener("click", (e) => { if (e.target.classList.contains("modal-backdrop")) close(); });

  const existing = mount.querySelector("#document-existing");
  async function renderExisting() {
    if (!transactionId) { existing.innerHTML = '<p class="muted">No transaction selected. Upload a document and choose one or more transactions below.</p>'; return; }
    const map = await fetchTransactionDocuments([transactionId]);
    const docs = map.get(transactionId) || [];
    existing.innerHTML = `<h3>Linked to this transaction</h3>${docs.length ? `<div class="document-list">${docs.map((d) => `<div class="document-list-row"><div><strong>${esc(d.file_name)}</strong><span>${docTypeLabel(d.document_type)}${d.invoice_number ? ` · #${esc(d.invoice_number)}` : ""}</span></div><div><button class="btn btn-small document-open" data-path="${esc(d.storage_path || "")}" data-id="${d.id}">Open</button><button class="btn btn-small document-unlink" data-id="${d.id}">Unlink</button></div></div>`).join("")}</div>` : '<p class="muted">No Invoice/Receipt attached yet.</p>'}`;
    existing.querySelectorAll(".document-open").forEach((b) => b.addEventListener("click", async () => { try { b.disabled = true; const url = await signedUrl(b.dataset.path); window.open(url, "_blank", "noopener"); } catch (e) { window.__toast(window.__friendlyError(e.message),{type:"error"}); } finally { b.disabled = false; } }));
    existing.querySelectorAll(".document-unlink").forEach((b) => b.addEventListener("click", async () => { try { b.disabled = true; await unlinkDocument(b.dataset.id, transactionId); await renderExisting(); onDone?.(); } catch (e) { window.__toast(window.__friendlyError(e.message),{type:"error"}); b.disabled = false; } }));
  }
  await renderExisting();

  mount.querySelector("#document-upload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget; const fd = new FormData(form); const feedback = form.querySelector(".form-status");
    const selected = [...mount.querySelectorAll("#document-link-list input[type=checkbox]:checked")].map((x) => x.value);
    if (!selected.length && transactionId) selected.push(transactionId);
    try {
      const file = fd.get("file");
      status(feedback, "Uploading document…");
      await uploadDocument({ file, documentType: fd.get("document_type"), supplierId, invoiceNumber: fd.get("invoice_number"), documentDate: fd.get("document_date"), notes: fd.get("notes"), transactionIds: selected });
      status(feedback, "Document uploaded and linked.");
      form.reset();
      await renderExisting();
      onDone?.();
    } catch (error) { status(feedback, error.message, true); }
  });
}


export async function openLinkExistingDocumentModal({ screen, documentId, onDone }) {
  let pickerTransactions = [];
  try { pickerTransactions = await loadTransactionsForPicker(); } catch (error) { window.__toast(window.__friendlyError(error.message),{type:"error"}); return; }
  const mount = document.createElement("div");
  mount.className = "document-modal-mount";
  const options = pickerTransactions.map((t) => `<label class="document-link-option"><input type="checkbox" value="${t.id}"><span>${esc(t.label)} · ${esc(t.txn_date)} · ${money(t.amount)}</span></label>`).join("");
  mount.innerHTML = `<div class="modal-backdrop"><div class="modal-card document-modal"><button type="button" class="modal-close">×</button><h2>Link document</h2><p class="muted">Select one or more Purchase/Expense entries to link this existing document.</p><div class="document-link-list">${options || '<p class="muted">No Purchase/Expense transactions available.</p>'}</div><div class="form-status"></div><button class="btn btn-primary" id="confirm-document-links">Link selected transactions</button></div></div>`;
  screen.append(mount);
  const close=()=>mount.remove();
  mount.querySelector(".modal-close").addEventListener("click",close);
  mount.querySelector(".modal-backdrop").addEventListener("click",e=>{if(e.target.classList.contains("modal-backdrop"))close();});
  mount.querySelector("#confirm-document-links").addEventListener("click",async()=>{
    const feedback=mount.querySelector(".form-status");
    const ids=[...mount.querySelectorAll('input[type="checkbox"]:checked')].map(x=>x.value);
    if(!ids.length){status(feedback,"Select at least one transaction.",true);return;}
    try{
      status(feedback,"Linking document…");
      for(const transactionId of ids){const {error}=await supabase.rpc("link_document_to_transaction",{p_document_id:documentId,p_transaction_id:transactionId});if(error)throw error;}
      status(feedback,"Document linked.");
      onDone?.();
      setTimeout(close,350);
    }catch(error){status(feedback,error.message,true);}
  });
}

export async function renderDocumentsScreen(screen, user) {
  if (!IS_CONFIGURED) { screen.innerHTML = `<div class="placeholder-screen"><h2>Connect Supabase first</h2><p>Run the Phase 4A document migration after configuring Supabase.</p></div>`; return; }
  const allowedUpload = canDo(user, "record_purchase") || canDo(user, "record_expense");
  screen.innerHTML = `<div class="screen-head"><div><h1>Documents</h1><p>Invoices, receipts and bills attached to Purchase/Expense transactions.</p></div></div>
    ${allowedUpload ? `<div class="card"><div class="card-title">Upload & link a document</div><p class="muted">You can link one document to multiple Purchase/Expense transactions, or leave it unlinked and connect it later.</p><button class="btn btn-primary" id="documents-upload">Upload document</button></div>` : ""}
    <div class="card table-wrap"><div class="card-title">Document library</div><table class="ledger"><thead><tr><th>Document</th><th>Type</th><th>Invoice #</th><th>Date</th><th>Linked entries</th><th>Uploaded</th><th></th></tr></thead><tbody id="documents-body"><tr><td colspan="7">Loading…</td></tr></tbody></table></div>`;

  async function load() {
    const { data, error } = await supabase.from("documents").select("id,file_name,storage_path,mime_type,size_bytes,document_type,invoice_number,document_date,created_at,supplier_id,transaction_documents(transaction_id)").order("created_at", { ascending: false }).limit(200);
    const body = screen.querySelector("#documents-body");
    if (error) { body.innerHTML = `<tr><td colspan="7"><span class="form-status error">${esc(error.message)}</span></td></tr>`; return; }
    body.innerHTML = (data || []).map((d) => `<tr><td><strong>${esc(d.file_name)}</strong></td><td>${docTypeLabel(d.document_type)}</td><td>${esc(d.invoice_number || "—")}</td><td>${esc(d.document_date || "—")}</td><td>${d.transaction_documents?.length || 0}</td><td>${esc(new Date(d.created_at).toLocaleDateString("en-IN"))}</td><td><button class="btn btn-small document-open-library" data-path="${esc(d.storage_path)}">Open</button><button class="btn btn-small document-link-library" data-id="${d.id}">Link</button></td></tr>`).join("") || '<tr><td colspan="7">No documents uploaded yet.</td></tr>';
    body.querySelectorAll(".document-open-library").forEach((b) => b.addEventListener("click", async () => { try { const url = await signedUrl(b.dataset.path); window.open(url, "_blank", "noopener"); } catch (e) { window.__toast(window.__friendlyError(e.message),{type:"error"}); } }));
    body.querySelectorAll(".document-link-library").forEach((b) => b.addEventListener("click", async () => { try { await openLinkExistingDocumentModal({ screen, documentId: b.dataset.id, onDone: load }); } catch (e) { window.__toast(window.__friendlyError(e.message),{type:"error"}); } }));
  }
  screen.querySelector("#documents-upload")?.addEventListener("click", () => openDocumentModal({ screen, user, onDone: load }));
  await load();
}
