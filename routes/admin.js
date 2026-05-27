/**
 * /api/admin/* routes.
 * All protected by JWT (except login).
 */

const crypto = require('crypto');
const {
  loginAdmin, changeAdminPassword, verifyAdminToken, logAdminAction,
} = require('../lib/auth');
const { dbList, dbGet, dbSum } = require('../lib/db');
const { metrics, createJob, jobs } = require('../lib/orchestrator');
const { getNodeCounts, realNodes, seedNodes, compactNode } = require('../lib/nodes');
const {
  listPendingPayouts, listAllPayouts, approvePayout, rejectPayout, getTreasuryStats,
} = require('../lib/payouts');
const {
  createClient, listClients, suspendClient, reactivateClient,
  topUpClientBalance, regenerateApiKey,
} = require('../lib/clients');

async function requireAdmin(req, res, json) {
  const session = await verifyAdminToken(req);
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
  // LOGIN — POST /api/admin/login
  // ============================================================
  if (route === 'POST /api/admin/login') {
    const { email, password } = body;
    if (!email || !password) return json(res, { error: 'Email & password required' }, 400);
    const result = await loginAdmin(email, password, ip);
    if (!result.ok) return json(res, { error: result.reason }, 401);
    return json(res, {
      token: result.token,
      admin: result.admin,
    });
  }

  // ============================================================
  // CHANGE PASSWORD — POST /api/admin/change-password
  // ============================================================
  if (route === 'POST /api/admin/change-password') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    const { newPassword } = body;
    const r = await changeAdminPassword(session.admin.id, newPassword);
    if (!r.ok) return json(res, { error: r.reason }, 400);
    await logAdminAction(session.admin.id, 'password_changed', 'admin', session.admin.id, ip);
    return json(res, { ok: true });
  }

  // ============================================================
  // OVERVIEW — GET /api/admin/overview
  // ============================================================
  if (route === 'GET /api/admin/overview') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;

    const counts = getNodeCounts();
    const users = await dbList('himer_users');
    const usersWithPayout = users.filter(u => u.payout_setup);
    const totalEarnedAll = users.reduce((a, u) => a + parseFloat(u.total_earnings || 0), 0);
    const totalWithdrawable = users.reduce((a, u) => a + parseFloat(u.withdrawable || 0), 0);
    const treasury = await getTreasuryStats();
    const pendingPayoutCount = (await listPendingPayouts()).length;

    return json(res, {
      mustChangePassword: !!session.mustChange,
      passwordExpiresAt: session.admin.password_expires_at,
      reality: {
        realNodes: counts.real,
        seedNodes: counts.seed,
        totalDisplayed: counts.total,
        realActive: counts.realActive,
        realInactive: counts.realInactive,
        seedActive: counts.seedActive,
        realUsers: users.length,
        usersWithPayoutSetup: usersWithPayout.length,
        totalRealEarnings: totalEarnedAll,
        totalWithdrawable,
      },
      treasury: {
        balance: treasury.balance,
        totalIn: treasury.totalIn,
        totalOut: treasury.totalOut,
        obligationsToUsers: treasury.obligationsToUsers,
        pendingPayouts: treasury.pendingPayouts,
        netAvailable: treasury.netAvailable,
        payoutsDistributed: treasury.totalOut,
      },
      revenue: {
        platform60: metrics.platformRevenue,
        users40: metrics.userRevenue,
        adRevenue: metrics.adRevenue,
        total: metrics.platformRevenue + metrics.userRevenue + metrics.adRevenue,
      },
      adStats: {
        impressions: metrics.adImpressions,
        clicks: metrics.adClicks,
        ctr: metrics.adImpressions > 0 ? (metrics.adClicks / metrics.adImpressions * 100).toFixed(2) + '%' : '0%',
        revenue: metrics.adRevenue,
        estimatedMonthly: ((metrics.adRevenue / Math.max(1, (Date.now() - metrics.startedAt) / 1000)) * 86400 * 30) || 0,
      },
      jobs: {
        total: jobs.size,
        pending: Array.from(jobs.values()).filter(j => j.status === 'PENDING').length,
        running: Array.from(jobs.values()).filter(j => j.status === 'RUNNING').length,
        done: metrics.jobsCompleted,
      },
      pendingPayoutCount,
    });
  }

  // ============================================================
  // ADMIN MAP DATA (with real/seed distinction)
  // ============================================================
  if (route === 'GET /api/admin/map') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    const nodes = [];
    for (const n of realNodes.values()) {
      nodes.push({ ...compactNode(n, true) });
    }
    // Sample seed nodes (up to 500)
    let count = 0;
    for (const n of seedNodes.values()) {
      if (count++ >= 500) break;
      nodes.push({ ...compactNode(n, true) });
    }
    return json(res, { nodes });
  }

  // ============================================================
  // PAYOUTS — GET /api/admin/payouts
  // ============================================================
  if (route === 'GET /api/admin/payouts') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    const list = await listAllPayouts(200);
    return json(res, { payouts: list });
  }

  // ============================================================
  // APPROVE PAYOUT
  // ============================================================
  if (route === 'POST /api/admin/payouts/approve') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    if (session.mustChange) return json(res, { error: 'Change password first' }, 403);
    const r = await approvePayout(body.payoutId, session.admin.id, ip);
    if (!r.ok) return json(res, { error: r.reason }, 400);
    await logAdminAction(session.admin.id, 'payout_approved', 'payout', body.payoutId, ip, { net: r.netAmount });
    // Get user from payout and notify
    const payout = await dbGet('himer_payouts', body.payoutId);
    if (payout) {
      helpers.notify(payout.user_id, 'payment',
        'notif.payoutPaid.title', 'notif.payoutPaid.message',
        { payoutId: payout.id, amount: r.netAmount });
    }
    return json(res, r);
  }

  // ============================================================
  // REJECT PAYOUT
  // ============================================================
  if (route === 'POST /api/admin/payouts/reject') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    if (session.mustChange) return json(res, { error: 'Change password first' }, 403);
    const r = await rejectPayout(body.payoutId, session.admin.id, body.reason);
    if (!r.ok) return json(res, { error: r.reason }, 400);
    await logAdminAction(session.admin.id, 'payout_rejected', 'payout', body.payoutId, ip, { reason: body.reason });
    return json(res, r);
  }

  // ============================================================
  // USERS LIST
  // ============================================================
  if (route === 'GET /api/admin/users') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    const users = await dbList('himer_users', { order: { col: 'created_at', asc: false }, limit: 500 });
    return json(res, {
      users: users.map(u => ({
        id: u.id,
        email: u.email,
        totalEarnings: parseFloat(u.total_earnings || 0),
        withdrawable: parseFloat(u.withdrawable || 0),
        deviceCount: u.device_count,
        payoutSetup: !!u.payout_setup,
        joinedAt: u.created_at,
        lastActiveAt: u.last_active_at,
      })),
    });
  }

  // ============================================================
  // CLIENTS LIST
  // ============================================================
  if (route === 'GET /api/admin/clients') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    const list = await listClients();
    return json(res, {
      clients: list.map(c => ({
        id: c.id,
        email: c.email,
        name: c.name,
        company: c.company,
        balance: parseFloat(c.balance || 0),
        totalSpent: parseFloat(c.total_spent || 0),
        totalToppedUp: parseFloat(c.total_topped_up || 0),
        isActive: c.is_active,
        suspendedReason: c.suspended_reason,
        createdAt: c.created_at,
        lastLoginAt: c.last_login_at,
        // NEVER expose password_hash or full api_key here
        apiKeyPreview: c.api_key ? c.api_key.slice(0, 16) + '...' : null,
      })),
    });
  }

  // ============================================================
  // CREATE CLIENT
  // ============================================================
  if (route === 'POST /api/admin/clients/create') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    if (session.mustChange) return json(res, { error: 'Change password first' }, 403);
    const r = await createClient({
      email: body.email,
      name: body.name,
      company: body.company,
      initialBalance: parseFloat(body.initialBalance || 0),
      createdByAdminId: session.admin.id,
      rateLimit: body.rateLimit,
    });
    if (!r.ok) return json(res, { error: r.reason }, 400);
    await logAdminAction(session.admin.id, 'client_created', 'client', r.client.id, ip, { email: r.client.email });
    return json(res, {
      ok: true,
      clientId: r.client.id,
      email: r.client.email,
      initialPassword: r.initialPassword,    // SHOW ONLY ONCE
      apiKey: r.apiKey,                       // SHOW ONLY ONCE
      loginUrl: `${url.origin || req.headers.origin || ''}/client.html`,
    });
  }

  // ============================================================
  // SUSPEND / REACTIVATE CLIENT
  // ============================================================
  if (route === 'POST /api/admin/clients/suspend') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    await suspendClient(body.clientId, body.reason, session.admin.id);
    await logAdminAction(session.admin.id, 'client_suspended', 'client', body.clientId, ip);
    return json(res, { ok: true });
  }
  if (route === 'POST /api/admin/clients/reactivate') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    await reactivateClient(body.clientId);
    await logAdminAction(session.admin.id, 'client_reactivated', 'client', body.clientId, ip);
    return json(res, { ok: true });
  }

  // ============================================================
  // TOP UP CLIENT
  // ============================================================
  if (route === 'POST /api/admin/clients/topup') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    const amt = parseFloat(body.amount || 0);
    if (amt <= 0) return json(res, { error: 'Invalid amount' }, 400);
    const r = await topUpClientBalance(body.clientId, amt, session.admin.id);
    if (!r.ok) return json(res, { error: r.reason }, 400);
    await logAdminAction(session.admin.id, 'client_topup', 'client', body.clientId, ip, { amount: amt });
    return json(res, r);
  }

  // ============================================================
  // REGENERATE API KEY
  // ============================================================
  if (route === 'POST /api/admin/clients/regen-key') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    const r = await regenerateApiKey(body.clientId);
    await logAdminAction(session.admin.id, 'client_apikey_regen', 'client', body.clientId, ip);
    return json(res, r);
  }

  // ============================================================
  // LAUNCH TEST JOB
  // ============================================================
  if (route === 'POST /api/admin/job') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    const job = await createJob({
      clientId: null,
      jobType: body.type || 'test',
      nodesNeeded: parseInt(body.nodes || 5),
      cost: parseFloat(body.reward || 1),
    });
    await logAdminAction(session.admin.id, 'job_launched', 'job', job.id, ip);
    return json(res, { jobId: job.id });
  }

  // ============================================================
  // AUDIT LOG
  // ============================================================
  if (route === 'GET /api/admin/audit') {
    const session = await requireAdmin(req, res, json);
    if (!session) return true;
    const list = await dbList('himer_admin_audit', { order: { col: 'created_at', asc: false }, limit: 100 });
    return json(res, { audit: list });
  }

  return false; // Route not handled
}

module.exports = { handle };
