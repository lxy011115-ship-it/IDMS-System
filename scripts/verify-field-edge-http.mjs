import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {fork} from 'node:child_process';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';

const scratch='work/field-channel-20261017',iso=n=>new Date(n).toISOString();
if(process.argv.includes('--worker')){
 if(process.env.NODE_ENV!=='test'||!/^fieldedgeqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned field-policy QA required');
 await worker();
}else await main();

async function main(){
 const {telemetryQualityFixture}=await import('./fixtures/telemetry-quality-model.mjs'),{migrateQaDatabases,cleanupQaRoles,qaAdminAccount}=await import('./qa-database.mjs');
 const {readEntities}=await import('../server/entity-repository.ts'),{memoryTask}=await import('../server/capacity.ts'),{canonical,digest}=await import('../server/imports.ts');
 await mkdir(scratch,{recursive:true});const suffix=randomUUID().replaceAll('-','').slice(0,10),root=JSON.parse(await readFile('.local/postgres-runtime.json')),config={host:root.host,port:root.port,tenants:{}},admin=new pg.Client({host:root.host,port:root.port,user:'idms_bootstrap',password:root.bootstrapPassword,database:'postgres'}),accounts=[],privatePath=resolve(scratch,'private-'+suffix+'.json'),runtimePath=resolve(scratch,'runtime-'+suffix+'.json');
 const original=async()=>{const out={};for(const [tenant,a]of Object.entries(root.tenants)){const c=new pg.Client({host:root.host,port:root.port,...a});await c.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const p=await memoryTask(()=>readEntities(c,tenant),true);out[tenant]={business:digest(canonical(p.payload.business)),imports:digest(canonical(p.payload.imports)),migrations:(await c.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows,...(tenant==='acme'?{state:(await c.query('SELECT * FROM business_state')).rows}:{}),tableCount:(await c.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].n};await c.query('COMMIT');}finally{await c.end();}}return out;};
 const before=await original();await admin.connect();try{
  for(const tenant of ['acme','sandbox']){const name='idms_fieldedgeqa_'+tenant+'_'+suffix,a={user:name,database:name,password:randomBytes(32).toString('base64url')};accounts.push(a);config.tenants[tenant]=a;await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${a.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);}
  const f=telemetryQualityFixture({count:0}),runtime=await migrateQaDatabases(config,root,{snapshot:f.snapshot,telemetryTenants:['acme','sandbox']});await writeFile(runtimePath,JSON.stringify(runtime));await writeFile(privatePath,JSON.stringify({sources:f.sources,admin:qaAdminAccount(root,config.tenants.acme),backupConfig:config}));
  const proof=await new Promise((ok,no)=>{const child=fork(new URL(import.meta.url),['--worker'],{env:{...process.env,NODE_ENV:'test',IDMS_AUTH_MODE:'demo',IDMS_TELEMETRY_CONFIG:'',IDMS_FIELD_PLATFORM_CONFIG:'',IDMS_WORKFLOW_CLIENT_CONFIG:'',IDMS_AI_CLIENT_CONFIG:'',IDMS_PREDICTOR_URL:'',IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:runtimePath,IDMS_DEMO_NAMESPACE:'fieldedgeqa-'+suffix,IDMS_FIELD_QA_PRIVATE:privatePath},stdio:['ignore','pipe','pipe','ipc']});let result,diagnostic='';child.stdout.on('data',b=>diagnostic+=b);child.stderr.on('data',b=>diagnostic+=b);child.on('message',m=>{if(m.type==='PROOF')result=m.value;});child.once('error',no);child.once('exit',(code,signal)=>code===0&&result?ok(result):no(Error('Field edge HTTP QA child failed '+code+'/'+signal+'\n'+diagnostic)));});
  assert.deepEqual(await original(),before);proof.originalNormalizedBusinessImportsMigrationsAndTablesUntouched=true;proof.originalAcmeExactStateUntouched=true;await writeFile(scratch+'/edge-http-verification.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
 }finally{for(const a of accounts){assert.match(a.database,new RegExp('^idms_fieldedgeqa_(acme|sandbox)_'+suffix+'$'));await admin.query('DROP DATABASE IF EXISTS "'+a.database+'" WITH (FORCE)');await admin.query('DROP ROLE IF EXISTS "'+a.user+'"');}await cleanupQaRoles(admin,config);await admin.end();await rm(privatePath,{force:true});await rm(runtimePath,{force:true});}
}

async function worker(){
 const staleServices=[];


 const {createServer}=await import('node:http'),{generateKeyPairSync}=await import('node:crypto'),{dirname,basename,relative,isAbsolute}=await import('node:path'),{seedStore}=await import('../server/store.ts'),{loadImports,mutate,waitForWrites,clearWorkspaceCache}=await import('../server/import-api.ts'),{tenantPool,closePostgres}=await import('../server/postgres-repository.ts'),{fieldIssuanceModel,fieldManifest}=await import('./fixtures/field-issuance-model.mjs'),{createTemplate,submitTemplate,approveTemplate}=await import('../server/catalog.ts'),{createFieldOpcuaServer}=await import('./fixtures/field-opcua-server.mjs'),{FieldLeaseClient}=await import('../services/field/lease-client.ts'),{LeasedFieldReadOnlyClient}=await import('../services/field/leased-readonly.ts'),{signFieldCheckRequest,verifyFieldCheck}=await import('../integrations/field-check.ts'),{resident}=await import('../server/capacity.ts'),{canonical}=await import('../server/imports.ts');




 const qa=await createFieldOpcuaServer(),{sources}=JSON.parse(await readFile(process.env.IDMS_FIELD_QA_PRIVATE)),source=structuredClone(sources[0]),store=seedStore(),key=generateKeyPairSync('ed25519'),requestKey=randomBytes(32),directory=resolve(dirname(process.env.IDMS_FIELD_QA_PRIVATE),'edge-'+randomUUID().replaceAll('-','').slice(0,10)),owned=[],state={lease:0,check:0,hold:false,held:[]},sockets=new Set(),pause=ms=>new Promise(ok=>setTimeout(ok,ms)),until=async(fn,label)=>{const stop=Date.now()+8000;



while(Date.now()<stop){if(await fn())return;



await pause(10);



}throw Error('Owned edge QA expired '+label);



};



let server,runtime;




 await mkdir(directory,{recursive:true});



try{
  await loadImports(store);



source.points=source.points.map((p,i)=>({...p,nodeId:qa.point(i?'native-Double':'pressure').nodeId}));



const seed=structuredClone(qa.profile);



seed.points=source.points.map(p=>({...qa.profile.points[0],...p}));



const model=await mutate(store,(_c,w)=>{const m=fieldIssuanceModel(w.store,w.imports,source,seed);



return {profile:m.profile,policy:m.policy,author:m.author,reviewer:m.reviewer};



},'acme'),privateProfile=structuredClone(seed),{origin,...identity}=model.profile.source;



privateProfile.source=identity;



privateProfile.points=structuredClone(model.profile.points);



await writeFile(resolve(directory,'signer.pem'),key.privateKey.export({type:'pkcs8',format:'pem'}));



await writeFile(resolve(directory,'request.bin'),requestKey);



const config={format:'idms-field-platform-config-v1',leaseSigningKeyFile:'signer.pem',tenants:[{tenantId:'acme',channels:[{profile:model.profile,requestKeyFile:'request.bin'}]}]},configFile=resolve(directory,'platform.json');



await writeFile(configFile,JSON.stringify(config));



process.env.IDMS_FIELD_PLATFORM_CONFIG=configFile;



runtime=await import('../server/index.ts');



server=createServer((req,res)=>{if(req.url==='/api/v1/field-channel/lease')state.lease++;



if(req.url==='/api/v1/field-channel/lease/check'){state.check++;



if(state.hold){state.held.push(()=>{if(!req.destroyed&&!res.destroyed)void runtime.handler(req,res);



});



return;



}}void runtime.handler(req,res);



});



server.on('connection',s=>{sockets.add(s);



s.on('close',()=>sockets.delete(s));



});



await new Promise(ok=>server.listen(0,'127.0.0.1',ok));



const url='http://127.0.0.1:'+server.address().port+'/api/v1/field-channel/lease',pool=tenantPool('acme'),make=()=>{const sdk=new FieldLeaseClient({profile:model.profile,requestKey,platformPublicKey:key.publicKey,url,timeoutMs:3000}),reader=new LeasedFieldReadOnlyClient(privateProfile,qa.materials,sdk);



owned.push({sdk,reader});



return {sdk,reader};



},image=async()=>({root:(await pool.query('SELECT * FROM business_state')).rows,audits:(await pool.query('SELECT * FROM audit_ledger ORDER BY sequence_no')).rows}),publish=async(version,paused)=>mutate(store,(_c,w)=>{const p=structuredClone(model.policy);



p.changeIntent='RETROSPECTIVE_CORRECTION';



if(paused)p.entries[0].admission=null;



p.entries[0].reason=paused?'SDK核对明确暂停':'SDK核对明确恢复';



const t=createTemplate(w.store,{templateKey:'issuer-qa-field',version,industry:'自有签发QA',manifest:fieldManifest('field-channel-policy','fieldChannelPolicy',p)},model.author,w.imports),e=t=>({expectedRevision:t.revision,expectedDigest:t.contentDigest});



submitTemplate(w.store,t.id,e(t),model.author,w.imports);



approveTemplate(w.store,t.id,{...e(t),decision:'APPROVED',comment:'独立核对SDK真实链路'},model.reviewer,w.imports);



return t;



},'acme'),postCheck=async lease=>{const request=signFieldCheckRequest({format:'idms-field-lease-check-request-v1',requestId:randomUUID(),requestedAtMs:Date.now(),lease},requestKey),response=await fetch(url+'/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)}),body=await response.json();



return {request,response,body};



};




  const first=make(),lease=await first.sdk.ensureLease(),before=canonical(await image());



for(let i=0;



i<3;



i++)await first.sdk.checkCurrent();



assert.equal(canonical(await image()),before);



assert.equal(state.lease,1);



const observation=await first.reader.readOnce();



assert.equal(observation.lease.body.leaseId,lease.body.leaseId);



assert.equal(observation.observation.samples.length,2);



assert.ok(observation.observation.samples.every(p=>p.value===42));



assert.equal(observation.observation.channel.server.sha256,qa.serverCertificate.sha256);



assert.equal(observation.fieldCommissioned,false);



assert.equal(state.lease,1);




  qa.state.mode='HOLD_VALUE';



const revoked=first.reader.readOnce();



revoked.catch(()=>{});



await until(()=>qa.state.held.length>0,'held read');



await publish('1.1.0',true);



const afterPause=canonical(await image());



await assert.rejects(revoked,e=>e.code==='FIELD_LEASE_REVOKED'||e.code==='FIELD_LEASE_REVOKED_IN_FLIGHT');



await until(()=>!first.reader.state().reader.active,'revoked read actual terminal');



for(const release of qa.state.held.splice(0))release();



assert.equal(canonical(await image()),afterPause);



const noRead=qa.state.valueRequests;



await assert.rejects(first.reader.readOnce());



assert.equal(qa.state.valueRequests,noRead);



assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_ledger WHERE event->>'objectType'='FIELD_LEASE'")).rows[0].n,1);



const denied=await postCheck(lease);



assert.equal(denied.response.status,200);



assert.equal(verifyFieldCheck(denied.body,key.publicKey,{requestId:denied.request.requestId,requestedAtMs:denied.request.requestedAtMs,lease},Date.now()).body.allowed,false);



await first.reader.close();




  await publish('1.2.0',false);



const second=make();



const next=await second.reader.readOnce();



assert.notEqual(next.lease.body.leaseId,lease.body.leaseId);



qa.state.mode='HOLD_VALUE';



const blocked=second.reader.readOnce();



blocked.catch(()=>{});



await until(()=>qa.state.held.length>0,'network-held OPC read');



state.hold=true;



await until(()=>state.held.length>0,'held HTTP check');



await assert.rejects(blocked,e=>e.code==='FIELD_LEASE_REVOKED'||e.code==='FIELD_LEASE_REVOKED_IN_FLIGHT');



await until(()=>!second.reader.state().reader.active&&!second.sdk.state().transportActive,'both cancelled clients actual terminal');



for(const release of qa.state.held.splice(0))release();



state.hold=false;



for(const release of state.held.splice(0))release();



await second.reader.close();




  const nativeQuery=pg.Client.prototype.query,faults={};



for(const target of ['DROP_TAIL','DUPLICATE','HEAD','FOREIGN','HASH']){const third=make();



const heldLease=await third.sdk.ensureLease();


if(target==='DROP_TAIL'){
 const {FieldPlatformService}=await import('../server/field-platform.ts');


 await writeFile(resolve(directory,'changed-request.bin'),randomBytes(32));


 const changed=structuredClone(config);

changed.tenants[0].channels[0].requestKeyFile='changed-request.bin';


 const changedFile=resolve(directory,'changed.json');

await writeFile(changedFile,JSON.stringify(changed));


 const stale=new FieldPlatformService();

staleServices.push(stale);

await stale.start(runtime.store,changedFile);


}

const stable=canonical(await image());



let hit=false;



pg.Client.prototype.query=function(config,...args){const text=typeof config==='string'?config:config?.text||'';



if(!hit&&(target==='HEAD'?text.includes('IDMS_AUDIT_PAGE_HEAD'):text.includes('IDMS_AUDIT_PAGE_ROWS'))){hit=true;



if(config instanceof pg.Query){if(target==='DROP_TAIL')config.text="SELECT * FROM ("+config.text+") x WHERE sequence::bigint < (SELECT max(sequence_no) FROM audit_ledger)";



if(target==='DUPLICATE')config.text='SELECT * FROM ('+config.text+') x CROSS JOIN generate_series(1,2)';



if(target==='FOREIGN'||target==='HASH')config.prependListener('row',r=>{if(target==='FOREIGN')r.tenant_id='sandbox';



else r.hash='0'.repeat(64);



});



}else return nativeQuery.call(this,config,...args).then(r=>{r.rows[0].hash='0'.repeat(64);



return r;



});



}return nativeQuery.call(this,config,...args);



};



try{await assert.rejects(third.sdk.checkCurrent());



}finally{pg.Client.prototype.query=nativeQuery;



}assert.equal(hit,true,target);



assert.throws(()=>third.sdk.currentLease());



assert.equal(canonical(await image()),stable);



faults[target]=true;



await third.reader.close();


if(target==='DROP_TAIL'){
 const denied=await postCheck(heldLease);

assert.equal(denied.response.status,409);

assert.equal(Object.hasOwn(denied.body,'signature'),false);


 const {FieldPlatformService}=await import('../server/field-platform.ts');

const restored=new FieldPlatformService();

staleServices.push(restored);

await restored.start(runtime.store,configFile);


}

}
  assert.equal(qa.state.requests.WriteRequest||0,0);



assert.equal(qa.state.requests.CallRequest||0,0);



assert.equal((await pool.query('SELECT count(*)::int AS n FROM telemetry_points')).rows[0].n,0);



const count=(await pool.query('SELECT count(*)::int AS n FROM idms_schema_migrations')).rows[0].n;



assert.equal(count,5);



for(const o of owned)await o.reader.close();


for(const s of staleServices)await s.close();



await new Promise(ok=>server.close(ok));



server=undefined;



await runtime.closeRuntime();



runtime=undefined;



clearWorkspaceCache();



for(const kind of ['task','body','response','cache'])assert.equal(resident.snapshot().categories[kind]||0,0,kind);




  process.send({type:'PROOF',value:{verifiedAt:iso(Date.now()),actualMainHttpMinimumRolePostgresEdgeSdkAndEncryptedOpcua:true,actualCurrentApprovalAndPersistedLeaseDriveReader:true,effectiveLeaseReusedForMultipleReads:true,readonlyChecksDoNotChangeRootOrAudit:true,backgroundPausePollingCancelsHeldNativeRead:true,pausedNewReadHasNoOpcuaRequests:true,oldLeaseGetsCryptographicallySignedDeniedStatus:true,restoredExplicitApprovalObtainsNewLease:true,stalledCheckExpiryCancelsHttpAndOpcuaAndActuallyDrains:true,headCheckedAuditPrefixOmissionCannotHideLatestState:true,faults,readFailureRevokesEdgeLeaseAndWritesNothing:true,writeRequests:0,callRequests:0,noTelemetryPointsProduced:true,migrationsRemainFive:true,httpAndTaskReservationsReleased:true,actualHumanOidcApprovalBrowserNotPartOfThisTest:true,mtlsMqttAndFieldIntakePending:true,fieldCommissioned:false,productionAcceptance:false}});




 }finally{state.hold=false;

for(const s of staleServices)await s.close();



for(const release of state.held.splice(0))release();



for(const release of qa.state.held.splice(0))release();



for(const o of owned)await o.reader.close();



if(server){server.closeAllConnections();



await new Promise(ok=>server.close(ok));



}if(runtime)await runtime.closeRuntime();



await waitForWrites();



clearWorkspaceCache();



await closePostgres();



await qa.close();



const base=resolve('work/field-channel-20261017'),rel=relative(base,directory);



assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&/^edge-[a-f0-9]{10}$/.test(basename(directory)));



await rm(directory,{recursive:true,force:true});



}
}
