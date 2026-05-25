/**
 * HIMER Neural Grid - Orchestrator v3
 *
 * Schimbări v3:
 *  - Tracking real vs seed nodes (admin vede realitatea pură)
 *  - Sistem payout cu prag $500 + Stripe Connect ready
 *  - Treasury real (bani din clienți → fond payout)
 *  - Milestones de rețea (în loc de contracte în lucru)
 *  - Click-info per nod
 *  - AI assistant proxy (răspunsuri pre-scrise + opțiune Claude API)
 *  - i18n - server returnează metrics raw, frontend traduce
 *
 * Deploy: Render free Web Service
 * ENV: PORT, ADMIN_KEY, PLATFORM_FEE, STRIPE_SECRET_KEY (opțional), ANTHROPIC_API_KEY (opțional)
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ============== CONFIG ==============
const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || 'himer-admin-change-me';
const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE || '0.6');
const USER_SHARE = 1 - PLATFORM_FEE;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || null; // opțional
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null; // opțional

const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'himer-data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');

const TICK_MS = 1000;
const SAMPLE_FOR_MAP = 500;
const SEED_NODE_COUNT = 500;

// Calcule reale
const PRICE_PER_GFLOP_SEC = 0.0001;
const WITHDRAW_FEE_PCT = 0.02;
const MIN_WITHDRAW = 500.00;  // ← prag $500 (era $1)
const PREMIUM_MULTIPLIER = 1.5;

// Ad revenue tracking (estimări industrie)
const AD_CPM = 1.50;
const AD_CTR = 0.012;
const AD_CPC = 0.45;

// Milestones rețea
const MILESTONES = [
  { id: 'real_nodes_10',    label: '10 noduri reale conectate',       target: 10,    type: 'real_nodes', reward: 'Beta access pentru toți contribuitorii' },
  { id: 'real_nodes_100',   label: '100 noduri reale',                target: 100,   type: 'real_nodes', reward: 'Lansare agent desktop' },
  { id: 'users_50',         label: '50 utilizatori activi',           target: 50,    type: 'users',      reward: 'Sistem referral activat' },
  { id: 'real_nodes_500',   label: '500 noduri reale',                target: 500,   type: 'real_nodes', reward: 'API public lansat' },
  { id: 'jobs_1000',        label: '1000 contracte finalizate',       target: 1000,  type: 'jobs',       reward: 'Marketplace P2P activ' },
  { id: 'revenue_10k',      label: '$10,000 revenue total',           target: 10000, type: 'revenue',    reward: 'Premium boost lansat' },
  { id: 'real_nodes_5000',  label: '5,000 noduri reale',              target: 5000,  type: 'real_nodes', reward: 'Migrare la infrastructură enterprise' }
];

// ============== STATE ==============
const state = {
  nodes: new Map(),       // nodeId -> { ownerId, source: 'real'|'seed', lat, lng, region, ... }
  users: new Map(),       // userId -> { email, totalEarnings, withdrawable, payoutSetup, ... }
  jobs: new Map(),
  clients: new Map(),
  notifications: new Map(),
  payouts: new Map(),     // payoutId -> { userId, amount, status, requestedAt, ... }
  metrics: {
    totalNodes: 0,
    realNodes: 0,
    seedNodes: 0,
    activeNodes: 0,
    totalGflops: 0,
    totalGflopSecondsProcessed: 0,
    platformRevenue: 0,
    userRevenue: 0,
    withdrawFeesCollected: 0,
    treasuryBalance: 0,        // bani efectiv încasați din clienți API
    payoutsDistributed: 0,
    jobsCompleted: 0,
    jobsActive: 0,
    contractsSigned: 0,
    contractsCompleted: 0,
    adImpressions: 0,
    adClicks: 0,
    adRevenue: 0,
    startedAt: Date.now()
  },
  dirtyNodes: new Set(),
  lastTick: Date.now(),
  rateLimits: new Map()
};

// ============== PERSISTENTA ==============
function saveSnapshot() {
  try {
    const data = {
      nodes: Array.from(state.nodes.entries()).slice(0, 10000),
      users: Array.from(state.users.entries()).map(([k, v]) => [k, { ...v, nodes: Array.from(v.nodes || []) }]),
      clients: Array.from(state.clients.entries()),
      jobs: Array.from(state.jobs.entries()).slice(-2000),
      notifications: Array.from(state.notifications.entries()),
      payouts: Array.from(state.payouts.entries()),
      metrics: state.metrics,
      savedAt: Date.now()
    };
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data));
  } catch (e) { console.error('Snapshot fail:', e.message); }
}

function loadSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    data.nodes?.forEach(([k, v]) => state.nodes.set(k, v));
    data.users?.forEach(([k, v]) => state.users.set(k, { ...v, nodes: new Set(v.nodes || []) }));
    data.clients?.forEach(([k, v]) => state.clients.set(k, v));
    data.jobs?.forEach(([k, v]) => state.jobs.set(k, v));
    data.notifications?.forEach(([k, v]) => state.notifications.set(k, v));
    data.payouts?.forEach(([k, v]) => state.payouts.set(k, v));
    if (data.metrics) Object.assign(state.metrics, data.metrics);
    console.log(`Snapshot loaded: ${state.nodes.size} nodes (${state.metrics.realNodes || 0} real, ${state.metrics.seedNodes || 0} seed), ${state.users.size} users`);
    return true;
  } catch (e) { console.error('Load snapshot fail:', e.message); return false; }
}

// ============== REGIUNI ==============
const REGIONS = [
  { name: 'EU-West',    lat: 48.8,  lng: 2.3,    weight: 0.18 },
  { name: 'EU-East',    lat: 44.4,  lng: 26.1,   weight: 0.12 },
  { name: 'US-East',    lat: 40.7,  lng: -74.0,  weight: 0.20 },
  { name: 'US-West',    lat: 37.7,  lng: -122.4, weight: 0.15 },
  { name: 'Asia-East',  lat: 35.6,  lng: 139.6,  weight: 0.13 },
  { name: 'Asia-South', lat: 19.0,  lng: 72.8,   weight: 0.10 },
  { name: 'SA',         lat: -23.5, lng: -46.6,  weight: 0.07 },
  { name: 'Africa',     lat: -1.2,  lng: 36.8,   weight: 0.03 },
  { name: 'Oceania',    lat: -33.8, lng: 151.2,  weight: 0.02 }
];

function pickRegion() {
  let r = Math.random();
  for (const reg of REGIONS) { r -= reg.weight; if (r <= 0) return reg; }
  return REGIONS[0];
}

// ============== NOTIFICATIONS ==============
function notify(userId, type, titleKey, messageKey, meta = {}) {
  if (!state.notifications.has(userId)) state.notifications.set(userId, []);
  const list = state.notifications.get(userId);
  const notif = {
    id: 'N-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    type, titleKey, messageKey, meta,
    ts: Date.now(),
    read: false
  };
  list.unshift(notif);
  if (list.length > 50) list.length = 50;
  return notif;
}

// ============== NODE LIFECYCLE ==============
function createNode(ownerId, opts = {}) {
  const id = (opts.source === 'real' ? 'HR-' : 'HS-') + crypto.randomBytes(4).toString('hex').toUpperCase();
  const region = opts.region || pickRegion();
  const jitter = () => (Math.random() - 0.5) * 8;
  const node = {
    id,
    ownerId,
    source: opts.source || 'seed', // 'real' or 'seed'
    lat: region.lat + jitter(),
    lng: region.lng + jitter(),
    region: region.name,
    load: 0,
    status: 'SYNCING',
    gflops: opts.source === 'real' ? (4 + Math.random() * 12) : (2 + Math.random() * 8),
    earnings: 0,
    gflopSecondsProcessed: 0,
    uptime: 0,
    lastSeen: Date.now(),
    trustScore: 100,
    boost: opts.boost || 1.0,
    tier: opts.tier || 'standard',
    contractsCompleted: 0,
    createdAt: Date.now()
  };
  state.nodes.set(id, node);
  state.dirtyNodes.add(id);
  if (ownerId && state.users.has(ownerId)) state.users.get(ownerId).nodes.add(id);
  recalcNodeCounts();
  return node;
}

function recalcNodeCounts() {
  let real = 0, seed = 0;
  for (const n of state.nodes.values()) {
    if (n.source === 'real') real++; else seed++;
  }
  state.metrics.totalNodes = state.nodes.size;
  state.metrics.realNodes = real;
  state.metrics.seedNodes = seed;
}

function seedDemoNodes(count = SEED_NODE_COUNT) {
  let created = 0;
  for (let i = 0; i < count; i++) {
    if (state.nodes.size >= count) break;
    createNode(null, { source: 'seed' });
    created++;
  }
  console.log(`Seeded ${created} demo nodes (total: ${state.nodes.size})`);
}

// Bootstrap
const loaded = loadSnapshot();
if (!loaded || state.metrics.seedNodes < SEED_NODE_COUNT) {
  const needed = SEED_NODE_COUNT - (state.metrics.seedNodes || 0);
  if (needed > 0) seedDemoNodes(needed);
}
recalcNodeCounts();
setInterval(saveSnapshot, 30000);

// ============== ORCHESTRATOR TICK ==============
function tick() {
  let active = 0;
  let totalGflops = 0;

  for (const [jobId, job] of state.jobs) {
    if (job.status === 'PENDING') assignJobToNodes(job);
  }

  for (const [id, node] of state.nodes) {
    const prevLoad = node.load;
    const prevStatus = node.status;

    // Seed nodes au activitate simulată; real nodes raportează ele (TODO: agent real)
    node.load = Math.max(0, Math.min(100, node.load + (Math.random() - 0.5) * 30));
    node.status = node.load > 80 ? 'COMPUTING' : node.load > 20 ? 'READY' : 'IDLE';
    node.uptime += 1;
    node.lastSeen = Date.now();

    if (node.status === 'COMPUTING') {
      const gflopSeconds = node.gflops * (node.load / 100);
      const grossEarning = gflopSeconds * PRICE_PER_GFLOP_SEC * node.boost;

      // Doar nodurile REAL contribuie la earnings reale ale userilor
      // Seed nodes generează doar metrici vizuali, NU bani fictivi
      if (node.source === 'real' && node.ownerId) {
        const userPortion = grossEarning * USER_SHARE;
        const platformPortion = grossEarning * PLATFORM_FEE;
        node.earnings += userPortion;
        node.gflopSecondsProcessed += gflopSeconds;
        state.metrics.userRevenue += userPortion;
        state.metrics.platformRevenue += platformPortion;
        if (state.users.has(node.ownerId)) {
          const u = state.users.get(node.ownerId);
          u.totalEarnings += userPortion;
          u.withdrawable += userPortion;
        }
      }
      // Seed nodes contribuie doar la GFLOPS public (vizualizare)
      state.metrics.totalGflopSecondsProcessed += gflopSeconds;
      totalGflops += gflopSeconds;
      active++;
    }

    if (Math.abs(node.load - prevLoad) > 5 || node.status !== prevStatus) {
      state.dirtyNodes.add(id);
    }
  }

  state.metrics.activeNodes = active;
  state.metrics.totalGflops = totalGflops;
  state.metrics.jobsActive = Array.from(state.jobs.values()).filter(j => j.status === 'RUNNING').length;

  // Ad tracking simulat (în producție: real prin endpoint /api/ad/*)
  // NU adăugăm impresii fictive aici - doar din endpoint-uri reale apelate de frontend

  broadcastDelta();
  state.dirtyNodes.clear();
  state.lastTick = Date.now();
}

// ============== JOB ASSIGNMENT ==============
function assignJobToNodes(job) {
  // Preferăm noduri REALE, dar fallback la seed dacă nu sunt destule
  const realCandidates = Array.from(state.nodes.values())
    .filter(n => n.source === 'real' && n.status !== 'COMPUTING' && n.trustScore > 50)
    .map(n => ({ n, score: (n.trustScore * n.gflops) / (n.load + 1) }))
    .sort((a, b) => b.score - a.score);

  const seedCandidates = Array.from(state.nodes.values())
    .filter(n => n.source === 'seed' && n.status !== 'COMPUTING' && n.trustScore > 50)
    .map(n => ({ n, score: (n.trustScore * n.gflops) / (n.load + 1) }))
    .sort((a, b) => b.score - a.score);

  const needed = job.nodesNeeded || 5;
  const candidates = realCandidates.length >= needed
    ? realCandidates.slice(0, needed)
    : [...realCandidates, ...seedCandidates.slice(0, needed - realCandidates.length)];

  if (candidates.length < needed) return;
  job.status = 'RUNNING';
  job.startedAt = Date.now();
  job.assignedNodes = candidates.map(c => c.n.id);
  job.realNodesAssigned = candidates.filter(c => c.n.source === 'real').length;
  candidates.forEach(c => { c.n.load = Math.min(100, c.n.load + 40); });

  state.metrics.contractsSigned++;

  // Notify owners ai nodurilor REAL
  const notifiedUsers = new Set();
  for (const c of candidates) {
    if (c.n.source === 'real' && c.n.ownerId && !notifiedUsers.has(c.n.ownerId)) {
      notifiedUsers.add(c.n.ownerId);
      notify(c.n.ownerId, 'contract_signed',
        'notif.contractSigned.title',
        'notif.contractSigned.message',
        { jobId: job.id, nodeId: c.n.id, type: job.type });
    }
  }

  setTimeout(() => completeJob(job.id), 10000 + Math.random() * 20000);
}

function completeJob(jobId) {
  const job = state.jobs.get(jobId);
  if (!job || job.status === 'DONE') return;
  job.status = 'DONE';
  job.completedAt = Date.now();
  state.metrics.jobsCompleted++;
  state.metrics.contractsCompleted++;

  const client = state.clients.get(job.clientId);
  if (client) {
    client.totalSpent += job.reward;
    state.metrics.treasuryBalance += job.reward; // bani REAL în treasury
  }

  // Notify owners noduri REAL cu plată
  const notifiedUsers = new Set();
  for (const nodeId of (job.assignedNodes || [])) {
    const node = state.nodes.get(nodeId);
    if (!node) continue;
    node.contractsCompleted++;
    if (node.source === 'real' && node.ownerId && !notifiedUsers.has(node.ownerId)) {
      notifiedUsers.add(node.ownerId);
      const userReward = (job.reward / (job.assignedNodes.length || 1)) * USER_SHARE;
      notify(node.ownerId, 'contract_completed',
        'notif.contractCompleted.title',
        'notif.contractCompleted.message',
        { jobId: job.id, nodeId, reward: userReward });
    }
  }
}

// ============== WS BROADCAST ==============
function publicMetrics() {
  // Public: NU expunem realNodes/seedNodes breakdown, NU expunem revenue
  // Afișăm totalul (real + seed) pentru efect vizual
  return {
    totalNodes: state.metrics.totalNodes,
    activeNodes: state.metrics.activeNodes,
    totalGflops: state.metrics.totalGflops,
    totalGflopSecondsProcessed: Math.floor(state.metrics.totalGflopSecondsProcessed),
    jobsCompleted: state.metrics.jobsCompleted,
    contractsSigned: state.metrics.contractsSigned,
    contractsCompleted: state.metrics.contractsCompleted,
    startedAt: state.metrics.startedAt
  };
}

function buildFullSnapshot() {
  const nodes = Array.from(state.nodes.values());
  const sample = nodes.length <= SAMPLE_FOR_MAP
    ? nodes
    : nodes.filter((_, i) => i % Math.ceil(nodes.length / SAMPLE_FOR_MAP) === 0);

  const regionAgg = {};
  for (const n of nodes) {
    if (!regionAgg[n.region]) regionAgg[n.region] = { count: 0, active: 0, gflops: 0 };
    regionAgg[n.region].count++;
    if (n.status === 'COMPUTING') regionAgg[n.region].active++;
    regionAgg[n.region].gflops += n.gflops;
  }

  return {
    type: 'SNAPSHOT',
    metrics: publicMetrics(),
    nodesSample: sample.map(compactNode),
    regions: regionAgg,
    milestones: getMilestonesProgress(),
    serverTime: Date.now()
  };
}

function compactNode(n) {
  return {
    id: n.id, lat: +n.lat.toFixed(2), lng: +n.lng.toFixed(2),
    l: n.load | 0, s: n.status[0], g: +n.gflops.toFixed(1),
    r: n.region, u: n.uptime | 0
  };
}

function getMilestonesProgress() {
  return MILESTONES.map(m => {
    let current = 0;
    if (m.type === 'real_nodes') current = state.metrics.realNodes;
    else if (m.type === 'users') current = state.users.size;
    else if (m.type === 'jobs') current = state.metrics.jobsCompleted;
    else if (m.type === 'revenue') current = state.metrics.platformRevenue + state.metrics.userRevenue;
    return {
      id: m.id, label: m.label, target: m.target,
      current: Math.min(current, m.target),
      percent: Math.min(100, (current / m.target) * 100),
      reward: m.reward,
      completed: current >= m.target
    };
  });
}

function broadcastDelta() {
  if (wss.clients.size === 0) return;
  const isSnapshot = (Date.now() - state.lastTick) % 10000 < 1000;
  const payload = isSnapshot ? buildFullSnapshot() : {
    type: 'DELTA',
    metrics: publicMetrics(),
    changed: Array.from(state.dirtyNodes).slice(0, 200).map(id => compactNode(state.nodes.get(id))).filter(Boolean),
    serverTime: Date.now()
  };
  const str = JSON.stringify(payload);
  wss.clients.forEach(c => {
    if (c.readyState === 1) {
      c.send(str);
      if (c.userId && state.notifications.has(c.userId)) {
        const unread = state.notifications.get(c.userId).filter(n => !n.read).slice(0, 5);
        if (unread.length > 0) {
          c.send(JSON.stringify({ type: 'NOTIFICATIONS', notifications: unread }));
          unread.forEach(n => n.read = true);
        }
      }
    }
  });
}

// ============== RATE LIMITING ==============
function checkRate(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  const rec = state.rateLimits.get(ip);
  if (!rec || rec.resetAt < now) {
    state.rateLimits.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (rec.count >= limit) return false;
  rec.count++;
  return true;
}

// ============== AI ASSISTANT (pre-scris + opțional Claude API) ==============
const AI_FAQ = [
  { kw: ['plata', 'platit', 'platesc', 'payment', 'pay', 'bani', 'money', 'cash', 'incasare'], a: 'ai.faq.payment' },
  { kw: ['privacy', 'date personale', 'gdpr', 'sigur', 'safe', 'securitate', 'data', 'fisier'], a: 'ai.faq.privacy' },
  { kw: ['cum functioneaza', 'how does', 'how it works', 'cum merge', 'mecanism'], a: 'ai.faq.howWorks' },
  { kw: ['cati bani', 'cat castig', 'how much', 'earnings', 'venit', 'profit'], a: 'ai.faq.earnings' },
  { kw: ['proof of compute', 'poc', 'verificare', 'verification', 'trust'], a: 'ai.faq.poc' },
  { kw: ['agent', 'instalare', 'install', 'descarcare', 'download'], a: 'ai.faq.agent' },
  { kw: ['retrage', 'withdraw', 'cash out', 'scoate bani', 'extract'], a: 'ai.faq.withdraw' },
  { kw: ['cont', 'register', 'inregistrare', 'sign up', 'inscriere'], a: 'ai.faq.register' },
  { kw: ['oprire', 'stop', 'pause', 'dezactiv', 'inchide'], a: 'ai.faq.stop' },
  { kw: ['contract', 'sarcina', 'task', 'job'], a: 'ai.faq.contract' },
  { kw: ['costuri', 'costs', 'taxe', 'fee', 'comision'], a: 'ai.faq.costs' },
  { kw: ['boost', 'multiplicator', 'multiplier', 'premium'], a: 'ai.faq.boost' },
  { kw: ['nod', 'node', 'neuron', 'pc', 'calculator'], a: 'ai.faq.node' },
  { kw: ['gflops', 'capacitate', 'performance', 'capacity'], a: 'ai.faq.gflops' },
  { kw: ['ai training', 'antrenare ai', 'machine learning', 'ml'], a: 'ai.faq.aiTraining' },
  { kw: ['3d render', 'randare', 'rendering'], a: 'ai.faq.rendering' },
  { kw: ['ce e himer', 'what is himer', 'cine sunteti', 'about'], a: 'ai.faq.whatIsHimer' },
  { kw: ['referral', 'invita', 'invite', 'prieten'], a: 'ai.faq.referral' },
];

function matchFAQ(question) {
  const q = (question || '').toLowerCase();
  let best = null, bestScore = 0;
  for (const item of AI_FAQ) {
    let score = 0;
    for (const k of item.kw) if (q.includes(k)) score++;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return best && bestScore > 0 ? best.a : null;
}

async function callClaude(question, lang = 'en') {
  if (!ANTHROPIC_KEY) return null;
  return new Promise((resolve) => {
    const data = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are HIMER Assistant. Help users with the HIMER Neural Grid (DePIN compute network). Be concise, friendly, and helpful. Reply in language code: ${lang}. User question: ${question}`
      }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': data.length
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.content?.[0]?.text || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

// ============== HTTP API ==============
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Admin-Key');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip)) { res.writeHead(429); return res.end('Rate limited'); }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  // === PUBLIC ===
  if (route === 'GET /') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`HIMER Neural Grid v3.0 | ${state.nodes.size} nodes | ${state.metrics.activeNodes} active`);
  }

  if (route === 'GET /api/stats') {
    return json(res, {
      totalNodes: state.metrics.totalNodes,
      activeNodes: state.metrics.activeNodes,
      totalGflops: state.metrics.totalGflops,
      totalGflopSecondsProcessed: Math.floor(state.metrics.totalGflopSecondsProcessed),
      jobsCompleted: state.metrics.jobsCompleted,
      contractsCompleted: state.metrics.contractsCompleted,
      uptime: Math.floor((Date.now() - state.metrics.startedAt) / 1000),
      regions: REGIONS.length,
      milestones: getMilestonesProgress()
    });
  }

  // Node detail (click pe nod în harta)
  if (route.startsWith('GET /api/node/')) {
    const nodeId = url.pathname.split('/').pop();
    const n = state.nodes.get(nodeId);
    if (!n) return json(res, { error: 'Node not found' }, 404);
    // Returnăm informații PUBLICE (fără ownerId)
    return json(res, {
      id: n.id, region: n.region, status: n.status,
      load: Math.round(n.load), gflops: +n.gflops.toFixed(1),
      uptime: n.uptime, trustScore: n.trustScore,
      contractsCompleted: n.contractsCompleted,
      type: n.source === 'real' ? 'verified' : 'demo'  // public ascunde "seed/real" terminologia
    });
  }

  // === USER ===
  if (route === 'POST /api/user/join') {
    return readBody(req, body => {
      const userId = 'U-' + crypto.randomBytes(6).toString('hex').toUpperCase();
      state.users.set(userId, {
        email: body.email || null,
        totalEarnings: 0,
        withdrawable: 0,
        joinedAt: Date.now(),
        nodes: new Set(),
        tier: 'standard',
        payoutSetup: false,    // true după Stripe Connect onboarding
        stripeAccountId: null,
        notificationsEnabled: true
      });
      // Creează nod REAL pentru user
      const node = createNode(userId, { source: 'real', boost: 1.0 });
      notify(userId, 'system', 'notif.welcome.title', 'notif.welcome.message', { nodeId: node.id });
      json(res, { userId, nodeId: node.id, message: 'Welcome' });
    });
  }

  if (route.match(/^GET \/api\/user\/[^/]+$/)) {
    const userId = url.pathname.split('/').pop();
    const user = state.users.get(userId);
    if (!user) return json(res, { error: 'User not found' }, 404);
    const userNodes = Array.from(user.nodes).map(id => state.nodes.get(id)).filter(Boolean);
    return json(res, {
      userId,
      email: user.email,
      totalEarnings: user.totalEarnings,
      withdrawable: user.withdrawable,
      joinedAt: user.joinedAt,
      tier: user.tier,
      payoutSetup: user.payoutSetup,
      notificationsEnabled: user.notificationsEnabled !== false,
      minWithdraw: MIN_WITHDRAW,
      progressToWithdraw: Math.min(100, (user.withdrawable / MIN_WITHDRAW) * 100),
      nodesList: userNodes.map(n => ({
        id: n.id, status: n.status, load: n.load,
        earnings: +n.earnings.toFixed(6), uptime: n.uptime,
        gflops: n.gflops, gflopSecondsProcessed: Math.floor(n.gflopSecondsProcessed),
        contractsCompleted: n.contractsCompleted, region: n.region
      })),
      stats: {
        totalNodes: userNodes.length,
        activeNow: userNodes.filter(n => n.status === 'COMPUTING').length,
        avgUptime: userNodes.reduce((a, n) => a + n.uptime, 0) / (userNodes.length || 1),
        totalGflopSeconds: Math.floor(userNodes.reduce((a, n) => a + (n.gflopSecondsProcessed || 0), 0)),
        totalContracts: userNodes.reduce((a, n) => a + (n.contractsCompleted || 0), 0)
      }
    });
  }

  if (route.match(/^GET \/api\/user\/[^/]+\/notifications$/)) {
    const userId = url.pathname.split('/')[3];
    if (!state.users.has(userId)) return json(res, { error: 'User not found' }, 404);
    return json(res, { notifications: state.notifications.get(userId) || [] });
  }

  if (route === 'POST /api/user/notifications/toggle') {
    return readBody(req, body => {
      const user = state.users.get(body.userId);
      if (!user) return json(res, { error: 'User not found' }, 404);
      user.notificationsEnabled = !!body.enabled;
      json(res, { ok: true, enabled: user.notificationsEnabled });
    });
  }

  // === PAYOUT FLOW ===
  if (route === 'POST /api/user/payout/setup') {
    return readBody(req, body => {
      const user = state.users.get(body.userId);
      if (!user) return json(res, { error: 'User not found' }, 404);
      // În producție: aici creezi Stripe Connect account și returnezi onboarding URL
      // Acum: simulăm că setup-ul e succes după ce ne dă date bancare validate
      // TODO Stripe real:
      // const account = await stripe.accounts.create({ type: 'express', country: 'US', email: user.email });
      // const link = await stripe.accountLinks.create({ account: account.id, return_url: '...', refresh_url: '...', type: 'account_onboarding' });
      // user.stripeAccountId = account.id;
      // user.payoutSetup = true; (sau pe webhook completion)
      user.payoutSetup = true;
      user.payoutDetails = {
        method: body.method || 'bank',
        verified: false, // în producție: setat la true după Stripe webhook
        setupAt: Date.now()
      };
      json(res, { ok: true, message: 'Payout setup initiated. Verification pending.' });
    });
  }

  if (route === 'POST /api/user/payout/request') {
    return readBody(req, body => {
      const user = state.users.get(body.userId);
      if (!user) return json(res, { error: 'User not found' }, 404);
      if (!user.payoutSetup) return json(res, { error: 'Payout method not configured. Setup first.' }, 400);
      if (user.withdrawable < MIN_WITHDRAW) return json(res, { error: `Minimum withdraw is $${MIN_WITHDRAW}` }, 400);

      const payoutId = 'PO-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const amount = user.withdrawable;
      const fee = amount * WITHDRAW_FEE_PCT;
      const net = amount - fee;

      // Move money from user wallet to payout pending
      user.withdrawable = 0;
      state.metrics.withdrawFeesCollected += fee;

      state.payouts.set(payoutId, {
        id: payoutId,
        userId: body.userId,
        gross: amount,
        fee,
        net,
        status: 'PENDING_REVIEW', // admin review before payout
        requestedAt: Date.now(),
        approvedAt: null,
        paidAt: null
      });

      notify(body.userId, 'payment',
        'notif.payoutRequested.title',
        'notif.payoutRequested.message',
        { payoutId, amount: net });

      json(res, { payoutId, gross: amount, fee, net, status: 'PENDING_REVIEW' });
    });
  }

  // === AI ASSISTANT ===
  if (route === 'POST /api/ai/ask') {
    return readBody(req, async body => {
      const q = body.question || '';
      const lang = body.lang || 'en';
      const useClaude = !!body.useClaude;

      // 1. Try FAQ first
      const faqKey = matchFAQ(q);
      if (faqKey && !useClaude) {
        return json(res, { source: 'faq', key: faqKey });
      }

      // 2. Claude API if configured and requested
      if (useClaude && ANTHROPIC_KEY) {
        const reply = await callClaude(q, lang);
        if (reply) return json(res, { source: 'claude', text: reply });
      }

      // 3. Fallback
      json(res, { source: 'fallback', key: 'ai.faq.fallback' });
    });
  }

  // === AD TRACKING ===
  if (route === 'POST /api/ad/impression') {
    state.metrics.adImpressions++;
    state.metrics.adRevenue += AD_CPM / 1000;
    return json(res, { ok: true });
  }
  if (route === 'POST /api/ad/click') {
    state.metrics.adClicks++;
    state.metrics.adRevenue += AD_CPC;
    return json(res, { ok: true });
  }

  // === CLIENT API (business clients pay for compute) ===
  if (route === 'POST /api/v1/compute') {
    const apiKey = req.headers['x-api-key'];
    return readBody(req, body => {
      let client = Array.from(state.clients.values()).find(c => c.apiKey === apiKey);
      if (!client && apiKey) {
        const cid = 'C-' + crypto.randomBytes(4).toString('hex');
        client = { id: cid, apiKey, balance: 10, totalSpent: 0, createdAt: Date.now() };
        state.clients.set(cid, client);
      }
      if (!client) return json(res, { error: 'Invalid API key' }, 401);
      const jobId = 'J-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const nodesNeeded = Math.min(body.nodes || 3, 50);
      const reward = nodesNeeded * 0.05;
      if (client.balance < reward) return json(res, { error: 'Insufficient balance' }, 402);
      client.balance -= reward;
      state.jobs.set(jobId, {
        id: jobId, clientId: client.id, type: body.type || 'compute',
        nodesNeeded, reward, status: 'PENDING', createdAt: Date.now()
      });
      json(res, { jobId, status: 'queued', cost: reward });
    });
  }

  // === ADMIN ===
  if (route === 'GET /api/admin/overview') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, {
      reality: {
        realNodes: state.metrics.realNodes,
        seedNodes: state.metrics.seedNodes,
        totalDisplayed: state.metrics.totalNodes,
        realUsers: state.users.size,
        usersWithPayoutSetup: Array.from(state.users.values()).filter(u => u.payoutSetup).length,
        activeRealNodes: Array.from(state.nodes.values()).filter(n => n.source === 'real' && n.status === 'COMPUTING').length,
        totalRealEarnings: Array.from(state.users.values()).reduce((a, u) => a + u.totalEarnings, 0),
        totalWithdrawable: Array.from(state.users.values()).reduce((a, u) => a + u.withdrawable, 0)
      },
      treasury: {
        balance: state.metrics.treasuryBalance,
        obligationsToUsers: Array.from(state.users.values()).reduce((a, u) => a + u.withdrawable, 0),
        netAvailable: state.metrics.treasuryBalance - Array.from(state.users.values()).reduce((a, u) => a + u.withdrawable, 0),
        payoutsDistributed: state.metrics.payoutsDistributed
      },
      revenue: {
        platform60: state.metrics.platformRevenue,
        users40: state.metrics.userRevenue,
        withdrawFees: state.metrics.withdrawFeesCollected,
        adRevenue: state.metrics.adRevenue,
        total: state.metrics.platformRevenue + state.metrics.userRevenue + state.metrics.adRevenue + state.metrics.withdrawFeesCollected
      },
      adStats: {
        impressions: state.metrics.adImpressions,
        clicks: state.metrics.adClicks,
        ctr: state.metrics.adImpressions > 0 ? (state.metrics.adClicks / state.metrics.adImpressions * 100).toFixed(2) + '%' : '0%',
        revenue: state.metrics.adRevenue,
        estimatedMonthly: ((state.metrics.adRevenue / Math.max(1, (Date.now() - state.metrics.startedAt) / 1000)) * 86400 * 30) || 0
      },
      jobs: {
        total: state.jobs.size,
        pending: Array.from(state.jobs.values()).filter(j => j.status === 'PENDING').length,
        running: Array.from(state.jobs.values()).filter(j => j.status === 'RUNNING').length,
        done: state.metrics.jobsCompleted
      },
      clients: state.clients.size,
      payouts: {
        pending: Array.from(state.payouts.values()).filter(p => p.status === 'PENDING_REVIEW').length,
        approved: Array.from(state.payouts.values()).filter(p => p.status === 'APPROVED').length,
        paid: Array.from(state.payouts.values()).filter(p => p.status === 'PAID').length
      }
    });
  }

  if (route === 'GET /api/admin/payouts') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, {
      payouts: Array.from(state.payouts.values()).sort((a, b) => b.requestedAt - a.requestedAt)
    });
  }

  if (route === 'POST /api/admin/payouts/approve') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return json(res, { error: 'Unauthorized' }, 401);
    return readBody(req, body => {
      const p = state.payouts.get(body.payoutId);
      if (!p) return json(res, { error: 'Payout not found' }, 404);
      p.status = 'APPROVED';
      p.approvedAt = Date.now();
      // În producție: trigger Stripe transfer here
      // În demo: marcăm direct ca paid
      p.status = 'PAID';
      p.paidAt = Date.now();
      state.metrics.payoutsDistributed += p.net;
      notify(p.userId, 'payment', 'notif.payoutPaid.title', 'notif.payoutPaid.message', { payoutId: p.id, amount: p.net });
      json(res, { ok: true, status: p.status });
    });
  }

  if (route === 'POST /api/admin/job') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return json(res, { error: 'Unauthorized' }, 401);
    return readBody(req, body => {
      const jobId = 'J-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      state.jobs.set(jobId, {
        id: jobId, clientId: 'admin', type: body.type, nodesNeeded: body.nodes || 5,
        reward: body.reward || 1.0, status: 'PENDING', createdAt: Date.now()
      });
      json(res, { jobId });
    });
  }

  if (route === 'GET /api/admin/users') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, {
      users: Array.from(state.users.entries()).map(([id, u]) => ({
        id, email: u.email, totalEarnings: u.totalEarnings,
        withdrawable: u.withdrawable, joinedAt: u.joinedAt,
        nodesCount: u.nodes.size, payoutSetup: u.payoutSetup
      })).sort((a, b) => b.joinedAt - a.joinedAt)
    });
  }

  if (route === 'GET /api/admin/nodes/real') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return json(res, { error: 'Unauthorized' }, 401);
    const reals = Array.from(state.nodes.values()).filter(n => n.source === 'real');
    return json(res, { nodes: reals });
  }

  res.writeHead(404); res.end('Not found');
});

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(data || '{}')); } catch { cb({}); } });
}

// ============== WEBSOCKET ==============
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify(buildFullSnapshot()));
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'SUBSCRIBE_USER' && data.userId && state.users.has(data.userId)) {
        ws.userId = data.userId;
        const unread = (state.notifications.get(data.userId) || []).filter(n => !n.read);
        if (unread.length > 0) ws.send(JSON.stringify({ type: 'NOTIFICATIONS', notifications: unread }));
      }
    } catch {}
  });
});

setInterval(tick, TICK_MS);
server.listen(PORT, () => {
  console.log(`HIMER Orchestrator v3 running on :${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Nodes: ${state.nodes.size} (${state.metrics.realNodes} real, ${state.metrics.seedNodes} seed) | Users: ${state.users.size}`);
  console.log(`Platform fee: ${(PLATFORM_FEE * 100).toFixed(0)}% | User share: ${(USER_SHARE * 100).toFixed(0)}%`);
  console.log(`Min withdraw: $${MIN_WITHDRAW}`);
  console.log(`Stripe: ${STRIPE_SECRET ? 'configured' : 'not configured'} | Claude AI: ${ANTHROPIC_KEY ? 'configured' : 'not configured'}`);
});

process.on('SIGTERM', () => { saveSnapshot(); process.exit(0); });
process.on('SIGINT', () => { saveSnapshot(); process.exit(0); });
