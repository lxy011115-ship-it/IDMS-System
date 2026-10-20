import {createHash} from 'node:crypto';
import {canonicalDigest,canonicalEqual} from '../server/canonical-state.ts';
import {readEntities} from '../server/entity-repository.ts';
import {databaseFacts,validateBusinessDatabase} from './backup-support.mjs';
import {encodeLegacyText,encodeLegacyPayload,legacySqlRowKey} from '../server/legacy-map-v4.ts';
import {stateValueText} from '../server/state-map-v1.ts';
import {inspectBusinessMaintenanceBinding} from './business-maintenance-gate.mjs';
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const q=v=>{need(typeof v==='string'&&/^[a-z_][a-z0-9_]{0,62}$/.test(v),'LEGACY_V4_IDENTIFIER');return '"'+v+'"';};
const settings=async c=>{await c.query("SET LOCAL timezone='UTC'");await c.query("SET LOCAL datestyle='ISO,YMD'");await c.query("SET LOCAL bytea_output='hex'");await c.query('SET LOCAL extra_float_digits=3');};
const structure=b=>({...b,catalog:b.catalog.map(r=>({...r,relacl:null})),functions:b.functions.map(r=>({...r,proacl:null}))});
export async function captureLegacyV3Map(gate,tenantId,accept){
 await gate.assertHeld();need(gate.entries.length===1&&gate.entries[0].tenantId===tenantId,'LEGACY_V4_GATE_SCOPE');const e=gate.entries[0],c=e.client;await settings(c);
 const checks=await validateBusinessDatabase(c,tenantId),loaded=await readEntities(c,tenantId),facts=await databaseFacts(c),tables=e.observed.catalog.filter(r=>r.kind==='r').map(r=>r.name).sort();need(canonicalEqual(tables,facts.map(f=>f.table).sort()),'LEGACY_V4_TABLE_SET');
 const root=(await c.query('SELECT tenant_id,revision::text,schema_version,payload_digest FROM public.business_state')).rows[0];need(root.tenant_id===tenantId&&root.schema_version===3&&root.payload_digest===canonicalDigest(loaded.payload),'LEGACY_V4_SOURCE_ROOT');
 for(const fact of facts){
  const hash=createHash('sha256');let rows=0;await c.query(`DECLARE idms_legacy_v4_cursor NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS record FROM public.${q(fact.table)} t ORDER BY to_jsonb(t)::text COLLATE "C"`);
  try{for(;;){const page=(await c.query('FETCH FORWARD 16 FROM idms_legacy_v4_cursor')).rows;if(!page.length)break;for(const row of page){need(typeof row.record==='string','LEGACY_V4_ROW');hash.update(row.record+'\n');rows++;for(const entry of encodeLegacyText('legacy_sql',legacySqlRowKey(fact.table,rows),row.record))await accept(entry);}}}finally{await c.query('CLOSE idms_legacy_v4_cursor');}
  need(rows===fact.rows&&hash.digest('hex')===fact.sha256,'LEGACY_V4_EXPORT_FACTS');
 }
 for(const entry of encodeLegacyPayload(tenantId,loaded.payload))await accept(entry);
 await gate.assertHeld();need(canonicalEqual(await databaseFacts(c),facts),'LEGACY_V4_SOURCE_CHANGED');
 const manifest={format:'IDMS_LEGACY_V3_CAPTURE_V1',operationId:gate.operationId,tenantId,source:e.observed.identity,sourceCatalogHash:canonicalDigest(e.observed),sourceStructureHash:canonicalDigest(structure(e.observed)),root,checks,
  audit:{count:loaded.payload.audits.length,tip:loaded.payload.audits.at(-1)?.hash||'GENESIS'},
  files:loaded.payload.imports.batches.map(b=>({batchId:b.batchId,sha256:b.fileSha256,bytes:Buffer.from(b.originalBase64,'base64').length})),tableFacts:facts,sequence:e.sequence};
 await accept({namespace:'legacy_meta',key:'source',valueText:stateValueText(manifest)});return manifest;
}
export async function inspectLegacyV3Fence(c,manifest){
 need(manifest?.format==='IDMS_LEGACY_V3_CAPTURE_V1','LEGACY_V4_MANIFEST');const expected=manifest.source;
 const identity=(await c.query("SELECT current_database() AS database,(SELECT system_identifier::text FROM pg_control_system()) AS system,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS \"databaseOid\",(SELECT oid::text FROM pg_roles WHERE oid=$1::oid) AS \"roleOid\",(SELECT datdba::text FROM pg_database WHERE datname=current_database()) AS \"ownerOid\"",[expected.roleOid])).rows[0];need(canonicalEqual(identity,expected),'LEGACY_V4_FENCE_IDENTITY');
 const role=(await c.query('SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE oid=$1::oid',[expected.roleOid])).rows[0];
 need(role&&role.rolcanlogin&&['rolsuper','rolcreatedb','rolcreaterole','rolinherit','rolreplication','rolbypassrls'].every(k=>!role[k]),'LEGACY_V4_FENCE_ROLE');
 need(!(await c.query('SELECT 1 FROM pg_auth_members WHERE member=$1::oid',[expected.roleOid])).rowCount,'LEGACY_V4_FENCE_MEMBERSHIP');
 const owner=(await c.query('SELECT rolname FROM pg_roles WHERE oid=$1::oid',[expected.ownerOid])).rows[0]?.rolname;
 const binding=await inspectBusinessMaintenanceBinding(c,{database:expected.database,user:role.rolname,ownerRole:owner},manifest.tenantId);
 need(canonicalDigest(structure(binding))===manifest.sourceStructureHash,'LEGACY_V4_FENCE_STRUCTURE');
 const schemas=(await c.query("SELECT nspname FROM pg_namespace WHERE nspname<>'information_schema' AND nspname !~ '^pg_' ORDER BY nspname COLLATE \"C\"")).rows.map(r=>r.nspname);need(canonicalEqual(schemas,['public']),'LEGACY_V4_FENCE_SCHEMAS');
 need(!(await c.query("SELECT 1 FROM pg_namespace WHERE nspname='public' AND has_schema_privilege($1::oid,oid,'CREATE')",[expected.roleOid])).rowCount,'LEGACY_V4_FENCE_CREATE');
 const tables=(await c.query("SELECT c.oid::text,c.relname,c.relkind,c.relacl::text FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f') ORDER BY c.relname COLLATE \"C\"")).rows;
 need(canonicalEqual(tables.filter(t=>t.relkind==='r').map(t=>t.relname),manifest.tableFacts.map(f=>f.table))&&tables.every(t=>t.relkind==='r'||t.relkind==='v'&&t.relname==='runtime_state'),'LEGACY_V4_FENCE_TABLE_SET');
 for(const t of tables){need(!(await c.query("SELECT has_table_privilege($1::oid,$2::oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1::oid,$2::oid,'INSERT,UPDATE,REFERENCES') AS bad",[expected.roleOid,t.oid])).rows[0].bad,'LEGACY_V4_FENCE_DML');}
 // Materialize sequence OIDs first: SQL may reorder AND predicates before the type filter.
 const sequenceObjects=(await c.query("SELECT oid::text,relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S' ORDER BY relname COLLATE \"C\"")).rows;
 need(sequenceObjects.length===manifest.sequence.length&&sequenceObjects.every((s,i)=>s.relname===manifest.sequence[i].name&&s.oid===manifest.sequence[i].oid),'LEGACY_V4_FENCE_SEQUENCE_SET');
 for(const s of sequenceObjects)need(!(await c.query("SELECT has_sequence_privilege($1::oid,$2::oid,'USAGE,UPDATE') AS bad",[expected.roleOid,s.oid])).rows[0].bad,'LEGACY_V4_FENCE_SEQUENCE');
 need(!(await c.query("SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND has_function_privilege($1::oid,oid,'EXECUTE')",[expected.roleOid])).rowCount,'LEGACY_V4_FENCE_FUNCTION');
 const root=(await c.query('SELECT tenant_id,revision::text,schema_version,payload_digest FROM public.business_state')).rows[0];need(canonicalEqual(root,manifest.root),'LEGACY_V4_FENCE_ROOT');
 const sequences=[];for(const s of manifest.sequence){const row=(await c.query('SELECT last_value::text AS "lastValue",is_called AS "isCalled" FROM public.'+q(s.name))).rows[0];need(row.lastValue===s.lastValue&&row.isCalled===s.isCalled,'LEGACY_V4_FENCE_SEQUENCE_DRIFT');sequences.push({name:s.name,...row});}
 return {format:'IDMS_LEGACY_V3_FENCE_V1',operationId:manifest.operationId,tenantId:manifest.tenantId,source:identity,appRole:role.rolname,tableAclHash:canonicalDigest(tables),sequence:sequences,oldRuntimeTableAndColumnDmlRevoked:true,oldRuntimeSequenceUsageRevoked:true,oldDataRootUnchanged:true};
}
/** Uses the SAME draining transaction: releasing a transient maintenance gate is insufficient. */
export async function commitLegacyV3Fence(gate,manifest){
 await gate.assertHeld();need(gate.entries.length===1&&gate.entries[0].tenantId===manifest.tenantId&&gate.operationId===manifest.operationId,'LEGACY_V4_GATE_SCOPE');const e=gate.entries[0],c=e.client;
 need(canonicalDigest(e.observed)===manifest.sourceCatalogHash,'LEGACY_V4_FENCE_BINDING');
 need(canonicalEqual(await databaseFacts(c),manifest.tableFacts),'LEGACY_V4_FENCE_SOURCE_CHANGED');const role=q(e.account.user);
 await c.query(`REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON ALL TABLES IN SCHEMA public FROM ${role}`);
 for(const t of e.observed.catalog.filter(t=>t.kind==='r'||t.kind==='v')){
  const cols=(await c.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::oid AND attnum>0 AND NOT attisdropped ORDER BY attnum',[t.oid])).rows.map(r=>q(r.attname)).join(',');
  await c.query(`REVOKE INSERT(${cols}),UPDATE(${cols}),REFERENCES(${cols}) ON TABLE public.${q(t.name)} FROM ${role}`);
 }
 await c.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);await c.query(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`);
 const proof=await inspectLegacyV3Fence(c,manifest);const result=await c.query('COMMIT');need(result.command==='COMMIT','LEGACY_V4_FENCE_COMMIT_UNKNOWN');await c.end();gate.entries=[];gate.state='FENCED';return proof;
}
export async function revalidateLegacyV3Fence(c,manifest){
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{await settings(c);const fence=await inspectLegacyV3Fence(c,manifest);need(canonicalEqual(await databaseFacts(c),manifest.tableFacts),'LEGACY_V4_FENCE_SOURCE_CHANGED');const payload=(await readEntities(c,manifest.tenantId)).payload;need(canonicalDigest(payload)===manifest.root.payload_digest,'LEGACY_V4_FENCE_PAYLOAD');await validateBusinessDatabase(c,manifest.tenantId);await c.query('COMMIT');return fence;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
}
