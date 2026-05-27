/**
 * /api/client/* routes (business clients).
 * Authentication: email+password via login (returns JWT) OR x-api-key header.
 */

const { loginClient, changeClientPassword, verifyClientToken } = require('../lib/auth');
const { dbGet, dbList, dbUpdate } = require('../lib/db');
const { getClientByApiKey, chargeClient } = require('../lib/clients');
const { createJob } = require('../lib/orchestrator');
const { ask } = require('../lib/ai');

async function requireClient(req, res, json) {
  const session = await verifyClientToken(req);
  if (!session) {
    json(res, { error: 'Unauthorized' }, 401);
    return false;
  }
  return session;
}

async function handle(req, res, url, body, helpers) {
  const { json, ip } = helpers;
  const route = `${req.method} ${url.pathname}`;

  // ============================================================
  // LOGIN
  // ============================================================
  if (route === 'POST /api/client/login') {
    const { email, password } = body;
    if (!email || !password) return json(res, { error: 'Email & password required' }, 400);
    const r = await loginClient(email, password, ip);
    if (!r.ok) return json(res, { error: r.reason }, 401);
    return json(res, { token: r.token, client: r.client });
  }

  // ============================================================
  // CHANGE PASSWORD
  // ============================================================
  if (route === 'POST /api/client/change-password') {
    const session = await requireClient(req, res, json);
    if (!session) return true;
    const r = await changeClientPassword(session.client.id, body.newPassword);
    if (!r.ok) return json(res, { error: r.reason }, 400);
    return json(res, { ok: true });
  }

  // ============================================================
  // GET ME (dashboard data)
  // ============================================================
  if (route === 'GET /api/client/me') {
    const session = await requireClient(req, res, json);
    if (!session) return true;
    const c = await dbGet('himer_clients', session.client.id);
    if (!c) return json(res, { error: 'Not found' }, 404);

    // List recent jobs
    const myJobs = await dbList('himer_jobs', {
      where: { client_id: c.id },
      order: { col: 'created_at', asc: false },
      limit: 50,
    });

    return json(res, {
      client: {
        id: c.id,
        email: c.email,
        name: c.name,
        company: c.company,
        balance: parseFloat(c.balance || 0),
        totalSpent: parseFloat(c.total_spent || 0),
        totalToppedUp: parseFloat(c.total_topped_up || 0),
        rateLimit: c.rate_limit_per_minute,
        isActive: c.is_active,
        mustChangePassword: c.must_change_password,
        apiKey: c.must_change_password ? null : c.api_key, // hide until pw changed
        apiKeyCreatedAt: c.api_key_created_at,
        createdAt: c.created_at,
      },
      stats: {
        totalJobs: myJobs.length,
        completedJobs: myJobs.filter(j => j.status === 'DONE').length,
        runningJobs: myJobs.filter(j => j.status === 'RUNNING').length,
      },
      jobs: myJobs.map(j => ({
        id: j.id,
        type: j.job_type,
        nodesNeeded: j.nodes_needed,
        cost: parseFloat(j.cost),
        status: j.status,
        createdAt: j.created_at,
        startedAt: j.started_at,
        completedAt: j.completed_at,
      })),
    });
  }

  // ============================================================
  // LAUNCH JOB (via dashboard, JWT auth)
  // ============================================================
  if (route === 'POST /api/client/job') {
    const session = await requireClient(req, res, json);
    if (!session) return true;
    const c = await dbGet('himer_clients', session.client.id);
    if (!c || !c.is_active) return json(res, { error: 'Account suspended or inactive' }, 403);

    const nodesNeeded = Math.min(parseInt(body.nodes || 3), 100);
    const cost = nodesNeeded * 0.05;

    const charge = await chargeClient(c.id, cost);
    if (!charge.ok) return json(res, { error: charge.reason }, 402);

    const job = await createJob({
      clientId: c.id,
      jobType: body.type || 'compute',
      nodesNeeded,
      cost,
      payload: body.payload || {},
    });

    return json(res, { jobId: job.id, status: 'queued', cost, nodesNeeded });
  }

  // ============================================================
  // PROGRAMMATIC API — /api/v1/compute (x-api-key)
  // ============================================================
  if (route === 'POST /api/v1/compute') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return json(res, { error: 'X-API-Key header required' }, 401);
    const c = await getClientByApiKey(apiKey);
    if (!c || !c.is_active) return json(res, { error: 'Invalid or inactive API key' }, 401);
    const nodesNeeded = Math.min(parseInt(body.nodes || 3), 100);
    const cost = nodesNeeded * 0.05;
    const charge = await chargeClient(c.id, cost);
    if (!charge.ok) return json(res, { error: charge.reason }, 402);
    const job = await createJob({
      clientId: c.id,
      jobType: body.type || 'compute',
      nodesNeeded,
      cost,
      payload: body.payload || {},
    });
    return json(res, { jobId: job.id, status: 'queued', cost });
  }

  // ============================================================
  // CLIENT AI ASK (uses CLIENT FAQ)
  // ============================================================
  if (route === 'POST /api/client/ai/ask') {
    const result = await ask(body.question, body.lang || 'en', 'client', !!body.useClaude);
    return json(res, result);
  }

  return false;
}

module.exports = { handle };
