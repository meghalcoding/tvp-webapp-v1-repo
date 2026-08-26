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
  if (lower.includes("duplicate") || lower.includes("unique")) return "That record already exists.";
  if (lower.includes("foreign key") || lower.includes("violates") || lower.includes("constraint")) return "This change conflicts with related records. Check the linked information and try again.";
  if (lower.includes("permission") || lower.includes("row-level security") || lower.includes("not authorized")) return "You don't have permission to perform this action.";
  if (lower.includes("network") || lower.includes("fetch")) return "We couldn't reach the server. Check your connection and try again.";
  return fallback;
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
    const close = value => { backdrop.remove(); resolve(value); };
    backdrop.querySelector("[data-cancel]").addEventListener("click", () => close(false));
    backdrop.querySelector("[data-confirm]").addEventListener("click", () => close(true));
    backdrop.querySelector(".modal-close").addEventListener("click", () => close(false));
    backdrop.addEventListener("click", e => { if (e.target === backdrop) close(false); });
    requestAnimationFrame(() => backdrop.querySelector("[data-confirm]")?.focus());
  });
}

export function promptDialog({ title = "Enter details", label = "Details", value = "", placeholder = "", submitLabel = "Save", required = false } = {}) {
  return new Promise(resolve => {
    const mount = ensureUiMount();
    const backdrop = document.createElement("div"); backdrop.className = "modal-backdrop ui-dialog-backdrop";
    backdrop.innerHTML = `<form class="modal-card ui-dialog" role="dialog" aria-modal="true">
      <div class="modal-header"><div><h2></h2></div><button type="button" class="btn btn-ghost modal-close" aria-label="Close">×</button></div>
      <div class="field"><label></label><textarea name="value" rows="4" placeholder=""></textarea></div>
      <div class="modal-footer"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" type="submit"></button></div>
    </form>`;
    backdrop.querySelector("h2").textContent = title;
    backdrop.querySelector("label").textContent = label;
    const input = backdrop.querySelector("textarea"); input.value = value; input.placeholder = placeholder; input.required = required;
    backdrop.querySelector("[data-cancel]").addEventListener("click", () => { backdrop.remove(); resolve(null); });
    backdrop.querySelector(".modal-close").addEventListener("click", () => { backdrop.remove(); resolve(null); });
    backdrop.querySelector("form").addEventListener("submit", e => { e.preventDefault(); backdrop.remove(); resolve(input.value); });
    mount.appendChild(backdrop); requestAnimationFrame(() => input.focus());
  });
}

export function setButtonLoading(button, loading, loadingLabel = "Working…") {
  if (!button) return;
  if (loading) { button.dataset.originalLabel = button.textContent; button.disabled = true; button.classList.add("is-loading"); button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escUi(loadingLabel)}</span>`; }
  else { button.disabled = false; button.classList.remove("is-loading"); button.textContent = button.dataset.originalLabel || button.textContent; delete button.dataset.originalLabel; }
}

window.__toast = toast;
window.__confirmDialog = confirmDialog;
window.__promptDialog = promptDialog;
window.__friendlyError = friendlyError;
window.__setButtonLoading = setButtonLoading;
