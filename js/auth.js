import { supabase } from "./supabase-client.js";

let cachedAppUser = null; // { id, name, role, auth_id }

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  cachedAppUser = null;
  await supabase.auth.signOut();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Resolves the row in public.users that matches the signed-in auth user.
// This is where we learn the person's name + role (owner/manager/staff).
// If no matching row exists, the Owner hasn't provisioned this person yet.
export async function getCurrentAppUser(forceRefresh = false) {
  if (cachedAppUser && !forceRefresh) return cachedAppUser;

  const session = await getSession();
  if (!session) return null;

  const { data, error } = await supabase
    .from("users")
    .select("id, name, role, active")
    .eq("auth_id", session.user.id)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    // Signed in to Supabase Auth, but no app profile yet — treat as
    // unprovisioned rather than silently granting any access.
    return null;
  }

  cachedAppUser = { ...data, auth_id: session.user.id, email: session.user.email };
  return cachedAppUser;
}

export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    cachedAppUser = null; // role may have changed; refetch next time it's needed
    callback(session);
  });
}

// Role helpers used throughout the UI to hide/disable actions.
// These mirror the RLS policies in db/rls_policies.sql — UI-side checks are
// a convenience, RLS is the authoritative gate (spec §7).
export function canDo(appUser, action) {
  if (!appUser) return false;
  const role = appUser.role;
  const matrix = {
    record_sale: ["owner", "manager", "staff"],
    record_quick_expense: ["owner", "manager", "staff"],
    record_detailed_expense: ["owner", "manager"],
    record_purchase: ["owner", "manager"],
    record_wastage: ["owner", "manager", "staff"],
    stock_adjustment: ["owner", "manager"],
    mark_settlement: ["owner", "manager"],
    money_transfer: ["owner", "manager"],
    supplier_payment: ["owner", "manager"],
    run_daily_closing: ["owner", "manager"],
    reopen_locked_day: ["owner"],
    edit_masters: ["owner"],
    manage_users: ["owner"],
    view_audit_log: ["owner"],
    export_backup: ["owner"],
  };
  return (matrix[action] || []).includes(role);
}
