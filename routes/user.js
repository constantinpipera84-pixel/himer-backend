/**
 * /api/user/* routes.
 * - Join: creates user + device + node (or just device + node if user exists)
 * - Multi-device: same user_id can connect from multiple devices; each = separate node
 * - Resilient: if user not found, auto-recreate from device fingerprint
 */

const crypto = require('crypto');
const { dbInsert, dbGet, dbUpdate, dbList } = require('../lib/db');
const { createRealNode, getUserNodes, realNodes } = require('../lib/nodes');

function newUserId() {
  return 'U-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

function newDeviceId() {
  return 'D-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function deviceFingerprint(req, body = {}) {
  // Combine: user-agent + body.fp (provided by frontend) + IP-prefix
  const ua = req.headers['user-agent'] || '';
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ipPrefix = ip.split('.').slice(0, 2).join('.'); // /16 subnet
  const raw = (body.fp || '') + ':' + ua + ':' + ipPrefix;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function detectDeviceName(ua) {
  ua = ua || '';
  let os = 'Unknown';
  if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Mac OS/i.test(ua)) os = 'Mac';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Linux/i.test(ua)) os = 'Linux';
  let browser = 'Browser';
  if (/Chrome/.test(ua) && !/Edg/.test(ua)) browser = 'Chrome';
  else if (/Firefox/.test(ua)) browser = 'Firefox';
  else if (/Safari/.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/Edg/.test(ua)) browser = 'Edge';
  return `${os} · ${browser}`;
}

