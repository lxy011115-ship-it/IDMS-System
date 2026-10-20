// Migration 5 adds this relation without altering prior migration DDL/checksums.
// Reuse the existing managed-data trigger function and its execution policy.
export const registryHistorySchema=`CREATE TABLE registry_history (
 tenant_id text NOT NULL,revision bigint NOT NULL CHECK(revision>0),observed_at timestamptz NOT NULL,
 writer_id text NOT NULL CHECK(length(writer_id) BETWEEN 1 AND 100),
 configuration_hash text NOT NULL CHECK(configuration_hash ~ '^[a-f0-9]{64}$'),
 previous_hash text NOT NULL,hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object' AND body->>'tenantId'=tenant_id AND body->>'format'='1'),
 PRIMARY KEY(tenant_id,revision),UNIQUE(tenant_id,hash)
);
CREATE INDEX registry_history_observed ON registry_history(tenant_id,observed_at,revision);
CREATE TRIGGER immutable_managed_data BEFORE UPDATE OR DELETE OR TRUNCATE ON registry_history
 FOR EACH STATEMENT EXECUTE FUNCTION reject_managed_data_mutation();`;
export const registryHistoryPrivileges={registry_history:['SELECT','INSERT']};
export const reportEventsSchema=`CREATE TABLE analysis_report_events (
 tenant_id text NOT NULL,report_id uuid NOT NULL,revision integer NOT NULL CHECK(revision BETWEEN 1 AND 3),
 action text NOT NULL CHECK(action IN ('GENERATED','SUBMITTED','APPROVED','RETURNED','REJECTED')),
 occurred_at timestamptz NOT NULL,actor_type text NOT NULL CHECK(actor_type='USER'),actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 300),
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 600),request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
 payload jsonb,previous_hash text NOT NULL,hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
 CHECK((action='GENERATED' AND revision=1 AND payload IS NOT NULL) OR (action<>'GENERATED' AND revision>1 AND payload IS NULL)),
 PRIMARY KEY(tenant_id,report_id,revision),UNIQUE(tenant_id,request_key),UNIQUE(tenant_id,report_id,hash)
);
CREATE INDEX analysis_report_device ON analysis_report_events(tenant_id,(metadata->>'deviceCode'),occurred_at,report_id) WHERE action='GENERATED';
CREATE TRIGGER immutable_managed_data BEFORE UPDATE OR DELETE OR TRUNCATE ON analysis_report_events
 FOR EACH STATEMENT EXECUTE FUNCTION reject_managed_data_mutation();`;
export const reportEventPrivileges={analysis_report_events:['SELECT','INSERT']};
