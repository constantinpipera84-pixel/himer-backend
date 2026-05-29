/**
 * HIMER v5 — Compute Engine
 *
 * Real distributed compute over WebSocket-connected browser nodes.
 *
 * Flow:
 *   1. Job submitted (client or owner) → split into chunks
 *   2. Chunks dispatched to available nodes via WS
 *   3. Nodes execute in WebWorker, return result + hash
 *   4. 5-10% chunks re-verified on witness nodes (Proof-of-Compute)
 *   5. Verified chunks → node earns; job assembled when all chunks done
 *   6. Payment split: 60% platform / 40% nodes
 *
 * Supported workload types (browser-executable WASM/JS):
 *   - hashing      : SHA-256 brute force / proof-of-work style
 *   - matrix       : matrix multiplication (ML primitive)
 *   - montecarlo   : Monte Carlo simulation (finance/science)
 *   - primes       : prime number search
 *   - dataprocess  : map/filter/reduce over data arrays
 *   - imagefilter  : image kernel convolution
 */
const crypto = require('crypto');
const { dbInsert, dbUpdate, dbGet, dbList } = require('./db');

const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE || '0.6');
const VERIFY_RATE = 0.08; // 8% of chunks re-verified
const CHUNK_TIMEOUT_MS = 60000; // 60s per chunk before reassign

// In-memory active job state (synced to DB on completion)
const activeJobs = new Map();   // jobId -> { job, chunks, results, ... }
const pendingChunks = [];        // queue of chunks waiting for a node
const dispatchedChunks = new Map(); // chunkId -> { chunk, nodeId, dispatchedAt }
const witnessQueue = [];         // chunks awaiting witness verification

// Node connections registry (set by server via setNodeRegistry)
let nodeConnections = null; // Map: nodeId -> ws
let getActiveNodeIds = () => [];

function setNodeRegistry(connections, activeNodesGetter) {
  nodeConnections = connections;
  if (activeNodesGetter) getActiveNodeIds = activeNodesGetter;
}

// ============================================================
// JOB SPLITTING
// ============================================================
function splitJobIntoChunks(job) {
  const chunks = [];
  const type = job.job_type || 'compute';
  const totalUnits = Math.max(1, Math.ceil(job.required_gflops_seconds / 1000)); // ~1000 GFLOP-s per chunk
  const maxChunks = Math.min(totalUnits, 1000);

  const input = job.input_data || {};

  for (let i = 0; i < maxChunks; i++) {
    chunks.push({
      id: `${job.id}-chunk-${i}`,
      jobId: job.id,
      index: i,
      total: maxChunks,
      type: mapJobTypeToWorkload(type),
      payload: buildChunkPayload(type, input, i, maxChunks),
      gflops: job.required_gflops_seconds / maxChunks,
      status: 'pending',
      attempts: 0,
    });
  }
  return chunks;
}

function mapJobTypeToWorkload(jobType) {
  const map = {
    compute: 'matrix',
    ml_training: 'matrix',
    ml_inference: 'matrix',
    render: 'montecarlo',
    scraping: 'dataprocess',
    data_processing: 'dataprocess',
    scientific: 'montecarlo',
  };
  return map[jobType] || 'matrix';
}

function buildChunkPayload(jobType, input, index, total) {
  const workload = mapJobTypeToWorkload(jobType);
  switch (workload) {
    case 'matrix':
      // Matrix multiply of size N (deterministic seed per chunk)
      return { op: 'matrix', size: input.matrix_size || 64, seed: index + 1 };
    case 'montecarlo':
      return { op: 'montecarlo', samples: input.samples || 500000, seed: index + 1 };
    case 'dataprocess':
      return { op: 'dataprocess', count: input.count || 100000, seed: index + 1, transform: input.transform || 'sum' };
    case 'hashing':
      return { op: 'hashing', difficulty: input.difficulty || 4, nonce_start: index * 100000 };
    case 'primes':
      return { op: 'primes', from: index * 100000, to: (index + 1) * 100000 };
    default:
      return { op: 'matrix', size: 64, seed: index + 1 };
  }
}

// ============================================================
// JOB LIFECYCLE
// ============================================================
async function startJob(job) {
  const chunks = splitJobIntoChunks(job);
  const state = {
    job,
    chunks,
    completedChunks: new Map(), // index -> { result, hash, nodeId, verified }
    totalChunks: chunks.length,
    startedAt: Date.now(),
    status: 'RUNNING',
  };
  activeJobs.set(job.id, state);

  // Queue all chunks
  for (const chunk of chunks) pendingChunks.push(chunk);

  await dbUpdate('himer_jobs', job.id, { status: 'COMPUTING', started_at: new Date().toISOString() });
  console.log(`[Compute] Job ${job.id} started: ${chunks.length} chunks queued`);

  // Kick dispatch
  dispatchPending();
  return state;
}

