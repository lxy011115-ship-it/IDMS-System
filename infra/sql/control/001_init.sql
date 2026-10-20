CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS tenants (id text PRIMARY KEY, name text NOT NULL, plan text NOT NULL, status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS template_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL REFERENCES tenants(id), template_key text NOT NULL, version text NOT NULL, status text NOT NULL, manifest jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id, template_key, version));
CREATE TABLE IF NOT EXISTS audit_events (event_id uuid PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), object_type text NOT NULL, object_id text NOT NULL, action text NOT NULL, actor_type text NOT NULL, actor_id text NOT NULL, correlation_id text NOT NULL, business_time timestamptz NOT NULL, before_json jsonb, after_json jsonb, metadata jsonb NOT NULL DEFAULT '{}', previous_hash text NOT NULL, hash text NOT NULL, UNIQUE(tenant_id, hash));
CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx ON audit_events(tenant_id, business_time DESC);
CREATE TABLE IF NOT EXISTS idempotency_keys (tenant_id text NOT NULL REFERENCES tenants(id), key text NOT NULL, method text NOT NULL, path text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,key,method,path));
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_tenant_policy ON audit_events USING (tenant_id = current_setting('app.tenant_id', true));
