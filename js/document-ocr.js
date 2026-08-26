const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/+esm";
const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.5.136/build/pdf.min.mjs";
const PDF_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.5.136/build/pdf.worker.min.mjs";

const esc = (v = "") => String(v).replace(/[&<>\'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\'":"&#39;",'"':"&quot;"}[c]));
const money = n => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const normalize = value => String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

let tesseractPromise;
let pdfPromise;

async function getTesseract() {
  if (!tesseractPromise) tesseractPromise = import(TESSERACT_URL);
  return tesseractPromise;
}

async function getPdfJs() {
  if (!pdfPromise) {
    pdfPromise = import(PDFJS_URL).then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      return pdfjs;
    });
  }
  return pdfPromise;
}

async function imageBlobFromCanvas(file, rotation = 0, enhance = true) {
  const bitmap = await createImageBitmap(file);
  const portrait = bitmap.height > bitmap.width;
  const rotated = rotation === 90 || rotation === 270;
  const srcW = bitmap.width, srcH = bitmap.height;
  const maxDim = 2400;
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = rotated ? h : w;
  canvas.height = rotated ? w : h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.save();
  if (rotation === 90) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
  else if (rotation === 270) { ctx.translate(0, w); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(bitmap, 0, 0, w, h);
  ctx.restore();
  bitmap.close?.();

  if (enhance) {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const boosted = Math.max(0, Math.min(255, (gray - 128) * 1.45 + 128));
      d[i] = d[i + 1] = d[i + 2] = boosted;
    }
    ctx.putImageData(image, 0, 0);
  }
  return canvas;
}

async function imageText(file, language, progress) {
  const { createWorker } = await getTesseract();
  const worker = await createWorker(language);
  try {
    const rotations = file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/webp' ? [0, 90, 270] : [0];
    const candidates = [];
    for (let i = 0; i < rotations.length; i += 1) {
      const rotation = rotations[i];
      progress?.(Math.round((i / rotations.length) * 75), rotation ? `Reading document (rotated ${rotation}°)…` : 'Reading document…');
      const canvas = await imageBlobFromCanvas(file, rotation, true);
      if (worker.setParameters) {
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
      });
    }
    const result = await worker.recognize(canvas, {}, { blocks: true });
      const text = result.data.text || '';
      const normalized = text.toLowerCase();
      const keywordHits = ['invoice', 'total', 'gst', 'tax', 'quantity', 'price', 'amount', 'dabeli', 'chatni', 'chutney', 'vada', 'roti', 'tikki'].reduce((n, k) => n + (normalized.includes(k) ? 1 : 0), 0);
      const confidence = Number(result.data.confidence || 0);
      const score = confidence + keywordHits * 4 + (findDate(text) ? 5 : 0) + (findTotal(text) != null ? 8 : 0);
      candidates.push({ text, score, rotation, confidence });
      canvas.width = 1; canvas.height = 1;
    }
    candidates.sort((a, b) => b.score - a.score);
    progress?.(100, 'OCR complete');
    return candidates[0]?.text || '';
  } finally {
    await worker.terminate();
  }
}

