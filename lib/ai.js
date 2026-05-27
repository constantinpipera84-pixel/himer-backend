/**
 * AI Assistant FAQ matching.
 * Two contexts: 'user' (regular contributors) and 'client' (business API users).
 *
 * Returns i18n keys; frontend translates.
 * If ANTHROPIC_API_KEY is set, fallback to Claude for unknown questions.
 */

const https = require('https');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null;

// ============================================================
// USER FAQ (50+ topics)
// ============================================================
const USER_FAQ = [
  { kw: ['plata', 'platit', 'payment', 'pay', 'bani', 'money', 'cash', 'incasare', 'salariu'], a: 'ai.faq.payment' },
  { kw: ['privacy', 'date personale', 'gdpr', 'sigur', 'safe', 'securitate', 'data', 'fisier', 'private'], a: 'ai.faq.privacy' },
  { kw: ['cum functioneaza', 'how does', 'how it works', 'cum merge', 'mecanism', 'explica'], a: 'ai.faq.howWorks' },
  { kw: ['cati bani', 'cat castig', 'how much', 'earnings', 'venit', 'profit', 'castiguri'], a: 'ai.faq.earnings' },
  { kw: ['proof of compute', 'poc', 'verificare', 'verification', 'trust'], a: 'ai.faq.poc' },
  { kw: ['agent', 'instalare', 'install', 'descarcare', 'download'], a: 'ai.faq.agent' },
  { kw: ['retrage', 'withdraw', 'cash out', 'scoate bani', 'extract'], a: 'ai.faq.withdraw' },
  { kw: ['cont', 'register', 'inregistrare', 'sign up', 'inscriere'], a: 'ai.faq.register' },
  { kw: ['oprire', 'stop', 'pause', 'dezactiv', 'inchide', 'pauza'], a: 'ai.faq.stop' },
  { kw: ['contract', 'sarcina', 'task', 'job'], a: 'ai.faq.contract' },
  { kw: ['costuri', 'costs', 'taxe', 'fee', 'comision', 'cost'], a: 'ai.faq.costs' },
  { kw: ['boost', 'multiplicator', 'multiplier', 'premium'], a: 'ai.faq.boost' },
  { kw: ['nod', 'node', 'neuron', 'pc', 'calculator', 'computer'], a: 'ai.faq.node' },
  { kw: ['gflops', 'capacitate', 'performance', 'capacity'], a: 'ai.faq.gflops' },
  { kw: ['ai training', 'antrenare ai', 'machine learning', 'ml'], a: 'ai.faq.aiTraining' },
  { kw: ['3d render', 'randare', 'rendering'], a: 'ai.faq.rendering' },
  { kw: ['ce e himer', 'what is himer', 'cine sunteti', 'about', 'despre'], a: 'ai.faq.whatIsHimer' },
  { kw: ['referral', 'invita', 'invite', 'prieten', 'recomanda'], a: 'ai.faq.referral' },
  { kw: ['cati useri', 'how many users', 'comunitate', 'community'], a: 'ai.faq.community' },
  { kw: ['blockchain', 'crypto', 'wallet crypto', 'eth', 'bitcoin'], a: 'ai.faq.blockchain' },
  { kw: ['cand primesc', 'when do i get', 'cat dureaza', 'timp', 'durata'], a: 'ai.faq.timing' },
  { kw: ['mai multe', 'multi device', 'multi-device', 'multidevice', 'mai multe pc', 'multiple computers', 'multiple devices', 'devices', 'telefon', 'second device', 'another device', 'add device'], a: 'ai.faq.multidevice' },
  { kw: ['linux', 'mac', 'windows', 'os', 'sistem'], a: 'ai.faq.os' },
  { kw: ['internet', 'banda', 'bandwidth', 'date trafic', 'mb'], a: 'ai.faq.bandwidth' },
  { kw: ['curent', 'energie', 'electric', 'consum', 'power'], a: 'ai.faq.power' },
  { kw: ['minor', 'varsta', 'age', 'tata', 'parinte'], a: 'ai.faq.age' },
  { kw: ['tara', 'country', 'romania', 'eligibil', 'oriunde'], a: 'ai.faq.country' },
  { kw: ['impozit', 'tax', 'fiscal', 'declarare', 'anaf'], a: 'ai.faq.tax' },
  { kw: ['stripe', 'cont bancar', 'bank account', 'transfer', 'iban'], a: 'ai.faq.stripe' },
  { kw: ['paypal', 'revolut', 'wise', 'alta metoda'], a: 'ai.faq.paymentMethods' },
  { kw: ['email', 'notificare email', 'mesaj email'], a: 'ai.faq.email' },
  { kw: ['parola', 'password', 'recuperare', 'reset'], a: 'ai.faq.password' },
  { kw: ['cont sters', 'delete account', 'sterg', 'eliminare'], a: 'ai.faq.deleteAccount' },
  { kw: ['vechi', 'vechime', 'cat de mult', 'lansare'], a: 'ai.faq.longevity' },
  { kw: ['fraud', 'fraud', 'inselatorie', 'scam', 'real'], a: 'ai.faq.legitimacy' },
  { kw: ['investitie', 'investment', 'fonduri', 'capital'], a: 'ai.faq.investment' },
  { kw: ['minim', 'minimum', 'cat minim', 'sub'], a: 'ai.faq.minimum' },
  { kw: ['maxim', 'maximum', 'plafon', 'limita'], a: 'ai.faq.maximum' },
  { kw: ['mobil', 'mobile', 'telefon', 'phone', 'app'], a: 'ai.faq.mobile' },
  { kw: ['fan', 'temperatura', 'cald', 'cpu temp', 'overheat'], a: 'ai.faq.temperature' },
  { kw: ['gpu', 'placa video', 'video card', 'cuda', 'nvidia'], a: 'ai.faq.gpu' },
  { kw: ['lent', 'slow', 'incetinire', 'browser lent', 'lag'], a: 'ai.faq.slowdown' },
  { kw: ['idle', 'oprit', 'noaptea', 'noapte', 'night'], a: 'ai.faq.idle' },
  { kw: ['vine cineva', 'support', 'sprijin', 'ajutor', 'help'], a: 'ai.faq.support' },
  { kw: ['ddos', 'atac', 'attack', 'protectie'], a: 'ai.faq.ddos' },
  { kw: ['legal', 'legalitate', 'permis', 'allowed', 'illegal'], a: 'ai.faq.legal' },
  { kw: ['terms', 'conditii', 'tos', 'regulament'], a: 'ai.faq.terms' },
  { kw: ['testnet', 'test', 'demo', 'beta'], a: 'ai.faq.beta' },
  { kw: ['offline', 'fara internet', 'no connection'], a: 'ai.faq.offline' },
  { kw: ['sus', 'jos', 'up', 'down', 'status server'], a: 'ai.faq.status' },
];

