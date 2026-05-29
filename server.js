/**
 * HIMER Neural Grid v4 — Main Server
 *
 * Architecture:
 *   server.js (this file)    → HTTP + WS + routing
 *   lib/db.js                → Supabase queries
 *   lib/auth.js              → JWT + bcrypt
 *   lib/nodes.js             → seed + real nodes
 *   lib/orchestrator.js      → tick loop, jobs, earnings
 *   lib/payouts.js           → withdraw approval flow
 *   lib/clients.js           → business clients
 *   lib/ai.js                → FAQ matching
 *   routes/user.js           → /api/user/*
 *   routes/admin.js          → /api/admin/*
 *   routes/client.js         → /api/client/* + /api/v1/compute
 *   routes/business.js       → /api/business/* (v5 business API)
 *
 * Env vars (set in Render):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   JWT_SECRET
 *   INITIAL_ADMIN_EMAIL = constantin.pipera84@gmail.com
 *   INITIAL_ADMIN_PASSWORD = 12345678
 *   MIN_WITHDRAW = 500
 *   PLATFORM_FEE = 0.6
 *   ANTHROPIC_API_KEY (optional)
 *   STRIPE_SECRET_KEY (optional, for real payouts)
 */

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const { dbInsert, dbList, isReal: dbIsReal } = require('./lib/db');
const { ensureInitialAdmin } = require('./lib/auth');
const {
  ensureSeedNodes, loadRealNodesFromDB, flushDirtyToDB,
  getNodeCounts, aggregateByRegion, compactNode,
  seedNodes, realNodes, getNode,
} = require('./lib/nodes');
const {
  metrics, tick, setNotifier, flushUserEarnings,
} = require('./lib/orchestrator');

const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const clientRoutes = require('./routes/client');
const businessRoutes = require('./routes/business');

const PORT = process.env.PORT || 8080;

// ============================================================
// HELPERS
// ============================================================
function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
  });
}

// Rate limiting
const rateLimits = new Map();
function checkRate(ip, limit = 120, windowMs = 60000) {
  const now = Date.now();
  const rec = rateLimits.get(ip);
  if (!rec || rec.resetAt < now) {
    rateLimits.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (rec.count >= limit) return false;
  rec.count++;
  return true;
}

// Notification helper (persists + broadcasts via WS)
async function notify(userId, type, titleKey, messageKey, meta = {}) {
  const id = 'N-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const notif = {
    id,
    user_id: userId,
    type,
    title_key: titleKey,
    message_key: messageKey,
    meta,
    is_read: false,
    created_at: new Date().toISOString(),
  };
  try { await dbInsert('himer_notifications', notif); } catch (e) {}

  // Broadcast via WS to that user
  for (const ws of wss.clients) {
    if (ws.readyState === 1 && ws.userId === userId) {
      ws.send(JSON.stringify({
        type: 'NOTIFICATIONS',
        notifications: [{
          id, type, titleKey, messageKey, meta,
          ts: Date.now(), read: false,
        }],
      }));
    }
  }
}

// Hook orchestrator notifier
setNotifier(notify);

// ============================================================
// HTTP SERVER + ROUTING
// ============================================================
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE, PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (!checkRate(ip)) {
    return json(res, { error: 'Rate limited' }, 429);
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  // Pre-read body for POST/PUT
  const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};

  const helpers = { json, ip, notify };

  // Health check
  if (route === 'GET /') {
    return res.end(`HIMER Neural Grid v5 | ${metrics.totalNodes} nodes (${metrics.activeNodes} active) | DB: ${dbIsReal ? 'Supabase' : 'memory-only'}`);
  }

  // Public stats
  if (route === 'GET /api/stats') {
    return json(res, {
      totalNodes: metrics.totalNodes,
      activeNodes: metrics.activeNodes,
      totalGflops: metrics.totalGflops,
      totalGflopSecondsProcessed: Math.floor(metrics.totalGflopSecondsProcessed),
      jobsCompleted: metrics.jobsCompleted,
      contractsCompleted: metrics.contractsCompleted,
      contractsSigned: metrics.contractsSigned,
      uptime: Math.floor((Date.now() - metrics.startedAt) / 1000),
    });
  }

  // Public node detail (any node, including seed — both look same to public)
  if (route.startsWith('GET /api/node/')) {
    const nodeId = url.pathname.split('/').pop();
    const n = getNode(nodeId);
    if (!n) return json(res, { error: 'Node not found' }, 404);
    return json(res, {
      id: n.id,
      region: n.region,
      status: n.status,
      load: Math.round(n.current_load || 0),
      gflops: +parseFloat(n.gflops).toFixed(1),
      uptime: n.uptime_seconds || 0,
      trustScore: n.trust_score || 100,
      contractsCompleted: n.contracts_completed || 0,
      type: n.source === 'real' ? 'verified' : 'demo',
    });
  }

  // Business API (v5) — handles its own routing
  if (route.startsWith('GET /api/business/') || route.startsWith('POST /api/business/')) {
    try {
      return await businessRoutes.handle(req, res, url, body);
    } catch (e) {
      console.error('[Business route error]', route, e);
      if (!res.headersSent) return json(res, { error: 'Internal server error', message: e.message }, 500);
      return;
    }
  }

  // Try sub-route handlers
  try {
    if (await userRoutes.handle(req, res, url, body, helpers)) return;
    if (await adminRoutes.handle(req, res, url, body, helpers)) return;
    if (await clientRoutes.handle(req, res, url, body, helpers)) return;
  } catch (e) {
    console.error('[Route error]', route, e);
    if (!res.headersSent) return json(res, { error: 'Internal server error', message: e.message }, 500);
    return;
  }

  // Not found
  res.writeHead(404);
  res.end('Not found');
});

