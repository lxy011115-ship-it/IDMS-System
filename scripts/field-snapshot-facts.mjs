import pg from 'pg';
import {createHash} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {readEntities} from '../server/entity-repository.ts';
import {memoryTask} from '../server/capacity.ts';
import {moduleTables,latestMigrationChecksum,quoteIdentifier as q} from '../server/postgres-schema.ts';
import {fieldTablePrivileges,fieldModuleChecksum} from '../server/field-schema.ts';
import {validateBusinessDatabase} from './backup-support.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const maxRowBytes=64*1024*1024;

// Low-level bounded snapshot scan. This does not establish role/DDL authority.
// Source and restored-target callers must run their strict security validators.
// Sequence values are not MVCC snapshots.
export async function scanFieldSnapshotFacts(client,account,tenantId,{sequenceClient}={}){
 return memoryTask(async()=>{
  if(client.getTransactionStatus?.()!=='T')fail('FIELD_BACKUP_SNAPSHOT_REQUIRED');
  const settings=(await client.query("SELECT current_setting('transaction_isolation') AS isolation,current_setting('server_version_num') AS version,current_database() AS database,pg_current_snapshot()::text AS snapshot,inet_server_addr()::text AS address,inet_server_port() AS port")).rows[0];
  if(!['repeatable read','serializable'].includes(settings.isolation)||!/^16\d{4}$/.test(settings.version)||settings.database!==account.database)fail('FIELD_BACKUP_SNAPSHOT_REQUIRED');
  if(sequenceClient?.getTransactionStatus?.()!=='T')fail('FIELD_BACKUP_READONLY_SEQUENCE_READER_REQUIRED');
  const reader=(await sequenceClient.query("SELECT current_user AS role,current_database() AS database,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,pg_current_snapshot()::text AS snapshot,inet_server_addr()::text AS address,inet_server_port() AS port")).rows[0];
  if(reader.role!==account.backupRole||reader.database!==account.database||reader.readonly!=='on'||reader.isolation!=='repeatable read'||reader.snapshot!==settings.snapshot||reader.address!==settings.address||reader.port!==settings.port)fail('FIELD_BACKUP_READONLY_SEQUENCE_READER_REQUIRED');
  const baseChecksum=latestMigrationChecksum(account.telemetry),module={version:1,baseChecksum,checksum:fieldModuleChecksum(baseChecksum)};
  const schemas=(await client.query("SELECT nspname FROM pg_namespace WHERE nspname<>'information_schema' AND nspname !~ '^pg_' ORDER BY nspname COLLATE \"C\"")).rows.map(r=>r.nspname);
  if(canonical(schemas)!==canonical(['idms_field','public']))fail('FIELD_BACKUP_SCHEMA_UNSUPPORTED');
  const expected=[...moduleTables(account.telemetry).map(table=>({schema:'public',table,kind:table==='runtime_state'?'v':'r'})),...Object.keys(fieldTablePrivileges).map(table=>({schema:'idms_field',table,kind:'r'}))].sort((a,b)=>Buffer.compare(Buffer.from(a.schema+'.'+a.table),Buffer.from(b.schema+'.'+b.table)));
  const actual=(await client.query("SELECT n.nspname AS schema,c.relname AS table,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','v','m','f') ORDER BY (n.nspname||'.'||c.relname) COLLATE \"C\"",[schemas])).rows;
  if(canonical(actual)!==canonical(expected))fail('FIELD_BACKUP_TABLE_SET_CHANGED');
  const loaded=await readEntities(client,tenantId),roots=(await client.query('SELECT * FROM public.business_state ORDER BY tenant_id COLLATE "C"')).rows;
  if(roots.length!==1||roots[0].tenant_id!==tenantId)fail('FIELD_BACKUP_TENANT_MISMATCH');
  const legacy=(await client.query('SELECT schema_version,payload FROM public.runtime_state WHERE singleton=true')).rows;
  if(legacy.length!==1||legacy[0].schema_version!==2||canonical(legacy[0].payload)!==canonical(loaded.payload))fail('FIELD_BACKUP_LEGACY_VIEW_MISMATCH');
  await validateBusinessDatabase(client,tenantId);
  const facts=[];
  for(const {schema,table,kind}of actual){
   const qualified=q(schema)+'.'+q(table);
   const size=(await client.query(`SELECT coalesce(max(octet_length(to_jsonb(t)::text)),0)::bigint AS bytes FROM ${qualified} t`)).rows[0].bytes;
   if(BigInt(size)>BigInt(maxRowBytes))fail('FIELD_BACKUP_ROW_LIMIT');
   const columns=(await client.query("SELECT column_name,data_type,udt_schema,udt_name,is_nullable,column_default,is_identity,identity_generation,is_generated,generation_expression,collation_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position",[schema,table])).rows;
   const digest=createHash('sha256');let rows=0,bytes=0;
   await new Promise((ok,no)=>{
    const query=client.query(new pg.Query(`SELECT to_jsonb(t)::text AS record FROM ${qualified} t ORDER BY to_jsonb(t)::text COLLATE "C"`));
    query.on('row',row=>{digest.update(row.record+'\n');rows++;bytes+=Buffer.byteLength(row.record)+1;});query.once('error',no);query.once('end',ok);
   });
   if(!Number.isSafeInteger(rows)||!Number.isSafeInteger(bytes))fail('FIELD_BACKUP_FACT_LIMIT');
   facts.push({schema,table,kind,...(kind==='v'?{definition:(await client.query('SELECT pg_get_viewdef($1::regclass,true) AS definition',[qualified])).rows[0].definition}:{}),columns,rows,bytes,sha256:digest.digest('hex')});
  }
  const sequences=[];
  for(const row of(await client.query("SELECT n.nspname AS schema,c.relname AS name,s.seqstart::text,s.seqincrement::text,s.seqmin::text,s.seqmax::text,s.seqcache::text,s.seqcycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) ORDER BY (n.nspname||'.'||c.relname) COLLATE \"C\"",[schemas])).rows){
   const value=(await sequenceClient.query(`SELECT last_value::text,is_called FROM ${q(row.schema)}.${q(row.name)}`)).rows;
   if(value.length!==1)fail('FIELD_BACKUP_SEQUENCE_INVALID');
   sequences.push({...row,...value[0]});
  }
  const audits=loaded.payload.audits,content={format:'idms-field-backup-facts-v1',tenantId,pgVersion:settings.version,sourceDatabase:account.database,sourceRoles:{owner:account.ownerRole,app:account.user,backup:account.backupRole},module,root:{...roots[0],updated_at:new Date(roots[0].updated_at).toISOString()},revision:loaded.revision,auditEvents:audits.length,auditHead:audits.at(-1)?.hash??null,businessSha256:hash(canonical(loaded.payload.business)),importsSha256:hash(canonical(loaded.payload.imports)),relations:facts,sequences};
  return {...content,factsSha256:hash(canonical(content)),sequenceValuesAreNotMvcc:true,maximumSupportedRowBytes:maxRowBytes};
 });
}
