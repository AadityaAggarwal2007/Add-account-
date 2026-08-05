-- =============================================================
-- META ADS ERP — COMPLETE VPS POSTGRESQL SCHEMA
-- Run this file after creating the meta_ads database on VPS.
-- Includes all 16 tables, indexes, and triggers.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- Fast ILIKE searches

-- 1. META ACCOUNTS
CREATE TABLE IF NOT EXISTS meta_accounts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meta_account_id   TEXT NOT NULL UNIQUE,
    name              TEXT NOT NULL,
    currency          TEXT DEFAULT 'USD',
    timezone          TEXT,
    status            TEXT DEFAULT 'active',
    is_active         BOOLEAN DEFAULT true,
    access_token      TEXT,
    token_expires_at  TIMESTAMPTZ,
    last_synced_at    TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT now(),
    updated_at        TIMESTAMPTZ DEFAULT now()
);

-- 2. SYSTEM SETTINGS
CREATE TABLE IF NOT EXISTS system_settings (
    key    TEXT PRIMARY KEY,
    value  JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO system_settings (key, value) VALUES
    ('usd_to_inr_rate', '{"rate": 84.5, "last_updated": "2026-04-02"}'),
    ('automation_enabled', '{"enabled": true}'),
    ('default_currency', '{"currency": "USD"}')
ON CONFLICT (key) DO NOTHING;

-- 3. CAMPAIGNS
CREATE TABLE IF NOT EXISTS campaigns (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meta_account_id     UUID NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
    external_id         TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'UNKNOWN',
    objective           TEXT,
    daily_budget        NUMERIC(15,2),
    lifetime_budget     NUMERIC(15,2),
    buying_type         TEXT,
    start_date          DATE,
    end_date            DATE,
    raw_data            JSONB,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- 4. AD SETS
CREATE TABLE IF NOT EXISTS ad_sets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id         UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    external_id         TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'UNKNOWN',
    daily_budget        NUMERIC(15,2),
    lifetime_budget     NUMERIC(15,2),
    targeting_summary   TEXT,
    optimization_goal   TEXT,
    bid_strategy        TEXT,
    raw_data            JSONB,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- 5. ADS
CREATE TABLE IF NOT EXISTS ads (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ad_set_id           UUID NOT NULL REFERENCES ad_sets(id) ON DELETE CASCADE,
    campaign_id         UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    external_id         TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'UNKNOWN',
    creative_type       TEXT,
    preview_url         TEXT,
    thumbnail_url       TEXT,
    raw_data            JSONB,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- 6. METRICS (with generated computed columns)
CREATE TABLE IF NOT EXISTS metrics (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type         TEXT NOT NULL CHECK (entity_type IN ('campaign', 'ad_set', 'ad')),
    campaign_id         UUID REFERENCES campaigns(id) ON DELETE CASCADE,
    ad_set_id           UUID REFERENCES ad_sets(id) ON DELETE CASCADE,
    ad_id               UUID REFERENCES ads(id) ON DELETE CASCADE,
    date                DATE NOT NULL,
    impressions         BIGINT DEFAULT 0,
    clicks              BIGINT DEFAULT 0,
    spend               NUMERIC(15,2) DEFAULT 0,
    conversions         NUMERIC(15,2) DEFAULT 0,
    conversion_value    NUMERIC(15,2) DEFAULT 0,
    reach               BIGINT,
    frequency           NUMERIC(10,4),
    video_views         BIGINT,
    link_clicks         BIGINT,
    cpc                 NUMERIC(10,4) GENERATED ALWAYS AS (
                            CASE WHEN clicks > 0 THEN spend / clicks ELSE NULL END
                        ) STORED,
    ctr                 NUMERIC(10,6) GENERATED ALWAYS AS (
                            CASE WHEN impressions > 0 THEN (clicks::NUMERIC / impressions) * 100 ELSE NULL END
                        ) STORED,
    cpm                 NUMERIC(10,4) GENERATED ALWAYS AS (
                            CASE WHEN impressions > 0 THEN (spend / impressions) * 1000 ELSE NULL END
                        ) STORED,
    roas                NUMERIC(10,4) GENERATED ALWAYS AS (
                            CASE WHEN spend > 0 THEN conversion_value / spend ELSE NULL END
                        ) STORED,
    raw_data            JSONB,
    synced_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metrics_date ON metrics(date DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_campaign_date ON metrics(campaign_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_entity_date ON metrics(entity_type, date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_unique_entity_date
    ON metrics(entity_type, date,
        COALESCE(campaign_id, '00000000-0000-0000-0000-000000000000'::UUID),
        COALESCE(ad_set_id, '00000000-0000-0000-0000-000000000000'::UUID),
        COALESCE(ad_id, '00000000-0000-0000-0000-000000000000'::UUID));

-- 7. AUTOMATION RULES
CREATE TABLE IF NOT EXISTS automation_rules (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  TEXT NOT NULL,
    description           TEXT,
    is_active             BOOLEAN DEFAULT true,
    scope                 TEXT NOT NULL CHECK (scope IN ('campaign', 'ad_set', 'ad')),
    target_ids            UUID[],
    target_account_ids    UUID[],
    target_external_ids   TEXT[],
    conditions            JSONB NOT NULL,
    action_type           TEXT NOT NULL CHECK (action_type IN (
                              'pause_campaign', 'enable_campaign',
                              'increase_budget', 'decrease_budget', 'set_budget',
                              'send_alert',
                              'auto_pause_resume', 'kill_switch',
                              'pause_ad', 'enable_ad',
                              'pause_ad_set', 'enable_ad_set')),
    action_params         JSONB,
    cooldown_minutes      INT DEFAULT 15,
    max_triggers_per_day  INT DEFAULT 50,
    min_spend_threshold   NUMERIC(10,2) DEFAULT 1.00,
    requires_approval     BOOLEAN DEFAULT false,
    dry_run               BOOLEAN DEFAULT false,
    last_triggered_at     TIMESTAMPTZ,
    trigger_count         INT DEFAULT 0,
    created_at            TIMESTAMPTZ DEFAULT now(),
    updated_at            TIMESTAMPTZ DEFAULT now()
);

-- 8. AUTOMATION LOGS
CREATE TABLE IF NOT EXISTS automation_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id             UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    rule_name           TEXT NOT NULL,
    entity_type         TEXT NOT NULL,
    entity_id           UUID,
    entity_external_id  TEXT NOT NULL,
    entity_name         TEXT,
    action_type         TEXT NOT NULL,
    action_params       JSONB,
    condition_snapshot  JSONB NOT NULL,
    status              TEXT NOT NULL CHECK (status IN (
                            'executed', 'failed', 'skipped_cooldown',
                            'skipped_max_triggers', 'pending_approval',
                            'dry_run', 'manually_overridden',
                            'skipped_min_spend')),
    error_message       TEXT,
    api_response        JSONB,
    previous_value      JSONB,
    is_reversed         BOOLEAN DEFAULT false,
    reversed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auto_logs_rule ON automation_logs(rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_logs_status ON automation_logs(status, created_at DESC);

-- 9. NOTIFICATIONS
CREATE TABLE IF NOT EXISTS notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type        TEXT NOT NULL CHECK (type IN (
                    'automation_fired', 'automation_failed',
                    'sync_failed', 'budget_alert',
                    'performance_alert', 'system')),
    title       TEXT NOT NULL,
    message     TEXT NOT NULL,
    severity    TEXT DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
    is_read     BOOLEAN DEFAULT false,
    metadata    JSONB,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(is_read, created_at DESC);

-- 10. SYNC STATUS
CREATE TABLE IF NOT EXISTS sync_status (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meta_account_id     UUID NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
    sync_type           TEXT NOT NULL CHECK (sync_type IN ('campaigns', 'metrics', 'full')),
    status              TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'partial')),
    records_processed   INT DEFAULT 0,
    error_message       TEXT,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    duration_ms         INT
);

-- 11. USERS (role-based access)
CREATE TABLE IF NOT EXISTS users (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username          TEXT NOT NULL UNIQUE,
    display_name      TEXT,
    password_hash     TEXT NOT NULL,
    password_salt     TEXT NOT NULL,
    role              TEXT NOT NULL DEFAULT 'viewer'
                      CHECK (role IN ('admin', 'developer', 'viewer')),
    is_active         BOOLEAN DEFAULT true,
    last_login_at     TIMESTAMPTZ,
    created_by        UUID REFERENCES users(id),
    created_at        TIMESTAMPTZ DEFAULT now(),
    updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active, role);

-- 12. AUTOMATION PAUSED ADS
CREATE TABLE IF NOT EXISTS automation_paused_ads (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ad_external_id    TEXT NOT NULL,
    ad_name           TEXT,
    rule_id           UUID REFERENCES automation_rules(id) ON DELETE CASCADE,
    rule_name         TEXT,
    reason            TEXT,
    metric_snapshot   JSONB DEFAULT '{}',
    paused_at         TIMESTAMPTZ DEFAULT now(),
    resumed_at        TIMESTAMPTZ,
    is_paused         BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_auto_paused_active ON automation_paused_ads(ad_external_id, is_paused);
CREATE INDEX IF NOT EXISTS idx_auto_paused_rule ON automation_paused_ads(rule_id, is_paused);

-- 13. BLOCKED ACCOUNTS (comments moderation)
CREATE TABLE IF NOT EXISTS blocked_accounts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id     TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    user_name   TEXT DEFAULT 'Unknown',
    reason      TEXT DEFAULT 'Spam/Fake comment',
    blocked_at  TIMESTAMPTZ DEFAULT now(),
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_unique ON blocked_accounts(page_id, user_id);
CREATE INDEX IF NOT EXISTS idx_blocked_page ON blocked_accounts(page_id);

-- 14. SPAM COMMENTS LOG
CREATE TABLE IF NOT EXISTS spam_comments_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comment_id      TEXT NOT NULL,
    post_id         TEXT,
    user_id         TEXT,
    user_name       TEXT,
    message         TEXT,
    spam_score      INT DEFAULT 0,
    matched_keywords TEXT[],
    action_taken    TEXT NOT NULL CHECK (action_taken IN ('deleted', 'hidden', 'blocked')),
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spam_log_date ON spam_comments_log(created_at DESC);

-- 15. PAGE TOKENS (for comment moderation across all pages)
CREATE TABLE IF NOT EXISTS page_tokens (
    id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    page_id               TEXT NOT NULL UNIQUE,
    page_name             TEXT,
    page_access_token     TEXT NOT NULL,
    instagram_account_id  TEXT,
    updated_at            TIMESTAMPTZ DEFAULT now(),
    created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_page_tokens_page_id ON page_tokens(page_id);
CREATE INDEX IF NOT EXISTS idx_page_tokens_ig_account ON page_tokens(instagram_account_id)
    WHERE instagram_account_id IS NOT NULL;

-- 16. AUTO-UPDATE updated_at TRIGGER
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER meta_accounts_updated_at
  BEFORE UPDATE ON meta_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER campaigns_updated_at
  BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER ad_sets_updated_at
  BEFORE UPDATE ON ad_sets FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER ads_updated_at
  BEFORE UPDATE ON ads FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER automation_rules_updated_at
  BEFORE UPDATE ON automation_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================================
-- DONE — 16 tables, all indexes, all triggers
-- =============================================================
