/**
 * HIMER v5 — Referral & Viral Mechanics
 *
 * - Each user gets a unique referral code
 * - When a new user signs up with a code, they're linked to the referrer
 * - Referrer earns a bonus % of the invitee's earnings for 12 months
 *   (paid by the PLATFORM, NOT deducted from the invitee — true incentive)
 * - Milestones unlock boosts (more referrals = higher earning multiplier)
 * - Leaderboard ranks top referrers
 */
const { dbGet, dbUpdate, dbList, dbInsert } = require('./db');

const REFERRAL_BONUS_PCT = 0.05;       // referrer earns 5% of invitee earnings
const REFERRAL_BONUS_MONTHS = 12;       // for 12 months
const SIGNUP_BONUS = 0.10;              // $0.10 instant bonus to new user on referred signup
const REFERRER_SIGNUP_BONUS = 0.25;     // $0.25 to referrer per successful referral

// Milestone tiers: referrals -> earning multiplier boost
const MILESTONE_TIERS = [
  { referrals: 0, boost: 1.0, name: 'Starter' },
  { referrals: 3, boost: 1.1, name: 'Connector' },
  { referrals: 10, boost: 1.25, name: 'Builder' },
  { referrals: 25, boost: 1.5, name: 'Ambassador' },
  { referrals: 50, boost: 1.75, name: 'Champion' },
  { referrals: 100, boost: 2.0, name: 'Legend' },
];

function generateReferralCode(userId) {
  // Short, shareable, derived from user id + random
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  const suffix = (userId || '').replace(/[^A-Z0-9]/gi, '').slice(-4).toUpperCase();
  return `HMR${suffix}${rand}`;
}

async function ensureReferralCode(userId) {
  const user = await dbGet('himer_users', userId);
  if (!user) return null;
  if (user.referral_code) return user.referral_code;
  let code = generateReferralCode(userId);
  // Ensure uniqueness
  let tries = 0;
  while (tries < 5) {
    const existing = (await dbList('himer_users', { where: { referral_code: code } }))[0];
    if (!existing) break;
    code = generateReferralCode(userId);
    tries++;
  }
  await dbUpdate('himer_users', userId, { referral_code: code });
  return code;
}

async function applyReferral(newUserId, referralCode) {
  if (!referralCode) return { ok: false, reason: 'no_code' };
  const referrer = (await dbList('himer_users', { where: { referral_code: referralCode } }))[0];
  if (!referrer) return { ok: false, reason: 'invalid_code' };
  if (referrer.id === newUserId) return { ok: false, reason: 'self_referral' };

  const newUser = await dbGet('himer_users', newUserId);
  if (!newUser) return { ok: false, reason: 'user_not_found' };
  if (newUser.referred_by) return { ok: false, reason: 'already_referred' };

  // Link new user to referrer
  await dbUpdate('himer_users', newUserId, {
    referred_by: referrer.id,
    referral_bonus_until: new Date(Date.now() + REFERRAL_BONUS_MONTHS * 30 * 86400000).toISOString(),
    withdrawable: parseFloat(newUser.withdrawable || 0) + SIGNUP_BONUS,
    total_earnings: parseFloat(newUser.total_earnings || 0) + SIGNUP_BONUS,
  });

  // Reward referrer
  const newReferralCount = (referrer.total_referrals || 0) + 1;
  await dbUpdate('himer_users', referrer.id, {
    total_referrals: newReferralCount,
    withdrawable: parseFloat(referrer.withdrawable || 0) + REFERRER_SIGNUP_BONUS,
    total_earnings: parseFloat(referrer.total_earnings || 0) + REFERRER_SIGNUP_BONUS,
    earning_boost: getMilestoneBoost(newReferralCount),
  });

  // Log it
  try {
    await dbInsert('himer_referrals', {
      referrer_id: referrer.id,
      referred_id: newUserId,
      code: referralCode,
      signup_bonus: SIGNUP_BONUS,
      referrer_bonus: REFERRER_SIGNUP_BONUS,
      created_at: new Date().toISOString(),
    });
  } catch (_) {}

  // Push notification to referrer
  try {
    const { notifyUser } = require('./push');
    await notifyUser(referrer.id, {
      title: '🎉 New referral joined HIMER!',
      body: `You earned $${REFERRER_SIGNUP_BONUS.toFixed(2)} bonus. Total referrals: ${newReferralCount}`,
      tag: 'himer-referral',
      url: '/',
    });
  } catch (_) {}

  return {
    ok: true,
    referrerId: referrer.id,
    signupBonus: SIGNUP_BONUS,
    referrerNewCount: newReferralCount,
    referrerBoost: getMilestoneBoost(newReferralCount),
  };
}