// ============================================================
// CLIENT FAQ (30+ topics for business clients)
// ============================================================
const CLIENT_FAQ = [
  { kw: ['api', 'integrare', 'integration', 'sdk'], a: 'aiclient.faq.api' },
  { kw: ['api key', 'cheie', 'token', 'authentication'], a: 'aiclient.faq.apiKey' },
  { kw: ['preturi', 'pricing', 'cost', 'cat costa', 'tarif'], a: 'aiclient.faq.pricing' },
  { kw: ['plata', 'top-up', 'incarcare', 'balance', 'sold'], a: 'aiclient.faq.topup' },
  { kw: ['contract', 'sla', 'garantii', 'guarantee', 'uptime'], a: 'aiclient.faq.sla' },
  { kw: ['cum incep', 'getting started', 'first steps', 'quickstart'], a: 'aiclient.faq.start' },
  { kw: ['rate limit', 'limita', 'requests per', 'throttle'], a: 'aiclient.faq.rateLimit' },
  { kw: ['docs', 'documentatie', 'documentation', 'reference'], a: 'aiclient.faq.docs' },
  { kw: ['endpoint', 'url', 'curl', 'request', 'compute'], a: 'aiclient.faq.endpoint' },
  { kw: ['tipuri job', 'job types', 'use cases', 'cazuri'], a: 'aiclient.faq.jobTypes' },
  { kw: ['ai training', 'ml training', 'antrenare model'], a: 'aiclient.faq.aiTraining' },
  { kw: ['rendering', 'blender', '3d', 'cinema 4d'], a: 'aiclient.faq.rendering' },
  { kw: ['inference', 'predict', 'predictie'], a: 'aiclient.faq.inference' },
  { kw: ['simulare', 'simulation', 'monte carlo', 'physics'], a: 'aiclient.faq.simulation' },
  { kw: ['noduri', 'nodes', 'cati noduri', 'cluster'], a: 'aiclient.faq.nodes' },
  { kw: ['rezultat', 'output', 'result', 'callback', 'webhook'], a: 'aiclient.faq.results' },
  { kw: ['factura', 'invoice', 'bill', 'receipt'], a: 'aiclient.faq.invoice' },
  { kw: ['suport', 'support', 'help', 'contact'], a: 'aiclient.faq.support' },
  { kw: ['security', 'securitate', 'incriptare', 'encryption'], a: 'aiclient.faq.security' },
  { kw: ['privacy', 'date confidentiale', 'confidential'], a: 'aiclient.faq.privacy' },
  { kw: ['enterprise', 'mare', 'volume mari', 'enterprise plan'], a: 'aiclient.faq.enterprise' },
  { kw: ['compare', 'aws', 'gcp', 'azure', 'comparatie'], a: 'aiclient.faq.compare' },
  { kw: ['speed', 'viteza', 'latency', 'latenta', 'rapid'], a: 'aiclient.faq.speed' },
  { kw: ['python', 'js', 'go', 'language', 'limbaj'], a: 'aiclient.faq.languages' },
  { kw: ['retry', 'fail', 'esuat', 'failure', 'reincercare'], a: 'aiclient.faq.retry' },
  { kw: ['suspend', 'suspendare', 'inchidere cont', 'pause'], a: 'aiclient.faq.suspend' },
  { kw: ['parola', 'password', 'reset', 'change password'], a: 'aiclient.faq.password' },
  { kw: ['parteneriat', 'partnership', 'reseller'], a: 'aiclient.faq.partnership' },
  { kw: ['demo', 'free trial', 'gratis', 'test'], a: 'aiclient.faq.trial' },
  { kw: ['scaling', 'scalare', 'creste', 'autoscale'], a: 'aiclient.faq.scaling' },
];

