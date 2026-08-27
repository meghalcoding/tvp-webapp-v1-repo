// Shared product UI primitives: toasts, confirmations, prompts, and friendly errors.
const escUi = (v = "") => String(v).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));

function ensureUiMount() {
  let mount = document.getElementById("ui-overlays");
  if (!mount) { mount = document.createElement("div"); mount.id = "ui-overlays"; document.body.appendChild(mount); }
  return mount;
}

export function toast(message, { type = "info", duration = 4000 } = {}) {
  const host = document.getElementById("toast-region") || (() => {
    const el = document.createElement("div"); el.id = "toast-region"; el.setAttribute("aria-live", "polite"); el.setAttribute("aria-atomic", "true"); document.body.appendChild(el); return el;
  })();
  const item = document.createElement("div"); item.className = `toast toast-${type}`; item.setAttribute("role", type === "error" ? "alert" : "status");
  item.innerHTML = `<span class="toast-message"></span><button type="button" class="toast-close" aria-label="Dismiss notification">×</button>`;
  item.querySelector(".toast-message").textContent = String(message || "");
  item.querySelector(".toast-close").addEventListener("click", () => item.remove());
  host.appendChild(item);
  if (duration > 0) setTimeout(() => item.remove(), duration);
  return item;
}

export function friendlyError(error, fallback = "Something went wrong. Please try again.") {
  const raw = String(error?.message || error || "");
  const lower = raw.toLowerCase();
  if (!raw) return fallback;
  if (lower.includes("invalid login credentials") || lower.includes("invalid_credentials")) return "Email or password is incorrect.";
  if (lower.includes("email not confirmed") || lower.includes("email_not_confirmed")) return "Please confirm your email address before signing in.";
  if (lower.includes("duplicate") || lower.includes("unique")) return "That record already exists.";
  if (lower.includes("foreign key") || lower.includes("violates") || lower.includes("constraint")) return "This change conflicts with related records. Check the linked information and try again.";
  if (lower.includes("permission") || lower.includes("row-level security") || lower.includes("not authorized")) return "You don't have permission to perform this action.";
  if (lower.includes("network") || lower.includes("fetch")) return "We couldn't reach the server. Check your connection and try again.";
  return fallback;
}

function dialogFocusables(backdrop) {
  return [...backdrop.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

function openDialogLifecycle(backdrop, initialFocus) {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closed = false;
  const keydown = event => {
    if (closed) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      backdrop.dispatchEvent(new CustomEvent('ui-dialog-cancel'));
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = dialogFocusables(backdrop);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };
  window.addEventListener('keydown', keydown);
  requestAnimationFrame(() => initialFocus?.focus());
  return (afterClose) => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', keydown);
    backdrop.remove();
    afterClose?.();
    requestAnimationFrame(() => previousFocus?.focus?.());
  };
}

export function confirmDialog({ title = "Are you sure?", body = "", confirmLabel = "Continue", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise(resolve => {
    const mount = ensureUiMount();
    const backdrop = document.createElement("div"); backdrop.className = "modal-backdrop ui-dialog-backdrop";
    backdrop.innerHTML = `<section class="modal-card ui-dialog" role="dialog" aria-modal="true" aria-labelledby="ui-dialog-title">
      <div class="modal-header"><div><h2 id="ui-dialog-title"></h2></div><button type="button" class="btn btn-ghost modal-close" aria-label="Close">×</button></div>
      <div class="ui-dialog-body"></div><div class="modal-footer"><button type="button" class="btn btn-ghost" data-cancel>${escUi(cancelLabel)}</button><button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-confirm>${escUi(confirmLabel)}</button></div>
    </section>`;
    backdrop.querySelector("#ui-dialog-title").textContent = title;
    backdrop.querySelector(".ui-dialog-body").textContent = body;
    mount.appendChild(backdrop);
    let finish;
    const close = value => { if (!finish) return; const fn = finish; finish = null; fn(() => resolve(value)); };
    finish = openDialogLifecycle(backdrop, backdrop.querySelector("[data-confirm]"));
    backdrop.querySelector("[data-cancel]").addEventListener("click", () => close(false));
    backdrop.querySelector("[data-confirm]").addEventListener("click", () => close(true));
    backdrop.querySelector(".modal-close").addEventListener("click", () => close(false));
    backdrop.addEventListener("click", e => { if (e.target === backdrop) close(false); });
    backdrop.addEventListener('ui-dialog-cancel', () => close(false));
  });
}

export function promptDialog({ title = "Enter details", label = "Details", value = "", placeholder = "", submitLabel = "Save", required = false } = {}) {
  return new Promise(resolve => {
    const mount = ensureUiMount();
    const backdrop = document.createElement("div"); backdrop.className = "modal-backdrop ui-dialog-backdrop";
    backdrop.innerHTML = `<form class="modal-card ui-dialog" role="dialog" aria-modal="true" aria-labelledby="ui-prompt-title">
      <div class="modal-header"><div><h2 id="ui-prompt-title"></h2></div><button type="button" class="btn btn-ghost modal-close" aria-label="Close">×</button></div>
      <div class="field"><label></label><textarea name="value" rows="4" placeholder=""></textarea></div>
      <div class="modal-footer"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" type="submit"></button></div>
    </form>`;
    backdrop.querySelector("#ui-prompt-title").textContent = title;
    backdrop.querySelector("label").textContent = label;
    const input = backdrop.querySelector("textarea"); input.value = value; input.placeholder = placeholder; input.required = required;
    mount.appendChild(backdrop);
    let finish;
    const close = result => { if (!finish) return; const fn = finish; finish = null; fn(() => resolve(result)); };
    finish = openDialogLifecycle(backdrop, input);
    backdrop.querySelector("[data-cancel]").addEventListener("click", () => close(null));
    backdrop.querySelector(".modal-close").addEventListener("click", () => close(null));
    backdrop.querySelector("form").addEventListener("submit", e => { e.preventDefault(); close(input.value); });
    backdrop.addEventListener('ui-dialog-cancel', () => close(null));
    backdrop.addEventListener("click", e => { if (e.target === backdrop) close(null); });
  });
}

export function attachDropdown(trigger, menu, { openClass = "is-open" } = {}) {
  if (!trigger || !menu) return () => {};
  let open = false;
  const setOpen = (next, restoreFocus = false) => {
    open = next;
    menu.classList.toggle("hidden", !open);
    trigger.setAttribute("aria-expanded", String(open));
    trigger.classList.toggle(openClass, open);
    if (open) document.addEventListener("click", onDocumentClick, true);
    else document.removeEventListener("click", onDocumentClick, true);
    if (!open && restoreFocus) trigger.focus();
  };
  const onDocumentClick = event => {
    if (!open || trigger.contains(event.target) || menu.contains(event.target)) return;
    setOpen(false);
  };
  const onKeydown = event => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); setOpen(false, true);
  };
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", event => { event.stopPropagation(); setOpen(!open); });
  document.addEventListener("keydown", onKeydown);
  return () => { document.removeEventListener("click", onDocumentClick, true); document.removeEventListener("keydown", onKeydown); setOpen(false); };
}

