import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {stateMapSchemaSql,inspectStateMapCatalog} from './state-map-schema-v1.mjs';
import {PostgresStateMapV1,StateMapCommitUnknownError} from '../server/state-map-sql-v1.ts';
import {createCommitReplyLossProxy} from './fixtures/state-map-commit-proxy.mjs';
import {stateKey,stateValueText,stateValueHash,stateRequestDigest,stateEmptyHashes,rebuildStateRoot,verifyStateProof} from '../server/state-map-v1.ts';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
const main=JSON.parse((await readFile('.local/postgres-runtime.json','utf8')).replace(/^\uFEFF/,'')),nonce=randomUUID().replaceAll('-','').slice(0,12),work=resolve('work/incremental-state-20261019',nonce);
await privateDirectory(work);const adminConfig={host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:'postgres'},admin=new pg.Client(adminConfig),pins={nonce,databases:[],roles:[]},tenants=[],connections=new Set(),checks=[],scales=[];
const sourceNames=['server/state-map-v1.ts','server/state-map-v1.test.ts','server/state-map-sql-v1.ts','server/state-map-catalog-v1.ts','scripts/state-map-schema-v1.mjs','scripts/state-map-v1.sql','scripts/verify-state-map-postgres.mjs','scripts/cleanup-state-map-qa.mjs','scripts/fixtures/state-map-commit-proxy.mjs'],sourcePins=[];
for(const name of sourceNames){const data=await readFile(name),path=join(work,'input-source',name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,data,{flag:'wx'});sourcePins.push({path:name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});}
const journal=()=>writeFile(join(work,'owned-resources.private.json'),JSON.stringify(pins,null,2));
const ident=v=>{assert.match(v,/^idms_smtqa_[a-z0-9_]+$/);return '"'+v+'"';};
const connect=async config=>{const c=new pg.Client(config);await c.connect();connections.add(c);return c;};
const close=async c=>{await c.end();connections.delete(c);};
const sqlValue=async(c,sql,args=[])=>{const r=await c.query(sql,args);return r.rows[0]?.value;};
const raw=h=>h===null?null:Buffer.from(h,'hex');
const direct=async(c,t,command)=>sqlValue(c,'SELECT state_map_v1.apply_delta_v1($1,$2,$3,$4,$5::jsonb) AS value',[t.tenant,command.commandId,command.expectedRevision,raw(command.expectedRoot),JSON.stringify(command.operations)]);
const command=(t,head,operations)=>({tenantId:t.tenant,commandId:randomUUID(),expectedRevision:head.revision,expectedRoot:head.rootHash,operations});
const operation=(key,valueText,expected=null,namespace='asset')=>({namespace,key,valueText,expected});
const denied=async(fn,pattern)=>{await assert.rejects(fn,pattern);};
const map=new Map();let report;
await admin.connect();
try{
 for(const tenant of ['tenantalpha','tenantbeta']){
  const base='idms_smtqa_'+nonce+'_'+tenant.slice(-5),owner=base+'_o',app=base+'_a',reader=base+'_r',database=base+'_db',password=randomBytes(32).toString('base64url'),readerPassword=randomBytes(32).toString('base64url');
  for(const [name,login,pw] of [[owner,false,null],[app,true,password],[reader,true,readerPassword]]){
   assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).rowCount,0);
   await admin.query(`CREATE ROLE ${ident(name)} ${login?'LOGIN PASSWORD '+"'"+pw+"'":'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
   pins.roles.push({name,oid:(await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0].oid});await journal();
  }
  assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0);
  await admin.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(owner)} TEMPLATE template0 ENCODING 'UTF8'`);
  const databaseOid=(await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1',[database])).rows[0].oid;pins.databases.push({name:database,oid:databaseOid,owner});await journal();
  await admin.query(`REVOKE ALL ON DATABASE ${ident(database)} FROM PUBLIC`);await admin.query(`GRANT CONNECT,TEMP ON DATABASE ${ident(database)} TO ${ident(app)},${ident(reader)}`);
  const root=await connect({...adminConfig,database});await root.query('BEGIN');try{await root.query(await stateMapSchemaSql({tenant,owner,app,reader}));await root.query('COMMIT');}catch(e){await root.query('ROLLBACK');throw e;}
  const account={host:main.host,port:main.port,user:app,password,database},readAccount={...account,user:reader,password:readerPassword},binding={tenantId:tenant,databaseOid,roleOid:pins.roles.find(r=>r.name===app).oid,catalogHash:await inspectStateMapCatalog(root)};
  const client=new PostgresStateMapV1(account,binding),readClient=new PostgresStateMapV1(readAccount,{...binding,roleOid:pins.roles.find(r=>r.name===reader).oid});
  tenants.push({tenant,owner,app,reader,database,account,readAccount,binding,client,readClient,root});
  const h=await client.head();assert.equal(h.revision,'0');assert.equal(h.rootHash,stateEmptyHashes[0]);
 }
 checks.push('twoFreshOwnedDatabasesAndMinimalRoles');const t=tenants[0],other=tenants[1];
 let head=await t.client.head();const initial=command(t,head,[operation('中文😀',stateValueText({name:'机床',n:0})),operation('a','null'),operation('b',' { "b": 2, "a": [true] } '),operation('audit1','{"action":"CREATED"}',null,'audit')]);
 let receipt=await t.client.apply(initial);assert.equal(receipt.replayed,false);assert.equal(receipt.requestHash,stateRequestDigest(t.tenant,initial.commandId,initial.expectedRevision,initial.expectedRoot,initial.operations));
 for(const o of initial.operations)map.set(stateKey(t.tenant,o.namespace,o.key),stateValueHash(o.valueText));
 assert.deepEqual({rootId:receipt.rootId,rootHash:receipt.rootHash,count:receipt.count},rebuildStateRoot(map));const oldRoot={rootId:receipt.rootId,rootHash:receipt.rootHash,count:receipt.count};
 for(const o of initial.operations){const p=await t.readClient.proof(o.namespace,o.key,oldRoot);assert.equal(p.result.present,true);assert.equal(p.result.valueHash,stateValueHash(o.valueText));}
 assert.equal((await t.client.proof('asset','missing',oldRoot)).result.present,false);checks.push('sqlBinaryCodecIndependentFullRootAndMemberAbsentProofs');
 const replay=await t.client.apply(initial);assert.equal(replay.replayed,true);assert.equal(replay.receiptHash,receipt.receiptHash);assert.equal((await t.client.head()).revision,'1');
 await denied(()=>t.client.apply({...initial,operations:[operation('different','true')]}),/COMMAND_CONFLICT/);
 const cross=await connect(t.account);await denied(()=>sqlValue(cross,'SELECT state_map_v1.read_receipt_v1($1,$2,$3) AS value',[other.tenant,initial.commandId,raw(receipt.requestHash)]),/AUTHORITY/);
 await denied(()=>direct(cross,other,{...initial,tenantId:other.tenant}),/AUTHORITY/);await close(cross);
 await denied(()=>other.client.proof('asset','a',oldRoot),/no rows|PROOF|integrity/i);
 checks.push('tenantBeforeReceiptReplayAndDifferentRequestRefusal');
 // All-or-nothing even after a first valid operation allocated immutable nodes.
 head=await t.client.head();const beforeCounts=(await t.root.query('SELECT (SELECT count(*) FROM state_map_v1.nodes)::text AS nodes,(SELECT count(*) FROM state_map_v1.kv_values)::text AS values,(SELECT count(*) FROM state_map_v1.receipts)::text AS receipts')).rows[0];
 await denied(()=>t.client.apply(command(t,head,[operation('first-valid','{}'),operation('a','true','f'.repeat(64))])),/KEY_CONFLICT/);
 assert.deepEqual(await t.client.head(),head);assert.deepEqual((await t.root.query('SELECT (SELECT count(*) FROM state_map_v1.nodes)::text AS nodes,(SELECT count(*) FROM state_map_v1.kv_values)::text AS values,(SELECT count(*) FROM state_map_v1.receipts)::text AS receipts')).rows[0],beforeCounts);
 await denied(()=>t.client.apply(command(t,head,[operation('audit1','null',stateValueHash(initial.operations[3].valueText),'audit')])),/IMMUTABLE_KEY/);
 const rollback=command(t,head,[operation('uncommitted','true')]),rollbackConn=await connect(t.account);await rollbackConn.query('BEGIN');const uncommitted=await direct(rollbackConn,t,rollback);assert.equal(uncommitted.revision,'2');assert.equal(await t.client.resolve(rollback),null);await rollbackConn.query('ROLLBACK');await close(rollbackConn);assert.equal(await t.client.resolve(rollback),null);assert.deepEqual(await t.client.head(),head);checks.push('failedMultiOpAndCallerRollbackLeaveNoNodesValuesHeadOrReceipt');
 const raceA=command(t,head,[operation('raceA','1')]),raceB=command(t,head,[operation('raceB','2')]),race=await Promise.allSettled([t.client.apply(raceA),t.client.apply(raceB)]);
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.match(race.find(r=>r.status==='rejected').reason.message,/CAS_CONFLICT/);const winner=race[0].status==='fulfilled'?raceA:raceB;map.set(stateKey(t.tenant,'asset',winner.operations[0].key),stateValueHash(winner.operations[0].valueText));
 head=await t.client.head();const same=command(t,head,[operation('same','{"n":1}')]),twins=await Promise.all([t.client.apply(same),t.client.apply(same)]);assert.equal(twins.filter(r=>r.replayed).length,1);assert.equal(twins[0].receiptHash,twins[1].receiptHash);map.set(stateKey(t.tenant,'asset','same'),stateValueHash(same.operations[0].valueText));
 const reconnected=new PostgresStateMapV1(t.account,t.binding);assert.equal((await reconnected.resolve(same)).receiptHash,twins[0].receiptHash);assert.equal((await reconnected.resolve(initial)).receiptHash,receipt.receiptHash);checks.push('concurrentRootCasOneWinnerSameCommandOnceAndReconnectResolve');
 head=await t.client.head();const uncertain=command(t,head,[operation('commit-uncertain','{"committed":true}')]),proxy=await createCommitReplyLossProxy(main.host,main.port);
 try{const faulty=new PostgresStateMapV1({...t.account,host:'127.0.0.1',port:proxy.port,ssl:false},t.binding);await denied(()=>faulty.apply(uncertain),e=>e instanceof StateMapCommitUnknownError&&e.commandId===uncertain.commandId);assert.equal(proxy.observedCommit,true);assert.equal(proxy.connections,1);const resolved=await t.client.resolve(uncertain);assert.equal(resolved.replayed,true);assert.equal((await t.client.apply(uncertain)).receiptHash,resolved.receiptHash);map.set(stateKey(t.tenant,'asset','commit-uncertain'),stateValueHash(uncertain.operations[0].valueText));}finally{await proxy.close();}
 checks.push('actualServerCommitReplyLostClientReportsUnknownAndReconnectResolvesOnce');
 // Update and delete must compress the tree and preserve historical root proofs.
 head=await t.client.head();const edits=command(t,head,[operation('a','false',stateValueHash('null')),operation('b',null,stateValueHash(initial.operations[2].valueText))]);await t.client.apply(edits);map.set(stateKey(t.tenant,'asset','a'),stateValueHash('false'));map.delete(stateKey(t.tenant,'asset','b'));
 assert.equal((await t.client.proof('asset','a',oldRoot)).result.value,null);assert.equal((await t.client.proof('asset','b',oldRoot)).result.present,true);head=await t.client.head();assert.deepEqual({rootId:head.rootId,rootHash:head.rootHash,count:head.count},rebuildStateRoot(map));checks.push('updateDeleteCompressionAndOldRootProofSurviveReconnect');
 const app=await connect(t.account),reader=await connect(t.readAccount);
 for(const sql of ["UPDATE state_map_v1.head SET revision=0","DELETE FROM state_map_v1.nodes","TRUNCATE state_map_v1.receipts","INSERT INTO state_map_v1._ctx VALUES(pg_backend_pid(),txid_current())","SELECT state_map_v1._leaf(decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex'))",`SET ROLE ${ident(t.owner)}`,"CREATE TABLE state_map_v1.evil(x int)","SET session_replication_role='replica'"]){await denied(()=>app.query(sql),/permission denied|must be|not permitted/);}
 await denied(()=>direct(reader,t,command(t,head,[operation('reader','true')])),/permission denied/);
 await app.query('CREATE TEMP TABLE head(singleton boolean,revision bigint)');await app.query('CREATE TEMP TABLE nodes(id bytea)');await app.query('SET search_path=pg_temp,public,state_map_v1');assert.deepEqual(await sqlValue(app,'SELECT state_map_v1.read_head_v1($1) AS value',[t.tenant]),head);await close(app);await close(reader);checks.push('directDmlPrivateContextInternalFunctionRoleReplicaReaderDeniedAndTempHijackSafe');
 // Use the SQL boundary directly, bypassing the normal Node validator.
 const rawApp=await connect(t.account);
 for(const vt of ['{"x":1,"x":2}','{"x":1,"\\u0078":2}','[1,]','"\\ud800"','"\\u0000"','1e999','['.repeat(130)+'0'+']'.repeat(130)])await denied(()=>direct(rawApp,t,command(t,head,[operation('raw-bad',vt)])),/INVALID|invalid|unsupported|Unicode|VALUE_LIMIT|out of range/);
 await denied(()=>direct(rawApp,t,command(t,head,[operation('duplicate','0'),operation('duplicate','1')])),/DUPLICATE_KEY/);
 await denied(()=>direct(rawApp,t,command(t,head,Array.from({length:65},(_,i)=>operation('op-'+i,'true')))),/INVALID/);
 await denied(()=>direct(rawApp,t,command(t,head,[operation('large',JSON.stringify('x'.repeat(1048576)))])),/VALUE_LIMIT/);
 const maximumValue=JSON.stringify('x'.repeat(1048574));await denied(()=>direct(rawApp,t,command(t,head,Array.from({length:9},(_,i)=>operation('many-'+i,maximumValue)))),/VALUE_LIMIT/);
 await close(rawApp);assert.deepEqual(await t.client.head(),head);checks.push('sqlRejectsDuplicateDecodedJsonKeysInvalidUnicodeAndDuplicateOperationsAndSizeLimits');
 // Larger histories: independently rebuild every checkpoint; count accessed nodes per write.
 for(const target of [64,256,1024]){
  while(map.size<target){head=await t.client.head();const count=Math.min(32,target-map.size),start=map.size,ops=Array.from({length:count},(_,i)=>operation('scale-'+(start+i),stateValueText({index:start+i,source:'synthetic-qa'}))),r=await t.client.apply(command(t,head,ops));for(const o of ops)map.set(stateKey(t.tenant,o.namespace,o.key),stateValueHash(o.valueText));assert.equal(r.rootHash,rebuildStateRoot(map).rootHash);}
  head=await t.client.head();const key='scale-update',old=(await t.client.proof('asset',key,head)).result.valueHash,r=await t.client.apply(command(t,head,[operation(key,String(target),old)]));map.set(stateKey(t.tenant,'asset',key),stateValueHash(String(target)));assert.equal(r.rootHash,rebuildStateRoot(map).rootHash);assert.ok(r.diagnostics.nodeReads<300);scales.push({liveKeys:map.size,nodeReadsForOneKey:r.diagnostics.nodeReads,totalStoredNodes:Number((await t.root.query('SELECT count(*)::text AS n FROM state_map_v1.nodes')).rows[0].n)});
 }
 checks.push('scaleRootsIndependentlyRebuiltWithBoundedPathNodeReads');
 // Full deletion to empty on the second tenant, without truncation/history deletion.
 let h2=await other.client.head();const small=command(other,h2,[operation('a','true'),operation('b','false')]);await other.client.apply(small);h2=await other.client.head();await other.client.apply(command(other,h2,[operation('a',null,stateValueHash('true')),operation('b',null,stateValueHash('false'))]));assert.equal((await other.client.head()).rootHash,stateEmptyHashes[0]);checks.push('deleteAllReturnsExactEmptyRoot');
 // Always triggers reject privileged ordinary writes, including replication mode.
 await denied(()=>t.root.query('UPDATE state_map_v1.kv_values SET value_text=\'null\''),/DIRECT_WRITE_FORBIDDEN/);await t.root.query("SET session_replication_role='replica'");try{await denied(()=>t.root.query('TRUNCATE state_map_v1.receipts'),/DIRECT_WRITE_FORBIDDEN/);}finally{await t.root.query("SET session_replication_role='origin'");}
 // Current role attributes are checked, not accepted from a cached receipt.
 await t.root.query(`ALTER ROLE ${ident(t.reader)} BYPASSRLS`);try{
  await denied(()=>t.client.resolve(initial),/CATALOG_DRIFT/);const escalated=await connect(t.account);try{await denied(()=>sqlValue(escalated,'SELECT state_map_v1.read_receipt_v1($1,$2,$3) AS value',[t.tenant,initial.commandId,raw(receipt.requestHash)]),/AUTHORITY/);}finally{await close(escalated);}
 }finally{await t.root.query(`ALTER ROLE ${ident(t.reader)} NOBYPASSRLS`);}assert.equal((await t.client.resolve(initial)).receiptHash,receipt.receiptHash);checks.push('currentRolePrivilegeDriftRefusesReplay');
 // A read transaction holds relation locks: DDL waits, then rollback still poisons epoch.
 const held=await connect(other.account);await held.query('BEGIN READ ONLY');await sqlValue(held,'SELECT state_map_v1.read_head_v1($1) AS value',[other.tenant]);const ddlPid=(await other.root.query('SELECT pg_backend_pid() AS n')).rows[0].n;
 await other.root.query('BEGIN');const waiting=other.root.query('ALTER TABLE state_map_v1.kv_values DISABLE TRIGGER state_map_write_guard');
 try{let observed=false;for(let i=0;i<100;i++){const row=(await admin.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1',[ddlPid])).rows[0];if(row?.wait_event_type==='Lock'&&row.wait_event==='advisory'){observed=true;break;}await new Promise(ok=>setTimeout(ok,20));}assert.equal(observed,true);await held.query('COMMIT');await waiting;}finally{await close(held);await other.root.query('ROLLBACK');}
 const bconn=await connect(other.account);await denied(()=>sqlValue(bconn,'SELECT state_map_v1.read_head_v1($1) AS value',[other.tenant]),/SCHEMA_EPOCH/);await close(bconn);checks.push('alwaysTriggersAndRolledBackDisableStillPoisonsEpoch');
 checks.push('concurrentDisableDdlWaitsForProtectedReadTransaction');
 // Disable -> untouched-value tamper -> reenable: catalog matches old, epoch must reject replay.
 const pinnedCatalog=t.binding.catalogHash;await t.root.query('ALTER TABLE state_map_v1.kv_values DISABLE TRIGGER state_map_write_guard');await t.root.query("UPDATE state_map_v1.kv_values SET value_text='false' WHERE value_hash=$1",[raw(stateValueHash(initial.operations[0].valueText))]);await t.root.query('ALTER TABLE state_map_v1.kv_values ENABLE ALWAYS TRIGGER state_map_write_guard');assert.equal(await inspectStateMapCatalog(t.root),pinnedCatalog);
 const tampered=await connect(t.account);await denied(()=>direct(tampered,t,initial),/SCHEMA_EPOCH/);await denied(()=>sqlValue(tampered,'SELECT state_map_v1.read_receipt_v1($1,$2,$3) AS value',[t.tenant,initial.commandId,raw(receipt.requestHash)]),/SCHEMA_EPOCH/);await close(tampered);await denied(()=>t.client.apply(initial),/SCHEMA_EPOCH/);checks.push('disableTamperReenableRefusesOldSuccessfulReplayWithoutBlindReseal');
 report={verifiedAt:new Date().toISOString(),format:'COMPRESSED_SMT_COUNTED_V1',sourcePins,checks,scales,actualDdlWaitWasAdvisory:true,actualCommitAcknowledgementLost:true,originalDatabasesMigrated:false,businessIntegrationComplete:false,retentionImplemented:false,productionAcceptance:false};
}finally{
 for(const c of connections)await close(c);
 for(const pin of pins.databases){const row=(await admin.query('SELECT oid::text,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[pin.name])).rows[0];assert.equal(row?.oid,pin.oid);assert.equal(row?.owner,pin.owner);let n;for(let i=0;i<80;i++){n=(await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=$1::oid',[pin.oid])).rows[0].n;if(!n)break;await new Promise(ok=>setTimeout(ok,50));}assert.equal(n,0);await admin.query(`DROP DATABASE ${ident(pin.name)}`);}
 for(const pin of pins.roles.toReversed()){assert.equal((await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[pin.name])).rows[0]?.oid,pin.oid);await admin.query(`DROP ROLE ${ident(pin.name)}`);}
 await admin.end();await privateNewFile(join(work,'cleanup.json'),JSON.stringify({at:new Date().toISOString(),ownedDatabases:pins.databases.length,ownedRoles:pins.roles.length,allOwnedRemoved:true,noForceOrBackendTermination:true}));
}
report.allOwnedDatabasesAndRolesRemoved=true;await privateNewFile(join(work,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({work,...report}));