function matchFAQ(question, context = 'user') {
  const q = (question || '').toLowerCase();
  const set = context === 'client' ? CLIENT_FAQ : USER_FAQ;
  let best = null, bestScore = 0;
  for (const item of set) {
    let score = 0;
    for (const k of item.kw) if (q.includes(k)) score++;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return best && bestScore > 0 ? best.a : null;
}

// Optional Claude fallback for complex questions
async function callClaude(question, lang = 'en', context = 'user') {
  if (!ANTHROPIC_KEY) return null;
  const sysPrompt = context === 'client'
    ? `You are HIMER Business Assistant helping enterprise clients integrate with HIMER Neural Grid (DePIN compute API). Be concise, technical, and helpful. Reply in language code: ${lang}.`
    : `You are HIMER Assistant. Help users contribute compute to HIMER Neural Grid. Be friendly and concise. Reply in language code: ${lang}.`;
  return new Promise((resolve) => {
    const data = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: sysPrompt,
      messages: [{ role: 'user', content: question }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': data.length,
      },
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

async function ask(question, lang = 'en', context = 'user', useClaude = false) {
  // 1. Try FAQ first
  const key = matchFAQ(question, context);
  if (key && !useClaude) return { source: 'faq', key };
  // 2. Try Claude if requested
  if (useClaude && ANTHROPIC_KEY) {
    const text = await callClaude(question, lang, context);
    if (text) return { source: 'claude', text };
  }
  // 3. Fallback
  return { source: 'fallback', key: context === 'client' ? 'aiclient.faq.fallback' : 'ai.faq.fallback' };
}

module.exports = { ask, matchFAQ, USER_FAQ, CLIENT_FAQ };
