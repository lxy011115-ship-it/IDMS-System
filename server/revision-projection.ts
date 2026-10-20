import {streamRows} from './pg-row-stream.ts';
import {holdAllocation,holdValue} from './capacity.ts';
import {canonicalEqual} from './canonical-state.ts';
import type pg from 'pg';
import {canonical,type ImportData,type ImportView} from './imports.ts';
import {revisionFacts,recordKey} from './import-revisions.ts';

export const revisionProjectionSchema=`CREATE TABLE IF NOT EXISTS managed_record_revisions (
 tenant_id text NOT NULL,root_ordinal bigint NOT NULL,revision integer NOT NULL CHECK(revision>1),
 batch_id uuid NOT NULL,source_row integer NOT NULL CHECK(source_row>=2),
 previous_batch_id uuid NOT NULL,previous_row integer NOT NULL CHECK(previous_row>=2),
 previous_digest text NOT NULL,snapshot_digest text NOT NULL,body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 PRIMARY KEY(tenant_id,root_ordinal,revision),UNIQUE(tenant_id,batch_id,source_row),
 UNIQUE(tenant_id,previous_batch_id,previous_row),
 FOREIGN KEY(tenant_id,root_ordinal) REFERENCES managed_import_rows(tenant_id,ordinal)
);`;
export async function initializeRevisionProjection(client:pg.PoolClient,data:ImportData|undefined,tenantId:string){
  await client.query(revisionProjectionSchema);
  await client.query('DROP TRIGGER IF EXISTS immutable_managed_data ON managed_record_revisions; CREATE TRIGGER immutable_managed_data BEFORE UPDATE OR DELETE OR TRUNCATE ON managed_record_revisions FOR EACH STATEMENT EXECUTE FUNCTION reject_managed_data_mutation()');
  if(data)await projectRevisionData(client,data,tenantId);
}
function expectedRows(data:ImportView,tenantId:string){
  const ordinals=new Map(data.records.filter(r=>r.tenantId===tenantId).map((r,i)=>[recordKey(r),i+1]));
  return revisionFacts(data,tenantId).facts.map(f=>({tenant_id:tenantId,root_ordinal:ordinals.get(recordKey(f.root))!,revision:f.revision,batch_id:f.record.batchId,source_row:f.record.row,previous_batch_id:f.previous.batchId,previous_row:f.previous.row,previous_digest:importDigest(f.previous),snapshot_digest:f.snapshotDigest,body:f.record.value}));
}
import {digest} from './imports.ts';
const importDigest=(record:unknown)=>digest(canonical(record));
function normalize(rows:pg.QueryResultRow[]):Record<string,any>[]{return rows.map(r=>({...r,root_ordinal:Number(r.root_ordinal)}));}
export async function projectRevisionData(client:pg.PoolClient,data:ImportData,tenantId:string){
  const expected=expectedRows(data,tenantId),stored=normalize((await client.query('SELECT * FROM managed_record_revisions ORDER BY root_ordinal,revision')).rows);
  const sorted=[...expected].sort((a,b)=>a.root_ordinal-b.root_ordinal||a.revision-b.revision),byKey=new Map(expected.map(r=>[r.root_ordinal+':'+r.revision,r]));
  if(stored.some(r=>canonical(r)!==canonical(byKey.get(r.root_ordinal+':'+r.revision)))||stored.length>expected.length)throw Error('Correction SQL ledger disagrees with immutable history');
  const keys=new Set(stored.map(r=>r.root_ordinal+':'+r.revision));
  for(const row of expected.filter(r=>!keys.has(r.root_ordinal+':'+r.revision)))await client.query('INSERT INTO managed_record_revisions(tenant_id,root_ordinal,revision,batch_id,source_row,previous_batch_id,previous_row,previous_digest,snapshot_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',Object.values(row));
  if(canonical(normalize((await client.query('SELECT * FROM managed_record_revisions ORDER BY root_ordinal,revision')).rows))!==canonical(sorted))throw Error('Correction SQL ledger is incomplete');
}
export async function verifyRevisionProjection(client:pg.PoolClient,data:ImportView,tenantId:string,check?:()=>void){
  check?.();const corrections=data.batches.reduce((n,b)=>n+(b.correction&&b.status==='COMMITTED'&&b.tenantId===tenantId?b.rows.length:0),0),indexBytes=65536+data.records.length*256+corrections*512;if(!Number.isSafeInteger(indexBytes))throw Error('Correction indexes exceed supported capacity');
  const releaseIndex=holdAllocation(indexBytes);let releaseExpected=()=>{},releaseRow=()=>{};
  try{const expected=expectedRows(data,tenantId).sort((a,b)=>a.root_ordinal-b.root_ordinal||a.revision-b.revision);releaseExpected=holdValue(expected);let seen=0;
   await streamRows<pg.QueryResultRow>(client,'/* IDMS_REVISION_PROJECTION_ROWS */ SELECT * FROM managed_record_revisions ORDER BY root_ordinal,revision',row=>{check?.();releaseRow();releaseRow=()=>{};releaseRow=holdValue(row);if(!expected[seen]||!canonicalEqual({...row,root_ordinal:Number(row.root_ordinal)},expected[seen]))throw Error('Correction SQL ledger disagrees with immutable history');seen++;},()=>{});
   if(seen!==expected.length)throw Error('Correction SQL ledger disagrees with immutable history');
  }finally{releaseRow();releaseExpected();releaseIndex();}
}

