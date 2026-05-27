/**
 * Orchestrator: the heartbeat of the network.
 * Every second:
 *  - Update node loads/statuses (seed nodes simulate; real follow user devices)
 *  - Assign pending jobs to nodes
 *  - Calculate earnings (only REAL nodes generate real money)
 *  - Mark dirty nodes for DB flush
 */

const crypto = require('crypto');
const {
  getAllNodesIterator, getNodeCounts, markDirty,
  seedNodes, realNodes,
} = require('./nodes');
const { dbInsert, dbUpdate, dbGet, dbList } = require('./db');

const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE || '0.6');
const USER_SHARE = 1 - PLATFORM_FEE;
const PRICE_PER_GFLOP_SEC = 0.0001;

// Live metrics (publicly exposed, sanitized)
const metrics = {
  totalNodes: 0,
  activeNodes: 0,
  totalGflops: 0,
  totalGflopSecondsProcessed: 0,
  platformRevenue: 0,
  userRevenue: 0,
  jobsCompleted: 0,
  contractsSigned: 0,
  contractsCompleted: 0,
  adImpressions: 0,
  adClicks: 0,
  adRevenue: 0,
  startedAt: Date.now(),
};

// Job queue (in RAM; persisted via himer_jobs)
const jobs = new Map();

// Notification callback (set by server.js)
let onNotify = () => {};
function setNotifier(fn) { onNotify = fn; }

// ============================================================
// TICK
// ============================================================
function tick() {
  let active = 0;
  let totalGflops = 0;

  // 1. Process pending jobs
  for (const [jobId, job] of jobs) {
    if (job.status === 'PENDING') assignJobToNodes(job);
  }

  // 2. Update each node
  for (const node of getAllNodesIterator()) {
    const prevLoad = node.current_load;
    const prevStatus = node.status;

    // Simulate load fluctuation
    node.current_load = Math.max(0, Math.min(100, node.current_load + (Math.random() - 0.5) * 30));
    node.status = node.current_load > 80 ? 'COMPUTING'
                : node.current_load > 20 ? 'READY' : 'IDLE';
    node.uptime_seconds = (node.uptime_seconds || 0) + 1;
    node.last_seen_at = new Date().toISOString();

    if (node.status === 'COMPUTING') {
      const gflops = parseFloat(node.gflops) || 0;
      const boost = parseFloat(node.boost_multiplier) || 1;
      const gflopSeconds = gflops * (node.current_load / 100);
      const grossEarning = gflopSeconds * PRICE_PER_GFLOP_SEC * boost;

      // ONLY real nodes generate user earnings
      if (node.source === 'real' && node.user_id) {
        const userPortion = grossEarning * USER_SHARE;
        const platformPortion = grossEarning * PLATFORM_FEE;
        node.total_earnings = (parseFloat(node.total_earnings) || 0) + userPortion;
        node.gflop_seconds_processed = (node.gflop_seconds_processed || 0) + gflopSeconds;
        metrics.userRevenue += userPortion;
        metrics.platformRevenue += platformPortion;
        markDirty(node.id);
        // Update user wallet (in memory cache; flush later)
        addUserEarnings(node.user_id, userPortion);
      }

      // Both seed + real contribute to visible totals
      metrics.totalGflopSecondsProcessed += gflopSeconds;
      totalGflops += gflopSeconds;
      active++;
    }

    if (Math.abs(node.current_load - prevLoad) > 5 || node.status !== prevStatus) {
      // Just update visual; no DB flush needed unless real
      if (node.source === 'real') markDirty(node.id);
    }
  }

  const counts = getNodeCounts();
  metrics.totalNodes = counts.total;
  metrics.activeNodes = active;
  metrics.totalGflops = totalGflops;
}

// ============================================================
// User earnings cache (batched DB writes)
// ============================================================
const userEarningsCache = new Map();   // userId -> { addedEarnings, lastFlush }

function addUserEarnings(userId, amount) {
  const c = userEarningsCache.get(userId) || { added: 0 };
  c.added += amount;
  userEarningsCache.set(userId, c);
}

