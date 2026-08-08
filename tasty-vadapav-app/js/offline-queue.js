// ============================================================================
// OFFLINE QUEUE — spec §14
// Sales, quick expenses, and wastage entries can be created while offline.
// They go into an IndexedDB "outbox" with a client-generated UUID, and get
// pushed to Supabase in creation order once connectivity returns.
// Settlement, supplier payments, and Daily Closing are NOT queued here —
// they depend on server-computed balances and stay disabled while offline
// (spec §14, "what stays disabled offline").
// ============================================================================

const DB_NAME = "tasty-vadapav-outbox";
const DB_VERSION = 1;
const STORE = "outbox";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "client_uuid" });
        store.createIndex("created_at", "created_at");
        store.createIndex("synced", "synced");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function uuid() {
  return crypto.randomUUID();
}

// entry = { kind: 'sale'|'expense'|'wastage', payload: {...} }
export async function queueEntry(entry) {
  const db = await openDb();
  const client_uuid = uuid();
  const record = {
    client_uuid,
    kind: entry.kind,
    payload: entry.payload,
    created_at: new Date().toISOString(),
    synced: 0,
    attempts: 0,
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return record;
}

export async function getPendingCount() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("synced").getAll(0);
    req.onsuccess = () => resolve(req.result.length);
    req.onerror = () => reject(req.error);
  });
}

export async function getPendingEntries() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("synced").getAll(0);
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.created_at.localeCompare(b.created_at)));
    req.onerror = () => reject(req.error);
  });
}

export async function markSynced(client_uuid) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(client_uuid);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function bumpAttempts(client_uuid) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(client_uuid);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (rec) {
        rec.attempts += 1;
        store.put(rec);
      }
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Called by app.js's writeSale/writeExpense/writeWastage helpers: attempts a
// direct write, and falls back to the outbox on network failure. Distinct
// from syncOutbox() (below), which drains anything already queued.
export async function withOfflineFallback(kind, payload, directWriteFn) {
  if (!navigator.onLine) {
    return queueEntry({ kind, payload });
  }
  try {
    return await directWriteFn(payload);
  } catch (err) {
    // Network-ish failure -> queue instead of losing the entry.
    if (err instanceof TypeError || err?.message?.includes("network")) {
      return queueEntry({ kind, payload });
    }
    throw err; // real validation/permission errors should surface immediately
  }
}

// Sync driver — pluggable per-kind writers passed in from app.js so this
// module doesn't need to know Supabase table shapes directly.
export async function syncOutbox(writers, onProgress) {
  const pending = await getPendingEntries();
  let done = 0;
  for (const entry of pending) {
    try {
      const writer = writers[entry.kind];
      if (!writer) throw new Error(`No writer registered for kind "${entry.kind}"`);
      await writer({ ...entry.payload, client_uuid: entry.client_uuid });
      await markSynced(entry.client_uuid);
      done += 1;
      onProgress?.(done, pending.length);
    } catch (err) {
      await bumpAttempts(entry.client_uuid);
      console.error("Sync failed for", entry.client_uuid, err);
      // stop on first failure to preserve creation order (spec §14)
      break;
    }
  }
  return { synced: done, total: pending.length };
}
