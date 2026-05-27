/**
 * Node management.
 * SEED nodes stay in RAM (volatile, just visual).
 * REAL nodes are persisted in Supabase (himer_nodes).
 *
 * For runtime efficiency, we cache real nodes in a Map after load.
 * Updates are flushed back to DB periodically.
 */

const crypto = require('crypto');
const { dbList, dbInsert, dbUpdate, dbGet } = require('./db');

const SEED_NODE_COUNT = 500;

// In-RAM caches
const seedNodes = new Map();   // id -> node object (visual only)
const realNodes = new Map();   // id -> node object (mirrors DB)

const REGIONS = [
  { name: 'EU-West',    lat: 48.8,  lng: 2.3,    weight: 0.18 },
  { name: 'EU-East',    lat: 44.4,  lng: 26.1,   weight: 0.12 },
  { name: 'US-East',    lat: 40.7,  lng: -74.0,  weight: 0.20 },
  { name: 'US-West',    lat: 37.7,  lng: -122.4, weight: 0.15 },
  { name: 'Asia-East',  lat: 35.6,  lng: 139.6,  weight: 0.13 },
  { name: 'Asia-South', lat: 19.0,  lng: 72.8,   weight: 0.10 },
  { name: 'SA',         lat: -23.5, lng: -46.6,  weight: 0.07 },
  { name: 'Africa',     lat: -1.2,  lng: 36.8,   weight: 0.03 },
  { name: 'Oceania',    lat: -33.8, lng: 151.2,  weight: 0.02 },
];

function pickRegion() {
  let r = Math.random();
  for (const reg of REGIONS) {
    r -= reg.weight;
    if (r <= 0) return reg;
  }
  return REGIONS[0];
}

