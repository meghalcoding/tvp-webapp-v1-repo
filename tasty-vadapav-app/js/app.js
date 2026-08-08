import { supabase, IS_CONFIGURED } from "./supabase-client.js";
import { signIn, signOut, getSession, getCurrentAppUser, onAuthStateChange, canDo } from "./auth.js";
import { exportFullBackup, exportModuleBackups } from "./backup.js";
import { getPendingCount, syncOutbox } from "./offline-queue.js";

// ============================================================================
// NAV TREE — exactly the structure in spec §15
// Each item: { path, label, icon, phase } — phase is shown on not-yet-built
// screens so the team always knows what's real vs. planned.
// ============================================================================
const NAV = [
  { group: null, items: [{ path: "dashboard", label: "Dashboard", icon: "▣" }] },
  {
    group: "Operations",
    items: [
      { path: "sales", label: "Sales", icon: "₹", phase: "Phase 3 — Daily Operations" },
      { path: "purchases", label: "Purchases", icon: "▤", phase: "Phase 4 — Procurement & Inventory" },
      { path: "expenses", label: "Expenses", icon: "✎", phase: "Phase 3 — Daily Operations" },
      { path: "inventory", label: "Inventory", icon: "▦", phase: "Phase 4 — Procurement & Inventory" },
      { path: "wastage", label: "Wastage", icon: "✕", phase: "Phase 4 — Procurement & Inventory" },
      { path: "daily-closing", label: "Daily Closing", icon: "✓", phase: "Phase 3 — Daily Operations" },
    ],
  },
  {
    group: "Money",
    items: [
      { path: "accounts", label: "Cash & Accounts", icon: "$", phase: "Phase 2 — Financial Engine" },
      { path: "upi", label: "UPI Reconciliation", icon: "⇄", phase: "Phase 3 — Daily Operations" },
      { path: "transfers", label: "Transfers", icon: "→", phase: "Phase 2 — Financial Engine" },
      { path: "supplier-dues", label: "Supplier Dues", icon: "⌘", phase: "Phase 4 — Procurement & Inventory" },
    ],
  },
  {
    group: "Reports",
    items: [
      { path: "report-daily", label: "Daily Report", icon: "▤", phase: "Phase 5 — Reporting" },
      { path: "report-sales", label: "Sales Report", icon: "▤", phase: "Phase 5 — Reporting" },
      { path: "report-purchase", label: "Purchase Report", icon: "▤", phase: "Phase 5 — Reporting" },
      { path: "report-expense", label: "Expense Report", icon: "▤", phase: "Phase 5 — Reporting" },
      { path: "report-stock", label: "Stock Report", icon: "▤", phase: "Phase 5 — Reporting" },
      { path: "report-pl", label: "P&L", icon: "▤", phase: "Phase 5 — Reporting" },
      { path: "report-gst", label: "GST Summary", icon: "▤", phase: "Phase 5 — Reporting" },
    ],
  },
  {
    group: "Masters",
    items: [
      { path: "master-items", label: "Items", icon: "•", phase: "Phase 4 — Procurement & Inventory" },
      { path: "master-suppliers", label: "Suppliers", icon: "•", phase: "Phase 4 — Procurement & Inventory" },
      { path: "master-categories", label: "Expense Categories", icon: "•", phase: "Phase 2 — Financial Engine" },
      { path: "master-accounts", label: "Accounts", icon: "•", phase: "Phase 2 — Financial Engine" },
      { path: "master-users", label: "Users", icon: "•", phase: "Phase 2 — Financial Engine" },
    ],
  },
  {
    group: "System",
    items: [
      { path: "backup", label: "Backup", icon: "⇩" },
      { path: "audit-log", label: "Audit Log", icon: "≡", phase: "Phase 2 — Financial Engine" },
      { path: "settings", label: "Settings", icon: "⚙" },
    ],
  },
];
const ALL_ITEMS = NAV.flatMap((g) => g.items);
const BOTTOM_NAV_PATHS = ["dashboard", "sales", "expenses", "backup"]; // "More" covers the rest on mobile

let currentAppUser = null;

// ============================================================================
// BOOTSTRAP
// ============================================================================
async function boot() {
  wireLoginForm();
  wireOnlineOfflineBanners();

  const session = await getSession();
  if (session) await enterApp();
  else showLogin();

  onAuthStateChange(async (session) => {
    if (session) await enterApp();
    else showLogin();
  });
}

