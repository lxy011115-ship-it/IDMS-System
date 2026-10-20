import assert from 'node:assert/strict';
import pg from 'pg';
import {closeSourceConnection} from '../field-source-freeze.mjs';
export async function exerciseArchiveSourceDrift({authority,runtime,args,cli}){
 const a=runtime.tenants.acme;
 if(!/^idms_fieldarchiveqa_acme_[a-f0-9]{10}$/.test(a.database))throw Error('Owned archive source required');
 async function sql(work){const c=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:a.database});try{await c.connect();return await work(c);}finally{await closeSourceConnection(c);}}
 const seq=(await sql(c=>c.query('SELECT last_value::text,is_called FROM public.audit_ledger_sequence_no_seq'))).rows[0];
 try{
  await sql(c=>c.query("SELECT setval('public.audit_ledger_sequence_no_seq',$1,true)",[(BigInt(seq.last_value)+11n).toString()]));
  assert.equal((await cli('archive',args,1)).code,'FIELD_ARCHIVE_SOURCE_FACTS_CHANGED');
 }finally{await sql(c=>c.query("SELECT setval('public.audit_ledger_sequence_no_seq',$1,$2)",[seq.last_value,seq.is_called]));}
 try{
  await sql(c=>c.query('CREATE FOREIGN DATA WRAPPER idms_field_archive_qa NO HANDLER;CREATE SERVER idms_field_archive_qa FOREIGN DATA WRAPPER idms_field_archive_qa'));
  assert.equal((await cli('archive',args,1)).code,'FIELD_ARCHIVE_DATABASE_GLOBALS_UNSUPPORTED');
 }finally{await sql(c=>c.query('DROP SERVER IF EXISTS idms_field_archive_qa;DROP FOREIGN DATA WRAPPER IF EXISTS idms_field_archive_qa'));}
 const view=(await sql(c=>c.query("SELECT pg_get_viewdef('public.runtime_state'::regclass,true) AS definition"))).rows[0].definition.replace(/;\s*$/,'');
 const columns=(await sql(c=>c.query("SELECT attname FROM pg_attribute WHERE attrelid='public.runtime_state'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum"))).rows.map(r=>r.attname);
 assert.ok(columns.every(n=>/^[a-z_]+$/.test(n))&&columns.includes('payload'));
 const change=definition=>sql(c=>c.query('SET ROLE "'+a.ownerRole+'";CREATE OR REPLACE VIEW public.runtime_state AS '+definition));
 try{
  await change('SELECT '+columns.map(n=>n==='payload'?"b.payload - 'audits' AS payload":'b."'+n+'"').join(',')+' FROM ('+view+') b');
  assert.equal((await cli('archive',args,1)).code,'FIELD_BACKUP_LEGACY_VIEW_MISMATCH');
 }finally{await change(view);}
 await cli('archive',args);
 return {changedSequenceRefusesCompletedArchiveReuse:true,unsupportedForeignServerRefused:true,legacyViewDisagreementRefused:true,onlyOwnedQaChangesRestored:true};
}