async function pdfText(file, language, progress) {
  const pdfjs = await getPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const pages = Math.min(pdf.numPages, 6);
  const chunks = [];
  for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
    progress?.(((pageNo - 1) / pages) * 100, `Reading PDF page ${pageNo} of ${pages}…`);
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const text = content.items.map(item => item.str).join(" ").trim();
    if (text) {
      chunks.push(text);
      continue;
    }
    const viewport = page.getViewport({ scale: 1.7 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    chunks.push(await imageText(canvas, language, progress));
  }
  return chunks.join("\n");
}

export async function extractDocumentText(file, { language = "eng", progress } = {}) {
  if (!file) throw new Error("Choose a document first.");
  if (file.type === "application/pdf") return pdfText(file, language, progress);
  return imageText(file, language, progress);
}

function numericTokens(text) {
  return [...String(text || "").matchAll(/(?:₹|rs\.?|inr)?\s*([0-9]+(?:[.,][0-9]+)?)/gi)].map(m => Number(m[1].replace(/,/g, ""))).filter(Number.isFinite);
}

function findDate(text) {
  const m = String(text || "").match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (!m) return "";
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  const dd = String(m[1]).padStart(2, "0");
  const mm = String(m[2]).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function findInvoiceNumber(text) {
  const patterns = [
    /(?:invoice\s*(?:no|number|#)?|inv\.?\s*(?:no|#)?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\/-]{2,})/i,
    /(?:bill\s*(?:no|number|#)?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\/-]{2,})/i,
  ];
  for (const re of patterns) {
    const m = String(text || "").match(re);
    if (m) return m[1];
  }
  return "";
}

function findTotal(text) {
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const candidates = [];
  for (const line of lines) {
    if (/(grand\s*total|invoice\s*amount|net\s*amount|amount\s*payable|total)/i.test(line)) {
      const nums = numericTokens(line);
      if (nums.length) candidates.push(nums[nums.length - 1]);
    }
  }
  if (candidates.length) return candidates[candidates.length - 1];
  const patterns = [
    /(?:grand\s*total|invoice\s*amount|net\s*amount|total\s*amount|amount\s*payable)\D{0,50}(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
    /(?:^|\n)\s*total\D{0,30}(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/im,
  ];
  for (const re of patterns) {
    const m = String(text || '').match(re);
    if (m) return Number(m[1].replace(/,/g, ''));
  }
  return null;
}

const ALIASES = new Map([
  ["vada masala", ["vada masalo", "vada masala", "vada masala aloo", "vada masalo aalu"]],
  ["lal chatni", ["lal chatni", "red chutney", "lal chutney", "red chatni"]],
  ["green chatni", ["green chatni", "green chutney", "green chutney", "green chatni"]],
  ["meethi chutney", ["meethi chutney", "meethi chatni", "sweet chutney", "sweet chatni"]],
  ["dabeli masala", ["dabeli masala", "dabeli masalo"]],
  ["roti/tikki", ["roti tikki", "roti/tikki", "tikki roti", "tikki"]],
  ["butter", ["butter", "vimal butter"]],
  ["cheese", ["cheese", "vimal cheese"]],
  ["sing", ["sing", "singh"]],
  ["sev", ["sev"]],
  ["mayo", ["mayo", "mayonnaise"]],
  ["white cheese", ["white cheese"]],
  ["ketchup", ["ketchup"]],
  ["shezwan", ["shezwan", "schezwan"]],
  ["chat masala", ["chat masala"]],
]);

function aliasesForItem(item) {
  const key = normalize(item?.name);
  const aliases = [item?.name || ""];
  for (const [canonical, list] of ALIASES.entries()) {
    if (normalize(canonical) === key || list.some(x => normalize(x) === key)) aliases.push(...list);
  }
  return [...new Set(aliases.filter(Boolean))];
}

function matchItem(line, items) {
  const n = normalize(line);
  let best = null;
  for (const item of items || []) {
    for (const alias of aliasesForItem(item)) {
      const a = normalize(alias);
      if (!a) continue;
      if (n.includes(a)) return item;
      const words = a.split(" ").filter(Boolean);
      const hits = words.filter(w => n.includes(w)).length;
      const score = words.length ? hits / words.length : 0;
      if (score >= 0.8 && (!best || score > best.score)) best = { item, score };
    }
  }
  return best?.item || null;
}

function parseItemLine(line, items) {
  const item = matchItem(line, items);
  if (!item) return null;
  const raw = String(line || '').trim();
  const itemAliases = aliasesForItem(item).sort((a, b) => b.length - a.length);
  let remainder = raw;
  for (const alias of itemAliases) {
    const idx = normalize(remainder).indexOf(normalize(alias));
    if (idx >= 0) {
      const originalLower = remainder.toLowerCase();
      const aliasLower = alias.toLowerCase();
      const directIdx = originalLower.indexOf(aliasLower);
      remainder = directIdx >= 0 ? remainder.slice(directIdx + alias.length) : remainder;
      break;
    }
  }
  // OCR table rows often start with a serial number. We deliberately parse
  // numbers AFTER the item name so "1 Vada Masalo 7 Kg ₹70 ₹24.50 ₹514.50"
  // yields quantity=7 and rate=70 instead of quantity=1 and rate=7.
  const nums = numericTokens(remainder);
  const pct = String(line).match(/([0-9]+(?:\.\d+)?)\s*%/);
  const gstRate = pct ? Number(pct[1]) : Number(item.gst_rate ?? 0);
  const quantity = nums[0] ?? null;
  const rate = nums[1] ?? null;
  return { item, quantity, rate, gstRate, raw };
}

function parsePurchase(text, items, suppliers) {
  const lines = String(text || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const itemLines = [];
  for (const line of lines) {
    const parsed = parseItemLine(line, items);
    if (parsed && !itemLines.some(x => x.item.id === parsed.item.id)) itemLines.push(parsed);
  }
  const supplier = (suppliers || []).find(s => {
    const n = normalize(text);
    const name = normalize(s.name);
    return name && (n.includes(name) || name.split(" ").filter(Boolean).every(w => n.includes(w)));
  }) || null;
  return {
    date: findDate(text) || today(),
    invoiceNumber: findInvoiceNumber(text),
    total: findTotal(text),
    supplier,
    items: itemLines,
  };
}

function parseExpense(text) {
  return { date: findDate(text) || today(), invoiceNumber: findInvoiceNumber(text), total: findTotal(text), merchant: "" };
}

function reviewModal({ screen, file, items = [], suppliers = [], mode, onApply }) {
  const mount = document.createElement("div");
  mount.className = "document-modal-mount";
  mount.innerHTML = `<div class="modal-backdrop"><section class="modal-card ocr-modal">
    <button type="button" class="modal-close" aria-label="Close">×</button>
    <h2>Extract from document</h2>
    <p class="muted">OCR is an assistant, not an accounting decision. Review every detected value before applying it.</p>
    <div class="form-grid">
      <div class="field"><label>Document language</label><select id="ocr-language"><option value="eng">English / printed</option><option value="guj">Gujarati</option></select></div>
      <div class="field"><label>Selected file</label><input value="${esc(file?.name || "")}" disabled></div>
    </div>
    <div class="ocr-progress"><div class="ocr-progress-bar"></div></div>
    <div class="form-status">Preparing OCR…</div>
    <div id="ocr-review" class="ocr-review hidden"></div>
    <details class="ocr-raw"><summary>Raw extracted text</summary><pre id="ocr-raw-text"></pre></details>
    <div class="ocr-actions hidden" id="ocr-actions"><button type="button" class="btn" id="ocr-cancel">Cancel</button><button type="button" class="btn btn-primary" id="ocr-apply">Apply reviewed values</button></div>
  </section></div>`;
  screen.append(mount);
  const close = () => mount.remove();
  mount.querySelector(".modal-close").onclick = close;
  mount.querySelector(".modal-backdrop").addEventListener("click", e => { if (e.target.classList.contains("modal-backdrop")) close(); });
  mount.querySelector("#ocr-cancel").onclick = close;

  const run = async () => {
    const feedback = mount.querySelector(".form-status");
    const bar = mount.querySelector(".ocr-progress-bar");
    const language = mount.querySelector("#ocr-language").value;
    try {
      const text = await extractDocumentText(file, { language, progress: (percent, message) => { bar.style.width = `${Math.max(2, Math.round(percent))}%`; feedback.textContent = message; } });
      mount.querySelector("#ocr-raw-text").textContent = text || "No readable text was detected.";
      const parsed = mode === "purchase" ? parsePurchase(text, items, suppliers) : parseExpense(text);
      renderReview(mount, parsed, mode);
      feedback.textContent = "Review the detected values, then apply them to the entry form.";
      mount.querySelector("#ocr-actions").classList.remove("hidden");
      mount.querySelector("#ocr-apply").onclick = () => { onApply?.(collectReview(mount, parsed, mode)); close(); };
    } catch (error) {
      feedback.textContent = `OCR failed: ${error.message || error}`;
      feedback.className = "form-status error";
    }
  };
  mount.querySelector("#ocr-language").addEventListener("change", () => { mount.querySelector("#ocr-actions").classList.add("hidden"); run(); });
  run();
}

function renderReview(mount, parsed, mode) {
  const host = mount.querySelector("#ocr-review");
  if (mode === "expense") {
    host.innerHTML = `<div class="ocr-grid"><div class="field"><label>Detected date</label><input data-ocr="date" type="date" value="${esc(parsed.date || "")}"></div><div class="field"><label>Detected invoice no.</label><input data-ocr="invoiceNumber" value="${esc(parsed.invoiceNumber || "")}"></div><div class="field"><label>Detected amount</label><input data-ocr="total" type="number" min="0" step="0.01" value="${parsed.total ?? ""}"></div></div>`;
  } else {
    const supplierOptions = `<option value="">No supplier match</option>${suppliers.map(s => `<option value="${s.id}" ${parsed.supplier?.id === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}`;
    host.innerHTML = `<div class="ocr-grid"><div class="field"><label>Detected date</label><input data-ocr="date" type="date" value="${esc(parsed.date || "")}"></div><div class="field"><label>Invoice no.</label><input data-ocr="invoiceNumber" value="${esc(parsed.invoiceNumber || "")}"></div><div class="field"><label>Supplier</label><select data-ocr="supplierId">${supplierOptions}</select></div><div class="field"><label>Detected total</label><input data-ocr="total" type="number" min="0" step="0.01" value="${parsed.total ?? ""}"></div></div><h3>Detected items</h3>${parsed.items.length ? `<div class="ocr-lines">${parsed.items.map((x, i) => `<div class="ocr-line" data-line-index="${i}"><div><strong>${esc(x.item.name)}</strong><small>${esc(x.raw)}</small></div><label>Qty<input data-line="qty" type="number" min="0.001" step="0.001" value="${x.quantity ?? ""}"></label><label>Invoice rate<input data-line="rate" type="number" min="0" step="0.01" value="${x.rate ?? ""}"></label><label>GST %<input data-line="gst" type="number" min="0" max="100" step="0.01" value="${x.gstRate ?? x.item.gst_rate ?? 0}"></label><label class="check-label"><input data-line="use-rate" type="checkbox" ${x.rate != null && Number(x.rate) !== Number(x.item.master_rate) ? "checked" : ""}> Use invoice rate</label><label class="check-label"><input data-line="use-gst" type="checkbox"> Use invoice GST</label></div>`).join("")}</div>` : `<p class="muted">No item could be confidently matched. You can still apply the detected header fields.</p>`}`;
  }
  host.classList.remove("hidden");
}

function collectReview(mount, parsed, mode) {
  const value = name => mount.querySelector(`[data-ocr="${name}"]`)?.value || "";
  if (mode === "expense") return { ...parsed, date: value("date"), invoiceNumber: value("invoiceNumber"), total: Number(value("total")) || null };
  return {
    ...parsed,
    date: value("date"),
    invoiceNumber: value("invoiceNumber"),
    supplierId: value("supplierId"),
    total: Number(value("total")) || null,
    items: [...mount.querySelectorAll(".ocr-line")].map((row, i) => ({
      ...parsed.items[i],
      quantity: Number(row.querySelector('[data-line="qty"]')?.value) || null,
      rate: Number(row.querySelector('[data-line="rate"]')?.value) || null,
      gstRate: Number(row.querySelector('[data-line="gst"]')?.value) || 0,
      useRate: !!row.querySelector('[data-line="use-rate"]')?.checked,
      useGst: !!row.querySelector('[data-line="use-gst"]')?.checked,
    })),
  };
}

export function openDocumentOcrReview({ screen, file, mode, items = [], suppliers = [], onApply }) {
  reviewModal({ screen, file, mode, items, suppliers, onApply });
}
