import {projectionSchema,projectionTables} from './data-projection.ts';
import {digest,canonical} from './imports.ts';
import {entitySchema,runtimeViewSchema,entityPrivileges,immutableEntityTables} from './entity-schema.ts';
import {revisionProjectionSchema} from './revision-projection.ts';
import {workerClaimSchema} from './outbox-schema.ts';
import {registryHistorySchema,registryHistoryPrivileges,reportEventsSchema,reportEventPrivileges} from './registry-history-schema.ts';

export const businessSchema=`
CREATE TABLE IF NOT EXISTS runtime_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision bigint NOT NULL,
 schema_version integer NOT NULL CHECK(schema_version=2), payload jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_ledger (
 sequence_no bigserial PRIMARY KEY, event_id uuid UNIQUE NOT NULL, tenant_id text NOT NULL,
 hash text NOT NULL, previous_hash text NOT NULL, event jsonb NOT NULL
);
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit ledger is append-only'; END $$;
DROP TRIGGER IF EXISTS immutable_audit ON audit_ledger;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_ledger
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
CREATE TABLE IF NOT EXISTS work_orders (
 id uuid PRIMARY KEY, tenant_id text NOT NULL, alert_id text NOT NULL UNIQUE,
 state text NOT NULL, version integer NOT NULL, body jsonb NOT NULL
);`;

export const workflowSchema=`CREATE TABLE IF NOT EXISTS workflow_outbox (
 command_id uuid PRIMARY KEY,entity_id uuid NOT NULL,request_digest text NOT NULL,envelope jsonb NOT NULL,
 proposed jsonb NOT NULL,before_digest text NOT NULL,context jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('PENDING','SYNCED','HUMAN_REVIEW')),
 attempts integer NOT NULL DEFAULT 0,next_attempt timestamptz NOT NULL DEFAULT now(),last_error text,
 response jsonb,created_at timestamptz NOT NULL DEFAULT now(),synced_at timestamptz
); CREATE UNIQUE INDEX IF NOT EXISTS workflow_one_pending ON workflow_outbox(entity_id) WHERE status IN ('PENDING','HUMAN_REVIEW');`;

export const aiSchema=`CREATE TABLE IF NOT EXISTS ai_review_outbox (
 request_id uuid PRIMARY KEY,batch_id uuid UNIQUE NOT NULL,request_digest text NOT NULL,envelope jsonb NOT NULL,
 expected_version integer NOT NULL,context jsonb NOT NULL,status text NOT NULL CHECK(status IN ('PENDING','DONE','HUMAN_REVIEW')),
 attempts integer NOT NULL DEFAULT 0,next_attempt timestamptz NOT NULL DEFAULT now(),response jsonb,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz
);`;

export const telemetrySchema=`
CREATE TABLE IF NOT EXISTS telemetry_points (
 id uuid PRIMARY KEY,tenant_id text NOT NULL,edge_id text NOT NULL,device_code text NOT NULL,
 tag_code text NOT NULL,node_id text NOT NULL,map_version text NOT NULL,origin text NOT NULL CHECK(origin IN ('SIMULATOR','FIELD')),
 sequence_no bigint NOT NULL,event_time timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),
 value double precision,unit text NOT NULL,quality text NOT NULL CHECK(quality IN ('GOOD','BAD','UNCERTAIN')),
 input_digest text NOT NULL,UNIQUE(edge_id,device_code,tag_code,event_time)
);
CREATE INDEX IF NOT EXISTS telemetry_latest ON telemetry_points(tenant_id,edge_id,tag_code,event_time DESC);
CREATE TABLE IF NOT EXISTS telemetry_receipts (
 edge_id text NOT NULL,event_id text NOT NULL,digest text NOT NULL,sequence_no bigint,
 status text NOT NULL CHECK(status IN ('STORED','REJECTED')),reason text,point_id uuid REFERENCES telemetry_points(id),
 envelope jsonb NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(edge_id,event_id,digest)
);
CREATE INDEX IF NOT EXISTS telemetry_event_ids ON telemetry_receipts(edge_id,event_id);
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_sequence ON telemetry_receipts(edge_id,sequence_no) WHERE status='STORED';`;

