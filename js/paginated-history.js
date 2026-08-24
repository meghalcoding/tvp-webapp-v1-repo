import { supabase } from "./supabase-client.js";

export const HISTORY_INITIAL_LIMIT = 5;
export const HISTORY_INCREMENT = 20;

const cursorFilter = (cursor) => {
  if (!cursor) return null;
  const date = cursor.txn_date;
  const createdAt = cursor.created_at;
  const id = cursor.id;
  return `txn_date.lt.${date},and(txn_date.eq.${date},created_at.lt.${createdAt}),and(txn_date.eq.${date},created_at.eq.${createdAt},id.lt.${id})`;
};

export async function fetchTransactionPage({ type, select, cursor = null, limit = HISTORY_INCREMENT }) {
  let query = supabase
    .from("transactions")
    .select(select)
    .eq("txn_type", type)
    .order("txn_date", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  const filter = cursorFilter(cursor);
  if (filter) query = query.or(filter);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export function createHistoryController({ tbody, controls, type, select, renderRow, colspan, initialRows, onRender }) {
  let rows = [...initialRows];
  let cursor = rows.length ? rows[rows.length - 1] : null;
  let loading = false;
  let exhausted = rows.length < HISTORY_INITIAL_LIMIT;

  const renderControls = () => {
    if (!controls) return;
    controls.innerHTML = exhausted
      ? `<span class="history-end">You're all caught up.</span>`
      : `<button type="button" class="btn btn-small" data-load-more>Load 20 more</button><span class="history-count">Showing ${rows.length}</span>`;
    const button = controls.querySelector("[data-load-more]");
    button?.addEventListener("click", loadMore);
  };

  const render = () => {
    if (!tbody) return;
    tbody.innerHTML = rows.map(renderRow).join("") || `<tr><td colspan="${colspan}">No records recorded.</td></tr>`;
    renderControls();
    onRender?.(rows);
  };

  async function loadMore() {
    if (loading || exhausted) return;
    loading = true;
    if (controls) {
      controls.innerHTML = `<span class="history-loading">Loading 20 more…</span><span class="history-count">Showing ${rows.length}</span>`;
    }
    try {
      const nextRows = await fetchTransactionPage({ type, select, cursor, limit: HISTORY_INCREMENT });
      rows = rows.concat(nextRows);
      cursor = rows.length ? rows[rows.length - 1] : cursor;
      exhausted = nextRows.length < HISTORY_INCREMENT;
      render();
    } catch (error) {
      if (controls) {
        controls.innerHTML = `<span class="form-status error">Could not load more records.</span><button type="button" class="btn btn-small" data-load-more>Retry</button><span class="history-count">Showing ${rows.length}</span>`;
        controls.querySelector("[data-load-more]")?.addEventListener("click", loadMore);
      }
      console.error("History pagination failed", error);
    } finally {
      loading = false;
    }
  }

  render();
  return { loadMore };
}
