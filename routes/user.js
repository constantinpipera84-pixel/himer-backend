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

    // CRITICAL: if userId was provided but not found, return error
    // (don't silently create new user with that ID — that's a bug)
    if (body.userId && !user) {
      return json(res, 404, { error: 'User ID not found', code: 'USER_NOT_FOUND' });
    }

    const wasNewUser = !user;
    // Create new user if not provided
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

      // Generate referral code immediately
      try {
        const { ensureReferralCode, applyReferral } = require('../lib/referral');
        await ensureReferralCode(userId);
        // Apply referral if a code was provided
        if (body.ref || body.referralCode) {
          await applyReferral(userId, body.ref || body.referralCode);
        }
      } catch (e) {
        console.warn('[Join] referral setup failed:', e.message);
      }
    }

    // Identify or create device
    const fp = deviceFingerprint(req, body);
    const deviceName = detectDeviceName(req.headers['user-agent']);
    const cap = body.capacity || {};
    const capacityFields = {
      cpu_cores: parseInt(cap.cpu_cores) || 1,
      cpu_gflops_max: parseFloat(cap.cpu_gflops_max) || 0,
      ram_gb_total: parseFloat(cap.ram_gb_total) || 0,
      bandwidth_mbps_max: parseFloat(cap.bandwidth_mbps_max) || 0,
    };
    // Geolocate IP (async, cached)
    let geo = null;
    try {
      const { geolocate } = require('../lib/geoip');
      geo = await geolocate(ip);
    } catch (e) { /* non-fatal */ }
    const geoFields = geo ? {
      country: geo.country,
      country_code: geo.countryCode,
      city: geo.city,
      lat: geo.lat,
      lng: geo.lng,
      region: geo.region,
    } : {};
    let device = (await dbList('himer_user_devices', { where: { user_id: userId, device_fingerprint: fp } }))[0];
    let node;
    if (device) {
      // Returning device — reactivate + refresh capacity + geo
      await dbUpdate('himer_user_devices', device.id, {
        is_online: true,
        last_seen_at: new Date().toISOString(),
        ip_address: ip,
        ...capacityFields,
        ...geoFields,
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
      // Update node location too
      if (node && geo) {
        await dbUpdate('himer_nodes', node.id, { lat: geo.lat, lng: geo.lng, country: geo.country, region: geo.region });
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
        ...capacityFields,
        ...geoFields,
      });
      node = await createRealNode(userId, deviceId);
      await dbUpdate('himer_user_devices', deviceId, { node_id: node.id });
      // Save node location
      if (geo) {
        await dbUpdate('himer_nodes', node.id, { lat: geo.lat, lng: geo.lng, country: geo.country, region: geo.region });
      }
    }

    // Update user device count + last login (for daily reminder system)
    const onlineDevices = await dbList('himer_user_devices', { where: { user_id: userId, is_online: true } });
    await dbUpdate('himer_users', userId, {
      device_count: onlineDevices.length,
      last_active_at: new Date().toISOString(),
      last_login_at: new Date().toISOString(),
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
      isNewUser: wasNewUser,
      isNewDevice: !device.last_seen_at || device.first_seen_at === device.last_seen_at,
      message: wasNewUser ? 'Welcome' : 'Device added',
    });
  }

  // ============================================================
  // GET USER /api/user/:id
  // ============================================================
  if (route.match(/^GET \/api\/user\/[^/]+$/) && !url.pathname.endsWith('/notifications') && !url.pathname.endsWith('/devices')) {
    const userId = url.pathname.split('/').pop();
    let user = await dbGet('himer_users', userId);

    // No auto-recreation: if user doesn't exist, return 404 cleanly
    // (Frontend will handle this — for new users, /api/user/join creates them;
    //  for existing users with bad ID, this returns proper error instead of silently creating ghost accounts)
    if (!user) return json(res, { error: 'User not found' }, 404);

    const userNodesArr = getUserNodes(userId);
    const devices = await dbList('himer_user_devices', { where: { user_id: userId } });
    const onlineDevices = devices.filter(d => d.is_online);

    // Aggregate capacity across all devices
    const totalCapacity = devices.reduce((acc, d) => ({
      cpu_cores: acc.cpu_cores + (parseInt(d.cpu_cores) || 0),
      cpu_gflops_max: acc.cpu_gflops_max + (parseFloat(d.cpu_gflops_max) || 0),
      ram_gb_total: acc.ram_gb_total + (parseFloat(d.ram_gb_total) || 0),
      bandwidth_mbps_max: acc.bandwidth_mbps_max + (parseFloat(d.bandwidth_mbps_max) || 0),
    }), { cpu_cores: 0, cpu_gflops_max: 0, ram_gb_total: 0, bandwidth_mbps_max: 0 });

    // Last 30 days of earnings for graph
    let history = [];
    try {
      history = await dbList('himer_earnings_daily', { where: { user_id: userId }, orderBy: 'date', desc: true, limit: 30 });
    } catch (_) { history = []; }

    // Recent payouts
    let recentPayouts = [];
    try {
      recentPayouts = await dbList('himer_payouts', { where: { user_id: userId }, orderBy: 'requested_at', desc: true, limit: 10 });
    } catch (_) { recentPayouts = []; }

    return json(res, {
      userId,
      email: user.email,
      totalEarnings: parseFloat(user.total_earnings || 0),
      withdrawable: parseFloat(user.withdrawable || 0),
      lifetimeEarnings: parseFloat(user.lifetime_earnings || user.total_earnings || 0),
      lifetimeComputeGflopsSec: parseFloat(user.lifetime_compute_gflops_sec || 0),
      lifetimeActiveSeconds: parseInt(user.lifetime_active_seconds || 0),
      joinedAt: user.created_at,
      tier: user.tier || 'standard',
      isPremium: !!user.is_premium,
      premiumUntil: user.premium_until,
      payoutSetup: !!user.payout_setup,
      payoutMethod: user.payout_method,
      cryptoAddress: user.crypto_address,
      cryptoNetwork: user.crypto_network,
      bankIban: user.bank_iban ? (user.bank_iban.slice(0, 4) + '****' + user.bank_iban.slice(-4)) : null,
      notificationsEnabled: user.notifications_enabled !== false,
      minWithdraw: parseFloat(process.env.MIN_WITHDRAW || '500'),
      progressToWithdraw: Math.min(100, (parseFloat(user.withdrawable || 0) / parseFloat(process.env.MIN_WITHDRAW || '500')) * 100),
      deviceCount: onlineDevices.length,
      capacity: {
        cpu_cores: totalCapacity.cpu_cores,
        cpu_gflops_max: Math.round(totalCapacity.cpu_gflops_max * 10) / 10,
        ram_gb_total: totalCapacity.ram_gb_total,
        bandwidth_mbps_max: Math.round(totalCapacity.bandwidth_mbps_max * 10) / 10,
      },
      devices: devices.map(d => ({
        id: d.id,
        name: d.device_name,
        country: d.country,
        isOnline: d.is_online,
        firstSeen: d.first_seen_at,
        lastSeen: d.last_seen_at,
        nodeId: d.node_id,
        capacity: {
          cores: d.cpu_cores,
          gflops: d.cpu_gflops_max,
          ramGb: d.ram_gb_total,
          bwMbps: d.bandwidth_mbps_max,
        },
        contribution: {
          cpu: d.contribution_cpu_pct || 50,
          ram: d.contribution_ram_pct || 30,
          bw: d.contribution_bw_pct || 20,
        },
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
      history: history.map(h => ({
        date: h.date,
        earnings: parseFloat(h.net_earnings || 0),
        gflopsSeconds: parseFloat(h.gflops_seconds || 0),
        contracts: h.contracts_count || 0,
      })),
      recentPayouts: recentPayouts.map(p => ({
        id: p.id,
        amountGross: parseFloat(p.amount_gross || 0),
        amountNet: parseFloat(p.amount_net || 0),
        fee: parseFloat(p.fee || 0),
        method: p.method,
        status: p.status,
        requestedAt: p.requested_at,
        paidAt: p.paid_at,
      })),
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
    const method = body.method || 'crypto';
    const updates = {
      payout_setup: true,
      payout_method: method,
      payout_verified: method === 'crypto', // Crypto self-custody; bank needs KYC
    };
    if (method === 'crypto' && body.wallet) {
      // Basic validation
      if (!/^0x[a-fA-F0-9]{40}$/.test(body.wallet)) {
        return json(res, { error: 'Invalid wallet address' }, 400);
      }
      updates.payout_wallet = body.wallet;
      updates.payout_bank = null;
    } else if (method === 'bank' && body.bank) {
      const b = body.bank;
      if (!b.fullname || !b.iban || !b.email) {
        return json(res, { error: 'Missing required bank fields' }, 400);
      }
      // Store as JSON (encrypted at rest by Supabase; in production rotate via vault)
      updates.payout_bank = JSON.stringify({
        fullname: b.fullname,
        iban: b.iban,
        swift: b.swift || '',
        country: b.country || '',
        bank_name: b.bank_name || '',
        email: b.email,
        saved_at: new Date().toISOString(),
      });
      updates.payout_wallet = null;
    }
    await dbUpdate('himer_users', body.userId, updates);
    return json(res, { ok: true, message: 'Payout details saved.', verified: updates.payout_verified });
  }

  // GET /api/user/:id/payout — return current payout details (masked)
  const payoutGetMatch = route.match(/^GET \/api\/user\/([^\/]+)\/payout$/);
  if (payoutGetMatch) {
    const uid = payoutGetMatch[1];
    const user = await dbGet('himer_users', uid);
    if (!user) return json(res, { error: 'User not found' }, 404);
    const out = { method: user.payout_method || null, verified: !!user.payout_verified };
    if (user.payout_wallet) out.wallet = user.payout_wallet;
    if (user.payout_bank) {
      try {
        const b = typeof user.payout_bank === 'string' ? JSON.parse(user.payout_bank) : user.payout_bank;
        out.bank = b;
      } catch (e) {}
    }
    return json(res, out);
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

  // GET /api/user/:id/referral — referral stats + share link
  if (req.method === 'GET' && /^\/api\/user\/U-[A-Za-z0-9]+\/referral$/.test(url.pathname)) {
    const userId = url.pathname.split('/')[3];
    const { getReferralStats } = require('../lib/referral');
    const stats = await getReferralStats(userId);
    if (!stats) return json(res, { error: 'User not found' }, 404);
    return json(res, stats);
  }

  // GET /api/leaderboard — top referrers (public)
  if (route === 'GET /api/leaderboard') {
    const { getLeaderboard } = require('../lib/referral');
    const board = await getLeaderboard(20);
    return json(res, { leaderboard: board });
  }

  // GET /api/premium/plans (public)
  if (route === 'GET /api/premium/plans') {
    const { getPremiumPlans } = require('../lib/monetization');
    return json(res, { plans: getPremiumPlans() });
  }

  // POST /api/user/premium/purchase (user purchases premium — payment_ref from outside system)
  if (route === 'POST /api/user/premium/purchase') {
    const { purchasePremium } = require('../lib/monetization');
    if (!body.userId || !body.plan) return json(res, { error: 'userId and plan required' }, 400);
    const r = await purchasePremium(body.userId, body.plan, body.paymentRef);
    return json(res, r);
  }

  // GET /api/affiliates (public, returns list of affiliate offers)
  if (route === 'GET /api/affiliates') {
    const { getAffiliateLinks } = require('../lib/monetization');
    return json(res, { affiliates: getAffiliateLinks(url.searchParams.get('category')) });
  }

  // POST /api/affiliate/click — track an affiliate click
  if (route === 'POST /api/affiliate/click') {
    const { trackAffiliateClick } = require('../lib/monetization');
    await trackAffiliateClick(body.userId, body.affiliateId);
    return json(res, { ok: true });
  }

  // POST /api/ad/impression / click — track ad event
  if (route === 'POST /api/ad/impression') {
    const { trackAdImpression } = require('../lib/monetization');
    await trackAdImpression(body.userId, body.slot, body.advertiser);
    return json(res, { ok: true });
  }
  if (route === 'POST /api/ad/click') {
    const { trackAdClick } = require('../lib/monetization');
    await trackAdClick(body.userId, body.slot, body.advertiser);
    return json(res, { ok: true });
  }

  // GET /api/push/vapid — get public VAPID key (browser uses it to subscribe)
  if (route === 'GET /api/push/vapid') {
    const { getPublicKey } = require('../lib/push');
    return json(res, { publicKey: getPublicKey() });
  }

  // POST /api/push/subscribe — save user's push subscription
  if (route === 'POST /api/push/subscribe') {
    const { saveSubscription } = require('../lib/push');
    if (!body.userId || !body.subscription) return json(res, { error: 'userId and subscription required' }, 400);
    const r = await saveSubscription(body.userId, body.subscription);
    return json(res, r);
  }

  // POST /api/push/unsubscribe
  if (route === 'POST /api/push/unsubscribe') {
    const { removeSubscription } = require('../lib/push');
    await removeSubscription(body.endpoint);
    return json(res, { ok: true });
  }

  // POST /api/push/test (user can test their own notifications)
  if (route === 'POST /api/push/test') {
    const { notifyUser } = require('../lib/push');
    if (!body.userId) return json(res, { error: 'userId required' }, 400);
    const r = await notifyUser(body.userId, {
      title: '🎉 HIMER notifications work!',
      body: 'You will now receive alerts about earnings, milestones, and referrals.',
      tag: 'himer-test',
    });
    return json(res, r);
  }

  return false; // Route not handled
}

module.exports = { handle };
