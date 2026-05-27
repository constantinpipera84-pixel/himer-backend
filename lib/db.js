/**
 * Supabase DB layer.
 * Uses service_role key (server-side only — never expose to frontend).
 *
 * If SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set, falls back
 * to in-memory storage (dev mode). Production MUST have these.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
let isReal = false;

if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  isReal = true;
  console.log('[DB] Connected to Supabase:', SUPABASE_URL);
} else {
  console.warn('[DB] No Supabase credentials — running in MEMORY-ONLY mode (data will be lost on restart!)');
}

// ============================================================
// In-memory fallback (when no Supabase)
// ============================================================
const memStore = {
  himer_users: new Map(),
  himer_user_devices: new Map(),
  himer_nodes: new Map(),
  himer_payouts: new Map(),
  himer_admins: new Map(),
  himer_clients: new Map(),
  himer_jobs: new Map(),
  himer_notifications: new Map(),
  himer_treasury_ledger: [],
  himer_admin_audit: [],
};

// ============================================================
// Universal DB helpers
// ============================================================

async function dbInsert(table, row) {
  if (isReal) {
    const { data, error } = await supabase.from(table).insert(row).select().single();
    if (error) throw error;
    return data;
  }
  const id = row.id || ('mem-' + Math.random().toString(36).slice(2, 12));
  const item = { ...row, id };
  // Some tables in memory are arrays (audit, ledger)
  if (Array.isArray(memStore[table])) {
    memStore[table].push(item);
  } else {
    memStore[table].set(id, item);
  }
  return item;
}

async function dbUpsert(table, row, onConflict = 'id') {
  if (isReal) {
    const { data, error } = await supabase.from(table).upsert(row, { onConflict }).select().single();
    if (error) throw error;
    return data;
  }
  memStore[table].set(row.id, row);
  return row;
}

async function dbGet(table, id, idColumn = 'id') {
  if (isReal) {
    const { data, error } = await supabase.from(table).select('*').eq(idColumn, id).maybeSingle();
    if (error) throw error;
    return data;
  }
  if (idColumn === 'id') return memStore[table].get(id) || null;
  // Search by another column in memory
  for (const v of memStore[table].values()) {
    if (v[idColumn] === id) return v;
  }
  return null;
}

async function dbUpdate(table, id, patch, idColumn = 'id') {
  if (isReal) {
    const { data, error } = await supabase.from(table).update(patch).eq(idColumn, id).select().single();
    if (error) throw error;
    return data;
  }
  const existing = memStore[table].get(id);
  if (!existing) return null;
  Object.assign(existing, patch);
  return existing;
}

async function dbDelete(table, id, idColumn = 'id') {
  if (isReal) {
    const { error } = await supabase.from(table).delete().eq(idColumn, id);
    if (error) throw error;
    return true;
  }
  return memStore[table].delete(id);
}

async function dbList(table, opts = {}) {
  if (isReal) {
    let q = supabase.from(table).select('*');
    if (opts.where) {
      for (const [k, v] of Object.entries(opts.where)) {
        q = q.eq(k, v);
      }
    }
    if (opts.order) q = q.order(opts.order.col, { ascending: opts.order.asc !== false });
    if (opts.limit) q = q.limit(opts.limit);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }
  let arr;
  if (Array.isArray(memStore[table])) {
    arr = memStore[table].slice();
  } else {
    arr = Array.from(memStore[table].values());
  }
  if (opts.where) {
    arr = arr.filter(r => {
      for (const [k, v] of Object.entries(opts.where)) {
        if (r[k] !== v) return false;
      }
      return true;
    });
  }
  if (opts.order) {
    arr.sort((a, b) => {
      const av = a[opts.order.col], bv = b[opts.order.col];
      return opts.order.asc !== false ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
    });
  }
  if (opts.limit) arr = arr.slice(0, opts.limit);
  return arr;
}

async function dbCount(table, where = {}) {
  if (isReal) {
    let q = supabase.from(table).select('id', { count: 'exact', head: true });
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  }
  const list = await dbList(table, { where });
  return list.length;
}

// ============================================================
// Counter helper (for sums)
// ============================================================
async function dbSum(table, column, where = {}) {
  if (isReal) {
    let q = supabase.from(table).select(column);
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).reduce((a, r) => a + parseFloat(r[column] || 0), 0);
  }
  const list = await dbList(table, { where });
  return list.reduce((a, r) => a + parseFloat(r[column] || 0), 0);
}

module.exports = {
  supabase,
  isReal,
  dbInsert,
  dbUpsert,
  dbGet,
  dbUpdate,
  dbDelete,
  dbList,
  dbCount,
  dbSum,
};
