/**
 * HIMER v5 — Web Push Notifications
 *
 * Uses Web Push Protocol (VAPID). Free, no external service needed.
 * Browser subscribes → we store endpoint+keys → we POST to endpoint to deliver.
 *
 * For Android (Chrome): notifications arrive even with browser closed.
 * For iOS 16.4+: also works (added support late 2023).
 *
 * Trigger types:
 *   - daily_reminder    : "Check your HIMER earnings!"
 *   - earnings_milestone: "You hit $X!"
 *   - referral_joined   : "A friend joined with your code"
 *   - payout_approved   : "Your $X payout is on the way"
 *   - chunk_done        : (silent — used to wake the worker)
 */
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { dbInsert, dbGet, dbUpdate, dbList, dbDelete } = require('./db');

// VAPID keys — generated once, stored in env. Public key shared with frontend.
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:himer.nodes@gmail.com';

// Auto-generate VAPID keys if missing (dev only; production must set env)
function ensureVapidKeys() {
  if (VAPID_PUBLIC && VAPID_PRIVATE) return { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE };

  // Generate P-256 EC keys (Web Push standard)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  // Extract raw 65-byte uncompressed point + raw 32-byte private scalar
  const pubRaw = publicKey.slice(-65);
  const privRaw = privateKey.slice(-32);
  const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const pubB64 = b64url(pubRaw);
  const privB64 = b64url(privRaw);
  console.log('[Push] AUTO-GENERATED VAPID KEYS — set these in env for production:');
  console.log('       VAPID_PUBLIC=' + pubB64);
  console.log('       VAPID_PRIVATE=' + privB64);
  return { publicKey: pubB64, privateKey: privB64 };
}

const VAPID = ensureVapidKeys();

function getPublicKey() { return VAPID.publicKey; }

// ============================================================
// SUBSCRIBE / UNSUBSCRIBE
// ============================================================
async function saveSubscription(userId, subscription) {
  // subscription = { endpoint, keys: { p256dh, auth } }
  if (!userId || !subscription?.endpoint) return { ok: false, error: 'Invalid subscription' };
  const id = 'PS-' + crypto.createHash('sha1').update(subscription.endpoint).digest('hex').slice(0, 16);
  // Upsert
  try {
    const existing = await dbGet('himer_push_subs', id);
    if (existing) {
      await dbUpdate('himer_push_subs', id, {
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys?.p256dh,
        auth: subscription.keys?.auth,
        updated_at: new Date().toISOString(),
      });
    } else {
      await dbInsert('himer_push_subs', {
        id, user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys?.p256dh,
        auth: subscription.keys?.auth,
        created_at: new Date().toISOString(),
      });
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  const id = 'PS-' + crypto.createHash('sha1').update(endpoint).digest('hex').slice(0, 16);
  try { await dbDelete('himer_push_subs', id); } catch (_) {}
}

// ============================================================
// WEB PUSH PROTOCOL — encrypt + send
// ============================================================

// Base64url <-> Buffer
function b64uToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function bufToB64u(b) {
  return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Create VAPID JWT (ES256)
function createVapidJWT(audience) {
  const header = bufToB64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bufToB64u(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  })));
  const unsigned = header + '.' + claims;

  // Sign with ECDSA P-256 SHA-256
  const privRaw = b64uToBuf(VAPID.privateKey);
  // Build PKCS8 DER from raw 32-byte private scalar
  const privDer = Buffer.concat([
    Buffer.from('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'),
    privRaw,
  ]);
  const privKey = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
  const sigDer = crypto.sign('sha256', Buffer.from(unsigned), privKey);
  // Convert DER signature → raw 64 bytes (r||s)
  const sigRaw = derToRaw(sigDer);
  return unsigned + '.' + bufToB64u(sigRaw);
}

function derToRaw(der) {
  // Parse DER: 0x30 len 0x02 rLen r 0x02 sLen s
  let i = 2;
  if (der[1] === 0x81) i = 3; // long form
  i++; // skip 0x02
  const rLen = der[i++];
  let r = der.slice(i, i + rLen);
  i += rLen;
  i++; // skip 0x02
  const sLen = der[i++];
  let s = der.slice(i, i + sLen);
  // Normalize to 32 bytes each
  if (r.length > 32) r = r.slice(r.length - 32);
  if (s.length > 32) s = s.slice(s.length - 32);
  const rPad = Buffer.concat([Buffer.alloc(32 - r.length), r]);
  const sPad = Buffer.concat([Buffer.alloc(32 - s.length), s]);
  return Buffer.concat([rPad, sPad]);
}