// ============================================================
// WEBSOCKET
// ============================================================
const wss = new WebSocket.Server({ server });

const PUBLIC_SAMPLE = 1000; // Show up to 1000 nodes on public map

function buildPublicSnapshot() {
  const allNodes = [];
  // Push REAL nodes first (always visible)
  for (const n of realNodes.values()) {
    allNodes.push(compactNode(n, false));
  }
  // Then seed nodes (sample up to fill)
  const seedRoom = Math.max(0, PUBLIC_SAMPLE - allNodes.length);
  let count = 0;
  for (const n of seedNodes.values()) {
    if (count++ >= seedRoom) break;
    allNodes.push(compactNode(n, false));
  }
  return {
    type: 'SNAPSHOT',
    metrics: {
      totalNodes: metrics.totalNodes,
      activeNodes: metrics.activeNodes,
      totalGflops: metrics.totalGflops,
      totalGflopSecondsProcessed: Math.floor(metrics.totalGflopSecondsProcessed),
      contractsCompleted: metrics.contractsCompleted,
      contractsSigned: metrics.contractsSigned,
      startedAt: metrics.startedAt,
    },
    nodesSample: allNodes,
    regions: aggregateByRegion(),
    serverTime: Date.now(),
  };
}

function buildAdminSnapshot() {
  // Admin gets nodes WITH source tag (real vs seed)
  const allNodes = [];
  for (const n of realNodes.values()) {
    allNodes.push(compactNode(n, true));
  }
  for (const n of seedNodes.values()) {
    allNodes.push(compactNode(n, true));
  }
  return {
    type: 'ADMIN_SNAPSHOT',
    nodesSample: allNodes,
    counts: getNodeCounts(),
    regions: aggregateByRegion(),
    serverTime: Date.now(),
  };
}

// ============================================================
// COMPUTE ENGINE — node connection registry
// ============================================================
const compute = require('./lib/compute');
const computeNodeConnections = new Map(); // nodeId -> ws

function getActiveComputeNodeIds() {
  const ids = [];
  for (const [nodeId, ws] of computeNodeConnections.entries()) {
    if (ws.readyState === 1) ids.push(nodeId);
  }
  return ids;
}

compute.setNodeRegistry(computeNodeConnections, getActiveComputeNodeIds);
compute.startEngine();