export function wireScreenTabs(screen, { tabSelector = ".screen-tab", panelAttr = "data-tab-panel" } = {}) {
  const tabs = [...screen.querySelectorAll(tabSelector)];
  tabs.forEach(tab => tab.addEventListener("click", () => {
    tabs.forEach(t => t.classList.toggle("is-active", t === tab));
    screen.querySelectorAll(`[${panelAttr}]`).forEach(panel => {
      panel.classList.toggle("hidden", panel.getAttribute(panelAttr) !== tab.dataset.tab);
    });
  }));
}

export function createItemCombobox(input, getItems, { onSelect, getSubtitle = () => "" } = {}) {
  if (!input) return { refresh() {} };
  const wrap = input.parentElement;
  wrap.classList.add("combobox");
  const menu = document.createElement("div");
  menu.className = "combobox-menu hidden";
  wrap.appendChild(menu);
  let activeIndex = -1, matches = [];
  const highlight = (name, q) => {
    const i = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i === -1) return escUi(name);
    return `${escUi(name.slice(0, i))}<mark>${escUi(name.slice(i, i + q.length))}</mark>${escUi(name.slice(i + q.length))}`;
  };
  const render = raw => {
    const q = raw.trim();
    const items = getItems();
    matches = (q ? items.filter(i => i.name.toLowerCase().includes(q.toLowerCase())) : items).slice(0, 8);
    menu.innerHTML = matches.length ? matches.map((item, i) => `<button type="button" class="combobox-option ${i === activeIndex ? "is-active" : ""}" data-index="${i}"><span class="combobox-option-name">${highlight(item.name, q)}</span><span class="combobox-option-sub">${escUi(getSubtitle(item) || "")}</span></button>`).join("") : `<div class="combobox-empty">No matching items</div>`;
    menu.classList.remove("hidden");
    menu.querySelectorAll(".combobox-option").forEach(btn => btn.addEventListener("mousedown", e => { e.preventDefault(); choose(matches[Number(btn.dataset.index)]); }));
  };
  const choose = item => { if (!item) return; input.value = item.name; menu.classList.add("hidden"); activeIndex = -1; onSelect?.(item); };
  input.addEventListener("input", () => { activeIndex = -1; render(input.value); if (!input.value) onSelect?.(null); });
  input.addEventListener("focus", () => render(input.value));
  input.addEventListener("keydown", e => {
    if (menu.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, matches.length - 1); render(input.value); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); render(input.value); }
    else if (e.key === "Enter") { if (activeIndex >= 0) { e.preventDefault(); choose(matches[activeIndex]); } }
    else if (e.key === "Escape") { menu.classList.add("hidden"); }
  });
  document.addEventListener("click", e => { if (!wrap.contains(e.target)) menu.classList.add("hidden"); });
  return { refresh: () => render(input.value) };
}

export function setButtonLoading(button, loading, loadingLabel = "Working…") {
  if (!button) return;
  if (loading) { button.dataset.originalLabel = button.textContent; button.disabled = true; button.classList.add("is-loading"); button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escUi(loadingLabel)}</span>`; }
  else { button.disabled = false; button.classList.remove("is-loading"); button.textContent = button.dataset.originalLabel || button.textContent; delete button.dataset.originalLabel; }
}