// Every query in one read transaction shares the same approved effective versions.
// Resolve the latest correction once, then materialize each typed set once.
// Rescanning a large untyped CTE per matching row caused nested-loop amplification.
// Historical facts and the version ledger remain append-only.
const currentCte=`WITH latest_revisions AS MATERIALIZED (
 SELECT DISTINCT ON (tenant_id,root_ordinal) * FROM managed_record_revisions WHERE tenant_id=$1 ORDER BY tenant_id,root_ordinal,revision DESC
),current_import_rows AS MATERIALIZED (
 SELECT r.tenant_id,r.ordinal,COALESCE(c.batch_id,r.batch_id) AS batch_id,COALESCE(c.source_row,r.source_row) AS source_row,
 r.data_type,r.source_system,r.source_record_id,COALESCE(c.snapshot_digest,r.snapshot_digest) AS snapshot_digest,
 COALESCE(c.body,r.body) AS body,COALESCE(c.revision,1) AS record_version,c.previous_batch_id
 FROM managed_import_rows r LEFT JOIN latest_revisions c ON c.tenant_id=r.tenant_id AND c.root_ordinal=r.ordinal WHERE r.tenant_id=$1
),current_assets AS MATERIALIZED (
 SELECT current_import_rows.*,ordinal AS source_ordinal,body->>'device_code' AS device_code,body->>'device_name' AS device_name,body->>'site_code' AS site_code,body->>'line_code' AS line_code,NULLIF(body->>'equipment_type','') AS equipment_type,NULLIF(body->>'brand','') AS brand,NULLIF(body->>'model','') AS model FROM current_import_rows WHERE data_type='DEVICE'
),current_point_definitions AS MATERIALIZED (
 SELECT current_import_rows.*,ordinal AS source_ordinal,body->>'device_code' AS device_code,body->>'tag_code' AS tag_code,body->>'tag_name' AS tag_name,body->>'unit' AS unit,(body->>'min_value')::float8 AS min_value,(body->>'max_value')::float8 AS max_value,NULLIF(body->>'expected_interval_seconds','')::integer AS expected_interval_seconds FROM current_import_rows WHERE data_type='POINT_DEFINITION'
),current_measurements AS MATERIALIZED (
 SELECT current_import_rows.*,ordinal AS source_ordinal,body->>'device_code' AS device_code,body->>'tag_code' AS tag_code,(body->>'measured_at')::timestamptz AS measured_at,(body->>'value')::float8 AS value,body->>'quality' AS quality,body->>'unit' AS unit FROM current_import_rows WHERE data_type='MEASUREMENT'
) `;
export function currentSql(text:string){return currentCte+text;}
export function currentQuery(client:pg.PoolClient,text:string,values:unknown[]){return client.query(currentSql(text),values);}
