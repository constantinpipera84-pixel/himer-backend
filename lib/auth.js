/**
 * Auth: bcrypt password hashing + JWT sessions.
 * Handles admin + client login, force password change, 3-month rotation.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { dbGet, dbUpdate, dbInsert } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = '7d';
const BCRYPT_ROUNDS = 10;

if (!process.env.JWT_SECRET) {
  console.warn('[Auth] JWT_SECRET not set in env — using random secret (sessions die on restart!)');
}

// ============================================================
// Password helpers
// ============================================================
async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) return { ok: false, reason: 'Password must be at least 8 characters' };
  if (pw.length > 200) return { ok: false, reason: 'Password too long' };
  return { ok: true };
}

// ============================================================
// JWT
// ============================================================
function signToken(payload, expiresIn = JWT_EXPIRY) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Extract token from Authorization header or cookie
function getTokenFromReq(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  // Try cookie
  const cookie = req.headers['cookie'] || '';
  const match = cookie.match(/himer_token=([^;]+)/);
  return match ? match[1] : null;
}

// ============================================================
// Admin login
// ============================================================
async function loginAdmin(email, password, ip) {
  const admin = await dbGet('himer_admins', email.toLowerCase(), 'email');
  if (!admin || !admin.is_active) {
    return { ok: false, reason: 'Invalid credentials' };
  }
  // Check lockout
  if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
    return { ok: false, reason: 'Account locked. Try again later.' };
  }
  // Verify password
  const valid = await verifyPassword(password, admin.password_hash);
  if (!valid) {
    const attempts = (admin.failed_login_attempts || 0) + 1;
    const patch = { failed_login_attempts: attempts };
    if (attempts >= 5) {
      patch.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      patch.failed_login_attempts = 0;
    }
    await dbUpdate('himer_admins', admin.id, patch);
    return { ok: false, reason: 'Invalid credentials' };
  }
  // Reset fail counter, update last login
  await dbUpdate('himer_admins', admin.id, {
    failed_login_attempts: 0,
    locked_until: null,
    last_login_at: new Date().toISOString(),
    last_login_ip: ip,
  });
  // Check if password must be changed
  const now = new Date();
  const expires = new Date(admin.password_expires_at);
  const mustChange = admin.must_change_password || expires <= now;
  // Sign token
  const token = signToken({
    sub: admin.id,
    email: admin.email,
    role: 'admin',
    mustChange,
  });
  return {
    ok: true,
    token,
    admin: {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      mustChangePassword: mustChange,
      passwordExpiresAt: admin.password_expires_at,
    },
  };
}

async function changeAdminPassword(adminId, newPassword) {
  const validation = validatePasswordStrength(newPassword);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  const hash = await hashPassword(newPassword);
  const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 3 months
  await dbUpdate('himer_admins', adminId, {
    password_hash: hash,
    must_change_password: false,
    password_last_changed_at: new Date().toISOString(),
    password_expires_at: expires.toISOString(),
  });
  return { ok: true };
}

async function verifyAdminToken(req) {
  const token = getTokenFromReq(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') return null;
  const admin = await dbGet('himer_admins', payload.sub);
  if (!admin || !admin.is_active) return null;
  return { ...payload, admin };
}

// ============================================================
// Client login (business clients)
// ============================================================
async function loginClient(email, password, ip) {
  const client = await dbGet('himer_clients', email.toLowerCase(), 'email');
  if (!client || !client.is_active) return { ok: false, reason: 'Invalid credentials' };
  const valid = await verifyPassword(password, client.password_hash);
  if (!valid) return { ok: false, reason: 'Invalid credentials' };
  await dbUpdate('himer_clients', client.id, {
    last_login_at: new Date().toISOString(),
  });
  const token = signToken({
    sub: client.id,
    email: client.email,
    role: 'client',
    mustChange: client.must_change_password,
  });
  return {
    ok: true,
    token,
    client: {
      id: client.id,
      email: client.email,
      name: client.name,
      company: client.company,
      mustChangePassword: client.must_change_password,
      apiKey: client.must_change_password ? null : client.api_key, // hide key until password changed
    },
  };
}

async function changeClientPassword(clientId, newPassword) {
  const validation = validatePasswordStrength(newPassword);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  const hash = await hashPassword(newPassword);
  await dbUpdate('himer_clients', clientId, {
    password_hash: hash,
    must_change_password: false,
  });
  return { ok: true };
}

async function verifyClientToken(req) {
  const token = getTokenFromReq(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'client') return null;
  const client = await dbGet('himer_clients', payload.sub);
  if (!client || !client.is_active) return null;
  return { ...payload, client };
}

// ============================================================
// Bootstrap initial admin
// ============================================================
async function ensureInitialAdmin() {
  const email = (process.env.INITIAL_ADMIN_EMAIL || 'admin@himer.network').toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD || '12345678';
  const existing = await dbGet('himer_admins', email, 'email');
  if (existing) {
    console.log('[Auth] Initial admin exists:', email);
    return existing;
  }
  const hash = await hashPassword(password);
  const id = 'A-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const admin = await dbInsert('himer_admins', {
    id,
    email,
    password_hash: hash,
    must_change_password: true,
    role: 'super_admin',
    is_active: true,
    password_last_changed_at: new Date().toISOString(),
    password_expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
  });
  console.log('[Auth] CREATED initial admin:', email);
  console.log('[Auth] Default password set. FIRST LOGIN WILL FORCE PASSWORD CHANGE.');
  return admin;
}

// ============================================================
// Audit log helper
// ============================================================
async function logAdminAction(adminId, action, targetType, targetId, ip, meta = {}) {
  try {
    await dbInsert('himer_admin_audit', {
      id: 'AU-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
      admin_id: adminId,
      action,
      target_type: targetType,
      target_id: targetId,
      ip_address: ip,
      meta,
    });
  } catch (e) {
    console.error('[Audit] Failed to log:', e.message);
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  signToken,
  verifyToken,
  getTokenFromReq,
  loginAdmin,
  changeAdminPassword,
  verifyAdminToken,
  loginClient,
  changeClientPassword,
  verifyClientToken,
  ensureInitialAdmin,
  logAdminAction,
};
