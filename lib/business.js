/**
 * HIMER v5 — Business clients management
 * - API key generation/verification (SHA-256 hash)
 * - Plans: free, starter, pro, enterprise, payg, owner
 * - Monthly quota tracking + auto-reset
 */
const crypto = require('crypto');
const { dbGet, dbInsert, dbUpdate, dbList } = require('./db');

const PLANS = {
  free:       { name: 'Free',       monthly_quota: 10000,    price_usd: 0,    api_calls_per_min: 10 },
  starter:    { name: 'Starter',    monthly_quota: 500000,   price_usd: 29,   api_calls_per_min: 60 },
  pro:        { name: 'Pro',        monthly_quota: 5000000,  price_usd: 149,  api_calls_per_min: 300 },
  enterprise: { name: 'Enterprise', monthly_quota: 999999999, price_usd: 999, api_calls_per_min: 9999 },
  payg:       { name: 'Pay-as-you-go', monthly_quota: 999999999, price_usd: 0, api_calls_per_min: 100 },
  owner:      { name: 'Owner (free unlimited)', monthly_quota: 999999999, price_usd: 0, api_calls_per_min: 99999 },
};

// PAYG pricing per GFLOP-second
const PAYG_PRICE_PER_GFLOPS = 0.0002;

function generateApiKey() {
  // Format: hk_live_<32 random base62 chars>
  const random = crypto.randomBytes(32).toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
  return `hk_live_${random}`;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function newClientId() {
  return 'C-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

function newJobId() {
  return 'J-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function nextMonthReset() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString();
}

async function createClient({ name, email, company, country, plan = 'free', isOwner = false }) {
  if (!name || !email) throw new Error('Name and email required');
  if (!PLANS[plan]) throw new Error('Invalid plan');

  const existing = (await dbList('himer_clients', { where: { email } }))[0];
  if (existing) throw new Error('Client with this email already exists');

  const apiKey = generateApiKey();
  const id = newClientId();
  const planCfg = PLANS[plan];

  const client = await dbInsert('himer_clients', {
    id,
    name,
    email: email.toLowerCase(),
    company: company || null,
    country: country || null,
    api_key_hash: hashApiKey(apiKey),
    api_key_prefix: apiKey.slice(0, 12) + '...',
    plan,
    monthly_gflops_quota: planCfg.monthly_quota,
    monthly_gflops_used: 0,
    monthly_resets_at: nextMonthReset(),
    is_owner: isOwner,
    is_active: true,
    created_at: new Date().toISOString(),
  });

  return { client, apiKey };
}

async function verifyApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.startsWith('hk_')) return null;
  const hash = hashApiKey(apiKey);
  const client = (await dbList('himer_clients', { where: { api_key_hash: hash } }))[0];
  if (!client) return null;
  if (!client.is_active) return null;

  // Check monthly reset
  if (client.monthly_resets_at && new Date(client.monthly_resets_at) <= new Date()) {
    await dbUpdate('himer_clients', client.id, {
      monthly_gflops_used: 0,
      monthly_resets_at: nextMonthReset(),
    });
    client.monthly_gflops_used = 0;
  }
  return client;
}

async function canSubmitJob(client, requiredGflops) {
  if (client.is_owner) return { ok: true };
  if (client.plan === 'payg') {
    const cost = requiredGflops * PAYG_PRICE_PER_GFLOPS;
    if ((client.balance_credits || 0) < cost && (client.balance_owed || 0) < 100) {
      return { ok: false, reason: 'Insufficient credits. Top up or accept invoice.' };
    }
    return { ok: true, costEstimate: cost };
  }
  const remaining = (client.monthly_gflops_quota || 0) - (client.monthly_gflops_used || 0);
  if (requiredGflops > remaining) {
    return { ok: false, reason: `Quota exceeded. ${remaining} GFLOP-s left this month.` };
  }
  return { ok: true };
}

async function recordJobUsage(clientId, actualGflopsSec, costTotal) {
  const client = await dbGet('himer_clients', clientId);
  if (!client) return;
  await dbUpdate('himer_clients', clientId, {
    monthly_gflops_used: (client.monthly_gflops_used || 0) + actualGflopsSec,
    total_jobs_submitted: (client.total_jobs_submitted || 0) + 1,
    balance_owed: (client.balance_owed || 0) + (client.is_owner ? 0 : costTotal),
    last_request_at: new Date().toISOString(),
  });
}

module.exports = {
  PLANS,
  PAYG_PRICE_PER_GFLOPS,
  generateApiKey,
  hashApiKey,
  createClient,
  verifyApiKey,
  canSubmitJob,
  recordJobUsage,
  newClientId,
  newJobId,
};
