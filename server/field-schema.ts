import {fieldSha256,fieldHash} from '../integrations/field-profile.ts';
import {fieldSchemaContract} from './field-schema-contract.ts';
import {stable} from '../integrations/telemetry.ts';
export const fieldStorageVersion='field-channel-data-1.0.0' as const;
export const fieldIntakeVersion='approved-capture-and-current-field-intake-1.0.0' as const;
export const fieldTablePrivileges={migrations:['SELECT'],points:['SELECT','INSERT'],receipts:['SELECT','INSERT']} as const;
export const fieldSchemaDDL=`
CREATE TABLE idms_field.migrations (
 version integer NOT NULL,tenant_id text NOT NULL,checksum text NOT NULL,base_checksum text NOT NULL,
 owner_role text NOT NULL,app_role text NOT NULL,backup_role text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT field_migrations_pk PRIMARY KEY(version),
 CONSTRAINT field_migrations_version CHECK(version=1),
 CONSTRAINT field_migrations_hash CHECK(checksum ~ '^[a-f0-9]{64}$' AND base_checksum ~ '^[a-f0-9]{64}$')
);
CREATE TABLE idms_field.points (
 tenant_id text NOT NULL,id uuid NOT NULL,edge_id text NOT NULL,stream_id text NOT NULL,sequence_no bigint NOT NULL,
 read_id uuid NOT NULL,tag_code text NOT NULL,audit_event_id uuid NOT NULL,body jsonb NOT NULL,
 device_code text GENERATED ALWAYS AS (body->'source'->>'deviceCode') STORED NOT NULL,
 event_time text GENERATED ALWAYS AS (body->'sample'->>'eventTime') STORED NOT NULL,
 received_at text GENERATED ALWAYS AS (body->>'receivedAt') STORED NOT NULL,
 CONSTRAINT field_points_pk PRIMARY KEY(tenant_id,id),
 CONSTRAINT field_points_sequence UNIQUE(tenant_id,edge_id,stream_id,sequence_no),
 CONSTRAINT field_points_read UNIQUE(tenant_id,edge_id,stream_id,read_id,tag_code),
 CONSTRAINT field_points_audit UNIQUE(tenant_id,audit_event_id),
 CONSTRAINT field_points_audit_fk FOREIGN KEY(audit_event_id) REFERENCES public.audit_ledger(event_id) DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT field_points_sequence_range CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
 CONSTRAINT field_points_stream CHECK(stream_id ~ '^[a-f0-9]{64}$'),
 CONSTRAINT field_points_body CHECK((jsonb_typeof(body)='object' AND octet_length(body::text)<=65536 AND body->>'format'='idms-field-point-v1' AND body->>'id'=id::text AND body->'source'->>'tenantId'=tenant_id AND body->'source'->>'edgeId'=edge_id AND body->>'streamId'=stream_id AND body->>'sequenceNo'=sequence_no::text AND body->>'readId'=read_id::text AND body->'sample'->>'tagCode'=tag_code AND body->>'auditEventId'=audit_event_id::text) IS TRUE)
);
CREATE INDEX field_points_device_time ON idms_field.points(tenant_id,device_code,event_time,id);
CREATE TABLE idms_field.receipts (
 tenant_id text NOT NULL,edge_id text NOT NULL,event_id uuid NOT NULL,digest text NOT NULL,stream_id text NOT NULL,
 sequence_no bigint NOT NULL,read_id uuid NOT NULL,tag_code text NOT NULL,status text NOT NULL,reason text,point_id uuid,
 audit_event_id uuid NOT NULL,received_at text NOT NULL,body jsonb NOT NULL,
 CONSTRAINT field_receipts_pk PRIMARY KEY(tenant_id,edge_id,event_id,digest),
 CONSTRAINT field_receipts_audit UNIQUE(tenant_id,audit_event_id),
 CONSTRAINT field_receipts_point_fk FOREIGN KEY(tenant_id,point_id) REFERENCES idms_field.points(tenant_id,id),
 CONSTRAINT field_receipts_audit_fk FOREIGN KEY(audit_event_id) REFERENCES public.audit_ledger(event_id) DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT field_receipts_sequence_range CHECK(sequence_no BETWEEN 1 AND 9007199254740991),
 CONSTRAINT field_receipts_hash CHECK(digest ~ '^[a-f0-9]{64}$' AND stream_id ~ '^[a-f0-9]{64}$'),
 CONSTRAINT field_receipts_status CHECK(((status='STORED' AND reason IS NULL AND point_id=event_id) OR (status='REJECTED' AND reason IS NOT NULL AND point_id IS NULL)) IS TRUE),
 CONSTRAINT field_receipts_body CHECK((body ? 'reason' AND body ? 'pointId' AND jsonb_typeof(body)='object' AND octet_length(body::text)<=65536 AND body->>'format'='idms-field-receipt-v1' AND body->>'tenantId'=tenant_id AND body->>'edgeId'=edge_id AND body->>'eventId'=event_id::text AND body->>'eventDigest'=digest AND body->>'streamId'=stream_id AND body->>'sequenceNo'=sequence_no::text AND body->>'readId'=read_id::text AND body->>'status'=status AND (body->>'reason') IS NOT DISTINCT FROM reason AND (body->>'pointId') IS NOT DISTINCT FROM point_id::text AND body->>'auditEventId'=audit_event_id::text AND body->>'receivedAt'=received_at) IS TRUE)
);
CREATE INDEX field_receipts_event ON idms_field.receipts(tenant_id,event_id);
CREATE UNIQUE INDEX field_receipts_stored_sequence ON idms_field.receipts(tenant_id,edge_id,stream_id,sequence_no) WHERE status='STORED';
CREATE UNIQUE INDEX field_receipts_stored_read ON idms_field.receipts(tenant_id,edge_id,stream_id,read_id,tag_code) WHERE status='STORED';
CREATE TRIGGER immutable_field_data BEFORE UPDATE OR DELETE OR TRUNCATE ON idms_field.migrations FOR EACH STATEMENT EXECUTE FUNCTION public.reject_managed_data_mutation();
CREATE TRIGGER immutable_field_data BEFORE UPDATE OR DELETE OR TRUNCATE ON idms_field.points FOR EACH STATEMENT EXECUTE FUNCTION public.reject_managed_data_mutation();
CREATE TRIGGER immutable_field_data BEFORE UPDATE OR DELETE OR TRUNCATE ON idms_field.receipts FOR EACH STATEMENT EXECUTE FUNCTION public.reject_managed_data_mutation();
`;
export function fieldModuleChecksum(baseChecksum:string){return fieldSha256(stable({version:1,fieldStorageVersion,fieldIntakeVersion,baseChecksum:fieldHash(baseChecksum),schema:fieldSchemaDDL,catalog:fieldSchemaContract,privileges:fieldTablePrivileges,policy:'separate-schema-append-only-same-parent-transaction-v1'}));}
