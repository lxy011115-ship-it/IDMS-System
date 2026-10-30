// Owns only randomly named QA databases. No customer records or identities change.
import pg from 'pg';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';
import {sparesSchema} from '../server/spares-db.ts';
import {spareCommand} from '../server/spares.ts';
import {canonical,digest} from '../server/imports.ts';
import {SpareAuditProofCache,spareProofGenerationSql,spareAuditProofCache} from '../server/spares-audit-proof.ts';
import {readSparesHistoryCurrent} from '../server/spares-history-db.ts';
import {SparesHistoryCollector,sparesHistoryPlan} from '../server/spares-history.ts';
import {installSpareQueryFixture} from './fixtures/spares-query-fixture.mjs';
import {spareTransaction,SpareCommitUnknown} from '../server/spares-transaction.ts';
import {verifySpareAuditFull} from '../server/spares-audit.ts';
import {SparesAuditChain} from '../server/spares-audit-chain.ts';
import {resident,sqlScheduler,requestResources} from '../server/capacity.ts';
import {trackSpareClient} from './fixtures/track-spares-client.mjs';

const attempt=randomBytes(6).toString('hex'),folder='work/spares-audit-proof-20261030/'+attempt;
await mkdir(folder,{recursive:true});
const runtime=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),accounts=JSON.parse(await readFile('.local/postgres-business.json','utf8')),app=accounts.tenants.acme;
const db='idms_spares_proof_qa_'+attempt,restoreDb=db+'_restore',marker='owned-spares-proof:'+attempt;
const quote=s=>'"'+s.replaceAll('"','""')+'"',boot={host:runtime.host,port:runtime.port,user:'idms_bootstrap',password:runtime.bootstrapPassword};
const admin=new pg.Client({...boot,database:'postgres'}),ctx={tenantId:'qa',actorId:'proof-clerk',actorType:'USER',authMode:'oidc',roles:['spare-parts-clerk'],correlationId:'owned-proof-synthetic'};
let owner,pool,restored;const created=[],caches=[spareAuditProofCache],checks=[],timings={},sql={metadataFetchMax:0,historyFetchMax:0,driverRetainedMax:0};
const fresh=(size)=>{const cache=new SpareAuditProofCache(size);caches.push(cache);return cache;};
const cached=fresh(),head=async c=>(await c.query("SELECT revision::text FROM idms_spares.state WHERE tenant_id='qa'")).rows[0].revision;
const verify=(cache=cached,source=pool,revision)=>spareTransaction(source,ctx,{},async c=>cache.verify(c,'qa',revision??await head(c)));
const delta=(cache,before)=>Object.fromEntries(['metadataRows','bodyRows','verifiedSegments','reusedSegments'].map(k=>[k,cache.snapshot()[k]-before[k]]));
await admin.connect();
try{
 await admin.query('CREATE DATABASE '+quote(db));created.push(db);await admin.query('COMMENT ON DATABASE '+quote(db)+" IS '"+marker+"'");
 owner=new pg.Client({...boot,database:db});await owner.connect();await owner.query(sparesSchema);await owner.query("INSERT INTO idms_spares.state VALUES('qa',0)");await installSpareQueryFixture(owner,'qa',app.user);
 await owner.query('GRANT CONNECT ON DATABASE '+quote(db)+' TO '+quote(app.user));await owner.query('GRANT USAGE ON SCHEMA idms_spares TO '+quote(app.user));await owner.query('GRANT SELECT ON idms_spares.events,idms_spares.state TO '+quote(app.user));
 const basePool=new pg.Pool({host:runtime.host,port:runtime.port,user:app.user,password:app.password,database:db,max:2,connectionTimeoutMillis:1000});
 pool={connect:async()=>trackSpareClient(await basePool.connect(),(q,promise)=>{
  if(q instanceof pg.Query){q.on('row',(_row,result)=>{sql.driverRetainedMax=Math.max(sql.driverRetainedMax,result?.rows?.length||0);});return;}
  if(String(q).startsWith('FETCH'))void promise.then(r=>{if(String(q).includes('proof_metadata'))sql.metadataFetchMax=Math.max(sql.metadataFetchMax,r.rows.length);else sql.historyFetchMax=Math.max(sql.historyFetchMax,r.rows.length);},()=>{});
 }),end:()=>basePool.end()};
 const rows=[];let previous='GENESIS';
 const makeEvent=()=>{const sequence=rows.length+1,site=sequence%3===1?'F2':'F1',action=site==='F2'?'supplier.create':'part.create',part=spareCommand({entities:[]},action,{siteCode:site,code:'PROOF-'+sequence,name:'合成验证备件 '+sequence,unit:'只',phone:'private-contact-needle'},ctx,{devices:[],orders:[]});const body=JSON.parse(JSON.stringify({tenantId:'qa',actor:ctx.actorId,action,at:new Date().toISOString(),correlationId:'owned-proof-seed',previousHash:previous,before:[null],after:[part]}));previous=digest(canonical(body));const row={sequence:String(sequence),site_code:site,body,hash:previous};rows.push(row);return row;};
 const insert=async records=>owner.query("INSERT INTO idms_spares.events SELECT 'qa',(r->>'sequence')::bigint,r->>'site_code',r->'body',r->>'hash' FROM jsonb_array_elements($1::jsonb) r",[JSON.stringify(records)]);
 for(let i=0;i<769;i++)makeEvent();const seedChain=new SparesAuditChain('qa');for(const row of rows)seedChain.accept(row);seedChain.finish('769');for(let i=0;i<rows.length;i+=128)await insert(rows.slice(i,i+128));await owner.query("UPDATE idms_spares.state SET revision=$1 WHERE tenant_id='qa'",[rows.length]);
 await spareTransaction(pool,ctx,{},c=>verifySpareAuditFull(c,'qa','769'));checks.push('domain-generated seed and persisted full-stream reference both verify');
 const start=performance.now();await verify();timings.coldMs=+(performance.now()-start).toFixed(2);assert.equal(cached.snapshot().bodyRows,769);assert.equal(cached.snapshot().entries,4);
 let before=cached.snapshot(),t=performance.now();await verify();timings.warmMs=+(performance.now()-t).toFixed(2);assert.deepEqual(delta(cached,before),{metadataRows:4,bodyRows:0,verifiedSegments:0,reusedSegments:4});checks.push('cold verifies every body; warm still scans all four metadata segments while reusing committed body proofs');
 await insert([makeEvent()]);await owner.query("UPDATE idms_spares.state SET revision=$1 WHERE tenant_id='qa'",[rows.length]);before=cached.snapshot();await verify();assert.deepEqual(delta(cached,before),{metadataRows:4,bodyRows:2,verifiedSegments:1,reusedSegments:3});checks.push('append revalidates only the changed partial segment and preserves continuous chain hashes');
 await owner.query("UPDATE idms_spares.events SET body=body||'{\"actor\":\"hidden-old-tamper\"}'::jsonb WHERE tenant_id='qa' AND sequence=1");await assert.rejects(verify(),e=>e.status===503);await owner.query("UPDATE idms_spares.events SET body=$1 WHERE tenant_id='qa' AND sequence=1",[rows[0].body]);await verify();checks.push('body tampering in an old hidden-site segment fails despite unchanged head revision and cached proof');
 for(const where of ['sequence=770','sequence=17','sequence BETWEEN 257 AND 512']){
  const removed=rows.filter(r=>where==='sequence=770'?r.sequence==='770':where==='sequence=17'?r.sequence==='17':+r.sequence>=257&&+r.sequence<=512);
  await owner.query("DELETE FROM idms_spares.events WHERE tenant_id='qa' AND "+where);await assert.rejects(verify(),e=>e.status===503);await insert(removed);await verify();
 }
 await owner.query("UPDATE idms_spares.events SET sequence=1027 WHERE tenant_id='qa' AND sequence=770");await assert.rejects(verify(),e=>e.status===503);await owner.query("UPDATE idms_spares.events SET sequence=770 WHERE tenant_id='qa' AND sequence=1027");await verify();checks.push('deleted tail, missing sequence, omitted full segment and moved sequence all fail complete-set validation');
 const rolled=fresh();await assert.rejects(spareTransaction(pool,ctx,{},async c=>{await rolled.verify(c,'qa',await head(c));throw Error('owned rollback probe');}),/owned rollback probe/);assert.equal(rolled.snapshot().entries,0);await verify(rolled);assert.equal(rolled.snapshot().bodyRows,1540);checks.push('proofs are discarded on rollback; next successful transaction performs a cold verification');
 const caught=fresh();await spareTransaction(pool,ctx,{},async c=>{await assert.rejects(caught.verify(c,'qa',String(rows.length+1)),e=>e.status===503);return null;});assert.equal(caught.snapshot().entries,0);checks.push('caught incomplete-chain failure cannot publish staged partial proofs even if caller commits');
 const unknown=fresh(),lost={async connect(){const c=await pool.connect();return new Proxy(c,{get(target,key){if(key==='query')return async(...args)=>{const result=await target.query(...args);if(args[0]==='COMMIT')throw Object.assign(Error('injected acknowledgement loss'),{code:'ECONNRESET'});return result;};return Reflect.get(target,key);}});}};
 await assert.rejects(spareTransaction(lost,ctx,{write:true},async c=>unknown.verify(c,'qa',await head(c))),e=>e instanceof SpareCommitUnknown);assert.equal(unknown.snapshot().entries,0);checks.push('confirmed-at-server but unacknowledged COMMIT never publishes a proof');
 const cancelled=fresh(),controller=new AbortController(),cancelPool={async connect(){const c=await pool.connect();return trackSpareClient(c,(q,promise)=>{if(q===spareProofGenerationSql)void promise.then(()=>controller.abort());});}};
 await assert.rejects(requestResources.run({signal:controller.signal},()=>verify(cancelled,cancelPool)),e=>e.status===499);assert.equal(cancelled.snapshot().entries,0);checks.push('cancellation between generation and metadata discards pending proof state');
 before=cached.snapshot();const generationBefore=(await owner.query(spareProofGenerationSql)).rows[0].relation_file;await owner.query('VACUUM FULL idms_spares.events');const generationAfter=(await owner.query(spareProofGenerationSql)).rows[0].relation_file;assert.notEqual(generationBefore,generationAfter);await verify();assert.equal(delta(cached,before).bodyRows,rows.length);checks.push('actual VACUUM FULL changes physical generation and invalidates every old segment proof');
 const evicted=fresh(2);await verify(evicted);assert.equal(evicted.snapshot().entries,2);before=evicted.snapshot();await verify(evicted);const eviction=delta(evicted,before);assert.ok(eviction.bodyRows>0&&eviction.bodyRows<rows.length);assert.equal(evicted.snapshot().entries,2);assert.ok(evicted.snapshot().bytes<=4096);checks.push('weighted two-entry eviction revalidates missing segments and keeps cache bytes bounded');
 // Concurrent old snapshot can overwrite a cache entry; metadata equality must still protect the next reader.
 const concurrent=fresh();let ready,release;const reached=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 const older=spareTransaction(pool,ctx,{},async c=>{const revision=await head(c);ready();await gate;return concurrent.verify(c,'qa',revision);});await reached;
 try{await insert([makeEvent()]);await owner.query("UPDATE idms_spares.state SET revision=$1 WHERE tenant_id='qa'",[rows.length]);await verify(concurrent);}finally{release();}await older;
 before=concurrent.snapshot();await verify(concurrent);assert.equal(delta(concurrent,before).bodyRows,3);checks.push('concurrent older snapshot publication causes safe revalidation rather than stale acceptance');
 const verifyCurrent=async c=>assert.equal((await c.query("SELECT revision FROM public.business_state WHERE tenant_id='qa'")).rows.length,1),restricted={...ctx,scope:{sites:['F1'],lines:['*'],devices:['*'],provided:true}},history=async(params='',actor=restricted)=>readSparesHistoryCurrent(pool,actor,new URLSearchParams(params),verifyCurrent);
 const first=await history('limit=7'),collector=new SparesHistoryCollector(restricted,{devices:[],orders:[]},sparesHistoryPlan(new URLSearchParams('limit=7')));for(const row of rows)collector.accept(row);assert.deepEqual(first.items,collector.finish(String(rows.length)).items);assert.ok(first.nextBefore.includes('.'));
 const second=await history('limit=7&before='+encodeURIComponent(first.nextBefore)),secondCollector=new SparesHistoryCollector(restricted,{devices:[],orders:[]},sparesHistoryPlan(new URLSearchParams('limit=7&before='+first.items.at(-1).sequence)));for(const row of rows)secondCollector.accept(row);assert.deepEqual(second.items,secondCollector.finish(String(rows.length)).items);assert.ok(!second.items.some(item=>first.items.some(prior=>item.sequence===prior.sequence)));
 assert.equal((await history('q=private-contact-needle',ctx)).items.length,0);assert.equal((await history('q=PROOF-771')).items.length,1);checks.push('current SQL history signed pages equal full reference, keep numeric order, and search only public summaries');
 await owner.query("UPDATE public.business_state SET revision=2 WHERE tenant_id='qa'");await assert.rejects(history('limit=7&before='+encodeURIComponent(first.nextBefore)),e=>e.status===409);await owner.query("UPDATE public.business_state SET revision=1 WHERE tenant_id='qa'");
 await owner.query("UPDATE idms_spares.state SET revision=772 WHERE tenant_id='qa'");await assert.rejects(history('limit=7&before='+encodeURIComponent(first.nextBefore)),e=>e.status===409);await owner.query("UPDATE idms_spares.state SET revision=771 WHERE tenant_id='qa'");await assert.rejects(history('before=10'),e=>e.status===400);checks.push('history rejects numeric unsigned anchors and expires signed pages when either business revision changes');
 await owner.query("UPDATE idms_spares.events SET body=body||'{\"actor\":\"hidden-history-tamper\"}'::jsonb WHERE tenant_id='qa' AND sequence=1");await assert.rejects(history('limit=1'),e=>e.status===503);await owner.query("UPDATE idms_spares.events SET body=$1 WHERE tenant_id='qa' AND sequence=1",[rows[0].body]);await history('limit=1');checks.push('warm current history still rejects a changed hidden old segment before returning a page');
 // Actual dump/restore into another owned database, retaining cache from the source.
 const exec=promisify(execFile),exe=name=>process.env.LOCALAPPDATA+'/IDMS/runtime/pgsql/bin/'+name+'.exe',dump=folder+'/proof.dump',env={...process.env,PGHOST:String(runtime.host),PGPORT:String(runtime.port),PGUSER:boot.user,PGPASSWORD:boot.password,PGDATABASE:db};
 await exec(exe('pg_dump'),['--format=custom','--no-owner','--no-acl','--no-password','--file='+dump],{env,windowsHide:true});await admin.query('CREATE DATABASE '+quote(restoreDb));created.push(restoreDb);await admin.query('COMMENT ON DATABASE '+quote(restoreDb)+" IS '"+marker+"'");
 await exec(exe('pg_restore'),['--dbname='+restoreDb,'--no-owner','--no-acl','--no-password','--exit-on-error','--single-transaction',dump],{env,windowsHide:true});
 restored=new pg.Pool({...boot,database:restoreDb,max:1});before=cached.snapshot();await verify(cached,restored);assert.equal(delta(cached,before).bodyRows,rows.length);await spareTransaction(restored,ctx,{},c=>verifySpareAuditFull(c,'qa',String(rows.length)));checks.push('real pg_dump/pg_restore target has a different database generation and cold full-body verification matches the complete-stream reference');
 const childRuns=[];for(let i=0;i<2;i++){const child=await exec(process.execPath,['scripts/fixtures/spares-proof-child.mjs',db,marker],{windowsHide:true});childRuns.push(JSON.parse(child.stdout));}assert.ok(childRuns.every(r=>r.initialEntries===0&&r.bodyRows===rows.length));checks.push('two actual separate Node processes begin with empty proof caches and cold-verify every event without a persisted trust checkpoint');
 assert.ok(sql.metadataFetchMax<=16);assert.ok(sql.historyFetchMax<=32);assert.equal(sql.driverRetainedMax,0);assert.equal(sqlScheduler.snapshot().active,0);assert.equal(sqlScheduler.snapshot().pending,0);assert.equal(resident.snapshot().categories.task,0);
 const cacheBytes=caches.reduce((n,c)=>n+c.snapshot().bytes,0);assert.equal(resident.snapshot().categories.cache,cacheBytes);for(const c of caches)c.clear();assert.equal(resident.snapshot().total,0);checks.push('metadata batches max16, body driver retains zero rows, task accounting drains and cache bytes exactly match resident accounting');
 await writeFile(folder+'/verification.json',JSON.stringify({passed:true,date:new Date().toISOString(),checks,timings,sql,eventCount:rows.length,customerBusinessWrites:0,realAccountChanges:0,productionAcceptance:false},null,2));
 console.log(JSON.stringify({passed:true,evidence:folder,checks:checks.length,timings,sql,eventCount:rows.length}));
}catch(error){await writeFile(folder+'/failure.json',JSON.stringify({checks,error:{name:error.name,code:error.code,message:error.message}},null,2));throw error;}
finally{
 for(const c of caches)c.clear();await restored?.end();await pool?.end();await owner?.end();
 try{for(const name of created.reverse()){
  if(!new RegExp('^idms_spares_proof_qa_'+attempt+'(?:_restore)?$').test(name))throw Error('Unsafe owned QA name');
  const proof=(await admin.query("SELECT shobj_description(oid,'pg_database') AS marker,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=$1) AS connections FROM pg_database WHERE datname=$1",[name])).rows[0];
  assert.equal(proof?.marker,marker);assert.equal(proof.connections,0);await admin.query('DROP DATABASE '+quote(name));
 }await writeFile(folder+'/cleanup.json',JSON.stringify({ownedDatabasesRemoved:created.length,forcedDisconnects:0,customerBusinessWrites:0}));}finally{await admin.end();}
}