export const migrationTableSchema=`CREATE TABLE idms_schema_migrations (
 version integer PRIMARY KEY, tenant_id text NOT NULL, checksum text NOT NULL,
 modules jsonb NOT NULL, owner_role text NOT NULL, app_role text NOT NULL, backup_role text NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT now()
);`;
export const revisionTablePrivileges:Record<string,string[]>={
 runtime_state:['SELECT','UPDATE'],audit_ledger:['SELECT','INSERT'],work_orders:['SELECT','INSERT','UPDATE'],
 managed_projection_state:['SELECT','UPDATE'],managed_record_revisions:['SELECT','INSERT'],
 ...Object.fromEntries(projectionTables.map(t=>[t,['SELECT','INSERT']])),
 workflow_outbox:['SELECT','INSERT','UPDATE'],ai_review_outbox:['SELECT','INSERT','UPDATE'],
 telemetry_points:['SELECT','INSERT'],telemetry_receipts:['SELECT','INSERT'],idms_schema_migrations:['SELECT']
};
export const tablePrivileges:Record<string,string[]>={...revisionTablePrivileges,...entityPrivileges,runtime_state:['SELECT']};
// Keep tablePrivileges frozen as migration-3 checksum input. Current runtime
// policy is additive and is hashed only in migration 5.
export const runtimeTablePrivileges:Record<string,string[]>={...tablePrivileges,...registryHistoryPrivileges,...reportEventPrivileges};
export const baseTables=Object.keys(tablePrivileges).filter(t=>!t.startsWith('telemetry_'));
export function moduleTables(telemetry:boolean){return [...baseTables,'registry_history','analysis_report_events',...(telemetry?['telemetry_points','telemetry_receipts']:[])].sort();}
export const migrationVersion=5;
export function legacyMigrationChecksum(telemetry:boolean){const {managed_record_revisions,...legacyPrivileges}=revisionTablePrivileges;return digest(canonical({version:1,businessSchema,projectionSchema,workflowSchema,aiSchema,telemetrySchema:telemetry?telemetrySchema:null,migrationTableSchema,tablePrivileges:legacyPrivileges,projectionAlgorithm:'approved-projection-v1',policy:'separate-roles-v1'}));}
export function revisionMigrationChecksum(telemetry:boolean){return digest(canonical({version:2,previous:legacyMigrationChecksum(telemetry),revisionProjectionSchema,tablePrivileges:revisionTablePrivileges,projectionAlgorithm:'approved-corrections-v1'}));}
export function normalizedMigrationChecksum(telemetry:boolean){return digest(canonical({version:3,previous:revisionMigrationChecksum(telemetry),entitySchema,runtimeViewSchema,tablePrivileges,immutableEntityTables,policy:'normalized-entities-v1'}));}
export function migrationChecksum(telemetry:boolean){return digest(canonical({version:4,previous:normalizedMigrationChecksum(telemetry),workerClaimSchema,policy:'leased-fenced-outbox-v1'}));}
export function latestMigrationChecksum(telemetry:boolean){return digest(canonical({version:5,previous:migrationChecksum(telemetry),registryHistorySchema,reportEventsSchema,tablePrivileges:runtimeTablePrivileges,policy:'registry-and-frozen-report-events-v1'}));}
export function migrationHistoryValid(rows:Record<string,any>[],a:{telemetry:boolean;ownerRole:string;user:string;backupRole:string},tenantId:string,maximum:number|boolean=migrationVersion){
  const count=maximum===true?1:maximum===false?migrationVersion:maximum;
  return rows.length===count&&rows.every((r,i)=>r.version===i+1&&r.tenant_id===tenantId&&r.checksum===(r.version===1?legacyMigrationChecksum(a.telemetry):r.version===2?revisionMigrationChecksum(a.telemetry):r.version===3?normalizedMigrationChecksum(a.telemetry):r.version===4?migrationChecksum(a.telemetry):r.version===5?latestMigrationChecksum(a.telemetry):null)&&canonical(r.modules)===canonical(r.version===5?(a.telemetry?['core','telemetry','analysis']:['core','analysis']):a.telemetry?['core','telemetry']:['core'])&&r.owner_role===a.ownerRole&&r.app_role===a.user&&r.backup_role===a.backupRole);
}
export const quoteIdentifier=(value:string)=>'"'+value.replaceAll('"','""')+'"';