// Push notifications scheduler
try {
  const push = require('./lib/push');
  push.startDailyReminders();
} catch (e) {
  console.warn('[Boot] push notifications not started:', e.message);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(buildPublicSnapshot()));
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'SUBSCRIBE_USER' && data.userId) {
        ws.userId = data.userId;
      }
      // Register this connection as a compute node (worker-capable)
      if (data.type === 'SUBSCRIBE_NODE' && data.nodeId) {
        ws.nodeId = data.nodeId;
        ws.userId = data.userId || ws.userId;
        computeNodeConnections.set(data.nodeId, ws);
        ws.send(JSON.stringify({ type: 'NODE_REGISTERED', nodeId: data.nodeId }));
        // Try to dispatch any pending chunks now that a new node is available
        compute.dispatchPending();
      }
      // Compute chunk result from a node's worker
      if (data.type === 'COMPUTE_RESULT') {
        if (data.isWitness) {
          compute.handleWitnessResult({
            chunkId: data.chunkId, result: data.result,
            hash: data.hash, nodeId: ws.nodeId,
          });
        } else {
          compute.handleChunkResult({
            chunkId: data.chunkId, jobId: data.jobId,
            result: data.result, hash: data.hash,
            nodeId: ws.nodeId, computeMs: data.computeMs,
          });
        }
      }
      if (data.type === 'COMPUTE_ERROR') {
        // Node failed a chunk — it will be reassigned by watchdog
        console.log(`[Compute] Node ${ws.nodeId} chunk error: ${data.error}`);
      }
      if (data.type === 'SUBSCRIBE_ADMIN' && data.token) {
        const { verifyToken } = require('./lib/auth');
        const p = verifyToken(data.token);
        if (p && p.role === 'admin') {
          ws.isAdmin = true;
          ws.send(JSON.stringify(buildAdminSnapshot()));
        }
      }
    } catch (e) {}
  });
  ws.on('close', () => {
    if (ws.nodeId) computeNodeConnections.delete(ws.nodeId);
  });
});

function broadcastUpdates() {
  if (wss.clients.size === 0) return;
  const publicPayload = JSON.stringify(buildPublicSnapshot());
  const adminPayload = JSON.stringify(buildAdminSnapshot());
  wss.clients.forEach(c => {
    if (c.readyState !== 1) return;
    c.send(c.isAdmin ? adminPayload : publicPayload);
  });
}

// ============================================================
// BOOTSTRAP
// ============================================================
async function bootstrap() {
  console.log('[Boot] HIMER Neural Grid v4 starting...');
  console.log('[Boot] DB mode:', dbIsReal ? 'Supabase' : 'IN-MEMORY (not for production!)');

  // Seed nodes
  ensureSeedNodes(500);
  console.log('[Boot] Seeded 500 demo nodes');

  // Load real nodes from DB
  await loadRealNodesFromDB();

  // Ensure initial admin
  await ensureInitialAdmin();

  // Ensure Owner business client (gets free unlimited API key for platform owner)
  await ensureOwnerClient();

  // Start tick loop
  setInterval(tick, 1000);
  // Broadcast snapshot every 2s
  setInterval(broadcastUpdates, 2000);
  // Flush DB writes every 10s
  setInterval(() => flushDirtyToDB().catch(e => console.error('[Flush] nodes:', e.message)), 10000);
  setInterval(() => flushUserEarnings().catch(e => console.error('[Flush] earnings:', e.message)), 10000);

  server.listen(PORT, () => {
    const counts = getNodeCounts();
    console.log(`[Boot] Server listening on :${PORT}`);
    console.log(`[Boot] Nodes: ${counts.real} real + ${counts.seed} seed = ${counts.total} total`);
    console.log(`[Boot] Endpoints: /api/stats, /api/user/*, /api/admin/*, /api/business/*, /api/client/*, /api/v1/compute`);
  });
}

async function ensureOwnerClient() {
  try {
    const { createClient, generateApiKey, hashApiKey } = require('./lib/business');
    const ownerEmail = (process.env.INITIAL_ADMIN_EMAIL || process.env.OWNER_EMAIL || 'himer.nodes@gmail.com').toLowerCase();
    const existing = (await dbList('himer_clients', { where: { email: ownerEmail } }))[0];
    if (existing) {
      console.log(`[Boot] Owner client exists: ${existing.id} (${existing.email})`);
      return;
    }
    const { client, apiKey } = await createClient({
      name: 'HIMER Owner',
      email: ownerEmail,
      company: 'HIMER',
      country: 'RO',
      plan: 'owner',
      isOwner: true,
    });
    console.log('================================================================');
    console.log('[Boot] OWNER API KEY CREATED — SAVE IT NOW (shown only once):');
    console.log(`       Client ID: ${client.id}`);
    console.log(`       API Key:   ${apiKey}`);
    console.log(`       Email:     ${client.email}`);
    console.log('       Use header: X-API-Key: ' + apiKey);
    console.log('================================================================');
  } catch (e) {
    console.error('[Boot] Owner client setup failed (non-fatal):', e.message);
  }
}

bootstrap().catch(e => {
  console.error('[Boot] FATAL:', e);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Shutdown] SIGTERM — flushing...');
  await flushDirtyToDB().catch(() => {});
  await flushUserEarnings().catch(() => {});
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('[Shutdown] SIGINT — flushing...');
  await flushDirtyToDB().catch(() => {});
  await flushUserEarnings().catch(() => {});
  process.exit(0);
});