async function handle(req, res, url, body, helpers) {
  const { json, ip } = helpers;
  const route = `${req.method} ${url.pathname}`;

  // ============================================================
  // JOIN — create or attach device to user
  // POST /api/user/join
  // Body: { userId?: 'U-...' (optional, if already known), fp?: 'frontend fingerprint' }
  // ============================================================
  if (route === 'POST /api/user/join') {
    let userId = body.userId;
    let user = userId ? await dbGet('himer_users', userId) : null;

    // Create new user if not provided or not found
    if (!user) {
      userId = newUserId();
      user = await dbInsert('himer_users', {
        id: userId,
        email: body.email || null,
        total_earnings: 0,
        withdrawable: 0,
        payout_setup: false,
        tier: 'standard',
        boost_multiplier: 1.0,
        notifications_enabled: true,
        preferred_language: body.lang || 'en',
        device_count: 0,
        last_login_ip: ip,
        created_at: new Date().toISOString(),
      });
    }

    // Identify or create device
    const fp = deviceFingerprint(req, body);
    const deviceName = detectDeviceName(req.headers['user-agent']);
    let device = (await dbList('himer_user_devices', { where: { user_id: userId, device_fingerprint: fp } }))[0];
    let node;
    if (device) {
      // Returning device — reactivate
      await dbUpdate('himer_user_devices', device.id, {
        is_online: true,
        last_seen_at: new Date().toISOString(),
        ip_address: ip,
      });
      // Reuse existing node if still exists
      if (device.node_id) {
        node = realNodes.get(device.node_id) || (await dbGet('himer_nodes', device.node_id));
      }
      if (!node) {
        // Create new node for this device
        node = await createRealNode(userId, device.id);
        await dbUpdate('himer_user_devices', device.id, { node_id: node.id });
      }
    } else {
      // New device
      const deviceId = newDeviceId();
      device = await dbInsert('himer_user_devices', {
        id: deviceId,
        user_id: userId,
        device_fingerprint: fp,
        device_name: deviceName,
        ip_address: ip,
        user_agent: req.headers['user-agent'] || '',
        is_online: true,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      });
      node = await createRealNode(userId, deviceId);
      await dbUpdate('himer_user_devices', deviceId, { node_id: node.id });
    }

    // Update user device count
    const onlineDevices = await dbList('himer_user_devices', { where: { user_id: userId, is_online: true } });
    await dbUpdate('himer_users', userId, {
      device_count: onlineDevices.length,
      last_active_at: new Date().toISOString(),
      last_login_ip: ip,
    });

    // Notify if new device
    if (!user.email || user.created_at === undefined) {
      // Welcome notification for fresh users
      helpers.notify(userId, 'system', 'notif.welcome.title', 'notif.welcome.message', { nodeId: node.id });
    }

    return json(res, {
      userId,
      deviceId: device.id,
      deviceName,
      nodeId: node.id,
      isNewUser: !body.userId,
      isNewDevice: !device.last_seen_at || device.first_seen_at === device.last_seen_at,
      message: body.userId ? 'Device added' : 'Welcome',
    });
  }

  // ============================================================
  // GET USER /api/user/:id
  // ============================================================
  if (route.match(/^GET \/api\/user\/[^/]+$/) && !url.pathname.endsWith('/notifications') && !url.pathname.endsWith('/devices')) {
    const userId = url.pathname.split('/').pop();
    let user = await dbGet('himer_users', userId);

    // RESILIENCE: if user not found, allow creating from "lost" id
    // (Only if it has the right format)
    if (!user && /^U-[0-9A-F]+$/.test(userId)) {
      user = await dbInsert('himer_users', {
        id: userId,
        total_earnings: 0,
        withdrawable: 0,
        payout_setup: false,
        tier: 'standard',
        notifications_enabled: true,
        created_at: new Date().toISOString(),
      });
      console.log('[User] Recreated lost user:', userId);
    }

    if (!user) return json(res, { error: 'User not found' }, 404);

    const userNodesArr = getUserNodes(userId);
    const devices = await dbList('himer_user_devices', { where: { user_id: userId } });
    const onlineDevices = devices.filter(d => d.is_online);

    return json(res, {
      userId,
      email: user.email,
      totalEarnings: parseFloat(user.total_earnings || 0),
      withdrawable: parseFloat(user.withdrawable || 0),
      joinedAt: user.created_at,
      tier: user.tier || 'standard',
      payoutSetup: !!user.payout_setup,
      notificationsEnabled: user.notifications_enabled !== false,
      minWithdraw: parseFloat(process.env.MIN_WITHDRAW || '500'),
      progressToWithdraw: Math.min(100, (parseFloat(user.withdrawable || 0) / parseFloat(process.env.MIN_WITHDRAW || '500')) * 100),
      deviceCount: onlineDevices.length,
      devices: devices.map(d => ({
        id: d.id,
        name: d.device_name,
        country: d.country,
        isOnline: d.is_online,
        firstSeen: d.first_seen_at,
        lastSeen: d.last_seen_at,
        nodeId: d.node_id,
      })),
      nodesList: userNodesArr.map(n => ({
        id: n.id,
        deviceId: n.device_id,
        status: n.status,
        load: n.current_load,
        earnings: +parseFloat(n.total_earnings || 0).toFixed(6),
        uptime: n.uptime_seconds || 0,
        gflops: parseFloat(n.gflops),
        gflopSecondsProcessed: parseInt(n.gflop_seconds_processed || 0),
        contractsCompleted: n.contracts_completed || 0,
        region: n.region,
      })),
      stats: {
        totalNodes: userNodesArr.length,
        activeNow: userNodesArr.filter(n => n.status === 'COMPUTING').length,
        avgUptime: userNodesArr.length ? userNodesArr.reduce((a, n) => a + (n.uptime_seconds || 0), 0) / userNodesArr.length : 0,
        totalGflopSeconds: Math.floor(userNodesArr.reduce((a, n) => a + (parseFloat(n.gflop_seconds_processed) || 0), 0)),
        totalContracts: userNodesArr.reduce((a, n) => a + (n.contracts_completed || 0), 0),
      },
    });
  }

  // ============================================================
  // GET USER NOTIFICATIONS
  // ============================================================
  if (route.match(/^GET \/api\/user\/[^/]+\/notifications$/)) {
    const userId = url.pathname.split('/')[3];
    const list = await dbList('himer_notifications', {
      where: { user_id: userId },
      order: { col: 'created_at', asc: false },
      limit: 50,
    });
    return json(res, {
      notifications: list.map(n => ({
        id: n.id,
        type: n.type,
        titleKey: n.title_key,
        messageKey: n.message_key,
        meta: n.meta,
        read: !!n.is_read,
        ts: new Date(n.created_at).getTime(),
      })),
    });
  }

  // ============================================================
  // TOGGLE NOTIFICATIONS
  // ============================================================
  if (route === 'POST /api/user/notifications/toggle') {
    if (!body.userId) return json(res, { error: 'userId required' }, 400);
    await dbUpdate('himer_users', body.userId, {
      notifications_enabled: !!body.enabled,
    });
    return json(res, { ok: true, enabled: !!body.enabled });
  }

  // ============================================================
  // SETUP PAYOUT METHOD
  // ============================================================
  if (route === 'POST /api/user/payout/setup') {
    if (!body.userId) return json(res, { error: 'userId required' }, 400);
    const user = await dbGet('himer_users', body.userId);
    if (!user) return json(res, { error: 'User not found' }, 404);
    // TODO: trigger Stripe Connect onboarding
    await dbUpdate('himer_users', body.userId, {
      payout_setup: true,
      payout_method: body.method || 'bank',
      payout_verified: false,
    });
    return json(res, { ok: true, message: 'Payout setup initiated. Verification pending.' });
  }

  // ============================================================
  // REQUEST WITHDRAW
  // ============================================================
  if (route === 'POST /api/user/payout/request') {
    const { requestWithdraw } = require('../lib/payouts');
    const r = await requestWithdraw(body.userId, ip);
    if (!r.ok) return json(res, { error: r.reason, code: r.code, available: r.available, minimum: r.minimum }, 400);
    helpers.notify(body.userId, 'payment', 'notif.payoutRequested.title', 'notif.payoutRequested.message', { payoutId: r.payout.id, amount: r.payout.net });
    return json(res, r.payout);
  }

  // ============================================================
  // AI ASK
  // ============================================================
  if (route === 'POST /api/ai/ask') {
    const { ask } = require('../lib/ai');
    const result = await ask(body.question, body.lang || 'en', 'user', !!body.useClaude);
    return json(res, result);
  }

  // ============================================================
  // AD TRACKING
  // ============================================================
  if (route === 'POST /api/ad/impression') {
    const { metrics } = require('../lib/orchestrator');
    metrics.adImpressions++;
    metrics.adRevenue += 1.50 / 1000; // CPM
    return json(res, { ok: true });
  }
  if (route === 'POST /api/ad/click') {
    const { metrics } = require('../lib/orchestrator');
    metrics.adClicks++;
    metrics.adRevenue += 0.45; // CPC
    return json(res, { ok: true });
  }

  return false; // Route not handled
}

module.exports = { handle };
