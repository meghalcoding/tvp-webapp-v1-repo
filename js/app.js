import { supabase, IS_CONFIGURED } from "./supabase-client.js";
import { signIn, signOut, getSession, getCurrentAppUser, onAuthStateChange, canDo } from "./auth.js";
import { exportFullBackup, exportModuleBackups } from "./backup.js";
import { getPendingCount, syncOutbox } from "./offline-queue.js";
import { renderAccountsScreen, renderTransfersScreen, renderLedgerScreen, renderAuditLogScreen } from "./financial-engine.js";
import { renderSalesScreen, renderExpensesScreen, renderUpiScreen, renderDailyClosingScreen } from "./daily-operations.js";
import { renderPurchasesScreen, renderInventoryScreen, renderItemMasterScreen, renderItemRelationshipsScreen, renderWastageScreen, renderSupplierDuesScreen, renderSupplierMasterScreen } from "./procurement-inventory.js";
import { renderDailyReport, renderSalesReport, renderPurchaseReport, renderExpenseReport, renderStockReport, renderPlReport, renderGstReport, renderUpiReport, renderSupplierReport, dashboardToday } from "./reporting.js";
import { renderExpenseCategoriesScreen, renderUsersScreen, renderAutomationScreen } from "./automation.js";
import { renderMasterCategoriesScreen, renderSupplierMasterEnhanced } from "./master-data.js";
import { renderDocumentsScreen } from "./documents.js";
import { renderMarketplaceImportScreen } from "./marketplace-imports.js";
import { renderBudgetScreen } from "./budget.js";
import { toast, confirmDialog, promptDialog, friendlyError, setButtonLoading } from "./ui.js";

// ============================================================================
// NAV TREE — exactly the structure in spec §15
// Each item: { path, label, icon, phase } — phase is shown on not-yet-built
// screens so the team always knows what's real vs. planned.
// ============================================================================
const ICONS = {
  dashboard:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  sales:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h9l3 3v17H6z"/><path d="M15 2v4h4M9 11h6M9 15h6M9 19h4"/></svg>',
  purchases:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18M5 5l1 15h12l1-15M9 9v7M15 9v7"/></svg>',
  expenses:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h5"/></svg>',
  inventory:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10"/></svg>',
  closing:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg>',
  money:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M3 9h2M19 9h2"/></svg>',
  ledger:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg>',
  upi:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10M17 7l-3-3M17 7l-3 3M17 17H7M7 17l3-3M7 17l3 3"/></svg>',
  supplier:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V5l8-2 8 2v16M4 9h16M8 13h2M14 13h2M8 17h2M14 17h2"/></svg>',
  documents:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6zM15 3v4h4M9 12h6M9 16h6"/></svg>',
  report:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  masters:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="3"/><circle cx="16" cy="16" r="3"/><path d="M10 10l4 4"/></svg>',
  admin:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2 2 3-.3.8 2.9 2.5 1.5-1.2 2.7 1.2 2.7-2.5 1.5-.8 2.9-3-.3-2 2-2-2-3 .3-.8-2.9-2.5-1.5 1.2-2.7-1.2-2.7 2.5-1.5.8-2.9 3 .3z"/><circle cx="12" cy="12" r="3"/></svg>',
  more:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>'
};
const NAV = [
 {group:'Overview', items:[{path:'dashboard',label:'Dashboard',icon:'dashboard'}]},
 {group:'Operations', items:[{path:'sales',label:'Sales',icon:'sales'},{path:'purchases',label:'Purchases',icon:'purchases'},{path:'expenses',label:'Expenses',icon:'expenses'},{path:'inventory',label:'Inventory',icon:'inventory'},{path:'daily-closing',label:'Daily Closing',icon:'closing'},{path:'marketplace-imports',label:'Marketplace Imports',icon:'purchases',secondary:true},{path:'budget',label:'Budget & Forecasting',icon:'ledger',secondary:true},{path:'wastage',label:'Wastage',icon:'expenses',secondary:true}]},
 {group:'Money', items:[{path:'accounts',label:'Cash & Accounts',icon:'money'},{path:'ledger',label:'Transaction Ledger',icon:'ledger'},{path:'upi',label:'UPI Reconciliation',icon:'upi'},{path:'supplier-dues',label:'Supplier Dues',icon:'supplier'},{path:'transfers',label:'Transfers',icon:'money',secondary:true},{path:'documents',label:'Documents',icon:'documents',secondary:true}]},
 {group:'Insights', items:[{path:'reports',label:'Reports',icon:'report'}]},
 {group:'Admin', items:[{path:'master-categories',label:'Categories',icon:'masters'},{path:'master-items',label:'Items',icon:'masters'},{path:'master-suppliers',label:'Suppliers',icon:'supplier'},{path:'master-relations',label:'Item Relationships',icon:'masters',secondary:true},{path:'master-accounts',label:'Accounts',icon:'money',secondary:true},{path:'master-users',label:'Users',icon:'admin',secondary:true},{path:'automation',label:'Automation',icon:'admin',secondary:true},{path:'backup',label:'Backup',icon:'documents',secondary:true},{path:'audit-log',label:'Audit Log',icon:'ledger',secondary:true},{path:'settings',label:'Settings',icon:'admin',secondary:true}]},
];
const ALL_ITEMS = NAV.flatMap(g => g.items);
const BOTTOM_NAV_PATHS = ['dashboard','sales','expenses','purchases'];
let currentAppUser = null;