function newId(prefix) {
  return prefix + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ============================================================
// SEED nodes (in RAM)
// ============================================================
function createSeedNode() {
  const region = pickRegion();
  const jitter = () => (Math.random() - 0.5) * 8;
  const id = newId('HS');
  const node = {
    id,
    source: 'seed',
    user_id: null,
    device_id: null,
    region: region.name,
    lat: region.lat + jitter(),
    lng: region.lng + jitter(),
    status: 'IDLE',
    current_load: 0,
    gflops: 2 + Math.random() * 8,
    trust_score: 100,
    boost_multiplier: 1.0,
    total_earnings: 0,
    gflop_seconds_processed: 0,
    contracts_completed: 0,
    uptime_seconds: 0,
    last_seen_at: new Date().toISOString(),
  };
  seedNodes.set(id, node);
  return node;
}

function ensureSeedNodes(target = SEED_NODE_COUNT) {
  while (seedNodes.size < target) createSeedNode();
}

// ============================================================
// REAL nodes (DB + RAM cache)
// ============================================================
async function loadRealNodesFromDB() {
  try {
    const nodes = await dbList('himer_nodes');
    for (const n of nodes) {
      realNodes.set(n.id, {
        ...n,
        source: 'real',
        // Force IDLE on startup so we don't think they're computing
        status: 'IDLE',
        current_load: 0,
      });
    }
    console.log(`[Nodes] Loaded ${realNodes.size} real nodes from DB`);
  } catch (e) {
    console.error('[Nodes] Failed to load from DB:', e.message);
  }
}

async function createRealNode(userId, deviceId = null, opts = {}) {
  const region = opts.region || pickRegion();
  const jitter = () => (Math.random() - 0.5) * 8;
  const id = newId('HR');
  const node = {
    id,
    user_id: userId,
    device_id: deviceId,
    region: region.name,
    lat: region.lat + jitter(),
    lng: region.lng + jitter(),
    status: 'SYNCING',
    current_load: 0,
    gflops: opts.gflops || (4 + Math.random() * 12),
    trust_score: 100,
    boost_multiplier: opts.boost || 1.0,
    total_earnings: 0,
    gflop_seconds_processed: 0,
    contracts_completed: 0,
    uptime_seconds: 0,
    last_seen_at: new Date().toISOString(),
  };
  try {
    const saved = await dbInsert('himer_nodes', node);
    realNodes.set(id, { ...saved, source: 'real' });
    return realNodes.get(id);
  } catch (e) {
    console.error('[Nodes] Create real node failed:', e.message);
    // Even if DB fails, keep in RAM so user has working node
    realNodes.set(id, { ...node, source: 'real' });
    return realNodes.get(id);
  }
}

// ============================================================
// Combined access
// ============================================================
function getAllNodesIterator() {
  // Generator that yields all nodes (seed + real)
  return {
    *[Symbol.iterator]() {
      for (const n of seedNodes.values()) yield n;
      for (const n of realNodes.values()) yield n;
    }
  };
}

function getNodeCounts() {
  let realActive = 0, realInactive = 0;
  let seedActive = 0;
  for (const n of realNodes.values()) {
    if (n.status === 'COMPUTING') realActive++;
    else realInactive++;
  }
  for (const n of seedNodes.values()) {
    if (n.status === 'COMPUTING') seedActive++;
  }
  return {
    real: realNodes.size,
    seed: seedNodes.size,
    total: realNodes.size + seedNodes.size,
    realActive,
    realInactive,
    seedActive,
    activeTotal: realActive + seedActive,
  };
}

function getNode(id) {
  return realNodes.get(id) || seedNodes.get(id) || null;
}

function getUserNodes(userId) {
  const out = [];
  for (const n of realNodes.values()) {
    if (n.user_id === userId) out.push(n);
  }
  return out;
}

// ============================================================
// DB flush (periodically save real node updates)
// ============================================================
const dirtyRealNodes = new Set();

function markDirty(nodeId) {
  if (realNodes.has(nodeId)) dirtyRealNodes.add(nodeId);
}

async function flushDirtyToDB() {
  if (dirtyRealNodes.size === 0) return;
  const ids = Array.from(dirtyRealNodes);
  dirtyRealNodes.clear();
  for (const id of ids) {
    const n = realNodes.get(id);
    if (!n) continue;
    try {
      await dbUpdate('himer_nodes', id, {
        status: n.status,
        current_load: n.current_load,
        total_earnings: n.total_earnings,
        gflop_seconds_processed: n.gflop_seconds_processed,
        contracts_completed: n.contracts_completed,
        uptime_seconds: n.uptime_seconds,
        trust_score: n.trust_score,
        last_seen_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error(`[Nodes] Flush ${id} failed:`, e.message);
    }
  }
}

// ============================================================
// Region aggregation
// ============================================================
function aggregateByRegion() {
  const agg = {};
  for (const n of getAllNodesIterator()) {
    if (!agg[n.region]) agg[n.region] = { count: 0, active: 0, gflops: 0 };
    agg[n.region].count++;
    if (n.status === 'COMPUTING') agg[n.region].active++;
    agg[n.region].gflops += parseFloat(n.gflops) || 0;
  }
  return agg;
}

// ============================================================
// Compact serialization for WebSocket
// ============================================================
function compactNode(n, includeSource = false) {
  const c = {
    id: n.id,
    lat: +Number(n.lat).toFixed(2),
    lng: +Number(n.lng).toFixed(2),
    l: n.current_load | 0,
    s: (n.status || 'IDLE')[0],  // I, R, C
    g: +Number(n.gflops).toFixed(1),
    r: n.region,
    u: n.uptime_seconds | 0,
  };
  if (includeSource) c.source = n.source;
  return c;
}

module.exports = {
  REGIONS,
  pickRegion,
  newId,
  ensureSeedNodes,
  loadRealNodesFromDB,
  createRealNode,
  getAllNodesIterator,
  getNodeCounts,
  getNode,
  getUserNodes,
  markDirty,
  flushDirtyToDB,
  aggregateByRegion,
  compactNode,
  seedNodes,
  realNodes,
};
