-- ╔══════════════════════════════════════════════════════════════╗
-- ║  HIMER Neural Grid v5 — Schema completă (safe re-run)        ║
-- ║                                                              ║
-- ║  Toate tabelele: CREATE TABLE IF NOT EXISTS                  ║
-- ║  Toate coloanele noi: ADD COLUMN IF NOT EXISTS               ║
-- ║  Toate indexurile: CREATE INDEX IF NOT EXISTS                ║
-- ║                                                              ║
-- ║  Poți rula acest fișier de oricâte ori — nu afectează datele ║
-- ║  existente. Doar adaugă ce lipsește.                         ║
-- ╚══════════════════════════════════════════════════════════════╝


-- ================================================================
-- 1. CORE: Users
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_users (
  id TEXT PRIMARY KEY,
  email TEXT,
  password_hash TEXT,
  force_password_change BOOLEAN DEFAULT false,
  password_changed_at TIMESTAMPTZ,
  role TEXT DEFAULT 'user',
  total_earnings NUMERIC(18,8) DEFAULT 0,
  withdrawable NUMERIC(18,8) DEFAULT 0,
  payout_setup BOOLEAN DEFAULT false,
  payout_method TEXT,
  payout_verified BOOLEAN DEFAULT false,
  tier TEXT DEFAULT 'standard',
  boost_multiplier NUMERIC(5,2) DEFAULT 1.0,
  notifications_enabled BOOLEAN DEFAULT true,
  preferred_language TEXT DEFAULT 'en',
  device_count INTEGER DEFAULT 0,
  last_login_ip TEXT,
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS lifetime_earnings NUMERIC(18,8) DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS lifetime_compute_gflops_sec NUMERIC(20,4) DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS referred_by TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS referral_count INTEGER DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS referral_earnings NUMERIC(18,8) DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS referral_bonus_until TIMESTAMPTZ;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS earning_boost NUMERIC(5,2) DEFAULT 1.0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT false;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS premium_plan TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS payout_wallet TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS payout_bank JSONB;

CREATE INDEX IF NOT EXISTS idx_users_email ON himer_users(email);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON himer_users(referral_code);


-- ================================================================
-- 2. User Devices (multi-device, multi-factor recognition)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_user_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  device_fingerprint TEXT,
  device_name TEXT,
  ip_address TEXT,
  user_agent TEXT,
  node_id TEXT,
  is_online BOOLEAN DEFAULT true,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS cpu_cores INTEGER DEFAULT 1;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS cpu_gflops_max NUMERIC(10,2) DEFAULT 0;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS ram_gb_total NUMERIC(8,2) DEFAULT 0;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS bandwidth_mbps_max NUMERIC(8,2) DEFAULT 0;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS country_code TEXT;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS lat NUMERIC(10,6);
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS lng NUMERIC(10,6);
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS soft_fingerprint TEXT;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS screen_signature TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_user ON himer_user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_fp ON himer_user_devices(device_fingerprint);
CREATE INDEX IF NOT EXISTS idx_devices_soft_fp ON himer_user_devices(soft_fingerprint);
CREATE INDEX IF NOT EXISTS idx_devices_online ON himer_user_devices(is_online);


-- ================================================================
-- 3. Nodes (compute units)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_nodes (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  device_id TEXT,
  is_real BOOLEAN DEFAULT true,
  region TEXT,
  lat NUMERIC(10,6),
  lng NUMERIC(10,6),
  status TEXT DEFAULT 'IDLE',
  load_pct INTEGER DEFAULT 0,
  gflops NUMERIC(10,2) DEFAULT 0,
  uptime_seconds INTEGER DEFAULT 0,
  trust_score NUMERIC(5,2) DEFAULT 1.0,
  total_earned NUMERIC(18,8) DEFAULT 0,
  last_heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE himer_nodes ADD COLUMN IF NOT EXISTS country TEXT;

CREATE INDEX IF NOT EXISTS idx_nodes_user ON himer_nodes(user_id);
CREATE INDEX IF NOT EXISTS idx_nodes_device ON himer_nodes(device_id);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON himer_nodes(status);


-- ================================================================
-- 4. Business Clients (API keys)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_clients (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  company TEXT,
  api_key_hash TEXT NOT NULL,
  api_key_prefix TEXT,
  plan TEXT DEFAULT 'free',
  monthly_gflops_used NUMERIC(18,4) DEFAULT 0,
  monthly_gflops_limit NUMERIC(18,4) DEFAULT 10000,
  total_spent NUMERIC(18,8) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  is_owner BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_clients_email ON himer_clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_api_key ON himer_clients(api_key_hash);


-- ================================================================
-- 5. Jobs (compute tasks submitted by clients)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_jobs (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  job_type TEXT,
  name TEXT,
  status TEXT DEFAULT 'PENDING',
  required_gflops_seconds NUMERIC(18,4),
  required_ram_gb NUMERIC(8,2),
  input_data JSONB,
  result JSONB,
  estimated_cost_usd NUMERIC(12,4),
  actual_cost_usd NUMERIC(12,4),
  user_payout_total NUMERIC(18,8) DEFAULT 0,
  platform_revenue NUMERIC(18,8) DEFAULT 0,
  is_owner_job BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_client ON himer_jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON himer_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON himer_jobs(created_at DESC);


-- ================================================================
-- 6. Job Chunks (split work)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_job_chunks (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  node_id TEXT,
  user_id TEXT,
  status TEXT DEFAULT 'PENDING',
  payload JSONB,
  result_hash TEXT,
  result JSONB,
  gflops_seconds NUMERIC(12,4),
  user_payout NUMERIC(18,8) DEFAULT 0,
  verification_status TEXT,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chunks_job ON himer_job_chunks(job_id);
CREATE INDEX IF NOT EXISTS idx_chunks_node ON himer_job_chunks(node_id);
CREATE INDEX IF NOT EXISTS idx_chunks_user ON himer_job_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_chunks_status ON himer_job_chunks(status);


-- ================================================================
-- 7. Daily Earnings (per-user, for charts)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_daily_earnings (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  date DATE NOT NULL,
  gflops_seconds NUMERIC(18,4) DEFAULT 0,
  earnings NUMERIC(18,8) DEFAULT 0,
  UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_user ON himer_daily_earnings(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_date ON himer_daily_earnings(date DESC);


-- ================================================================
-- 8. Payouts (withdrawal requests)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_payouts (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  amount_gross NUMERIC(18,8),
  fee NUMERIC(18,8),
  amount_net NUMERIC(18,8),
  method TEXT,
  destination TEXT,
  status TEXT DEFAULT 'PENDING',
  admin_note TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payouts_user ON himer_payouts(user_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON himer_payouts(status);


-- ================================================================
-- 9. Admin Audit Log
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_admin_log (
  id BIGSERIAL PRIMARY KEY,
  admin_email TEXT,
  action TEXT,
  details JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adminlog_created ON himer_admin_log(created_at DESC);


-- ================================================================
-- 10. Notifications (per-user)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  type TEXT,
  title_key TEXT,
  body_key TEXT,
  data JSONB,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON himer_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON himer_notifications(user_id, read_at);


-- ================================================================
-- 11. Settings (admin-editable contacts, etc.)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default contact settings (only if missing)
INSERT INTO himer_settings (key, value) VALUES ('contact_email', 'himer.nodes@gmail.com') ON CONFLICT (key) DO NOTHING;
INSERT INTO himer_settings (key, value) VALUES ('contact_phone', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO himer_settings (key, value) VALUES ('contact_telegram', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO himer_settings (key, value) VALUES ('contact_address', '') ON CONFLICT (key) DO NOTHING;


-- ================================================================
-- 12. Business Signup Requests
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_signup_requests (
  id BIGSERIAL PRIMARY KEY,
  email TEXT,
  name TEXT,
  company TEXT,
  use_case TEXT,
  expected_volume TEXT,
  ip_address TEXT,
  status TEXT DEFAULT 'PENDING',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signup_status ON himer_signup_requests(status);


-- ================================================================
-- 13. Referrals (5% earnings for 12 months)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_referrals (
  id BIGSERIAL PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  referred_id TEXT NOT NULL,
  code TEXT,
  signup_bonus NUMERIC(10,4) DEFAULT 0,
  referrer_bonus NUMERIC(10,4) DEFAULT 0,
  total_paid NUMERIC(18,8) DEFAULT 0,
  active_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referrer_id, referred_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON himer_referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON himer_referrals(referred_id);


-- ================================================================
-- 14. Premium Subscriptions
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_premium_subs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan TEXT,
  amount_usd NUMERIC(10,4),
  payment_ref TEXT,
  expires_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_premium_user ON himer_premium_subs(user_id);
CREATE INDEX IF NOT EXISTS idx_premium_status ON himer_premium_subs(status);


-- ================================================================
-- 15. Ad Events (AdSense tracking)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_ad_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  event_type TEXT,
  revenue NUMERIC(10,6) DEFAULT 0,
  page TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_user ON himer_ad_events(user_id);
CREATE INDEX IF NOT EXISTS idx_ad_created ON himer_ad_events(created_at);


-- ================================================================
-- 16. Affiliate Clicks
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_affiliate_clicks (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  affiliate_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aff_user ON himer_affiliate_clicks(user_id);


-- ================================================================
-- 17. Push Notification Subscriptions (Web Push API)
-- ================================================================

CREATE TABLE IF NOT EXISTS himer_push_subs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT,
  auth TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_user ON himer_push_subs(user_id);




-- ================================================================
-- BETA v7: Loyalty Credits System
-- ================================================================

-- Credits columns on himer_users
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS credits_total BIGINT DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS lifetime_credits BIGINT DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS streak_days INTEGER DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS longest_streak INTEGER DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS last_checkin_date DATE;

CREATE INDEX IF NOT EXISTS idx_users_last_checkin ON himer_users(last_checkin_date);

-- Daily check-ins log (one row per user per day)
CREATE TABLE IF NOT EXISTS himer_daily_checkins (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  date DATE NOT NULL,
  credits_awarded INTEGER DEFAULT 10,
  streak_at_claim INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_checkins_user ON himer_daily_checkins(user_id);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON himer_daily_checkins(date DESC);

-- Ad events (rewarded videos, display impressions)
ALTER TABLE himer_ad_events ADD COLUMN IF NOT EXISTS credits_awarded INTEGER DEFAULT 0;
ALTER TABLE himer_ad_events ADD COLUMN IF NOT EXISTS date DATE;
ALTER TABLE himer_ad_events ADD COLUMN IF NOT EXISTS revenue_estimate NUMERIC(10,6) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ad_events_user_date ON himer_ad_events(user_id, date);


-- ╔══════════════════════════════════════════════════════════════╗
-- ║              SCHEMA APPLIED SUCCESSFULLY                      ║
-- ║                                                              ║
-- ║  Dacă vezi 'Success. No rows returned' = totul e OK.        ║
-- ║  Poți rula acest fișier oricând fără să afectezi date.      ║
-- ╚══════════════════════════════════════════════════════════════╝
