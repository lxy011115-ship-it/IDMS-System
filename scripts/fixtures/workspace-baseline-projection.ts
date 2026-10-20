if(!process.send||!/^(workspaceqa-[a-f0-9]{10}|readqa-[a-f0-9]{10}-[01]|stateqa-[a-f0-9]{10})$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Isolated QA IPC required');
import type pg from 'pg';
import {initializeRevisionProjection,projectRevisionData,verifyRevisionProjection} from '../../server/revision-projection.ts';
import {canonical,digest,type ImportData} from '../../server/imports.ts';

export const projectionSchema=`
CREATE TABLE IF NOT EXISTS managed_projection_state (
 tenant_id text PRIMARY KEY, schema_version integer NOT NULL CHECK(schema_version=1),
 row_count bigint NOT NULL CHECK(row_count>=0), rows_digest text NOT NULL
);
CREATE TABLE IF NOT EXISTS managed_import_rows (
 tenant_id text NOT NULL, ordinal bigint NOT NULL CHECK(ordinal>0), batch_id uuid NOT NULL,
 source_row integer NOT NULL CHECK(source_row>=2), data_type text NOT NULL,
 source_system text NOT NULL, source_record_id text NOT NULL, snapshot_digest text NOT NULL,
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 PRIMARY KEY(tenant_id,ordinal), UNIQUE(tenant_id,batch_id,source_row),
 UNIQUE(tenant_id,data_type,source_system,source_record_id), UNIQUE(tenant_id,ordinal,data_type)
);
CREATE TABLE IF NOT EXISTS managed_assets (
 tenant_id text NOT NULL, device_code text NOT NULL, source_ordinal bigint NOT NULL,
 data_type text NOT NULL DEFAULT 'DEVICE' CHECK(data_type='DEVICE'),
 device_name text NOT NULL, site_code text NOT NULL, line_code text NOT NULL,
 equipment_type text, brand text, model text, serial_number text,
 criticality text CHECK(criticality IN ('LOW','MEDIUM','HIGH','CRITICAL')),
 PRIMARY KEY(tenant_id,device_code), UNIQUE(tenant_id,source_ordinal),
 FOREIGN KEY(tenant_id,source_ordinal,data_type) REFERENCES managed_import_rows(tenant_id,ordinal,data_type)
);
CREATE TABLE IF NOT EXISTS managed_point_definitions (
 tenant_id text NOT NULL, device_code text NOT NULL, tag_code text NOT NULL,
 source_ordinal bigint NOT NULL, data_type text NOT NULL DEFAULT 'POINT_DEFINITION' CHECK(data_type='POINT_DEFINITION'),
 tag_name text NOT NULL, unit text NOT NULL, min_value double precision NOT NULL,
 max_value double precision NOT NULL, expected_interval_seconds integer CHECK(expected_interval_seconds BETWEEN 1 AND 31536000),
 CHECK(min_value>'-Infinity'::float8 AND max_value<'Infinity'::float8 AND min_value<max_value),
 PRIMARY KEY(tenant_id,device_code,tag_code), UNIQUE(tenant_id,source_ordinal),
 FOREIGN KEY(tenant_id,device_code) REFERENCES managed_assets(tenant_id,device_code),
 FOREIGN KEY(tenant_id,source_ordinal,data_type) REFERENCES managed_import_rows(tenant_id,ordinal,data_type)
);
CREATE TABLE IF NOT EXISTS managed_measurements (
 tenant_id text NOT NULL, source_ordinal bigint NOT NULL, device_code text NOT NULL,
 tag_code text NOT NULL, measured_at timestamptz NOT NULL, value double precision NOT NULL,
 unit text NOT NULL, quality text NOT NULL CHECK(quality IN ('GOOD','BAD','UNCERTAIN')),
 data_type text NOT NULL DEFAULT 'MEASUREMENT' CHECK(data_type='MEASUREMENT'),
 CHECK(value>'-Infinity'::float8 AND value<'Infinity'::float8),
 PRIMARY KEY(tenant_id,source_ordinal), UNIQUE(tenant_id,device_code,tag_code,measured_at),
 FOREIGN KEY(tenant_id,device_code) REFERENCES managed_assets(tenant_id,device_code),
 FOREIGN KEY(tenant_id,source_ordinal,data_type) REFERENCES managed_import_rows(tenant_id,ordinal,data_type)
);
CREATE INDEX IF NOT EXISTS managed_assets_scope ON managed_assets(tenant_id,site_code,equipment_type,source_ordinal);
CREATE INDEX IF NOT EXISTS managed_measurements_lookup ON managed_measurements(tenant_id,device_code,tag_code,measured_at DESC,source_ordinal);
CREATE INDEX IF NOT EXISTS managed_measurements_quality ON managed_measurements(tenant_id,quality,measured_at DESC,source_ordinal);
CREATE INDEX IF NOT EXISTS managed_measurements_time ON managed_measurements(tenant_id,measured_at DESC,source_ordinal);
CREATE OR REPLACE FUNCTION reject_managed_data_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'approved managed data is append-only'; END $$;
`;
export const projectionTables=['managed_import_rows','managed_assets','managed_point_definitions','managed_measurements'];
const tables=projectionTables;

function rowsFor(data:ImportData,tenantId:string){return data.records.filter(r=>r.tenantId===tenantId);}
export async function initializeDataProjection(client:pg.PoolClient,data:ImportData,tenantId:string){
  await client.query(projectionSchema);
  for(const table of [...tables,'managed_projection_state'])if((await client.query(`SELECT 1 FROM ${table} WHERE tenant_id<>$1 LIMIT 1`,[tenantId])).rowCount)throw Error('Managed data tables contain foreign tenant rows');
  for(const table of tables){
    await client.query(`DROP TRIGGER IF EXISTS immutable_managed_data ON ${table}; CREATE TRIGGER immutable_managed_data BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_managed_data_mutation()`);
  }
  await initializeRevisionProjection(client,undefined,tenantId);
  const existing=await client.query('SELECT row_count,rows_digest FROM managed_projection_state WHERE tenant_id=$1',[tenantId]);
  if(!existing.rowCount){
    for(const table of tables)if(Number((await client.query(`SELECT count(*) FROM ${table}`)).rows[0].count)!==0)throw Error('Uninitialized managed data tables are not empty');
    await client.query('INSERT INTO managed_projection_state(tenant_id,schema_version,row_count,rows_digest) VALUES($1,1,0,$2)',[tenantId,digest(canonical([]))]);
    await projectApprovedData(client,data,tenantId);
  }
  await projectRevisionData(client,data,tenantId);
  await verifyDataProjection(client,data,tenantId);
}

export async function verifyDataProjection(client:pg.PoolClient,data:ImportData,tenantId:string){
  for(const table of [...tables,'managed_projection_state'])if((await client.query(`SELECT 1 FROM ${table} WHERE tenant_id IS DISTINCT FROM $1 LIMIT 1`,[tenantId])).rowCount)throw Error('Managed data tables contain foreign tenant rows');
  const existing=await client.query('SELECT schema_version,row_count,rows_digest FROM managed_projection_state WHERE tenant_id=$1',[tenantId]);
  if(existing.rowCount){
    const stored=(await client.query('SELECT * FROM managed_import_rows WHERE tenant_id=$1 ORDER BY ordinal',[tenantId])).rows;
    const records=rowsFor(data,tenantId);
    const batches=new Map(data.batches.filter(b=>b.tenantId===tenantId&&b.status==='COMMITTED').map(b=>[b.batchId,b]));
    if(existing.rows[0].schema_version!==1||existing.rows[0].rows_digest!==digest(canonical(records))||Number(existing.rows[0].row_count)!==records.length||stored.length!==records.length||stored.some((row,i)=>Number(row.ordinal)!==i+1||row.source_record_id!==String(records[i]?.value.source_record_id)||row.snapshot_digest!==batches.get(row.batch_id)?.snapshotDigest||canonical({tenantId,dataType:row.data_type,batchId:row.batch_id,row:row.source_row,sourceSystem:row.source_system,value:row.body})!==canonical(records[i])))throw Error('Managed data projection disagrees with approved import history');
  }else throw Error('Managed data migration is not initialized');
  await verifyTypedProjection(client,tenantId);
  await verifyRevisionProjection(client,data,tenantId);
}

export async function projectApprovedData(client:pg.PoolClient,data:ImportData,tenantId:string){
  const records=rowsFor(data,tenantId),state=(await client.query('SELECT row_count,rows_digest FROM managed_projection_state WHERE tenant_id=$1 FOR UPDATE',[tenantId])).rows[0];
  if(!state)throw Error('Managed data migration is not initialized');
  const count=Number(state.row_count);
  if(count>records.length||digest(canonical(records.slice(0,count)))!==state.rows_digest)throw Error('Approved import history cannot be changed or removed');
  if(count===records.length){await projectRevisionData(client,data,tenantId);return;}
  const batches=new Map(data.batches.filter(b=>b.tenantId===tenantId&&b.status==='COMMITTED').map(b=>[b.batchId,b]));
  for(let offset=count;offset<records.length;offset+=1000){
    const input=records.slice(offset,offset+1000).map((r,i)=>{
      const batch=batches.get(r.batchId);if(!batch||batch.dataType!==r.dataType)throw Error('Only committed import rows can enter managed data tables');
      return {tenant_id:tenantId,ordinal:offset+i+1,batch_id:r.batchId,source_row:r.row,data_type:r.dataType,source_system:r.sourceSystem,source_record_id:String(r.value.source_record_id),snapshot_digest:batch.snapshotDigest,body:r.value};
    });
    await client.query(`INSERT INTO managed_import_rows SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(tenant_id text,ordinal bigint,batch_id uuid,source_row integer,data_type text,source_system text,source_record_id text,snapshot_digest text,body jsonb)`,[JSON.stringify(input)]);
  }
  const base=[tenantId,count];
  await client.query(`INSERT INTO managed_assets(tenant_id,device_code,source_ordinal,device_name,site_code,line_code,equipment_type,brand,model,serial_number,criticality)
   SELECT tenant_id,body->>'device_code',ordinal,body->>'device_name',body->>'site_code',body->>'line_code',NULLIF(body->>'equipment_type',''),NULLIF(body->>'brand',''),NULLIF(body->>'model',''),NULLIF(body->>'serial_number',''),NULLIF(body->>'criticality','') FROM managed_import_rows WHERE tenant_id=$1 AND ordinal>$2 AND data_type='DEVICE'`,base);
  await client.query(`INSERT INTO managed_point_definitions(tenant_id,device_code,tag_code,source_ordinal,tag_name,unit,min_value,max_value,expected_interval_seconds)
   SELECT tenant_id,body->>'device_code',body->>'tag_code',ordinal,body->>'tag_name',body->>'unit',(body->>'min_value')::float8,(body->>'max_value')::float8,NULLIF(body->>'expected_interval_seconds','')::integer FROM managed_import_rows WHERE tenant_id=$1 AND ordinal>$2 AND data_type='POINT_DEFINITION'`,base);
  await client.query(`INSERT INTO managed_measurements(tenant_id,source_ordinal,device_code,tag_code,measured_at,value,unit,quality)
   SELECT tenant_id,ordinal,body->>'device_code',body->>'tag_code',(body->>'measured_at')::timestamptz,(body->>'value')::float8,body->>'unit',body->>'quality' FROM managed_import_rows WHERE tenant_id=$1 AND ordinal>$2 AND data_type='MEASUREMENT'`,base);
  await client.query('UPDATE managed_projection_state SET row_count=$2,rows_digest=$3 WHERE tenant_id=$1',[tenantId,records.length,digest(canonical(records))]);
  await projectRevisionData(client,data,tenantId);
}

async function verifyTypedProjection(client:pg.PoolClient,tenantId:string){
  const counts=(await client.query(`SELECT data_type,count(*)::int AS count FROM managed_import_rows WHERE tenant_id=$1 GROUP BY data_type`,[tenantId])).rows;
  for(const [table,type] of [['managed_assets','DEVICE'],['managed_point_definitions','POINT_DEFINITION'],['managed_measurements','MEASUREMENT']]){
    const actual=(await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE tenant_id=$1`,[tenantId])).rows[0].count;
    if(actual!==(counts.find(r=>r.data_type===type)?.count||0))throw Error('Managed domain row count differs from approved history');
  }
  const mismatch=await client.query(`SELECT 1 FROM managed_assets a JOIN managed_import_rows r ON r.tenant_id=a.tenant_id AND r.ordinal=a.source_ordinal WHERE a.tenant_id=$1 AND
   (a.device_code IS DISTINCT FROM r.body->>'device_code' OR a.device_name IS DISTINCT FROM r.body->>'device_name' OR a.site_code IS DISTINCT FROM r.body->>'site_code' OR a.line_code IS DISTINCT FROM r.body->>'line_code' OR a.equipment_type IS DISTINCT FROM NULLIF(r.body->>'equipment_type','') OR a.brand IS DISTINCT FROM NULLIF(r.body->>'brand','') OR a.model IS DISTINCT FROM NULLIF(r.body->>'model','') OR a.serial_number IS DISTINCT FROM NULLIF(r.body->>'serial_number','') OR a.criticality IS DISTINCT FROM NULLIF(r.body->>'criticality',''))
   UNION ALL SELECT 1 FROM managed_point_definitions p JOIN managed_import_rows r ON r.tenant_id=p.tenant_id AND r.ordinal=p.source_ordinal WHERE p.tenant_id=$1 AND
   (p.device_code IS DISTINCT FROM r.body->>'device_code' OR p.tag_code IS DISTINCT FROM r.body->>'tag_code' OR p.tag_name IS DISTINCT FROM r.body->>'tag_name' OR p.unit IS DISTINCT FROM r.body->>'unit' OR p.min_value IS DISTINCT FROM (r.body->>'min_value')::float8 OR p.max_value IS DISTINCT FROM (r.body->>'max_value')::float8 OR p.expected_interval_seconds IS DISTINCT FROM NULLIF(r.body->>'expected_interval_seconds','')::integer)
   UNION ALL SELECT 1 FROM managed_measurements m JOIN managed_import_rows r ON r.tenant_id=m.tenant_id AND r.ordinal=m.source_ordinal WHERE m.tenant_id=$1 AND
   (m.device_code IS DISTINCT FROM r.body->>'device_code' OR m.tag_code IS DISTINCT FROM r.body->>'tag_code' OR m.measured_at IS DISTINCT FROM (r.body->>'measured_at')::timestamptz OR m.value IS DISTINCT FROM (r.body->>'value')::float8 OR m.unit IS DISTINCT FROM r.body->>'unit' OR m.quality IS DISTINCT FROM r.body->>'quality') LIMIT 1`,[tenantId]);
  if(mismatch.rowCount)throw Error('Managed typed fields disagree with original source rows');
}
