CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE IF NOT EXISTS telemetry (tenant_id text NOT NULL, device_id text NOT NULL, tag_code text NOT NULL, event_time timestamptz NOT NULL, value_double double precision, value_text text, unit text, quality text NOT NULL DEFAULT 'GOOD', source text NOT NULL, sequence_no bigint, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, device_id, tag_code, event_time));
SELECT create_hypertable('telemetry','event_time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS telemetry_lookup_idx ON telemetry(tenant_id, device_id, tag_code, event_time DESC);
ALTER TABLE telemetry SET (timescaledb.compress, timescaledb.compress_segmentby = 'tenant_id,device_id,tag_code');
SELECT add_retention_policy('telemetry', INTERVAL '365 days', if_not_exists => TRUE);
