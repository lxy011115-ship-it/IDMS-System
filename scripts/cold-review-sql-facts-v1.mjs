import {createHash,randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {reviewSourceNeedV1 as need,reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
const q=s=>'"'+s.replaceAll('"','""')+'"',limits=Object.freeze({relations:1024,rows:4000000,rowBytes:64*1024**2,totalBytes:32*1024**3});
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(','),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),oid=v=>typeof v==='string'&&/^[1-9][0-9]{0,9}$/.test(v)&&BigInt(v)<=4294967295n,id=v=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=63&&!/[\u0000-\u001f\u007f]/.test(v);
export function validateColdReviewSqlFactsV1(v){
 const {sha256,...body}=v??{};need(exact(v,['format','identity','relations','totalRows','totalBytes','sha256'])&&v.format==='COLD_REVIEW_SQL_FACTS_V1'&&hex(sha256)&&hash(body)===sha256,'COLD_FULL_SQL_FACTS_HASH');
 const i=v.identity;need(exact(i,['systemIdentifier','database','databaseOid','controlOid'])&&typeof i.systemIdentifier==='string'&&/^[1-9][0-9]{9,24}$/.test(i.systemIdentifier)&&id(i.database)&&oid(i.databaseOid)&&oid(i.controlOid)&&Array.isArray(v.relations)&&v.relations.length>=3&&v.relations.length<=limits.relations+2,'COLD_FULL_SQL_FACTS_SHAPE');
 let rows=0,bytes=0,large=0;const names=new Set(),ids=new Set();for(const r of v.relations){need(id(r?.schema)&&id(r.name)&&!names.has(r.schema+'\0'+r.name),'COLD_FULL_SQL_FACTS_RELATION');names.add(r.schema+'\0'+r.name);
  if(r.kind==='S'){need(exact(r,['oid','schema','name','kind','last_value','is_called'])&&oid(r.oid)&&!ids.has(r.oid)&&typeof r.last_value==='string'&&/^-?[0-9]+$/.test(r.last_value)&&typeof r.is_called==='boolean'&&!r.schema.startsWith('pg_')&&r.schema!=='information_schema','COLD_FULL_SQL_FACTS_SEQUENCE');ids.add(r.oid);continue;}
  need(['r','LARGE_OBJECT'].includes(r.kind)&&exact(r,r.kind==='r'?['oid','schema','name','kind','rows','bytes','sha256']:['schema','name','kind','rows','bytes','sha256'])&&Number.isSafeInteger(r.rows)&&r.rows>=0&&Number.isSafeInteger(r.bytes)&&r.bytes>=0&&hex(r.sha256),'COLD_FULL_SQL_FACTS_RELATION');
  if(r.kind==='r'){need(oid(r.oid)&&!ids.has(r.oid)&&!r.schema.startsWith('pg_')&&r.schema!=='information_schema','COLD_FULL_SQL_FACTS_RELATION');ids.add(r.oid);}else{need(r.schema==='pg_catalog'&&['pg_largeobject_metadata','pg_largeobject'].includes(r.name),'COLD_FULL_SQL_FACTS_LARGE_OBJECT');large++;}
  rows+=r.rows;bytes+=r.bytes;need(rows<=limits.rows&&bytes<=limits.totalBytes,'COLD_FULL_SQL_LIMIT');
 }need(large===2&&v.totalRows===rows&&v.totalBytes===bytes,'COLD_FULL_SQL_FACTS_COVERAGE');return v;
}
/** All stored user relations, sequences and large objects in the caller's original transaction. */
async function captureInTransaction(c,expected){
 need(c?.getTransactionStatus?.()==='T','COLD_FULL_SQL_TRANSACTION');
 const identity=(await c.query("SELECT (pg_control_system()).system_identifier::text AS systemIdentifier,current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS databaseOid,session_user::regrole::oid::text AS controlOid,current_user::regrole::oid::text AS currentOid,pg_is_in_recovery() AS standby")).rows[0];
 need(identity.systemIdentifier===expected.systemIdentifier&&identity.database===expected.database&&identity.databaseOid===expected.databaseOid&&identity.controlOid===expected.controlOid&&identity.currentOid===identity.controlOid&&!identity.standby,'COLD_FULL_SQL_IDENTITY');
 await c.query("SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO, YMD';SET LOCAL IntervalStyle='iso_8601';SET LOCAL extra_float_digits=3;SET LOCAL bytea_output='hex';SET LOCAL standard_conforming_strings=on");
 const tables=(await c.query("SELECT c.oid::text,n.nspname AS schema,c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','f','m','S') ORDER BY n.nspname COLLATE \"C\",c.relname COLLATE \"C\"")).rows;
 need(tables.length>0&&tables.length<=limits.relations&&tables.every(t=>['r','S'].includes(t.kind)),'COLD_FULL_SQL_RELATIONS');const relations=[];let totalRows=0,totalBytes=0;
 async function digest(sql){
  const name='cold_full_sql_'+randomUUID().replaceAll('-',''),h=createHash('sha256');let rows=0,bytes=0,problem;await c.query('DECLARE '+name+' NO SCROLL CURSOR FOR '+sql);
  try{for(;;){const batch=(await c.query('FETCH FORWARD 32 FROM '+name)).rows;if(!batch.length)break;for(const r of batch){need(typeof r.record==='string'&&Buffer.byteLength(r.record)<=limits.rowBytes&&++totalRows<=limits.rows,'COLD_FULL_SQL_LIMIT');const b=Buffer.from(r.record+'\n');rows++;bytes+=b.length;totalBytes+=b.length;need(totalBytes<=limits.totalBytes,'COLD_FULL_SQL_LIMIT');h.update(b);}}}catch(e){problem=e;throw e;}finally{if(!problem)await c.query('CLOSE '+name);}
  return{rows,bytes,sha256:h.digest('hex')};
 }
 for(const t of tables){const table=q(t.schema)+'.'+q(t.name);if(t.kind==='S'){const rows=(await c.query('SELECT last_value::text,is_called FROM '+table)).rows;need(rows.length===1&&/^-?[0-9]+$/.test(rows[0].last_value)&&typeof rows[0].is_called==='boolean','COLD_FULL_SQL_SEQUENCE');relations.push({...t,...rows[0]});}else relations.push({...t,...await digest('SELECT to_jsonb(t)::text AS record FROM '+table+' t ORDER BY to_jsonb(t)::text COLLATE "C"')});}
 // Large objects live in pg_catalog rather than ordinary user schemas.
 for(const table of ['pg_largeobject_metadata','pg_largeobject'])relations.push({schema:'pg_catalog',name:table,kind:'LARGE_OBJECT',...await digest('SELECT to_jsonb(t)::text AS record FROM pg_catalog.'+table+' t ORDER BY '+(table==='pg_largeobject'?'loid,pageno':'oid'))});
 const body={format:'COLD_REVIEW_SQL_FACTS_V1',identity:{systemIdentifier:identity.systemIdentifier,database:identity.database,databaseOid:identity.databaseOid,controlOid:identity.controlOid},relations,totalRows,totalBytes};
 return {...body,sha256:hash(body)};
}
export async function captureColdReviewSqlFactsV1(c,expected){
 need(c?.getTransactionStatus?.()==='T','COLD_FULL_SQL_TRANSACTION');const savepoint='cold_sql_settings_'+randomUUID().replaceAll('-','');await c.query('SAVEPOINT '+savepoint);let problem;
 try{return await captureInTransaction(c,expected);}catch(e){problem=e;throw e;}finally{try{need(['T','E'].includes(c.getTransactionStatus?.()),'COLD_FULL_SQL_TRANSACTION_ENDED');await c.query('ROLLBACK TO SAVEPOINT '+savepoint);await c.query('RELEASE SAVEPOINT '+savepoint);}catch(e){if(problem)problem.sqlSettingsRestorationUnproven=true;else throw e;}}
}
export function assertColdReviewSqlFactsV1(actual,expected){
 for(const v of [actual,expected])validateColdReviewSqlFactsV1(v);
 need(canonical(actual)===canonical(expected),'COLD_FULL_SQL_SOURCE_CHANGED');return true;
}
