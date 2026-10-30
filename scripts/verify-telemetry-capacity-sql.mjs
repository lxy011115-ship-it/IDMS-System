import assert from 'node:assert/strict';
import {readFile,mkdir,rm,writeFile} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {businessSchema,telemetrySchema} from '../server/postgres-schema.ts';
import {EdgeSpool} from '../services/edge/spool.ts';
import {signAck,sha} from '../integrations/telemetry.ts';
import {appendAudit} from '../server/audit.ts';
import {samplePgCapacity,sampleQueueCapacity} from './telemetry-capacity-sample.mjs';
const main=JSON.parse((await readFile('.local/postgres-runtime.json','utf8')).replace(/^\uFEFF/,'')),suffix=randomUUID().replaceAll('-','').slice(0,12),name='idms_capacityqa_'+suffix,root=resolve('.local'),directory=join(root,'telemetry-capacity-qa-'+suffix),password=randomBytes(32).toString('base64url');
assert.ok(directory.startsWith(root+sep)&&/^idms_capacityqa_[a-f0-9]{12}$/.test(name));
const admin=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:'postgres',statement_timeout:10000});let c,writer,dbOid,roleOid,proof;
try{
 await mkdir(directory,{recursive:false});await admin.connect();
 await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);roleOid=(await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0].oid;
 await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);dbOid=(await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1',[name])).rows[0].oid;await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
 const options={host:main.host,port:main.port,user:name,password,database:name,statement_timeout:10000};c=new pg.Client(options);writer=new pg.Client(options);await c.connect();await writer.connect();await writer.query(businessSchema+telemetrySchema);
 const auditStore={audits:[]};
 async function insert(n){const id=randomUUID();await writer.query('BEGIN');try{await writer.query("INSERT INTO telemetry_points(id,tenant_id,edge_id,device_code,tag_code,node_id,map_version,origin,sequence_no,event_time,value,unit,quality,input_digest) VALUES($1,'sandbox','capacity-qa','DEV','temperature','node','v1','SIMULATOR',$2,now(),1,'C','GOOD',$3)",[id,n,'digest-'+n]);await writer.query("INSERT INTO telemetry_receipts(edge_id,event_id,digest,sequence_no,status,point_id,envelope) VALUES('capacity-qa',$1,$2,$3,'STORED',$4,$5)",[id,'digest-'+n,n,id,{id,n}]);const audit=appendAudit(auditStore,{tenantId:'sandbox',objectType:'TELEMETRY_EVENT',objectId:id,action:'TELEMETRY_STORED',actorType:'INTERFACE',actorId:'capacity-qa',correlationId:id,metadata:{n}});await writer.query('INSERT INTO audit_ledger(tenant_id,event_id,hash,previous_hash,event) VALUES($1,$2,$3,$4,$5)',['sandbox',audit.eventId,audit.hash,audit.previousHash,audit]);await writer.query('COMMIT');}catch(e){await writer.query('ROLLBACK');throw e;}}
 await insert(1);await insert(2);
 await c.query('BEGIN READ ONLY');await assert.rejects(c.query('INSERT INTO audit_ledger SELECT * FROM audit_ledger WHERE false'),e=>e.code==='25006');await c.query('ROLLBACK');
 let injected=false;const wrapper={query:async(...args)=>{if(!injected&&typeof args[0]==='string'&&args[0].startsWith('SELECT pg_relation_size')){injected=true;await insert(3);}return c.query(...args);}};
 const first=await samplePgCapacity(wrapper);assert.ok(injected);for(const t of Object.values(first.tables))assert.equal(t.rows,2);assert.equal(first.identity.read_only,'on');
 const next=await samplePgCapacity(c,first);for(const [table,t]of Object.entries(next.tables)){assert.equal(t.rows,3);const independent=(await writer.query(`SELECT sum(pg_column_size(t))::text AS bytes FROM public.${table} t`)).rows[0];assert.equal(t.rowValueBytes,Number(independent.bytes));assert.ok(t.totalBytes>=t.heapBytes+t.indexBytes);}
 await assert.rejects(samplePgCapacity(c,{...first,identity:{...first.identity,database_oid:'0'}}),/identity changed/);assert.equal((await c.query('SELECT current_setting(\'transaction_read_only\') AS ro')).rows[0].ro,'off');
 await writer.query('ALTER TABLE telemetry_points RENAME TO telemetry_points_old');await writer.query('CREATE TABLE telemetry_points (LIKE telemetry_points_old INCLUDING ALL)');await assert.rejects(samplePgCapacity(c,first),/table identity changed/);await writer.query('DROP TABLE telemetry_points');await writer.query('ALTER TABLE telemetry_points_old RENAME TO telemetry_points');
 const source={tenantId:'sandbox',edgeId:'capacity-qa',deviceCode:'DEV',mapVersion:'v1',origin:'SIMULATOR',signingKey:randomBytes(32).toString('base64url'),acknowledgementKey:randomBytes(32).toString('base64url')},file=join(directory,'queue.sqlite'),spool=new EdgeSpool(file,source,10),events=[];
 try{for(let i=0;i<5;i++)events.push(spool.append({tagCode:'temperature',nodeId:'node',eventTime:new Date(Date.now()+i).toISOString(),value:i,unit:'C',quality:'GOOD'}));for(const e of events.slice(0,3))assert.ok(spool.acknowledge(signAck({version:1,tenantId:'sandbox',edgeId:source.edgeId,eventId:e.eventId,digest:sha(e),status:e===events[2]?'REJECTED':'STORED'},source.acknowledgementKey)));}finally{spool.close();}
 const facts=await sampleQueueCapacity(file,source);assert.equal(facts.sequence,5);assert.equal(facts.pending,2);assert.equal(facts.rejected,1);assert.equal(facts.acknowledged,2);assert.ok(facts.pendingPayloadBytes>0&&facts.fileBytes.db>0&&facts.volumeAvailableBytes>0);await assert.rejects(sampleQueueCapacity(file,{...source,mapVersion:'other'}),/binding mismatch/);
 const readonly=new DatabaseSync(file,{readOnly:true});try{assert.throws(()=>readonly.prepare("DELETE FROM acknowledged").run());}finally{readonly.close();}
 proof={verifiedAt:new Date().toISOString(),realPostgresAndSqlite:true,actualPgReadOnlyTransactionRejectsInsert:true,concurrentWriterCommitsBetweenTableReadsButAllCountsStayOldSnapshot:true,nextSnapshotSeesAllThreeNewRows:true,independentRowValueByteSumsMatch:true,wrongDatabaseAndReplacedTableOidRefused:true,pgRollbackAfterRefusalConfirmed:true,realSignedQueueStoredRejectedAndPendingConserve:true,sourceBindingMismatchRefused:true,actualReadOnlySqliteRejectsDelete:true,originalDatabasesAndQueuesUntouched:true,productionAcceptance:false};
}finally{
 if(c)await c.end();if(writer)await writer.end();
 if(dbOid){const row=(await admin.query('SELECT d.oid::text,r.oid::text AS owner_oid FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1',[name])).rows[0];assert.equal(row?.oid,dbOid);assert.equal(row?.owner_oid,roleOid);assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=$1::oid',[dbOid])).rows[0].n,0);await admin.query(`DROP DATABASE "${name}"`);}
 if(roleOid){assert.equal((await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0]?.oid,roleOid);await admin.query(`DROP ROLE "${name}"`);}
 await admin.end();await rm(directory,{recursive:true});
}
proof.allOwnedQaDatabaseRoleAndPrivateFilesRemoved=true;await writeFile('work/telemetry-capacity-20261019/sql-verification.json',JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify(proof));
