-- ============================================================
-- HIMER Neural Grid v5 - Schema (additive, safe to re-run)
-- Existing v4 tables are kept; v5 adds new tables and columns
-- ============================================================

-- v4 base (kept, idempotent)
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
  tier TEXT DEFAULT 'standard',
  boost_multiplier NUMERIC(5,2) DEFAULT 1.0,
  notifications_enabled BOOLEAN DEFAULT true,
  preferred_language TEXT DEFAULT 'en',
  device_count INTEGER DEFAULT 0,
  last_login_ip TEXT,
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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
  ram_gb NUMERIC(10,2) DEFAULT 0,
  bandwidth_mbps NUMERIC(10,2) DEFAULT 0,
  trust_score INTEGER DEFAULT 100,
  contracts_completed INTEGER DEFAULT 0,
  total_earnings NUMERIC(18,8) DEFAULT 0,
  uptime_seconds BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_heartbeat TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS himer_payouts (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  amount_gross NUMERIC(18,8),
  fee NUMERIC(18,8),
  amount_net NUMERIC(18,8),
  method TEXT,
  crypto_address TEXT,
  crypto_network TEXT,
  tx_hash TEXT,
  bank_iban TEXT,
  bank_holder TEXT,
  status TEXT DEFAULT 'PENDING_REVIEW',
  admin_notes TEXT,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS himer_notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  type TEXT NOT NULL,
  title_key TEXT,
  message_key TEXT,
  metadata JSONB,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS himer_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT,
  actor_type TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- v5 ADDITIONS — Run these on existing v4 DB safely
-- ============================================================

-- User extra columns
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS lifetime_earnings NUMERIC(18,8) DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS lifetime_compute_gflops_sec NUMERIC(18,2) DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS lifetime_active_seconds BIGINT DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS crypto_address TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS crypto_network TEXT DEFAULT 'polygon';
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS bank_iban TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS bank_holder_name TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS bank_country TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS kyc_status TEXT DEFAULT 'none';
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT false;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS referred_by TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS total_referrals INTEGER DEFAULT 0;

-- Device capacity tracking
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS cpu_cores INTEGER DEFAULT 1;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS cpu_gflops_max NUMERIC(10,2) DEFAULT 0;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS ram_gb_total NUMERIC(10,2) DEFAULT 0;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS bandwidth_mbps_max NUMERIC(10,2) DEFAULT 0;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS contribution_cpu_pct INTEGER DEFAULT 50;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS contribution_ram_pct INTEGER DEFAULT 30;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS contribution_bw_pct INTEGER DEFAULT 20;

-- Daily earnings history (for graphs)
CREATE TABLE IF NOT EXISTS himer_earnings_daily (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  date DATE NOT NULL,
  gflops_seconds NUMERIC(18,2) DEFAULT 0,
  ram_gb_hours NUMERIC(18,4) DEFAULT 0,
  bw_gb_transferred NUMERIC(18,4) DEFAULT 0,
  contracts_count INTEGER DEFAULT 0,
  gross_earnings NUMERIC(18,8) DEFAULT 0,
  net_earnings NUMERIC(18,8) DEFAULT 0,
  active_seconds INTEGER DEFAULT 0,
  UNIQUE(user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_earnings_user_date ON himer_earnings_daily(user_id, date DESC);

-- Business clients
CREATE TABLE IF NOT EXISTS himer_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  company TEXT,
  country TEXT,
  api_key_hash TEXT NOT NULL UNIQUE,
  api_key_prefix TEXT NOT NULL,
  plan TEXT DEFAULT 'free',
  plan_started_at TIMESTAMPTZ DEFAULT NOW(),
  plan_renews_at TIMESTAMPTZ,
  monthly_gflops_quota NUMERIC(18,2) DEFAULT 10000,
  monthly_gflops_used NUMERIC(18,2) DEFAULT 0,
  monthly_resets_at TIMESTAMPTZ,
  balance_credits NUMERIC(18,4) DEFAULT 0,
  balance_owed NUMERIC(18,4) DEFAULT 0,
  total_paid NUMERIC(18,4) DEFAULT 0,
  total_jobs_submitted INTEGER DEFAULT 0,
  is_owner BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  suspended_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_request_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_clients_email ON himer_clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_api_hash ON himer_clients(api_key_hash);

-- Compute jobs (from clients OR owner)
CREATE TABLE IF NOT EXISTS himer_jobs (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  is_owner_job BOOLEAN DEFAULT false,
  job_type TEXT DEFAULT 'compute',
  job_name TEXT,
  input_data JSONB,
  status TEXT DEFAULT 'PENDING',
  required_gflops_seconds NUMERIC(18,2) NOT NULL,
  required_ram_gb NUMERIC(10,2) DEFAULT 1,
  required_bw_mbps NUMERIC(10,2) DEFAULT 1,
  node_ids JSONB,
  actual_gflops_seconds NUMERIC(18,2) DEFAULT 0,
  cost_total NUMERIC(18,4) DEFAULT 0,
  cost_to_users NUMERIC(18,4) DEFAULT 0,
  cost_platform_fee NUMERIC(18,4) DEFAULT 0,
  result_data JSONB,
  result_hash TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jobs_client ON himer_jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON himer_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON himer_jobs(is_owner_job);

-- Invoices for business clients
CREATE TABLE IF NOT EXISTS himer_invoices (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  invoice_number TEXT UNIQUE,
  period_start DATE,
  period_end DATE,
  jobs_count INTEGER DEFAULT 0,
  gflops_seconds_total NUMERIC(18,2) DEFAULT 0,
  subtotal NUMERIC(18,4),
  tax NUMERIC(18,4) DEFAULT 0,
  total NUMERIC(18,4),
  status TEXT DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  payment_tx_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  due_at TIMESTAMPTZ
);

-- Premium subscriptions (when implemented)
CREATE TABLE IF NOT EXISTS himer_premium_subs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  amount_eur NUMERIC(10,2),
  payment_method TEXT,
  payment_ref TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

-- Platform revenue ledger
CREATE TABLE IF NOT EXISTS himer_revenue_ledger (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  amount NUMERIC(18,4) NOT NULL,
  currency TEXT DEFAULT 'USD',
  client_id TEXT,
  user_id TEXT,
  job_id TEXT,
  reference TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revenue_source ON himer_revenue_ledger(source);
CREATE INDEX IF NOT EXISTS idx_revenue_date ON himer_revenue_ledger(created_at DESC);

-- Platform expenses ledger (track infrastructure costs)
CREATE TABLE IF NOT EXISTS himer_expenses_ledger (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  description TEXT,
  amount NUMERIC(18,4) NOT NULL,
  currency TEXT DEFAULT 'USD',
  recurring BOOLEAN DEFAULT false,
  paid_at DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- v5: ALTER himer_clients to add new columns (idempotent)
-- v4 may already have this table — only add what's missing
-- ============================================================
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS api_key_hash TEXT;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS api_key_prefix TEXT;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free';
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS plan_started_at TIMESTAMPTZ;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS plan_renews_at TIMESTAMPTZ;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS monthly_gflops_quota NUMERIC(18,2) DEFAULT 10000;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS monthly_gflops_used NUMERIC(18,2) DEFAULT 0;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS monthly_resets_at TIMESTAMPTZ;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS balance_credits NUMERIC(18,4) DEFAULT 0;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS balance_owed NUMERIC(18,4) DEFAULT 0;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS total_paid NUMERIC(18,4) DEFAULT 0;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS total_jobs_submitted INTEGER DEFAULT 0;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT false;
ALTER TABLE himer_clients ADD COLUMN IF NOT EXISTS last_request_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_clients_api_hash_v5 ON himer_clients(api_key_hash);

-- ============================================================
-- v5: Platform settings (contacts editable from admin)
-- ============================================================
CREATE TABLE IF NOT EXISTS himer_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default contact settings (safe, only inserts if missing)
INSERT INTO himer_settings (key, value) VALUES
  ('contact_email', 'himer.nodes@gmail.com'),
  ('contact_phone', ''),
  ('contact_support_email', 'himer.nodes@gmail.com'),
  ('contact_telegram', ''),
  ('contact_address', ''),
  ('company_name', 'HIMER Network')
ON CONFLICT (key) DO NOTHING;

-- API key signup requests (when users request via public form)
CREATE TABLE IF NOT EXISTS himer_signup_requests (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  company TEXT,
  plan TEXT,
  status TEXT DEFAULT 'pending',
  api_key_issued TEXT,
  client_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_signup_status ON himer_signup_requests(status);

-- ============================================================
-- v5.1: Referral system
-- ============================================================
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS referral_earnings NUMERIC(18,8) DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS referral_bonus_until TIMESTAMPTZ;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS earning_boost NUMERIC(6,3) DEFAULT 1.0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT false;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS premium_plan TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS lifetime_earnings NUMERIC(18,8) DEFAULT 0;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS lifetime_compute_gflops_sec NUMERIC(20,4) DEFAULT 0;

CREATE TABLE IF NOT EXISTS himer_referrals (
  id BIGSERIAL PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  referred_id TEXT NOT NULL,
  code TEXT,
  signup_bonus NUMERIC(10,4) DEFAULT 0,
  referrer_bonus NUMERIC(10,4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ref_referrer ON himer_referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_ref_referred ON himer_referrals(referred_id);

-- ============================================================
-- v5.2: Monetization (ads, affiliate)
-- ============================================================
CREATE TABLE IF NOT EXISTS himer_ad_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  slot TEXT,
  advertiser TEXT,
  type TEXT,
  revenue_usd NUMERIC(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_user ON himer_ad_events(user_id);
CREATE INDEX IF NOT EXISTS idx_ad_created ON himer_ad_events(created_at);

CREATE TABLE IF NOT EXISTS himer_affiliate_clicks (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  affiliate_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE himer_premium_subs ADD COLUMN IF NOT EXISTS plan TEXT;
ALTER TABLE himer_premium_subs ADD COLUMN IF NOT EXISTS amount_usd NUMERIC(10,4);
ALTER TABLE himer_premium_subs ADD COLUMN IF NOT EXISTS payment_ref TEXT;
ALTER TABLE himer_premium_subs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE himer_premium_subs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

-- ============================================================
-- v5.3: Push Notifications (Web Push API)
-- ============================================================
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
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- ============================================================
-- v5.4: Real geolocation for nodes
-- ============================================================
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS country_code TEXT;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS lat NUMERIC(10,6);
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS lng NUMERIC(10,6);
ALTER TABLE himer_user_devices ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE himer_nodes ADD COLUMN IF NOT EXISTS lat NUMERIC(10,6);
ALTER TABLE himer_nodes ADD COLUMN IF NOT EXISTS lng NUMERIC(10,6);

-- ============================================================
-- v5.5: Payout details (wallet + bank)
-- ============================================================
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS payout_wallet TEXT;
ALTER TABLE himer_users ADD COLUMN IF NOT EXISTS payout_bank JSONB;