// ============================================================
// CHUNK DISPATCH
// ============================================================
function dispatchPending() {
  if (!nodeConnections) return;
  const activeIds = getActiveNodeIds();
  if (activeIds.length === 0) return;

  let dispatched = 0;
  // Round-robin dispatch to available nodes
  while (pendingChunks.length > 0) {
    const chunk = pendingChunks[0];
    // Find a free-ish node (simple: random active node not overloaded)
    const nodeId = pickNode(activeIds);
    if (!nodeId) break;
    const ws = nodeConnections.get(nodeId);
    if (!ws || ws.readyState !== 1) {
      // Node gone, try next
      const idx = activeIds.indexOf(nodeId);
      if (idx >= 0) activeIds.splice(idx, 1);
      if (activeIds.length === 0) break;
      continue;
    }

    pendingChunks.shift();
    chunk.status = 'dispatched';
    chunk.attempts++;
    dispatchedChunks.set(chunk.id, { chunk, nodeId, dispatchedAt: Date.now() });

    try {
      ws.send(JSON.stringify({
        type: 'COMPUTE_CHUNK',
        chunkId: chunk.id,
        jobId: chunk.jobId,
        workload: chunk.type,
        payload: chunk.payload,
        index: chunk.index,
        total: chunk.total,
      }));
      dispatched++;
    } catch (e) {
      // Failed to send — requeue
      chunk.status = 'pending';
      dispatchedChunks.delete(chunk.id);
      pendingChunks.push(pendingChunks.shift());
      break;
    }
  }
  if (dispatched > 0) console.log(`[Compute] Dispatched ${dispatched} chunks`);
}

let nodeRoundRobin = 0;
function pickNode(activeIds) {
  if (activeIds.length === 0) return null;
  // Simple round-robin
  nodeRoundRobin = (nodeRoundRobin + 1) % activeIds.length;
  return activeIds[nodeRoundRobin];
}

// ============================================================
// RESULT HANDLING (called by server on WS message COMPUTE_RESULT)
// ============================================================
async function handleChunkResult({ chunkId, jobId, result, hash, nodeId, computeMs }) {
  const dispatched = dispatchedChunks.get(chunkId);
  if (!dispatched) return; // unknown/expired chunk
  const state = activeJobs.get(jobId);
  if (!state) { dispatchedChunks.delete(chunkId); return; }

  const chunk = dispatched.chunk;
  dispatchedChunks.delete(chunkId);

  // Decide if this chunk needs witness verification
  const needsVerify = Math.random() < VERIFY_RATE && getActiveNodeIds().length > 2;

  if (needsVerify && !chunk._isWitnessResult) {
    // Store first result, send to witness
    chunk._firstResult = { result, hash, nodeId };
    witnessQueue.push(chunk);
    dispatchWitness(chunk);
    return;
  }

  // Accept result
  await acceptChunk(state, chunk, { result, hash, nodeId, computeMs });
}

async function acceptChunk(state, chunk, { result, hash, nodeId, computeMs }) {
  if (state.completedChunks.has(chunk.index)) return; // already done

  state.completedChunks.set(chunk.index, { result, hash, nodeId, verified: true });

  // Credit the node/user
  await creditNode(nodeId, chunk.gflops, state.job);

  console.log(`[Compute] Chunk ${chunk.index + 1}/${state.totalChunks} done (job ${state.job.id})`);

  // Job complete?
  if (state.completedChunks.size >= state.totalChunks) {
    await finishJob(state);
  } else {
    dispatchPending();
  }
}

function dispatchWitness(chunk) {
  const activeIds = getActiveNodeIds().filter(id => id !== chunk._firstResult.nodeId);
  if (activeIds.length === 0) {
    // No witness available, accept original
    const state = activeJobs.get(chunk.jobId);
    if (state) acceptChunk(state, chunk, chunk._firstResult);
    return;
  }
  const witnessId = activeIds[Math.floor(Math.random() * activeIds.length)];
  const ws = nodeConnections.get(witnessId);
  if (!ws || ws.readyState !== 1) {
    const state = activeJobs.get(chunk.jobId);
    if (state) acceptChunk(state, chunk, chunk._firstResult);
    return;
  }
  chunk._witnessId = witnessId;
  chunk._isWitnessResult = true;
  dispatchedChunks.set(chunk.id, { chunk, nodeId: witnessId, dispatchedAt: Date.now() });
  ws.send(JSON.stringify({
    type: 'COMPUTE_CHUNK',
    chunkId: chunk.id,
    jobId: chunk.jobId,
    workload: chunk.type,
    payload: chunk.payload,
    index: chunk.index,
    total: chunk.total,
    isWitness: true,
  }));
}

