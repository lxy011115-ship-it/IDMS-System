// Each collection has its own relation. JSONB holds versioned domain extensions;
// generated columns are indexed query/identity fields, never a second editable copy.
export const entityTables={tenants:'business_tenants',devices:'business_devices',alarms:'business_alarms',approvals:'business_approvals',templates:'business_templates',plugins:'business_plugins',healthSnapshots:'business_health_snapshots',predictiveAlerts:'business_predictive_alerts',maintenanceRecommendations:'business_maintenance_recommendations',predictiveModels:'business_predictive_models',workOrders:'business_work_orders'} as const;
export const entitySchema=Object.entries(entityTables).map(([collection,table])=>`CREATE TABLE ${table} (
 tenant_id text NOT NULL,id text NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>0),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 entity_version text GENERATED ALWAYS AS (body->>'version') STORED,
 lifecycle text GENERATED ALWAYS AS (COALESCE(body->>'state',body->>'status')) STORED,
 CHECK(body->>'id'=id AND ${collection==='tenants'?"body->>'id'=tenant_id":"body->>'tenantId'=tenant_id"}),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,ordinal)
); CREATE INDEX ${table}_lifecycle ON ${table}(tenant_id,lifecycle,ordinal);`).join('\n')+`
CREATE UNIQUE INDEX business_template_versions ON business_templates(tenant_id,(body->>'templateKey'),(body->>'version'));
CREATE UNIQUE INDEX business_device_codes ON business_devices(tenant_id,(body->>'code'));
CREATE INDEX business_work_orders_assignee ON business_work_orders(tenant_id,(body->>'assignee'),lifecycle);
CREATE INDEX business_alert_devices ON business_predictive_alerts(tenant_id,(body->>'deviceCode'),lifecycle);
CREATE TABLE business_state (
 tenant_id text PRIMARY KEY,revision bigint NOT NULL CHECK(revision>0),schema_version integer NOT NULL CHECK(schema_version=3),
 payload_digest text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business_import_batches (
 tenant_id text NOT NULL,batch_id uuid NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>0),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 data_type text GENERATED ALWAYS AS (body->>'dataType') STORED,
 status text GENERATED ALWAYS AS (body->>'status') STORED,
 version integer GENERATED ALWAYS AS ((body->>'version')::integer) STORED,
 CHECK(body->>'batchId'=batch_id::text AND body->>'tenantId'=tenant_id),
 PRIMARY KEY(tenant_id,batch_id),UNIQUE(tenant_id,ordinal)
);
CREATE INDEX business_import_batch_status ON business_import_batches(tenant_id,status,ordinal DESC);
CREATE TABLE business_import_files (
 tenant_id text NOT NULL,batch_id uuid NOT NULL,sha256 text NOT NULL,content bytea NOT NULL,
 PRIMARY KEY(tenant_id,batch_id),FOREIGN KEY(tenant_id,batch_id) REFERENCES business_import_batches(tenant_id,batch_id)
);
CREATE TABLE business_import_input_rows (
 tenant_id text NOT NULL,batch_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal>0),
 valid_ordinal integer CHECK(valid_ordinal>0),body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 PRIMARY KEY(tenant_id,batch_id,ordinal),UNIQUE(tenant_id,batch_id,valid_ordinal),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES business_import_batches(tenant_id,batch_id)
);
CREATE TABLE business_import_requests (
 tenant_id text NOT NULL,request_key text NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>0),digest text NOT NULL,batch_id uuid NOT NULL,
 CHECK(request_key LIKE tenant_id||':%'),PRIMARY KEY(tenant_id,request_key),UNIQUE(tenant_id,ordinal),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES business_import_batches(tenant_id,batch_id)
);
CREATE TABLE business_command_receipts (
 tenant_id text NOT NULL,request_key text NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>0),body jsonb NOT NULL,
 CHECK(request_key LIKE tenant_id||':%'),PRIMARY KEY(tenant_id,request_key),UNIQUE(tenant_id,ordinal)
);`;
export const entityPrivileges:Record<string,string[]>={
 ...Object.fromEntries(Object.values(entityTables).map(t=>[t,['SELECT','INSERT','UPDATE']])),
 business_state:['SELECT','UPDATE'],business_import_batches:['SELECT','INSERT','UPDATE'],
 business_import_files:['SELECT','INSERT'],business_import_input_rows:['SELECT','INSERT'],
 business_import_requests:['SELECT','INSERT'],business_command_receipts:['SELECT','INSERT'],migration_snapshot_v2:['SELECT']
};
export const immutableEntityTables=['migration_snapshot_v2','business_import_files','business_import_input_rows','business_import_requests','business_command_receipts'];
const aggregate=(table:string,expression:string,order='ordinal')=>`COALESCE((SELECT jsonb_agg(${expression} ORDER BY ${order}) FROM ${table} WHERE tenant_id=s.tenant_id),'[]'::jsonb)`;
// Read-only compatibility envelope; there is no write-through rule or INSTEAD OF trigger.
// All JSON arrays are computed from authoritative entity/record/file/receipt relations.
export const runtimeViewSchema=`CREATE VIEW runtime_state AS SELECT DISTINCT true AS singleton,s.revision,2 AS schema_version,
 jsonb_build_object('business',jsonb_build_object(${Object.entries(entityTables).map(([key,table])=>`'${key}',${aggregate(table,'body')}`).join(',')}),
 'imports',jsonb_build_object('batches',COALESCE((SELECT jsonb_agg(b.body||jsonb_build_object(
 'originalBase64',replace(encode(f.content,'base64'),E'\\n',''),
 'rows',COALESCE((SELECT jsonb_agg(r.body ORDER BY r.ordinal) FROM business_import_input_rows r WHERE r.tenant_id=b.tenant_id AND r.batch_id=b.batch_id),'[]'::jsonb),
 'validRows',COALESCE((SELECT jsonb_agg(r.body ORDER BY r.valid_ordinal) FROM business_import_input_rows r WHERE r.tenant_id=b.tenant_id AND r.batch_id=b.batch_id AND r.valid_ordinal IS NOT NULL),'[]'::jsonb)) ORDER BY b.ordinal)
 FROM business_import_batches b JOIN business_import_files f ON f.tenant_id=b.tenant_id AND f.batch_id=b.batch_id WHERE b.tenant_id=s.tenant_id),'[]'::jsonb),
 'records',${aggregate('managed_import_rows',"jsonb_build_object('tenantId',tenant_id,'dataType',data_type,'batchId',batch_id,'row',source_row,'sourceSystem',source_system,'value',body)")},
 'requests',${aggregate('business_import_requests',"jsonb_build_object('key',request_key,'digest',digest,'batchId',batch_id)")}),
 'audits',${aggregate('audit_ledger','event','sequence_no')},
 'idempotency',${aggregate('business_command_receipts','jsonb_build_array(request_key,body)')}) AS payload,s.updated_at
 FROM business_state s`;