function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app-shell").classList.add("hidden");
}

async function enterApp() {
  currentAppUser = await getCurrentAppUser(true);
  if (!currentAppUser) {
    document.getElementById("login-error").textContent =
      "Signed in, but no profile exists for this account yet. Ask the Owner to add you in Masters → Users.";
    await signOut();
    showLogin();
    return;
  }
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  renderUserBadges();
  renderNav();
  window.addEventListener("hashchange", renderRoute);
  renderRoute();
  trySync();
}

function wireLoginForm() {
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const errEl = document.getElementById("login-error");
    errEl.textContent = "";
    if (!IS_CONFIGURED) {
      errEl.textContent = "Supabase isn't connected yet — set SUPABASE_URL / SUPABASE_ANON_KEY in js/config.js.";
      return;
    }
    try {
      await signIn(email, password);
    } catch (err) {
      errEl.textContent = err.message || "Sign-in failed.";
    }
  });
}

function renderUserBadges() {
  const html = `${currentAppUser.name} <span class="role-pill">${currentAppUser.role}</span>
    <button class="btn" id="logout-btn" style="padding:3px 9px;font-size:0.75rem;">Sign out</button>`;
  document.getElementById("topbar-user-badge").innerHTML = html;
  document.getElementById("desktop-user-badge").innerHTML = html;
  document.querySelectorAll("#logout-btn").forEach((b) => b.addEventListener("click", () => signOut()));
}

// ============================================================================
// NAV RENDERING
// ============================================================================
function renderNav() {
  const sidebar = document.getElementById("sidebar-nav");
  sidebar.innerHTML = NAV.map(
    (group) => `
    <div class="nav-group">
      ${group.group ? `<div class="nav-group-label">${group.group}</div>` : ""}
      ${group.items.map(navLinkHtml).join("")}
    </div>`
  ).join("");

  const bottom = document.getElementById("bottom-nav");
  const bottomItems = ALL_ITEMS.filter((i) => BOTTOM_NAV_PATHS.includes(i.path));
  bottomItems.push({ path: "more", label: "More", icon: "☰" });
  bottom.innerHTML = bottomItems.map(navLinkHtml).join("");

  document.querySelectorAll(".nav-link").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const path = el.dataset.path;
      if (path === "more") {
        // simplest mobile "more" behaviour for the foundation phase: jump to
        // Reports index-ish screen (a full drawer can be added in a later pass)
        location.hash = "#/master-items";
      } else {
        location.hash = `#/${path}`;
      }
    });
  });
}

function navLinkHtml(item) {
  return `<a href="#/${item.path}" class="nav-link" data-path="${item.path}">
    <span class="icon">${item.icon}</span><span class="label">${item.label}</span>
  </a>`;
}

function setActiveNav(path) {
  document.querySelectorAll(".nav-link").forEach((el) => {
    el.classList.toggle("active", el.dataset.path === path);
  });
}