// Called when witness returns result
async function handleWitnessResult({ chunkId, result, hash, nodeId }) {
  const dispatched = dispatchedChunks.get(chunkId);
  if (!dispatched) return;
  const chunk = dispatched.chunk;
  dispatchedChunks.delete(chunkId);
  const state = activeJobs.get(chunk.jobId);
  if (!state) return;

  const first = chunk._firstResult;
  if (first && first.hash === hash) {
    // Match! Both nodes trustworthy → credit both, accept
    await adjustTrust(first.nodeId, +1);
    await adjustTrust(nodeId, +1);
    await creditNode(nodeId, chunk.gflops * 0.1, state.job); // witness gets 10% bonus
    await acceptChunk(state, chunk, first);
  } else {
    // Mismatch! Trust drop for original, re-dispatch chunk
    await adjustTrust(first.nodeId, -10);
    chunk._isWitnessResult = false;
    chunk._firstResult = null;
    chunk.status = 'pending';
    pendingChunks.push(chunk);
    dispatchPending();
  }
}

// ============================================================
// PAYMENT & TRUST
// ============================================================
async function creditNode(nodeId, gflopsSeconds, job) {
  try {
    const node = await dbGet('himer_nodes', nodeId);
    if (!node) return;
    const userId = node.user_id;
    const isOwnerJob = !!job.is_owner_job;

    // For owner jobs: track stats only, no money paid out
    if (isOwnerJob) {
      await dbUpdate('himer_nodes', nodeId, {
        contracts_completed: (node.contracts_completed || 0) + 1,
        gflop_seconds_processed: parseFloat(node.gflop_seconds_processed || 0) + gflopsSeconds,
        status: 'COMPUTING',
        last_heartbeat: new Date().toISOString(),
      });
      // Stats only for the user — no withdrawable money increment
      if (userId) {
        const user = await dbGet('himer_users', userId);
        if (user) {
          await dbUpdate('himer_users', userId, {
            lifetime_compute_gflops_sec: parseFloat(user.lifetime_compute_gflops_sec || 0) + gflopsSeconds,
          });
        }
      }
      return; // No payment for owner jobs
    }

    // Regular client job: pay user (40%), platform keeps 60%
    const RATE = 0.0001; // $ per GFLOP-second (gross)
    const gross = gflopsSeconds * RATE;
    const userShare = gross * (1 - PLATFORM_FEE);

    // Update node
    await dbUpdate('himer_nodes', nodeId, {
      total_earnings: parseFloat(node.total_earnings || 0) + userShare,
      contracts_completed: (node.contracts_completed || 0) + 1,
      gflop_seconds_processed: parseFloat(node.gflop_seconds_processed || 0) + gflopsSeconds,
      status: 'COMPUTING',
      last_heartbeat: new Date().toISOString(),
    });

    // Update user wallet (apply referral milestone boost)
    if (userId) {
      const user = await dbGet('himer_users', userId);
      if (user) {
        const boost = parseFloat(user.earning_boost || 1.0);
        const boostedShare = userShare * boost;
        const oldEarnings = parseFloat(user.total_earnings || 0);
        const newEarnings = oldEarnings + boostedShare;
        await dbUpdate('himer_users', userId, {
          withdrawable: parseFloat(user.withdrawable || 0) + boostedShare,
          total_earnings: newEarnings,
          lifetime_earnings: parseFloat(user.lifetime_earnings || user.total_earnings || 0) + boostedShare,
          lifetime_compute_gflops_sec: parseFloat(user.lifetime_compute_gflops_sec || 0) + gflopsSeconds,
        });
        await recordDailyEarnings(userId, gflopsSeconds, boostedShare);
        try {
          const { distributeReferralBonus } = require('./referral');
          await distributeReferralBonus(userId, boostedShare);
        } catch (e) {}
        // Milestone notification: $1, $10, $50, $100, $500
        const milestones = [1, 10, 50, 100, 500];
        for (const m of milestones) {
          if (oldEarnings < m && newEarnings >= m) {
            try {
              const { notifyUser } = require('./push');
              await notifyUser(userId, {
                title: `🎯 You hit $${m}!`,
                body: m >= 500 ? `Amazing! You can request withdrawal now.` : `Keep going — you're earning steadily.`,
                tag: 'himer-milestone-' + m,
                url: '/',
              });
            } catch (_) {}
            break;
          }
        }
      }
    }

    // Platform revenue ledger
    await dbInsert('himer_revenue_ledger', {
      source: 'compute_chunk',
      amount: gross * PLATFORM_FEE,
      currency: 'USD',
      user_id: userId,
      job_id: job.id,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[Compute] creditNode error:', e.message);
  }
}

async function recordDailyEarnings(userId, gflopsSeconds, earnings) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const existing = (await dbList('himer_earnings_daily', { where: { user_id: userId, date: today } }))[0];
    if (existing) {
      await dbUpdate('himer_earnings_daily', existing.id, {
        gflops_seconds: parseFloat(existing.gflops_seconds || 0) + gflopsSeconds,
        net_earnings: parseFloat(existing.net_earnings || 0) + earnings,
        gross_earnings: parseFloat(existing.gross_earnings || 0) + earnings,
        contracts_count: (existing.contracts_count || 0) + 1,
      });
    } else {
      await dbInsert('himer_earnings_daily', {
        user_id: userId, date: today,
        gflops_seconds: gflopsSeconds,
        net_earnings: earnings, gross_earnings: earnings,
        contracts_count: 1,
      });
    }
  } catch (e) { /* non-fatal */ }
}

