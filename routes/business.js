/**
 * HIMER v5 — Business client API routes
 *
 * Endpoints (all require X-API-Key header except /pricing):
 *   GET  /api/business/pricing       - public pricing info
 *   GET  /api/business/me            - current client info + usage
 *   GET  /api/business/jobs          - list my jobs
 *   POST /api/business/jobs          - submit new job
 *   GET  /api/business/jobs/:id      - job status + result
 *   GET  /api/business/invoices      - list invoices
 *   POST /api/business/topup         - add credits (PAYG)
 */
const { dbGet, dbList, dbUpdate, dbInsert } = require('../lib/db');
const { PLANS, PAYG_PRICE_PER_GFLOPS, verifyApiKey, canSubmitJob, recordJobUsage } = require('../lib/business');
const { submitJob, completeJob, listJobs } = require('../lib/jobs');

function json(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

async function handle(req, res, url, parsedBody) {
  const method = req.method || 'GET';
  const route = `${method} ${url.pathname}`;
  // body already parsed by server.js — fallback to readBody if not provided
  const getBody = async () => parsedBody !== undefined ? parsedBody : await readBody(req);

  // PUBLIC: self-signup for API key (creates client + returns key immediately)
  if (route === 'POST /api/business/signup') {
    const body = await getBody();
    const name = (body.name || '').trim();
    const email = (body.email || '').trim().toLowerCase();
    const company = (body.company || '').trim();
    const plan = ['free', 'starter', 'pro', 'enterprise'].includes(body.plan) ? body.plan : 'free';

    if (!name || !email) return json(res, { error: 'Name and email are required' }, 400);
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return json(res, { error: 'Invalid email' }, 400);

    const { createClient } = require('../lib/business');
    try {
      // Free plan = instant key. Paid plans = create as pending (admin/payment confirms)
      if (plan === 'free') {
        const { client, apiKey } = await createClient({ name, email, company, plan: 'free' });
        // Record signup
        try {
          await dbInsert('himer_signup_requests', {
            id: 'SR-' + Date.now().toString(36).toUpperCase(),
            name, email, company, plan,
            status: 'issued',
            api_key_issued: client.api_key_prefix,
            client_id: client.id,
            created_at: new Date().toISOString(),
            processed_at: new Date().toISOString(),
          });
        } catch (_) {}
        return json(res, {
          ok: true,
          instant: true,
          api_key: apiKey,
          client_id: client.id,
          plan: 'free',
          message: 'Your free API key is ready. Save it now — it is shown only once.',
        }, 201);
      } else {
        // Paid plan: record request, admin will activate after payment
        const reqId = 'SR-' + Date.now().toString(36).toUpperCase();
        await dbInsert('himer_signup_requests', {
          id: reqId, name, email, company, plan,
          status: 'pending', created_at: new Date().toISOString(),
        });
        return json(res, {
          ok: true,
          instant: false,
          reference: reqId,
          plan,
          message: 'Request received. We will email your API key after payment setup. Check your inbox.',
        }, 201);
      }
    } catch (e) {
      if (String(e.message).includes('already exists')) {
        return json(res, { error: 'An account with this email already exists. Contact support to retrieve your key.' }, 409);
      }
      return json(res, { error: 'Signup failed: ' + e.message }, 500);
    }
  }

  // PUBLIC: contact info (from settings)
  if (route === 'GET /api/business/contact') {
    try {
      const settings = await dbList('himer_settings', {});
      const map = {};
      for (const s of settings) map[s.key] = s.value;
      return json(res, {
        email: map.contact_email || 'himer.nodes@gmail.com',
        support_email: map.contact_support_email || 'himer.nodes@gmail.com',
        phone: map.contact_phone || '',
        telegram: map.contact_telegram || '',
        company: map.company_name || 'HIMER Network',
      });
    } catch (_) {
      return json(res, { email: 'himer.nodes@gmail.com', support_email: 'himer.nodes@gmail.com' });
    }
  }

  // PUBLIC: pricing info
  if (route === 'GET /api/business/pricing') {
    return json(res, {
      plans: Object.entries(PLANS)
        .filter(([k]) => !['owner'].includes(k))
        .map(([key, p]) => ({
          key,
          name: p.name,
          monthly_quota_gflops_sec: p.monthly_quota,
          price_usd_per_month: p.price_usd,
          api_calls_per_min: p.api_calls_per_min,
        })),
      payg_price_per_gflops_sec: PAYG_PRICE_PER_GFLOPS,
      currency: 'USD',
      notes: [
        'Quota is GFLOP-seconds per month (1 GFLOPS for 1 second).',
        'PAYG: charged per actual usage. Other plans: monthly quota, soft limit.',
        'Annual billing: 20% discount available — contact sales@himer.network',
      ],
    });
  }

  // All other routes require API key
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!apiKey) return json(res, { error: 'Missing X-API-Key header' }, 401);

  const client = await verifyApiKey(apiKey);
  if (!client) return json(res, { error: 'Invalid or revoked API key' }, 401);

  // GET /api/business/me
  if (route === 'GET /api/business/me') {
    return json(res, {
      id: client.id,
      name: client.name,
      email: client.email,
      company: client.company,
      plan: client.plan,
      plan_name: PLANS[client.plan]?.name || client.plan,
      is_owner: !!client.is_owner,
      monthly_gflops_quota: client.monthly_gflops_quota,
      monthly_gflops_used: client.monthly_gflops_used,
      monthly_resets_at: client.monthly_resets_at,
      balance_credits: client.balance_credits || 0,
      balance_owed: client.balance_owed || 0,
      total_paid: client.total_paid || 0,
      total_jobs_submitted: client.total_jobs_submitted || 0,
      api_key_prefix: client.api_key_prefix,
      created_at: client.created_at,
    });
  }

  // GET /api/business/jobs
  if (route === 'GET /api/business/jobs') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
    const status = url.searchParams.get('status');
    const jobs = await listJobs({ clientId: client.id, status, limit });
    return json(res, {
      jobs: jobs.map((j) => ({
        id: j.id,
        type: j.job_type,
        name: j.job_name,
        status: j.status,
        required_gflops: j.required_gflops_seconds,
        actual_gflops: j.actual_gflops_seconds,
        cost: j.cost_total,
        created_at: j.created_at,
        completed_at: j.completed_at,
        error: j.error_message,
      })),
    });
  }

  // POST /api/business/jobs
  if (route === 'POST /api/business/jobs') {
    const body = await getBody();
    const requiredGflops = parseFloat(body.required_gflops_seconds || body.gflops || 0);
    if (!requiredGflops || requiredGflops <= 0) {
      return json(res, { error: 'required_gflops_seconds must be > 0' }, 400);
    }
    if (requiredGflops > 1e9) {
      return json(res, { error: 'Job too large. Split into smaller jobs (max 1B GFLOP-s per job).' }, 400);
    }

    const check = await canSubmitJob(client, requiredGflops);
    if (!check.ok) return json(res, { error: check.reason }, 402);

    const job = await submitJob({
      client,
      jobType: body.job_type || 'compute',
      jobName: body.name || `Job ${new Date().toISOString().slice(0, 10)}`,
      inputData: body.input_data || body.input || {},
      requiredGflops,
      requiredRamGb: parseFloat(body.required_ram_gb || 1),
      requiredBwMbps: parseFloat(body.required_bw_mbps || 1),
    });

    return json(res, {
      job_id: job.id,
      status: job.status,
      estimated_cost_usd: check.costEstimate || 0,
      message: 'Job queued. Poll GET /api/business/jobs/:id for status.',
    }, 201);
  }

  // GET /api/business/jobs/:id
  const jobMatch = route.match(/^GET \/api\/business\/jobs\/([A-Z0-9-]+)$/i);
  if (jobMatch) {
    const job = await dbGet('himer_jobs', jobMatch[1]);
    if (!job || job.client_id !== client.id) return json(res, { error: 'Job not found' }, 404);
    return json(res, {
      id: job.id,
      type: job.job_type,
      name: job.job_name,
      status: job.status,
      required_gflops: job.required_gflops_seconds,
      actual_gflops: job.actual_gflops_seconds,
      cost: job.cost_total,
      input: job.input_data,
      result: job.result_data,
      result_hash: job.result_hash,
      error: job.error_message,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
    });
  }

  // GET /api/business/invoices
  if (route === 'GET /api/business/invoices') {
    const invoices = await dbList('himer_invoices', { where: { client_id: client.id }, orderBy: 'created_at', desc: true });
    return json(res, { invoices });
  }

  // POST /api/business/topup — record prepaid credits
  if (route === 'POST /api/business/topup') {
    const body = await getBody();
    const amount = parseFloat(body.amount_usd || 0);
    if (!amount || amount < 10) return json(res, { error: 'Minimum top-up: $10' }, 400);
    // In real flow: would call Stripe Checkout / crypto invoice
    // For now: admin-only manual approval. Return pending status.
    return json(res, {
      message: 'Top-up requested. Pay to receive credits.',
      amount_usd: amount,
      payment_methods: [
        { type: 'crypto', network: 'polygon', token: 'USDC', address: process.env.OWNER_USDC_ADDRESS || 'TBD' },
        { type: 'bank', iban: process.env.OWNER_BANK_IBAN || 'TBD', reference: `TOPUP-${client.id}` },
      ],
    });
  }

  return json(res, { error: 'Not found' }, 404);
}

module.exports = { handle };