// ============================================================================
// BOOTSTRAP
// ============================================================================
async function boot() {
  wireLoginForm();
  wireOnlineOfflineBanners();

  try {
    const session = await getSession();
    if (session) await enterApp();
    else showLogin();

    onAuthStateChange(async (event, session) => {
      try {
        if (event === "SIGNED_OUT" || !session) { showLogin(); return; }
        // SIGNED_IN/USER_UPDATED can require a bootstrap; token refreshes are
        // deliberately ignored by auth.js so the active form remains intact.
        if (event === "SIGNED_IN" || event === "USER_UPDATED" || event === "INITIAL_SESSION") {
          if (document.getElementById("app-shell")?.classList.contains("hidden") || !currentAppUser) await enterApp();
        }
      } catch (error) {
        console.error("Auth state handling failed:", error);
        showAuthError(error);
      }
    });
  } catch (error) {
    console.error("Application bootstrap failed:", error);
    showAuthError(error);
  }
}

function showAuthError(error) {
  const el = document.getElementById("login-error");
  if (!el) return;
  const message = error?.message || error?.error_description || String(error || "Unknown error");
  el.textContent = `Unable to initialize your account session: ${message}`;
  document.getElementById("login-screen")?.classList.remove("hidden");
  document.getElementById("app-shell")?.classList.add("hidden");
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
  window.__appUser = currentAppUser;
  renderUserBadges();
  renderNav();
  if (!window.__routeListenerBound) {
    window.addEventListener("hashchange", renderRoute);
    window.__routeListenerBound = true;
  }
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
    const submit = e.currentTarget.querySelector("button[type=submit]");
    setButtonLoading(submit, true, "Signing in…");
    try {
      await signIn(email, password);
    } catch (err) {
      console.error("Sign-in failed:", err);
      errEl.textContent = "Sign-in failed. Check your email and password and try again.";
    } finally { setButtonLoading(submit, false); }
  });
}

function renderUserBadges() {
  const html = `${currentAppUser.name} <span class="role-pill">${currentAppUser.role}</span>
    <button class="btn btn-small btn-ghost" id="logout-btn">Sign out</button>`;
  document.getElementById("topbar-user-badge").innerHTML = html;
  document.getElementById("desktop-user-badge").innerHTML = html;
  document.querySelectorAll("#logout-btn").forEach((b) => b.addEventListener("click", () => signOut()));
}