async function flushUserEarnings() {
  const entries = Array.from(userEarningsCache.entries());
  userEarningsCache.clear();
  for (const [userId, c] of entries) {
    if (c.added <= 0) continue;
    try {
      const user = await dbGet('himer_users', userId);
      if (!user) continue;
      const newTotal = parseFloat(user.total_earnings || 0) + c.added;
      const newWithdrawable = parseFloat(user.withdrawable || 0) + c.added;
      await dbUpdate('himer_users', userId, {
        total_earnings: newTotal,
        withdrawable: newWithdrawable,
        last_active_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error(`[Orch] Flush user ${userId} earnings failed:`, e.message);
      // Re-add to cache so we don't lose it
      const back = userEarningsCache.get(userId) || { added: 0 };
      back.added += c.added;
      userEarningsCache.set(userId, back);
    }
  }
}

// ============================================================
// Job assignment
// ============================================================
function assignJobToNodes(job) {
  // Prefer real nodes; fall back to seed if not enough
  const realCands = [];
  const seedCands = [];
  for (const n of getAllNodesIterator()) {
    if (n.status === 'COMPUTING') continue;
    if (n.trust_score < 50) continue;
    const score = (n.trust_score * n.gflops) / (n.current_load + 1);
    (n.source === 'real' ? realCands : seedCands).push({ n, score });
  }
  realCands.sort((a, b) => b.score - a.score);
  seedCands.sort((a, b) => b.score - a.score);

  const needed = job.nodes_needed || 5;
  const picked = realCands.length >= needed
    ? realCands.slice(0, needed)
    : [...realCands, ...seedCands.slice(0, needed - realCands.length)];

  if (picked.length < needed) return;

  job.status = 'RUNNING';
  job.started_at = new Date().toISOString();
  job.nodes_assigned = picked.map(p => p.n.id);
  job.real_nodes_count = picked.filter(p => p.n.source === 'real').length;
  job.seed_nodes_count = picked.length - job.real_nodes_count;

  for (const p of picked) {
    p.n.current_load = Math.min(100, p.n.current_load + 40);
  }
  metrics.contractsSigned++;

  // Persist job state
  dbUpdate('himer_jobs', job.id, {
    status: 'RUNNING',
    started_at: job.started_at,
    nodes_assigned: job.nodes_assigned,
    real_nodes_count: job.real_nodes_count,
    seed_nodes_count: job.seed_nodes_count,
  }).catch(e => console.error('[Orch] Job persist failed:', e.message));

  // Notify owners of REAL nodes
  const notifiedUsers = new Set();
  for (const p of picked) {
    if (p.n.source === 'real' && p.n.user_id && !notifiedUsers.has(p.n.user_id)) {
      notifiedUsers.add(p.n.user_id);
      onNotify(p.n.user_id, 'contract_signed',
        'notif.contractSigned.title', 'notif.contractSigned.message',
        { jobId: job.id, nodeId: p.n.id, type: job.job_type });
    }
  }

  // Schedule completion
  setTimeout(() => completeJob(job.id), 10000 + Math.random() * 20000);
}

async function completeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status === 'DONE') return;
  job.status = 'DONE';
  job.completed_at = new Date().toISOString();
  metrics.jobsCompleted++;
  metrics.contractsCompleted++;

  // Update job in DB
  dbUpdate('himer_jobs', jobId, {
    status: 'DONE',
    completed_at: job.completed_at,
  }).catch(() => {});

  // Notify owners of REAL nodes (with payment)
  const notifiedUsers = new Set();
  const cost = parseFloat(job.cost) || 0;
  const realCount = job.real_nodes_count || 1;
  for (const nodeId of (job.nodes_assigned || [])) {
    const node = realNodes.get(nodeId) || seedNodes.get(nodeId);
    if (!node) continue;
    node.contracts_completed = (node.contracts_completed || 0) + 1;
    if (node.source === 'real' && node.user_id && !notifiedUsers.has(node.user_id)) {
      notifiedUsers.add(node.user_id);
      const share = (cost / realCount) * USER_SHARE;
      onNotify(node.user_id, 'contract_completed',
        'notif.contractCompleted.title', 'notif.contractCompleted.message',
        { jobId: job.id, nodeId, reward: share });
    }
  }
}

// ============================================================
// Job creation (called by client API & admin)
// ============================================================
async function createJob({ clientId, jobType, nodesNeeded, cost, payload = {} }) {
  const id = 'J-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const job = {
    id,
    client_id: clientId || null,
    job_type: jobType || 'compute',
    nodes_needed: nodesNeeded || 5,
    cost: cost || (nodesNeeded || 5) * 0.05,
    status: 'PENDING',
    nodes_assigned: null,
    real_nodes_count: 0,
    seed_nodes_count: 0,
    payload,
    created_at: new Date().toISOString(),
  };
  jobs.set(id, job);
  try {
    await dbInsert('himer_jobs', job);
  } catch (e) {
    console.error('[Orch] Job DB insert failed:', e.message);
  }
  return job;
}

module.exports = {
  metrics,
  jobs,
  tick,
  setNotifier,
  flushUserEarnings,
  createJob,
  PLATFORM_FEE,
  USER_SHARE,
  PRICE_PER_GFLOP_SEC,
};
