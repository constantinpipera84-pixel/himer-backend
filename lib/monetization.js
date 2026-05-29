/**
 * HIMER v5 — Monetization Module
 *
 * Three streams of platform revenue independent of compute jobs:
 *   1. Premium subscriptions (boost, instant payouts, ad-free)
 *   2. Ad placements (AdSense / Coinzilla / native)
 *   3. Affiliate referrals (crypto exchanges, VPN, hardware)
 *
 * All revenue lands in himer_revenue_ledger so the admin can see real numbers.
 */
const { dbInsert, dbUpdate, dbGet, dbList } = require('./db');

const PREMIUM_PLANS = {
  premium_monthly: {
    name: 'Premium Monthly',
    price_usd: 4.99,
    duration_days: 30,
    perks: ['1.3x earnings boost', 'Instant payouts (no min)', 'Ad-free', 'Priority support', 'Advanced analytics'],
  },
  premium_yearly: {
    name: 'Premium Yearly',
    price_usd: 49.99,
    duration_days: 365,
    perks: ['1.5x earnings boost', 'Instant payouts (no min)', 'Ad-free', 'Priority support', 'Advanced analytics', '2 months free'],
  },
};

// Affiliate links (you replace these with your real referral URLs)
const AFFILIATE_LINKS = [
  { id: 'binance', name: 'Binance', desc: 'Buy crypto, get $100 bonus', url: 'https://binance.com/?ref=YOURREF', payout_per_signup: 20, category: 'crypto' },
  { id: 'coinbase', name: 'Coinbase', desc: 'Easy crypto for beginners', url: 'https://coinbase.com/join/YOURREF', payout_per_signup: 10, category: 'crypto' },
  { id: 'nordvpn', name: 'NordVPN', desc: 'Stay private, 70% off', url: 'https://go.nordvpn.net/aff_c?offer_id=YOUR', payout_per_signup: 15, category: 'security' },
  { id: 'hetzner', name: 'Hetzner Cloud', desc: 'Cheap VPS, €20 credit', url: 'https://hetzner.cloud/?ref=YOUR', payout_per_signup: 20, category: 'cloud' },
];

// ============================================================
// PREMIUM
// ============================================================
async function purchasePremium(userId, planKey, paymentRef) {
  const plan = PREMIUM_PLANS[planKey];
  if (!plan) return { ok: false, error: 'Invalid plan' };
  const user = await dbGet('himer_users', userId);
  if (!user) return { ok: false, error: 'User not found' };

  const now = new Date();
  // Extend if already premium
  const currentUntil = user.premium_until ? new Date(user.premium_until) : now;
  const baseDate = currentUntil > now ? currentUntil : now;
  const until = new Date(baseDate.getTime() + plan.duration_days * 86400000);

  const boost = planKey === 'premium_yearly' ? 1.5 : 1.3;

  await dbUpdate('himer_users', userId, {
    is_premium: true,
    premium_plan: planKey,
    premium_until: until.toISOString(),
    earning_boost: Math.max(parseFloat(user.earning_boost || 1.0), boost),
  });

  // Record subscription
  await dbInsert('himer_premium_subs', {
    user_id: userId,
    plan: planKey,
    amount_usd: plan.price_usd,
    payment_ref: paymentRef || null,
    started_at: now.toISOString(),
    expires_at: until.toISOString(),
    status: 'active',
  });

  // Platform revenue
  await dbInsert('himer_revenue_ledger', {
    source: 'premium_subscription',
    amount: plan.price_usd,
    currency: 'USD',
    user_id: userId,
    reference: `${planKey} ${paymentRef || ''}`.trim(),
    created_at: now.toISOString(),
  });

  return { ok: true, plan: planKey, until: until.toISOString(), boost };
}

async function checkPremiumExpiry(userId) {
  const user = await dbGet('himer_users', userId);
  if (!user || !user.is_premium) return false;
  if (user.premium_until && new Date(user.premium_until) < new Date()) {
    // Expired — downgrade
    await dbUpdate('himer_users', userId, {
      is_premium: false,
      premium_plan: null,
      earning_boost: 1.0, // reset (referral boost recomputed separately)
    });
    return false;
  }
  return true;
}

function getPremiumPlans() {
  return Object.entries(PREMIUM_PLANS).map(([key, p]) => ({ key, ...p }));
}

// ============================================================
// AD TRACKING
// ============================================================
async function trackAdImpression(userId, slot, advertiser = 'house') {
  try {
    await dbInsert('himer_ad_events', {
      user_id: userId || null,
      slot,
      advertiser,
      type: 'impression',
      revenue_usd: 0.002, // ~$2 CPM = $0.002 per impression
      created_at: new Date().toISOString(),
    });
    await dbInsert('himer_revenue_ledger', {
      source: 'ad_impression',
      amount: 0.002,
      currency: 'USD',
      user_id: userId,
      reference: `${slot}/${advertiser}`,
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* non-fatal */ }
}

async function trackAdClick(userId, slot, advertiser = 'house') {
  try {
    await dbInsert('himer_ad_events', {
      user_id: userId || null,
      slot,
      advertiser,
      type: 'click',
      revenue_usd: 0.40, // typical CPC for crypto/tech
      created_at: new Date().toISOString(),
    });
    await dbInsert('himer_revenue_ledger', {
      source: 'ad_click',
      amount: 0.40,
      currency: 'USD',
      user_id: userId,
      reference: `${slot}/${advertiser}`,
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* non-fatal */ }
}

// ============================================================
// AFFILIATE
// ============================================================
function getAffiliateLinks(category = null) {
  return category ? AFFILIATE_LINKS.filter(l => l.category === category) : AFFILIATE_LINKS;
}

async function trackAffiliateClick(userId, affiliateId) {
  try {
    await dbInsert('himer_affiliate_clicks', {
      user_id: userId || null,
      affiliate_id: affiliateId,
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* non-fatal */ }
}

// Called manually by admin when an affiliate platform pays out
async function recordAffiliateRevenue(affiliateId, amount, reference) {
  await dbInsert('himer_revenue_ledger', {
    source: 'affiliate',
    amount,
    currency: 'USD',
    reference: `${affiliateId}: ${reference || ''}`.trim(),
    created_at: new Date().toISOString(),
  });
}

// ============================================================
// REVENUE SUMMARY (for admin)
// ============================================================
async function getRevenueBreakdown(sinceISO) {
  try {
    const rows = await dbList('himer_revenue_ledger', {});
    const filtered = sinceISO ? rows.filter(r => r.created_at && r.created_at >= sinceISO) : rows;
    const bySource = {};
    let total = 0;
    for (const r of filtered) {
      const amt = parseFloat(r.amount || 0);
      bySource[r.source] = (bySource[r.source] || 0) + amt;
      total += amt;
    }
    return { total, bySource, count: filtered.length };
  } catch (_) { return { total: 0, bySource: {}, count: 0 }; }
}

module.exports = {
  PREMIUM_PLANS,
  AFFILIATE_LINKS,
  purchasePremium,
  checkPremiumExpiry,
  getPremiumPlans,
  trackAdImpression,
  trackAdClick,
  getAffiliateLinks,
  trackAffiliateClick,
  recordAffiliateRevenue,
  getRevenueBreakdown,
};
