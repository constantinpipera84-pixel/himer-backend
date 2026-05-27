/**
 * Business clients management.
 * Admin creates clients manually. Each client gets:
 *  - Login credentials (email + initial password, forced change on first login)
 *  - API key for programmatic access
 *  - Their own dashboard at /client
 */

const crypto = require('crypto');
const { dbInsert, dbUpdate, dbGet, dbList } = require('./db');
const { hashPassword } = require('./auth');

function generateApiKey() {
  // Format: hmr_live_xxx (similar to Stripe style)
  return 'hmr_live_' + crypto.randomBytes(24).toString('hex');
}

function generateInitialPassword() {
  // 12 chars, alphanumeric, easy to type
  const charset = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let pw = '';
  for (let i = 0; i < 12; i++) {
    pw += charset[Math.floor(Math.random() * charset.length)];
  }
  return pw;
}

async function createClient({ email, name, company, initialBalance = 0, createdByAdminId, rateLimit = 60 }) {
  if (!email) return { ok: false, reason: 'Email required' };
  const emailLower = email.toLowerCase();
  const existing = await dbGet('himer_clients', emailLower, 'email');
  if (existing) return { ok: false, reason: 'Client with this email already exists' };

  const initialPassword = generateInitialPassword();
  const apiKey = generateApiKey();
  const hash = await hashPassword(initialPassword);
  const id = 'C-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  const client = await dbInsert('himer_clients', {
    id,
    email: emailLower,
    password_hash: hash,
    name: name || null,
    company: company || null,
    api_key: apiKey,
    api_key_created_at: new Date().toISOString(),
    balance: initialBalance,
    total_spent: 0,
    total_topped_up: initialBalance,
    rate_limit_per_minute: rateLimit,
    is_active: true,
    created_at: new Date().toISOString(),
    created_by_admin_id: createdByAdminId || null,
    must_change_password: true,
  });

  if (initialBalance > 0) {
    // Log initial topup
    await dbInsert('himer_treasury_ledger', {
      id: 'TX-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
      type: 'client_payment',
      direction: 'in',
      amount: initialBalance,
      client_id: id,
      description: `Initial balance for ${emailLower}`,
    });
  }

  return {
    ok: true,
    client,
    initialPassword,        // SHOW ONCE to admin so they can email it
    apiKey,                 // SHOW ONCE
  };
}

async function listClients() {
  return dbList('himer_clients', { order: { col: 'created_at', asc: false } });
}

async function getClient(id) {
  return dbGet('himer_clients', id);
}

async function getClientByApiKey(apiKey) {
  return dbGet('himer_clients', apiKey, 'api_key');
}

async function suspendClient(clientId, reason, adminId) {
  await dbUpdate('himer_clients', clientId, {
    is_active: false,
    suspended_reason: reason,
  });
  return { ok: true };
}

async function reactivateClient(clientId) {
  await dbUpdate('himer_clients', clientId, {
    is_active: true,
    suspended_reason: null,
  });
  return { ok: true };
}

async function topUpClientBalance(clientId, amount, adminId) {
  const client = await dbGet('himer_clients', clientId);
  if (!client) return { ok: false, reason: 'Client not found' };
  const newBalance = parseFloat(client.balance || 0) + amount;
  await dbUpdate('himer_clients', clientId, {
    balance: newBalance,
    total_topped_up: parseFloat(client.total_topped_up || 0) + amount,
  });
  // Treasury entry
  await dbInsert('himer_treasury_ledger', {
    id: 'TX-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    type: 'client_payment',
    direction: 'in',
    amount,
    client_id: clientId,
    description: `Top-up by admin ${adminId || 'system'}`,
  });
  return { ok: true, newBalance };
}

async function regenerateApiKey(clientId) {
  const newKey = generateApiKey();
  await dbUpdate('himer_clients', clientId, {
    api_key: newKey,
    api_key_created_at: new Date().toISOString(),
  });
  return { ok: true, apiKey: newKey };
}

async function chargeClient(clientId, amount, jobId) {
  const client = await dbGet('himer_clients', clientId);
  if (!client) return { ok: false, reason: 'Client not found' };
  if (parseFloat(client.balance) < amount) {
    return { ok: false, reason: 'Insufficient balance' };
  }
  await dbUpdate('himer_clients', clientId, {
    balance: parseFloat(client.balance) - amount,
    total_spent: parseFloat(client.total_spent || 0) + amount,
  });
  return { ok: true };
}

module.exports = {
  createClient,
  listClients,
  getClient,
  getClientByApiKey,
  suspendClient,
  reactivateClient,
  topUpClientBalance,
  regenerateApiKey,
  chargeClient,
};