// ============================================================================
// NAV RENDERING
// ============================================================================
function renderNav() {
  const sidebar = document.getElementById('sidebar-nav');
  sidebar.innerHTML = `<div class="nav-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input id="nav-search" type="search" placeholder="Search menu…" aria-label="Search menu"></div>` + NAV.map((group, gi) => `
    <section class="nav-group ${gi ? '' : 'nav-group-first'}" data-nav-group="${group.group}">
      <button type="button" class="nav-group-toggle" aria-expanded="true"><span>${group.group}</span><span class="nav-chevron">⌄</span></button>
      <div class="nav-group-items">${group.items.map(navLinkHtml).join('')}</div>
    </section>`).join('');
  sidebar.querySelectorAll('.nav-group-toggle').forEach(btn => btn.addEventListener('click', () => { const expanded = btn.getAttribute('aria-expanded') === 'true'; btn.setAttribute('aria-expanded', String(!expanded)); btn.closest('.nav-group').classList.toggle('is-collapsed', expanded); }));
  sidebar.querySelector('#nav-search')?.addEventListener('input', e => { const q = e.target.value.trim().toLowerCase(); sidebar.querySelectorAll('.nav-link').forEach(a => a.classList.toggle('nav-hidden', q && !a.textContent.toLowerCase().includes(q))); sidebar.querySelectorAll('.nav-group').forEach(g => { const visible = [...g.querySelectorAll('.nav-link')].some(a => !a.classList.contains('nav-hidden')); g.classList.toggle('nav-search-empty', !visible); if(q && visible) g.classList.remove('is-collapsed'); }); });
  const navSearch=sidebar.querySelector('#nav-search'); window.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();navSearch?.focus();navSearch?.select();}});
  sidebar.querySelectorAll('.nav-group').forEach(group => { const items = group.querySelectorAll('.nav-link.secondary'); if(items.length) { const more = document.createElement('button'); more.type='button'; more.className='nav-show-more'; more.textContent='Show more'; more.addEventListener('click',()=>{ group.classList.toggle('show-secondary'); more.textContent=group.classList.contains('show-secondary')?'Show less':'Show more'; }); group.querySelector('.nav-group-items').appendChild(more); } });
  const bottom = document.getElementById('bottom-nav');
  bottom.innerHTML = BOTTOM_NAV_PATHS.map(path => navLinkHtml(ALL_ITEMS.find(i=>i.path===path))).join('') + navLinkHtml({path:'more',label:'More',icon:'more'});
  document.querySelectorAll('.nav-link').forEach(el => el.addEventListener('click', e => { e.preventDefault(); const path=el.dataset.path; location.hash = `#/${path}`; }));
}
function navLinkHtml(item) { return `<a href="#/${item.path}" class="nav-link ${item.secondary?'secondary':''}" data-path="${item.path}"><span class="icon">${ICONS[item.icon] || ICONS.masters}</span><span class="label">${item.label}</span></a>`; }
function setActiveNav(path) { const active = path === 'reports' || path.startsWith('report-') ? 'reports' : path; document.querySelectorAll('.nav-link').forEach(el => el.classList.toggle('active', el.dataset.path === active)); }

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
    accounts: (target) => renderAccountsScreen(target, currentAppUser),
    "master-accounts": (target) => renderAccountsScreen(target, currentAppUser),
    transfers: (target) => renderTransfersScreen(target, currentAppUser),
    ledger: (target) => renderLedgerScreen(target, currentAppUser),
    "audit-log": (target) => renderAuditLogScreen(target, currentAppUser),
    sales: (target) => renderSalesScreen(target, currentAppUser),
    "marketplace-imports": (target) => renderMarketplaceImportScreen(target, currentAppUser),
    budget: (target) => renderBudgetScreen(target, currentAppUser),
    expenses: (target) => renderExpensesScreen(target, currentAppUser),
    upi: (target) => renderUpiScreen(target, currentAppUser),
    "daily-closing": (target) => renderDailyClosingScreen(target, currentAppUser),
    purchases: (target) => renderPurchasesScreen(target, currentAppUser),
    inventory: (target) => renderInventoryScreen(target, currentAppUser),
    wastage: (target) => renderWastageScreen(target, currentAppUser),
    "supplier-dues": (target) => renderSupplierDuesScreen(target, currentAppUser),
    documents: (target) => renderDocumentsScreen(target, currentAppUser),
    "master-items": (target) => renderItemMasterScreen(target, currentAppUser),
    "master-relations": (target) => renderItemRelationshipsScreen(target, currentAppUser),
    "master-suppliers": (target) => renderSupplierMasterEnhanced(target, currentAppUser),
    "master-categories": (target) => renderMasterCategoriesScreen(target, currentAppUser),
    "master-users": (target) => renderUsersScreen(target, currentAppUser),
    automation: (target) => renderAutomationScreen(target, currentAppUser),
    "report-daily": renderDailyReport,
    "report-sales": renderSalesReport,
    "report-purchase": renderPurchaseReport,
    "report-expense": renderExpenseReport,
    "report-stock": renderStockReport,
    "report-pl": renderPlReport,
    "report-gst": renderGstReport,
    "report-upi": renderUpiReport,
    "report-suppliers": renderSupplierReport,
    reports: renderReportsHub,
    more: renderMoreScreen,
  };

  if (renderers[path]) {
    try {
      await renderers[path](screen);
    } catch (err) {
      screen.innerHTML = `<div class="placeholder-screen"><h2>Something went wrong</h2><p>${friendlyError(err)}</p></div>`;
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

  const localNow = new Date();
  localNow.setMinutes(localNow.getMinutes() - localNow.getTimezoneOffset());
  const today = localNow.toISOString().slice(0, 10);

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
  const todayStats = await dashboardToday();

  screen.innerHTML = `
    <div class="dashboard-hero card"><div><span class="eyebrow">Today</span><h1>Net cash position</h1><strong class="hero-number">₹${fmt(Number(cash?.balance||0) + Number(bank?.balance||0) + Number(upiPendingTotal||0))}</strong><p class="muted">Cash, bank and pending UPI settlement.</p></div></div>
    <div class="grid grid-2">
      <div class="card">
        <div class="card-title">Today at a glance</div>
        <div class="stat-row"><span class="stat-label">Sales</span><span class="stat-value positive">₹${fmt(todayStats?.sales)}</span></div>
        <div class="stat-row"><span class="stat-label">Expenses</span><span class="stat-value negative">₹${fmt(todayStats?.expenses)}</span></div>
        <div class="stat-row"><span class="stat-label">Purchases</span><span class="stat-value">₹${fmt(todayStats?.purchases)}</span></div>
        <div class="stat-row"><span class="stat-label">Wastage</span><span class="stat-value negative">₹${fmt(todayStats?.wastage)}</span></div>
      </div>
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

    <div class="card quick-actions-card">
      <div class="card-title">Quick actions</div>
      <div class="quick-actions"><button class="btn btn-primary" id="quick-new">+ New</button><div class="quick-action-menu hidden" id="quick-menu"><a href="#/sales">Sale</a><a href="#/purchases">Purchase</a><a href="#/expenses">Expense</a><a href="#/transfers">Money transfer</a><a href="#/inventory">Stock adjustment</a><a href="#/daily-closing">Daily closing</a></div></div>
    </div>`;
  document.getElementById("quick-new")?.addEventListener("click", () => document.getElementById("quick-menu")?.classList.toggle("hidden"));
}

function renderMoreScreen(screen) {
  screen.innerHTML=`<div class="screen-head"><div><h1>More</h1><p>Everything else, grouped the same way as the desktop navigation.</p></div></div><div class="more-grid">${NAV.filter(g=>g.group!=='Overview').map(g=>`<section class="card more-section"><h2>${g.group}</h2><div class="more-links">${g.items.map(i=>`<a href="#/${i.path}" class="more-link"><span class="icon">${ICONS[i.icon]||ICONS.masters}</span><span>${i.label}</span></a>`).join('')}</div></section>`).join('')}</div>`;
}

async function renderReportsHub(screen) {
  const tabs=[['report-daily','Daily'],['report-sales','Sales'],['report-purchase','Purchase'],['report-expense','Expense'],['report-stock','Stock'],['report-pl','P&L'],['report-gst','GST'],['report-upi','UPI'],['report-suppliers','Suppliers']];
  screen.innerHTML=`<div class="screen-head"><div><h1>Reports</h1><p>Choose a report without leaving the reporting workspace.</p></div></div><div class="segmented-tabs" role="tablist">${tabs.map((t,i)=>`<button class="segmented-tab ${i===0?'active':''}" data-report="${t[0]}" role="tab">${t[1]}</button>`).join('')}</div><div id="report-panel" class="report-panel"></div>`;
  const panel=screen.querySelector('#report-panel');
  const renderers={ 'report-daily':renderDailyReport,'report-sales':renderSalesReport,'report-purchase':renderPurchaseReport,'report-expense':renderExpenseReport,'report-stock':renderStockReport,'report-pl':renderPlReport,'report-gst':renderGstReport,'report-upi':renderUpiReport,'report-suppliers':renderSupplierReport };
  const load=async path=>{screen.querySelectorAll('.segmented-tab').forEach(b=>b.classList.toggle('active',b.dataset.report===path)); panel.innerHTML='<div class="loading-state">Loading report…</div>'; await renderers[path](panel);};
  screen.querySelectorAll('.segmented-tab').forEach(b=>b.addEventListener('click',()=>load(b.dataset.report))); await load('report-daily');
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
  const write = async (rpcName, payload) => {
    const { error } = await supabase.rpc(rpcName, payload);
    if (error) throw error;
  };
  const writers = {
    sale: (payload) => write("create_sale_idempotent", payload),
    expense: (payload) => write("create_expense_idempotent", payload),
    wastage: (payload) => write("record_wastage_idempotent", payload),
  };
  const { synced, total } = await syncOutbox(writers, (done, tot) => {
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