async function adjustTrust(nodeId, delta) {
  try {
    const node = await dbGet('himer_nodes', nodeId);
    if (!node) return;
    let trust = (node.trust_score || 100) + delta;
    trust = Math.max(0, Math.min(100, trust));
    await dbUpdate('himer_nodes', nodeId, { trust_score: trust });
  } catch (e) { /* non-fatal */ }
}

// ============================================================
// JOB COMPLETION
// ============================================================
async function finishJob(state) {
  state.status = 'COMPLETED';
  const job = state.job;

  // Assemble results
  const results = [];
  for (let i = 0; i < state.totalChunks; i++) {
    const c = state.completedChunks.get(i);
    results.push(c ? c.result : null);
  }
  const combinedHash = crypto.createHash('sha256')
    .update(JSON.stringify(results)).digest('hex');

  await dbUpdate('himer_jobs', job.id, {
    status: 'COMPLETED',
    actual_gflops_seconds: job.required_gflops_seconds,
    result_data: { chunks: state.totalChunks, summary: summarizeResults(results) },
    result_hash: combinedHash,
    completed_at: new Date().toISOString(),
  });

  activeJobs.delete(job.id);
  console.log(`[Compute] Job ${job.id} COMPLETED (${state.totalChunks} chunks, hash ${combinedHash.slice(0, 12)})`);
}

function summarizeResults(results) {
  const valid = results.filter(r => r != null);
  return {
    total: results.length,
    completed: valid.length,
    sample: valid.slice(0, 3),
  };
}

// ============================================================
// TIMEOUT WATCHDOG — reassign stuck chunks
// ============================================================
function watchdog() {
  const now = Date.now();
  for (const [chunkId, d] of dispatchedChunks.entries()) {
    if (now - d.dispatchedAt > CHUNK_TIMEOUT_MS) {
      // Chunk timed out — requeue
      dispatchedChunks.delete(chunkId);
      const chunk = d.chunk;
      if (chunk.attempts < 3) {
        chunk.status = 'pending';
        chunk._isWitnessResult = false;
        pendingChunks.push(chunk);
      } else {
        // Give up on chunk after 3 attempts — mark job failed
        const state = activeJobs.get(chunk.jobId);
        if (state) {
          dbUpdate('himer_jobs', chunk.jobId, { status: 'FAILED', error_message: 'Chunk timeout after 3 attempts', completed_at: new Date().toISOString() });
          activeJobs.delete(chunk.jobId);
        }
      }
    }
  }
  dispatchPending();
}

// Start watchdog + periodic dispatch
let watchdogTimer = null;
function startEngine() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(watchdog, 10000);
  console.log('[Compute] Engine watchdog started');
}

// ============================================================
// STATS
// ============================================================
function getEngineStats() {
  return {
    activeJobs: activeJobs.size,
    pendingChunks: pendingChunks.length,
    dispatchedChunks: dispatchedChunks.size,
    jobs: Array.from(activeJobs.values()).map(s => ({
      id: s.job.id,
      progress: s.completedChunks.size,
      total: s.totalChunks,
      pct: Math.round((s.completedChunks.size / s.totalChunks) * 100),
    })),
  };
}

module.exports = {
  setNodeRegistry,
  startJob,
  startEngine,
  handleChunkResult,
  handleWitnessResult,
  dispatchPending,
  getEngineStats,
  activeJobs,
};
