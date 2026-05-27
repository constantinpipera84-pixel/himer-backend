/**
 * Payouts: withdraw request flow with admin approval.
 * - User requests withdraw (only if >= $500 + payout setup)
 * - Status: PENDING_REVIEW -> APPROVED -> PAID
 *                          \-> REJECTED
 * - Admin approves per request (one-by-one)
 */

const crypto = require('crypto');
const { dbInsert, dbUpdate, dbGet, dbList, dbSum } = require('./db');

const MIN_WITHDRAW = parseFloat(process.env.MIN_WITHDRAW || '500');
const WITHDRAW_FEE_PCT = 0.02;

async function requestWithdraw(userId, userIp = null) {
  const user = await dbGet('himer_users', userId);
  if (!user) return { ok: false, reason: 'User not found' };
  if (!user.payout_setup) return { ok: false, reason: 'Setup payout method first', code: 'NO_PAYOUT_METHOD' };

  const available = parseFloat(user.withdrawable || 0);
  if (available < MIN_WITHDRAW) {
    return {
      ok: false,
      reason: `Minimum withdraw is $${MIN_WITHDRAW}. You have $${available.toFixed(2)}`,
      code: 'BELOW_MINIMUM',
      available,
      minimum: MIN_WITHDRAW,
    };
  }

  const gross = available;
  const fee = gross * WITHDRAW_FEE_PCT;
  const net = gross - fee;
  const payoutId = 'PO-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  // Move money from withdrawable to pending payout
  await dbUpdate('himer_users', userId, { withdrawable: 0 });

  const payout = await dbInsert('himer_payouts', {
    id: payoutId,
    user_id: userId,
    gross_amount: gross,
    fee,
    net_amount: net,
    status: 'PENDING_REVIEW',
    user_ip: userIp,
    requested_at: new Date().toISOString(),
  });

  return {
    ok: true,
    payout: {
      id: payoutId,
      gross,
      fee,
      net,
      status: 'PENDING_REVIEW',
    },
  };
}

async function listPendingPayouts() {
  return dbList('himer_payouts', {
    where: { status: 'PENDING_REVIEW' },
    order: { col: 'requested_at', asc: true },
  });
}

async function listAllPayouts(limit = 200) {
  return dbList('himer_payouts', {
    order: { col: 'requested_at', asc: false },
    limit,
  });
}

async function approvePayout(payoutId, adminId, adminIp = null) {
  const payout = await dbGet('himer_payouts', payoutId);
  if (!payout) return { ok: false, reason: 'Payout not found' };
  if (payout.status !== 'PENDING_REVIEW') return { ok: false, reason: `Already ${payout.status}` };

  // Mark approved
  const now = new Date().toISOString();
  await dbUpdate('himer_payouts', payoutId, {
    status: 'APPROVED',
    approved_by_admin_id: adminId,
    approved_at: now,
  });

  // TODO: Trigger real Stripe transfer here.
  // For now, immediately mark as PAID (demo flow).
  // In production, replace with:
  //   const transfer = await stripe.transfers.create({ amount: payout.net_amount*100, ... })
  //   await dbUpdate('himer_payouts', payoutId, { stripe_transfer_id: transfer.id, status: 'PAID', paid_at: ... })

  await dbUpdate('himer_payouts', payoutId, {
    status: 'PAID',
    paid_at: now,
  });

  // Treasury ledger entry
  await dbInsert('himer_treasury_ledger', {
    id: 'TX-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    type: 'payout',
    direction: 'out',
    amount: parseFloat(payout.net_amount),
    user_id: payout.user_id,
    payout_id: payoutId,
    description: `Payout to user ${payout.user_id}`,
  });

  return { ok: true, status: 'PAID', netAmount: parseFloat(payout.net_amount) };
}

async function rejectPayout(payoutId, adminId, reason) {
  const payout = await dbGet('himer_payouts', payoutId);
  if (!payout) return { ok: false, reason: 'Payout not found' };
  if (payout.status !== 'PENDING_REVIEW') return { ok: false, reason: `Already ${payout.status}` };

  // Refund withdrawable to user
  const user = await dbGet('himer_users', payout.user_id);
  if (user) {
    await dbUpdate('himer_users', payout.user_id, {
      withdrawable: parseFloat(user.withdrawable || 0) + parseFloat(payout.gross_amount),
    });
  }

  await dbUpdate('himer_payouts', payoutId, {
    status: 'REJECTED',
    approved_by_admin_id: adminId,
    approved_at: new Date().toISOString(),
    rejection_reason: reason || 'Rejected by admin',
  });

  return { ok: true, status: 'REJECTED' };
}

async function getTreasuryStats() {
  const totalIn = await dbSum('himer_treasury_ledger', 'amount', { direction: 'in' });
  const totalOut = await dbSum('himer_treasury_ledger', 'amount', { direction: 'out' });
  const balance = totalIn - totalOut;

  // Obligations = sum of all user withdrawable
  const users = await dbList('himer_users');
  const obligationsToUsers = users.reduce((a, u) => a + parseFloat(u.withdrawable || 0), 0);

  const pendingPayouts = await dbSum('himer_payouts', 'net_amount', { status: 'PENDING_REVIEW' });

  return {
    balance,
    totalIn,
    totalOut,
    obligationsToUsers,
    pendingPayouts,
    netAvailable: balance - pendingPayouts,
  };
}

module.exports = {
  MIN_WITHDRAW,
  WITHDRAW_FEE_PCT,
  requestWithdraw,
  listPendingPayouts,
  listAllPayouts,
  approvePayout,
  rejectPayout,
  getTreasuryStats,
};
