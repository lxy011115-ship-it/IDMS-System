import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {stat,statfs} from 'node:fs/promises';
import {sha} from '../integrations/telemetry.ts';
import {safeCount,assertQueue} from './telemetry-capacity-model.mjs';
const names=['telemetry_points','telemetry_receipts','audit_ledger'];
export async function samplePgCapacity(client,expected){
 const started=performance.now();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  const identity=(await client.query("SELECT current_database() AS database,current_user AS role,d.oid::text AS database_oid,r.oid::text AS role_oid,current_setting('transaction_read_only') AS read_only FROM pg_database d CROSS JOIN pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user")).rows[0];assert.equal(identity.read_only,'on');if(expected)assert.deepEqual(identity,expected.identity,'Capacity database/account identity changed');
  const catalog=(await client.query("SELECT c.relname,c.oid::text AS oid,c.relkind,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege(c.oid,'SELECT') AS can_read FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname",[names])).rows;
  assert.equal(catalog.length,3);for(const row of catalog)assert.ok(row.relkind==='r'&&!row.relrowsecurity&&!row.relforcerowsecurity&&row.can_read,'Unsupported capacity table');if(expected)assert.deepEqual(catalog,expected.catalog,'Capacity table identity changed');
  const tables={};for(const name of names){
   const logical=(await client.query(`SELECT count(*)::text AS rows,COALESCE(sum(pg_column_size(t)),0)::text AS bytes FROM public.${name} t`)).rows[0];
   const physical=(await client.query('SELECT pg_relation_size($1::regclass)::text AS heap,pg_indexes_size($1::regclass)::text AS indexes,pg_total_relation_size($1::regclass)::text AS total',['public.'+name])).rows[0];
   tables[name]={rows:safeCount(logical.rows),rowValueBytes:safeCount(logical.bytes),heapBytes:safeCount(physical.heap),indexBytes:safeCount(physical.indexes),totalBytes:safeCount(physical.total)};
  }
  const databaseBytes=safeCount((await client.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes);
  return {identity,catalog,tables,databaseBytes,sampleMs:performance.now()-started};
 }finally{await client.query('ROLLBACK');}
}
export async function sampleQueueCapacity(file,source){
 const db=new DatabaseSync(file,{readOnly:true});let queue;
 try{
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
  const binding=db.prepare("SELECT value FROM metadata WHERE name='source'").get()?.value;assert.equal(binding,sha({tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion}),'Capacity queue source binding mismatch');
  const counts=db.prepare("SELECT count(*) FILTER(WHERE state='PENDING') AS pending,count(*) FILTER(WHERE state='REJECTED') AS rejected,count(*) FILTER(WHERE state NOT IN ('PENDING','REJECTED')) AS invalid,COALESCE(sum(length(CAST(payload AS BLOB))),0) AS pendingPayloadBytes FROM pending").get();assert.equal(counts.invalid,0);
  queue={pending:safeCount(counts.pending),rejected:safeCount(counts.rejected),acknowledged:safeCount(db.prepare('SELECT count(*) AS n FROM acknowledged').get().n),sequence:safeCount(db.prepare("SELECT value FROM metadata WHERE name='sequence'").get()?.value),pendingPayloadBytes:safeCount(counts.pendingPayloadBytes),pageSize:safeCount(db.prepare('PRAGMA page_size').get().page_size),pages:safeCount(db.prepare('PRAGMA page_count').get().page_count),freePages:safeCount(db.prepare('PRAGMA freelist_count').get().freelist_count)};
  assertQueue(queue);
 }finally{try{db.exec('ROLLBACK');}finally{db.close();}}
 const files={};for(const [kind,suffix]of [['db',''],['wal','-wal'],['shm','-shm']]){try{files[kind]=safeCount((await stat(file+suffix)).size);}catch(e){if(e.code!=='ENOENT'||!suffix)throw e;files[kind]=0;}}
 const fs=await statfs(file);return {...queue,fileBytes:files,volumeAvailableBytes:safeCount(fs.bavail*fs.bsize),fileSizesAreNonAtomic:true};
}
export async function sampleEdgeStatus(source){
 const url=new URL(source.statusUrl);assert.ok(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.pathname==='/status'&&!url.username&&!url.password,'Untrusted capacity status URL');
 const response=await fetch(url,{headers:{Authorization:'Bearer '+source.statusKey},signal:AbortSignal.timeout(3000),redirect:'error'});assert.equal(response.status,200);
 const reader=response.body.getReader();let n=0,text='';try{while(true){const r=await reader.read();if(r.done)break;n+=r.value.byteLength;assert.ok(n<=32768,'Capacity status too large');text+=Buffer.from(r.value).toString('utf8');}}finally{await reader.cancel().catch(()=>{});}
 const s=JSON.parse(text);assert.equal(s.tenantId,source.tenantId);assert.equal(s.edgeId,source.edgeId);assertQueue(s);assert.ok(s.mqttConnected&&s.ackSubscribed);assert.equal(s.flowControl?.version,'business-ack-window-v1');assert.equal(s.flowControl.window,1);assert.ok(s.flowControl.occupied>=0&&s.flowControl.occupied<=1);
 return {pending:s.pending,rejected:s.rejected,acknowledged:s.acknowledged,sequence:s.sequence,capacity:safeCount(s.capacity),gaps:safeCount(s.gaps),retries:safeCount(s.flowControl.retries),published:safeCount(s.flowControl.published),occupied:s.flowControl.occupied,capacityBlocked:s.capacityBlocked===true,lastError:s.lastError??null};
}
