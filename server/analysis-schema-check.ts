import type pg from 'pg';
import {canonical} from './imports.ts';
// Concurrency correctness depends on these actual unique keys; a migration row
// and a matching application role alone do not prove that they still exist.
export async function verifyAnalysisSchema(client:pg.PoolClient){
 // In a caller-owned transaction these reads keep AccessShare locks until the
 // command/read ends, so constraints cannot be dropped after verification.
 await client.query('SELECT 1 FROM public.registry_history LIMIT 0');await client.query('SELECT 1 FROM public.analysis_report_events LIMIT 0');
 const tables:Record<string,[string,string,boolean][]|undefined>={
  registry_history:[['tenant_id','text',true],['revision','bigint',true],['observed_at','timestamp with time zone',true],['writer_id','text',true],['configuration_hash','text',true],['previous_hash','text',true],['hash','text',true],['body','jsonb',true]],
  analysis_report_events:[['tenant_id','text',true],['report_id','uuid',true],['revision','integer',true],['action','text',true],['occurred_at','timestamp with time zone',true],['actor_type','text',true],['actor_id','text',true],['request_key','text',true],['request_digest','text',true],['payload_digest','text',true],['metadata','jsonb',true],['payload','jsonb',false],['previous_hash','text',true],['hash','text',true]]
 };
 for(const [table,expected]of Object.entries(tables)){
  const columns=(await client.query("SELECT attname,format_type(atttypid,atttypmod) AS type,attnotnull,attgenerated,attidentity FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",['public.'+table])).rows;
  if(canonical(columns.map(r=>[r.attname,r.type,r.attnotnull]))!==canonical(expected)||columns.some(r=>r.attgenerated!==''||r.attidentity!==''))throw Error('Analysis history column layout does not match migration 5');
  const constraints=(await client.query("SELECT contype,condeferrable,condeferred,convalidated,ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.ord) AS columns FROM pg_constraint c WHERE conrelid=$1::regclass AND contype IN ('p','u') ORDER BY contype,conname",['public.'+table])).rows;
  const wanted=table==='registry_history'?[['p',['tenant_id','revision']],['u',['tenant_id','hash']]]:[['p',['tenant_id','report_id','revision']],['u',['tenant_id','request_key']],['u',['tenant_id','report_id','hash']]];
  if(canonical(constraints.map(r=>canonical([r.contype,r.columns])).sort())!==canonical(wanted.map(r=>canonical(r)).sort())||constraints.some(r=>r.condeferrable||r.condeferred||!r.convalidated))throw Error('Analysis history primary or unique constraints do not match migration 5');
 }
}