// ============================================================================
// ROUTER
// ============================================================================
function currentPath() {
  return (location.hash.replace(/^#\//, "") || "dashboard").split("?")[0];
}

async function renderRoute() {
  const path = currentPath();
  setActiveNav(path);
  const screen = document.getElementById("screen");
  screen.innerHTML = `<div class="placeholder-screen">Loading…</div>`;

  const renderers = {
    dashboard: renderDashboard,
    backup: renderBackupScreen,
    settings: renderSettingsScreen,
  };

  if (renderers[path]) {
    try {
      await renderers[path](screen);
    } catch (err) {
      screen.innerHTML = `<div class="placeholder-screen"><h2>Something went wrong</h2><p>${err.message}</p></div>`;
    }
    return;
  }

  const item = ALL_ITEMS.find((i) => i.path === path);
  renderPlaceholder(screen, item);
}

function renderPlaceholder(screen, item) {
  if (!item) {
    screen.innerHTML = `<div class="placeholder-screen"><h2>Not found</h2></div>`;
    return;
  }
  screen.innerHTML = `
    <div class="placeholder-screen">
      <div class="phase-tag">${item.phase || "Coming soon"}</div>
      <h2>${item.label}</h2>
      <p>This screen is defined in the specification (§2) but hasn't been built yet.
      It ships in <strong>${item.phase || "a later phase"}</strong> of the roadmap.</p>
    </div>`;
}

// ============================================================================
// DASHBOARD — reads the live views defined in db/schema.sql. Shows a
// "connect Supabase" state until js/config.js has real credentials, and an
// empty-but-correct state once connected with no data yet.
// ============================================================================
async function renderDashboard(screen) {
  if (!IS_CONFIGURED) {
    screen.innerHTML = notConfiguredCard();
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  const [{ data: accounts, error: accErr }, { data: stock, error: stockErr }, { data: upi, error: upiErr }] =
    await Promise.all([
      supabase.from("account_balances").select("*").order("name"),
      supabase.from("current_stock").select("*").order("name"),
      supabase.from("upi_reconciliation").select("*").order("name"),
    ]);

  if (accErr || stockErr || upiErr) {
    screen.innerHTML = `<div class="placeholder-screen"><h2>Couldn't load the dashboard</h2>
      <p>${accErr?.message || stockErr?.message || upiErr?.message}</p>
      <p style="font-size:0.8rem;">If this is a brand-new project, make sure you've run db/schema.sql,
      db/rls_policies.sql, and db/seed.sql, and that your signed-in user has a row in the users table.</p>
      </div>`;
    return;
  }

  const cash = accounts?.find((a) => a.name === "Cash Drawer");
  const bank = accounts?.find((a) => a.name === "Cravory Bank");
  const upiPendingTotal = (upi || []).reduce((s, r) => s + Number(r.pending || 0), 0);
  const lowStock = (stock || []).filter((s) => Number(s.quantity) <= Number(s.reorder_level));

  screen.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <div class="card-title">Cash Position</div>
        <div class="stat-row"><span class="stat-label">Cash Drawer</span><span class="stat-value">₹${fmt(cash?.balance)}</span></div>
        <div class="stat-row"><span class="stat-label">UPI Pending Settlement</span><span class="stat-value negative">₹${fmt(upiPendingTotal)}</span></div>
        <div class="stat-row"><span class="stat-label">Cravory Bank</span><span class="stat-value positive">₹${fmt(bank?.balance)}</span></div>
      </div>
      <div class="card">
        <div class="card-title">UPI Collection Accounts</div>
        ${(upi || [])
          .map(
            (r) => `<div class="stat-row"><span class="stat-label">${r.name}</span>
              <span class="stat-value ${Number(r.pending) > 0 ? "negative" : "positive"}">₹${fmt(r.pending)}
              <span class="stamp ${Number(r.pending) > 0 ? "pending" : "settled"}" style="margin-left:6px;">
                ${Number(r.pending) > 0 ? "Pending" : "Settled"}</span></span></div>`
          )
          .join("") || emptyRow("No collection accounts yet")}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Inventory Alerts</div>
      ${lowStock.length
        ? lowStock
            .map(
              (s) => `<div class="stat-row"><span class="stat-label">${s.name}</span>
                <span class="stamp pending">Low</span></div>`
            )
            .join("")
        : emptyRow("Nothing low yet — items appear here once purchases are recorded (Phase 4).")}
    </div>

    <div class="card">
      <div class="card-title">Quick Actions</div>
      <div class="fab-row">
        <button class="btn btn-primary" disabled title="Ships in Phase 3">+ Sale</button>
        <button class="btn btn-primary" disabled title="Ships in Phase 4">+ Purchase</button>
        <button class="btn btn-primary" disabled title="Ships in Phase 3">+ Expense</button>
        <button class="btn" disabled title="Ships in Phase 2">+ Money Transfer</button>
        <button class="btn" disabled title="Ships in Phase 4">+ Stock Adjustment</button>
        <button class="btn" disabled title="Ships in Phase 3">+ Daily Closing</button>
      </div>
      <p style="font-size:0.78rem;color:var(--steel);margin-top:10px;margin-bottom:0;">
        Quick Actions are wired up to their real forms starting Phase 2. This dashboard already reads
        live data from Supabase — try recording a row directly in the Supabase table editor to see it appear here.
      </p>
    </div>`;
}

function notConfiguredCard() {
  return `<div class="placeholder-screen">
    <div class="phase-tag">Setup needed</div>
    <h2>Connect Supabase</h2>
    <p>Open <code>js/config.js</code> and set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code>
    from your Supabase project's Settings → API page, then reload.</p>
    <p style="font-size:0.8rem;">See README.md for the full setup checklist (schema, RLS, seed data, first user).</p>
  </div>`;
}

function emptyRow(text) {
  return `<div class="stat-row"><span class="stat-label" style="color:var(--steel);">${text}</span></div>`;
}

function fmt(n) {
  return Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ============================================================================
// BACKUP SCREEN — the one fully functional "System" screen in Phase 1
// ============================================================================
function renderBackupScreen(screen) {
  const allowed = canDo(currentAppUser, "export_backup");
  screen.innerHTML = `
    <div class="card">
      <div class="card-title">Backup</div>
      <p>Supabase's free tier doesn't guarantee automatic backups, so backup is a feature of this app, not
      an assumption about the hosting (spec §13). Export regularly — weekly at minimum, and always after
      closing the books on the 1st of the month.</p>
      <div class="fab-row">
        <button class="btn btn-primary" id="btn-full-backup" ${allowed ? "" : "disabled"}>⇩ Export Full Backup (JSON)</button>
        <button class="btn" id="btn-module-backup" ${allowed ? "" : "disabled"}>⇩ Export Module Backups (CSV)</button>
      </div>
      ${allowed ? "" : `<p style="font-size:0.8rem;color:var(--chutney-red);margin-top:10px;">Only the Owner can export or restore backups.</p>`}
      <div id="backup-status" style="font-size:0.85rem;margin-top:12px;"></div>
    </div>`;

  document.getElementById("btn-full-backup")?.addEventListener("click", async () => {
    const status = document.getElementById("backup-status");
    status.textContent = "Exporting full backup…";
    try {
      await exportFullBackup();
      status.textContent = "Full backup downloaded.";
    } catch (err) {
      status.textContent = `Backup failed: ${err.message}`;
    }
  });

  document.getElementById("btn-module-backup")?.addEventListener("click", async () => {
    const status = document.getElementById("backup-status");
    status.textContent = "Exporting module backups…";
    try {
      await exportModuleBackups();
      status.textContent = "Module backups downloaded.";
    } catch (err) {
      status.textContent = `Backup failed: ${err.message}`;
    }
  });
}

function renderSettingsScreen(screen) {
  screen.innerHTML = `
    <div class="card">
      <div class="card-title">Settings</div>
      <div class="stat-row"><span class="stat-label">Business</span><span class="stat-value">Tasty Vadapav (Cravory Hospitality LLP)</span></div>
      <div class="stat-row"><span class="stat-label">Signed in as</span><span class="stat-value">${currentAppUser.name} (${currentAppUser.role})</span></div>
      <div class="stat-row"><span class="stat-label">Supabase connection</span><span class="stat-value ${IS_CONFIGURED ? "positive" : "negative"}">${IS_CONFIGURED ? "Connected" : "Not configured"}</span></div>
    </div>
    <div class="card">
      <div class="card-title">Coming later</div>
      <p style="font-size:0.85rem;">GST number, reorder-level defaults, and currency/number-format settings are
      part of the Masters/Settings work in Phase 2+.</p>
    </div>`;
}

// ============================================================================
// OFFLINE / SYNC BANNERS (spec §14)
// ============================================================================
function wireOnlineOfflineBanners() {
  const offlineBanner = document.getElementById("offline-banner");
  const syncBanner = document.getElementById("sync-banner");

  function update() {
    offlineBanner.classList.toggle("hidden", navigator.onLine);
  }
  window.addEventListener("online", async () => {
    update();
    await trySync();
  });
  window.addEventListener("offline", update);
  update();

  window.__showSyncBanner = (text) => {
    syncBanner.textContent = text;
    syncBanner.classList.remove("hidden");
  };
  window.__hideSyncBanner = () => syncBanner.classList.add("hidden");
}

async function trySync() {
  const pending = await getPendingCount().catch(() => 0);
  if (pending === 0) return;
  window.__showSyncBanner?.(`Syncing ${pending} transaction${pending === 1 ? "" : "s"}…`);
  // Real writers (sale/expense/wastage) are registered once those screens
  // exist (Phase 3/4). For now this just reports the pending count so
  // nothing is silently lost while offline in the foundation phase.
  const { synced, total } = await syncOutbox({}, (done, tot) => {
    window.__showSyncBanner?.(`Syncing ${done}/${tot} transactions…`);
  }).catch(() => ({ synced: 0, total: pending }));
  if (synced === total) window.__hideSyncBanner?.();
}

// ============================================================================
// SERVICE WORKER
// ============================================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed:", err));
  });
}

boot();
