-- ============================================================
-- HIMER Neural Grid - Supabase Schema v4
-- ============================================================
-- Run this ONCE in Supabase SQL Editor.
-- All tables use 'himer_' prefix to avoid mixing with other projects.
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- USERS (real users contributing compute)
-- ============================================================
CREATE TABLE IF NOT EXISTS himer_users (
    id TEXT PRIMARY KEY,                    -- e.g., 'U-A1B2C3D4E5F6'
    email TEXT UNIQUE,                      -- optional, for payouts/notifications
    password_hash TEXT,                     -- optional, only if user enables password login
    
    -- Wallet
    total_earnings NUMERIC(20, 8) DEFAULT 0 NOT NULL,
    withdrawable NUMERIC(20, 8) DEFAULT 0 NOT NULL,
    
    -- Payout configuration
    payout_setup BOOLEAN DEFAULT FALSE NOT NULL,
    payout_method TEXT,                     -- 'bank', 'stripe', etc.
    stripe_account_id TEXT,
    payout_verified BOOLEAN DEFAULT FALSE NOT NULL,
    
    -- Settings
    tier TEXT DEFAULT 'standard' NOT NULL,  -- standard, premium
    boost_multiplier NUMERIC(5, 2) DEFAULT 1.0 NOT NULL,
    notifications_enabled BOOLEAN DEFAULT TRUE NOT NULL,
    preferred_language TEXT DEFAULT 'en' NOT NULL,
    
    -- Multi-device support
    device_count INTEGER DEFAULT 0 NOT NULL,
    last_login_ip TEXT,
    last_login_country TEXT,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_active_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_himer_users_email ON himer_users(email);
CREATE INDEX IF NOT EXISTS idx_himer_users_last_active ON himer_users(last_active_at DESC);

-- ============================================================
-- USER DEVICES (multi-device login tracking)
-- ============================================================
-- Each device a user connects with becomes a separate node.
-- Devices are identified by user_id + device_fingerprint (browser/OS hash).
CREATE TABLE IF NOT EXISTS himer_user_devices (
    id TEXT PRIMARY KEY,                    -- e.g., 'D-A1B2C3D4'
    user_id TEXT NOT NULL REFERENCES himer_users(id) ON DELETE CASCADE,
    device_fingerprint TEXT NOT NULL,       -- hash of user-agent + screen + timezone
    device_name TEXT,                       -- 'Desktop Chrome', 'iPhone Safari', etc.
    
    -- Connection info
    ip_address TEXT,
    country TEXT,
    city TEXT,
    user_agent TEXT,
    
    -- Status
    is_online BOOLEAN DEFAULT FALSE NOT NULL,
    
    -- Node link (each device gets its own node)
    node_id TEXT,                           -- references himer_nodes(id)
    
    -- Metadata
    first_seen_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_seen_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    UNIQUE (user_id, device_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_himer_devices_user ON himer_user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_himer_devices_online ON himer_user_devices(user_id, is_online);

-- ============================================================
-- NODES (real nodes only; seed nodes stay in RAM)
-- ============================================================
CREATE TABLE IF NOT EXISTS himer_nodes (
    id TEXT PRIMARY KEY,                    -- e.g., 'HR-A1B2C3D4' (HR = HIMER Real)
    user_id TEXT NOT NULL REFERENCES himer_users(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES himer_user_devices(id) ON DELETE SET NULL,
    
    -- Location
    region TEXT NOT NULL,
    lat NUMERIC(10, 6),
    lng NUMERIC(10, 6),
    
    -- Performance
    gflops NUMERIC(10, 2) DEFAULT 4 NOT NULL,
    boost_multiplier NUMERIC(5, 2) DEFAULT 1.0 NOT NULL,
    trust_score INTEGER DEFAULT 100 NOT NULL CHECK (trust_score >= 0 AND trust_score <= 100),
    
    -- Earnings & stats
    total_earnings NUMERIC(20, 8) DEFAULT 0 NOT NULL,
    gflop_seconds_processed BIGINT DEFAULT 0 NOT NULL,
    contracts_completed INTEGER DEFAULT 0 NOT NULL,
    uptime_seconds BIGINT DEFAULT 0 NOT NULL,
    
    -- Status (current state, frequently updated)
    status TEXT DEFAULT 'IDLE' NOT NULL,    -- IDLE, READY, COMPUTING, OFFLINE
    current_load INTEGER DEFAULT 0 NOT NULL,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_seen_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_himer_nodes_user ON himer_nodes(user_id);
CREATE INDEX IF NOT EXISTS idx_himer_nodes_status ON himer_nodes(status);
CREATE INDEX IF NOT EXISTS idx_himer_nodes_region ON himer_nodes(region);

-- ============================================================
-- PAYOUTS (withdraw requests with admin approval flow)
-- ============================================================
CREATE TABLE IF NOT EXISTS himer_payouts (
    id TEXT PRIMARY KEY,                    -- e.g., 'PO-A1B2C3D4'
    user_id TEXT NOT NULL REFERENCES himer_users(id) ON DELETE CASCADE,
    
    -- Amounts
    gross_amount NUMERIC(20, 8) NOT NULL,
    fee NUMERIC(20, 8) NOT NULL,
    net_amount NUMERIC(20, 8) NOT NULL,
    
    -- Status flow: PENDING_REVIEW -> APPROVED -> PAID
    --              PENDING_REVIEW -> REJECTED
    status TEXT DEFAULT 'PENDING_REVIEW' NOT NULL,
    rejection_reason TEXT,
    
    -- Admin actions
    approved_by_admin_id TEXT,              -- references himer_admins(id)
    approved_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    stripe_transfer_id TEXT,
    
    -- Metadata
    requested_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    user_ip TEXT,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_himer_payouts_user ON himer_payouts(user_id);
CREATE INDEX IF NOT EXISTS idx_himer_payouts_status ON himer_payouts(status);
CREATE INDEX IF NOT EXISTS idx_himer_payouts_requested ON himer_payouts(requested_at DESC);

-- ============================================================
-- ADMINS (admin users with password rotation)
-- ============================================================
CREATE TABLE IF NOT EXISTS himer_admins (
    id TEXT PRIMARY KEY,                    -- e.g., 'A-A1B2C3'
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,            -- bcrypt hash
    
    -- Password rotation policy
    must_change_password BOOLEAN DEFAULT TRUE NOT NULL,  -- TRUE on first login
    password_last_changed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    password_expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '3 months') NOT NULL,
    
    -- Role
    role TEXT DEFAULT 'admin' NOT NULL,     -- admin, super_admin
    
    -- Session
    last_login_at TIMESTAMPTZ,
    last_login_ip TEXT,
    failed_login_attempts INTEGER DEFAULT 0 NOT NULL,
    locked_until TIMESTAMPTZ,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_himer_admins_email ON himer_admins(email);

-- ============================================================
-- CLIENTS (business clients who pay for compute)
-- ============================================================
CREATE TABLE IF NOT EXISTS himer_clients (
    id TEXT PRIMARY KEY,                    -- e.g., 'C-A1B2C3D4'
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    company TEXT,
    
    -- API
    api_key TEXT UNIQUE NOT NULL,           -- e.g., 'hmr_live_xxx'
    api_key_created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    -- Financial
    balance NUMERIC(20, 8) DEFAULT 0 NOT NULL,
    total_spent NUMERIC(20, 8) DEFAULT 0 NOT NULL,
    total_topped_up NUMERIC(20, 8) DEFAULT 0 NOT NULL,
    
    -- Limits & status
    rate_limit_per_minute INTEGER DEFAULT 60 NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    suspended_reason TEXT,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    created_by_admin_id TEXT,
    last_login_at TIMESTAMPTZ,
    must_change_password BOOLEAN DEFAULT TRUE NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_himer_clients_email ON himer_clients(email);
CREATE INDEX IF NOT EXISTS idx_himer_clients_api_key ON himer_clients(api_key);

-- ============================================================
-- JOBS (audit log)
-- ============================================================
CREATE TABLE IF NOT EXISTS himer_jobs (
    id TEXT PRIMARY KEY,                    -- e.g., 'J-A1B2C3D4'
    client_id TEXT REFERENCES himer_clients(id) ON DELETE SET NULL,
    job_type TEXT NOT NULL,                 -- 'ai-training', 'rendering', 'compute'
    
    -- Resources
    nodes_needed INTEGER NOT NULL,
    nodes_assigned JSONB,                   -- array of node IDs
    real_nodes_count INTEGER DEFAULT 0,
    seed_nodes_count INTEGER DEFAULT 0,
    
    -- Financial
    cost NUMERIC(20, 8) NOT NULL,
    
    -- Status
    status TEXT DEFAULT 'PENDING' NOT NULL, -- PENDING, RUNNING, DONE, FAILED
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    
    -- Metadata
    payload JSONB
);
CREATE INDEX IF NOT EXISTS idx_himer_jobs_client ON himer_jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_himer_jobs_status ON himer_jobs(status);
CREATE INDEX IF NOT EXISTS idx_himer_jobs_created ON himer_jobs(created_at DESC);

-- ============================================================
-- NOTIFICATIONS (persisted notifications per user)
-- ============================================================
CREATE TABLE IF NOT EXISTS himer_notifications (
    id TEXT PRIMARY KEY,                    -- e.g., 'N-A1B2C3'
    user_id TEXT NOT NULL REFERENCES himer_users(id) ON DELETE CASCADE,
    
    type TEXT NOT NULL,                     -- contract_signed, contract_completed, payment, system
    title_key TEXT NOT NULL,                -- i18n key
    message_key TEXT NOT NULL,              -- i18n key
    meta JSONB,                             -- extra data (jobId, amount, etc.)
    
    is_read BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_himer_notifications_user ON himer_notifications(user_id, is_read, created_at DESC);

-- ============================================================
-- TREASURY (ledger of all money in/out)
-- ============================================================
CREATE TABLE IF NOT EXISTS himer_treasury_ledger (
    id TEXT PRIMARY KEY DEFAULT 'TX-' || REPLACE(uuid_generate_v4()::TEXT, '-', '')::TEXT,
    
    type TEXT NOT NULL,                     -- 'client_payment', 'payout', 'fee', 'refund'
    direction TEXT NOT NULL,                -- 'in', 'out'
    amount NUMERIC(20, 8) NOT NULL,
    
    -- References
    client_id TEXT REFERENCES himer_clients(id) ON DELETE SET NULL,
    user_id TEXT REFERENCES himer_users(id) ON DELETE SET NULL,
    payout_id TEXT REFERENCES himer_payouts(id) ON DELETE SET NULL,
    job_id TEXT REFERENCES himer_jobs(id) ON DELETE SET NULL,
    
    -- Balance after this transaction
    balance_after NUMERIC(20, 8),
    
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_himer_treasury_type ON himer_treasury_ledger(type);
CREATE INDEX IF NOT EXISTS idx_himer_treasury_created ON himer_treasury_ledger(created_at DESC);

-- ============================================================
-- ADMIN AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS himer_admin_audit (
    id TEXT PRIMARY KEY DEFAULT 'AU-' || REPLACE(uuid_generate_v4()::TEXT, '-', '')::TEXT,
    admin_id TEXT NOT NULL REFERENCES himer_admins(id) ON DELETE CASCADE,
    action TEXT NOT NULL,                   -- 'payout_approved', 'client_created', etc.
    target_type TEXT,                       -- 'payout', 'client', 'user'
    target_id TEXT,
    ip_address TEXT,
    meta JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_himer_audit_admin ON himer_admin_audit(admin_id, created_at DESC);

-- ============================================================
-- AUTO-UPDATE updated_at TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION himer_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS himer_users_updated_at ON himer_users;
CREATE TRIGGER himer_users_updated_at
    BEFORE UPDATE ON himer_users
    FOR EACH ROW EXECUTE FUNCTION himer_update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — disabled by default
-- We use service_role key, so RLS is bypassed.
-- Enable later if you want public anon access with policies.
-- ============================================================
-- ALTER TABLE himer_users ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE himer_payouts ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- DONE
-- ============================================================
-- After running this, set in your Render env vars:
--   SUPABASE_URL = https://yourproject.supabase.co
--   SUPABASE_SERVICE_ROLE_KEY = (Settings > API > service_role secret)
--   INITIAL_ADMIN_EMAIL = constantin.pipera84@gmail.com
--   INITIAL_ADMIN_PASSWORD = 12345678
--   JWT_SECRET = (any long random string)
--
-- The first time the backend starts, it will create the admin row.
-- First login on /admin will force password change.