function getMilestoneBoost(referralCount) {
  let boost = 1.0;
  for (const tier of MILESTONE_TIERS) {
    if (referralCount >= tier.referrals) boost = tier.boost;
  }
  return boost;
}

function getMilestoneInfo(referralCount) {
  let current = MILESTONE_TIERS[0];
  let next = null;
  for (let i = 0; i < MILESTONE_TIERS.length; i++) {
    if (referralCount >= MILESTONE_TIERS[i].referrals) {
      current = MILESTONE_TIERS[i];
      next = MILESTONE_TIERS[i + 1] || null;
    }
  }
  return {
    current,
    next,
    referralCount,
    progressToNext: next ? Math.min(100, ((referralCount - current.referrals) / (next.referrals - current.referrals)) * 100) : 100,
  };
}

// Pay referrer their cut when an invitee earns (called from compute crediting)
async function distributeReferralBonus(inviteeUserId, inviteeEarnings) {
  try {
    const invitee = await dbGet('himer_users', inviteeUserId);
    if (!invitee || !invitee.referred_by) return;
    // Check bonus window still active
    if (invitee.referral_bonus_until && new Date(invitee.referral_bonus_until) < new Date()) return;
    const referrer = await dbGet('himer_users', invitee.referred_by);
    if (!referrer) return;
    const bonus = inviteeEarnings * REFERRAL_BONUS_PCT;
    if (bonus <= 0) return;
    await dbUpdate('himer_users', referrer.id, {
      withdrawable: parseFloat(referrer.withdrawable || 0) + bonus,
      total_earnings: parseFloat(referrer.total_earnings || 0) + bonus,
      referral_earnings: parseFloat(referrer.referral_earnings || 0) + bonus,
    });
  } catch (e) { /* non-fatal */ }
}

async function getReferralStats(userId) {
  const user = await dbGet('himer_users', userId);
  if (!user) return null;
  const code = await ensureReferralCode(userId);
  const referralCount = user.total_referrals || 0;
  const milestone = getMilestoneInfo(referralCount);

  // List people they referred
  const referred = await dbList('himer_users', { where: { referred_by: userId } });

  return {
    code,
    referralCount,
    referralEarnings: parseFloat(user.referral_earnings || 0),
    earningBoost: getMilestoneBoost(referralCount),
    milestone,
    allTiers: MILESTONE_TIERS,
    referredUsers: referred.map(r => ({
      id: r.id,
      joinedAt: r.created_at,
      earnings: parseFloat(r.total_earnings || 0),
      active: !!r.is_active,
    })),
    bonusPct: REFERRAL_BONUS_PCT * 100,
    bonusMonths: REFERRAL_BONUS_MONTHS,
  };
}

async function getLeaderboard(limit = 20) {
  const users = await dbList('himer_users', { orderBy: 'total_referrals', desc: true, limit: limit * 2 });
  return users
    .filter(u => (u.total_referrals || 0) > 0)
    .slice(0, limit)
    .map((u, i) => ({
      rank: i + 1,
      userId: u.id ? (u.id.slice(0, 4) + '****' + u.id.slice(-4)) : '—',
      referrals: u.total_referrals || 0,
      boost: getMilestoneBoost(u.total_referrals || 0),
      tier: getMilestoneInfo(u.total_referrals || 0).current.name,
    }));
}

module.exports = {
  ensureReferralCode,
  applyReferral,
  distributeReferralBonus,
  getReferralStats,
  getLeaderboard,
  getMilestoneBoost,
  getMilestoneInfo,
  REFERRAL_BONUS_PCT,
  MILESTONE_TIERS,
};