// Encrypt payload using aes128gcm (RFC 8291)
function encryptPayload(payload, p256dhB64, authB64) {
  const clientPub = b64uToBuf(p256dhB64); // 65 bytes
  const auth = b64uToBuf(authB64);          // 16 bytes
  const payloadBuf = Buffer.from(payload);

  // Generate ephemeral keypair
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const localPub = ecdh.getPublicKey(); // 65 bytes uncompressed
  const sharedSecret = ecdh.computeSecret(clientPub);

  // Salt
  const salt = crypto.randomBytes(16);

  // PRK_key = HMAC(auth, sharedSecret)
  const prkKey = hmacSha256(auth, sharedSecret);

  // key_info = "WebPush: info\0" || ua_public || as_public
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    clientPub, localPub,
  ]);
  const ikm = hkdf_expand(prkKey, keyInfo, 32);

  // PRK = HMAC(salt, ikm)
  const prk = hmacSha256(salt, ikm);

  // CEK = HKDF-expand(prk, "Content-Encoding: aes128gcm\0", 16)
  const cek = hkdf_expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  // Nonce = HKDF-expand(prk, "Content-Encoding: nonce\0", 12)
  const nonce = hkdf_expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  // Pad: 0x02 marker (end of last record)
  const padded = Buffer.concat([payloadBuf, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = Buffer.concat([enc, tag]);

  // Header: salt(16) || rs(4 BE = 4096) || idlen(1) || keyid(localPub 65 bytes)
  const header = Buffer.concat([
    salt,
    Buffer.from([0, 0, 0x10, 0]), // record size 4096
    Buffer.from([65]),              // keyid length
    localPub,
  ]);
  return Buffer.concat([header, body]);
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function hkdf_expand(prk, info, length) {
  // T(1) = HMAC(prk, info || 0x01)
  return hmacSha256(prk, Buffer.concat([info, Buffer.from([1])])).slice(0, length);
}

// Send a single push (returns true on success)
function sendPush(sub, payload) {
  return new Promise((resolve) => {
    try {
      const endpointUrl = new URL(sub.endpoint);
      const audience = endpointUrl.origin;
      const jwt = createVapidJWT(audience);
      const encrypted = encryptPayload(payload, sub.p256dh, sub.auth);

      const lib = endpointUrl.protocol === 'https:' ? https : http;
      const req = lib.request({
        method: 'POST',
        host: endpointUrl.hostname,
        port: endpointUrl.port,
        path: endpointUrl.pathname + endpointUrl.search,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          'Content-Length': encrypted.length,
          'TTL': '86400',
          'Urgency': 'normal',
          'Authorization': `vapid t=${jwt}, k=${VAPID.publicKey}`,
        },
      }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          // 410 = subscription expired, delete it
          if (res.statusCode === 410 || res.statusCode === 404) {
            removeSubscription(sub.endpoint);
          }
          resolve(res.statusCode >= 200 && res.statusCode < 300);
        });
      });
      req.on('error', (e) => { console.warn('[Push] send error:', e.message); resolve(false); });
      req.setTimeout(8000, () => { req.destroy(); resolve(false); });
      req.write(encrypted);
      req.end();
    } catch (e) {
      console.warn('[Push] encrypt error:', e.message);
      resolve(false);
    }
  });
}

// ============================================================
// HIGH-LEVEL HELPERS
// ============================================================
async function notifyUser(userId, { title, body, url, tag, data }) {
  try {
    const subs = await dbList('himer_push_subs', { where: { user_id: userId } });
    if (!subs.length) return { sent: 0 };
    const payload = JSON.stringify({
      title: title || 'HIMER',
      body: body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: tag || 'himer-default',
      data: { url: url || '/', ...(data || {}) },
    });
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      const ok = await sendPush(s, payload);
      if (ok) sent++;
    }));
    return { sent, total: subs.length };
  } catch (e) {
    console.warn('[Push] notifyUser error:', e.message);
    return { sent: 0, error: e.message };
  }
}

// Daily reminder — sent to users who haven't visited today
async function sendDailyReminders() {
  try {
    const allSubs = await dbList('himer_push_subs', {});
    let sent = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (const s of allSubs) {
      const user = await dbGet('himer_users', s.user_id);
      if (!user) continue;
      // Only send if user hasn't been seen today
      const lastLogin = (user.last_login_at || user.created_at || '').slice(0, 10);
      if (lastLogin === today) continue;
      const earnings = parseFloat(user.withdrawable || 0);
      const title = '💎 HIMER — check your earnings';
      const body = earnings > 0.5
        ? `You have $${earnings.toFixed(2)} ready. Tap to view!`
        : `Your nodes are running. Check today's progress.`;
      const ok = await sendPush(s, JSON.stringify({
        title, body,
        icon: '/icon-192.png', badge: '/icon-192.png',
        tag: 'himer-daily',
        data: { url: '/' },
      }));
      if (ok) sent++;
    }
    console.log(`[Push] Daily reminders sent: ${sent}`);
    return { sent };
  } catch (e) {
    console.warn('[Push] daily reminder error:', e.message);
    return { sent: 0 };
  }
}

// Schedule daily reminder check every hour (only sends to users not seen today)
let dailyTimer = null;
function startDailyReminders() {
  if (dailyTimer) return;
  // Check every hour — sends only if user inactive today
  dailyTimer = setInterval(sendDailyReminders, 3600000);
  console.log('[Push] Daily reminder scheduler started (hourly check)');
}

module.exports = {
  getPublicKey,
  saveSubscription,
  removeSubscription,
  notifyUser,
  sendDailyReminders,
  startDailyReminders,
};
