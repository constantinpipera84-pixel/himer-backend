/**
 * HIMER v5 — Compute jobs lifecycle
 *
 * Lifecycle: PENDING -> DISPATCHED -> COMPUTING -> COMPLETED/FAILED
 * Pricing: cost = gflops_used * PAYG_PRICE (PAYG plan)
 *   or eats quota (subscription plans)
 * Split: 60% platform, 40% to nodes (PLATFORM_FEE env var)
 */
const crypto = require('crypto');
const { dbInsert, dbUpdate, dbGet, dbList } = require('./db');
const { newJobId, PAYG_PRICE_PER_GFLOPS } = require('./business');

const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE || '0.6');

async function submitJob({ client, jobType, jobName, inputData, requiredGflops, requiredRamGb = 1, requiredBwMbps = 1 }) {
  // Calculate cost (owner = 0, others = price)
  let costTotal = 0;
  if (!client.is_owner) {
    if (client.plan === 'payg') {
      costTotal = requiredGflops * PAYG_PRICE_PER_GFLOPS;
    } else {
      // Subscription plans: cost computed but not charged immediately (deducted from quota)
      costTotal = 0;
    }
  }

  const id = newJobId();
  const job = await dbInsert('himer_jobs', {
    id,
    client_id: client.id,
    is_owner_job: !!client.is_owner,
    job_type: jobType || 'compute',
    job_name: jobName || 'Untitled Job',
    input_data: inputData || {},
    status: 'PENDING',
    required_gflops_seconds: requiredGflops,
    required_ram_gb: requiredRamGb,
    required_bw_mbps: requiredBwMbps,
    cost_total: costTotal,
    cost_to_users: costTotal * (1 - PLATFORM_FEE),
    cost_platform_fee: costTotal * PLATFORM_FEE,
    created_at: new Date().toISOString(),
  });

  // Hand the job to the compute engine for chunking + dispatch to real nodes
  try {
    const compute = require('./compute');
    await compute.startJob(job);
  } catch (e) {
    console.error('[Jobs] Failed to start compute for job', id, e.message);
  }

  return job;
}

async function completeJob(jobId, { actualGflops, resultData, resultHash, errorMessage }) {
  const job = await dbGet('himer_jobs', jobId);
  if (!job) return null;

  const finalGflops = actualGflops || job.required_gflops_seconds;
  const isOwnerJob = !!job.is_owner_job;
  const status = errorMessage ? 'FAILED' : 'COMPLETED';

  // Recompute cost based on actual usage
  let finalCost = 0;
  if (!isOwnerJob) {
    const client = await dbGet('himer_clients', job.client_id);
    if (client && client.plan === 'payg') {
      finalCost = finalGflops * PAYG_PRICE_PER_GFLOPS;
    }
  }

  const update = {
    status,
    actual_gflops_seconds: finalGflops,
    cost_total: finalCost,
    cost_to_users: finalCost * (1 - PLATFORM_FEE),
    cost_platform_fee: finalCost * PLATFORM_FEE,
    result_data: resultData || null,
    result_hash: resultHash || null,
    error_message: errorMessage || null,
    completed_at: new Date().toISOString(),
  };
  await dbUpdate('himer_jobs', jobId, update);

  // Record revenue (if not owner)
  if (!isOwnerJob && finalCost > 0 && status === 'COMPLETED') {
    await dbInsert('himer_revenue_ledger', {
      source: 'compute_job',
      amount: finalCost * PLATFORM_FEE,
      currency: 'USD',
      client_id: job.client_id,
      job_id: jobId,
      reference: `Compute job ${jobId}`,
      created_at: new Date().toISOString(),
    });
  }

  return { ...job, ...update };
}

async function listJobs({ clientId, status, limit = 50, ownerOnly = false } = {}) {
  const where = {};
  if (clientId) where.client_id = clientId;
  if (status) where.status = status;
  if (ownerOnly) where.is_owner_job = true;
  return await dbList('himer_jobs', { where, orderBy: 'created_at', desc: true, limit });
}

module.exports = {
  submitJob,
  completeJob,
  listJobs,
  PLATFORM_FEE,
};
