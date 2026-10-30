import {WorkflowCancelReservationTransportV1} from '../../server/workflow-cancel-reservation-transport-v1.ts';
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {canonical} from '../../server/imports.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
import {readApplicationFileV1,applicationManifestV1} from '../runtime-application-config-v1.mjs';
import {createPlatformDependenciesV3} from '../platform-dependency-controller-v3.mjs';
import {launchPostgresLifecycleV1,bindPostgresLifecycleV1,stopPostgresLifecycleV1} from '../postgres-lifecycle-v1.mjs';
import {stopIdentityLifecycleV1} from '../identity-lifecycle-portable-v1.mjs';
import {readApplicationRegistryV1} from '../runtime-application-registry-v1.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8')),sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function within(promise,ms,code){let timer;try{return await Promise.race([promise,new Promise((_,no)=>timer=setTimeout(()=>no(Error(code)),ms))]);}finally{clearTimeout(timer);}}

export async function prepareCoreEndpointApplicationQaV1({root,originalManifestFile,flowConfigs}){
 const original=applicationManifestV1(JSON.parse((await readApplicationFileV1(originalManifestFile)).bytes.toString('utf8')));
 assert.deepEqual(Object.keys(flowConfigs).sort(),[...original.tenantIds].sort());
 const bindings=[];let origin=null,port=null;
 for(const tenant of original.tenantIds){
  const config=flowConfigs[tenant],transport=new WorkflowCancelReservationTransportV1(config),url=new URL(config.workflow.baseUrl);
  assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.equal(config.workflow.tenantId,tenant);
  assert(Number(url.port)>0&&Number(url.port)<=65535);
  if(origin===null){origin=url.origin;port=Number(url.port);}else assert.equal(url.origin,origin,'CORE_QA_SEALED_ENDPOINTS_DIFFER');
  bindings.push({tenant,origin,workflowBinding:transport.workflowBinding,reservationBinding:transport.binding});
 }
 // Existing domain markers bind the original public origin. Replace the stopped
 // proxy with the real JVM at that origin; do not rewrite sealed client graphs.
 await privateDirectory(root);const app={...original,registryDirectory:join(root,'application-registry')},manifestFile=join(root,'application.private.json');
 await privateNewFile(manifestFile,canonical(app));await privateNewFile(join(root,'sealed-endpoint-preservation.json'),canonical({origin,port,bindings,clientRuntimeFilesUnchanged:true}));
 return{original,app,manifestFile,origin,port,bindings};
}

/** Actual core lifecycle with this case's stopped target/identity PG only. */
export async function exercisePlatformCoreQaV3({work,nonce,cluster,identityCluster,identity,site,local,worker,children,report,note,setLocal,setWorker,setContext}){
 const ctx={api:null,config:null,warmdown:false,cleanupPg:[],rootsRegistered:new Set(),resources:[],blocker:null};setContext(ctx);
 ctx.capture=()=>{
  ctx.resources=ctx.api?.resources()??[];
  for(const e of ctx.resources)if(e.kind==='APPLICATIONS'&&!ctx.rootsRegistered.has(e.handle.process.pid)){const h={process:e.handle.process,script:'scripts/runtime-application-suite-v2.mjs',stopType:'APPLICATION_SUITE_STOP',lifecycle:e.handle,terminal:e.handle.terminal.then(p=>p.exit)};h.terminal.catch(()=>{});ctx.rootsRegistered.add(h.process.pid);children.push(h);report.children.push({pid:h.process.pid,script:h.script});}
 };
 ctx.prepareLegacyCleanup=async()=>{
  ctx.capture();await ctx.blocker?.end();ctx.blocker=null;
  if(ctx.api){const result=await ctx.api.close();assert(result.allOwnedResourcesRetired,'CORE_QA_KERNEL_RESOURCES_NOT_RETIRED');}
  if(!ctx.warmdown)return;
  for(const p of ctx.config.postgres){
   const{id,...options}=p,handle=await launchPostgresLifecycleV1(options);ctx.cleanupPg.push({id,handle});await bindPostgresLifecycleV1(handle);
  }
 };
 ctx.stopCleanupPg=async()=>{
  const outcomes=[];
  for(const e of [...ctx.cleanupPg].reverse()){const proof=await stopPostgresLifecycleV1(e.handle);assert.equal(proof.terminal.code,0);outcomes.push({id:e.id,pid:e.handle.process.pid,directory:e.handle.directory,binding:e.handle.binding,proof});}
  report.coreCleanupPostgres=outcomes;await privateNewFile(join(work,'core-cleanup-postgres.json'),canonical(outcomes));
 };
 const root=join(work,'core-input'),records=join(root,'controller-records'),pgRecords=join(root,'postgres-records'),identityRecords=resolve('work/ikp-'+nonce);for(const p of [root,records,pgRecords,identityRecords])await privateDirectory(p);
 const flow=site.flow.children.at(-1),flowIntent=await json(join(flow.directory,'launch-intent.json')),flowFile=name=>flowIntent.files.find(f=>basename(f.path)===name+'.private.json')?.path;
 const {original,app,manifestFile,port}=await prepareCoreEndpointApplicationQaV1({root,originalManifestFile:join(work,'application-a.private.json'),flowConfigs:Object.fromEntries(['acme','sandbox'].map(t=>[t,site.flow.config(t)]))});
 const id=await json(join(work,'identity.private.json')),account=p=>({user:p.account.user,password:p.account.password,database:'postgres'});
 ctx.config={format:1,purpose:'PLATFORM_DEPENDENCIES_V1',workDirectory:records,postgres:[{id:'business',binDirectory:cluster.bin,dataDirectory:cluster.target,workDirectory:pgRecords,expectedSystemIdentifier:cluster.systemIdentifier,port:cluster.account.port,account:account(cluster)},{id:'identity-pg',binDirectory:identityCluster.bin,dataDirectory:identityCluster.source,workDirectory:pgRecords,expectedSystemIdentifier:identityCluster.systemIdentifier,port:identityCluster.account.port,account:account(identityCluster)}],identity:{id:'identity',postgresId:'identity-pg',javaHome:resolve(process.argv[3]),keycloakDirectory:identity.handle.binding.root,workDirectory:identityRecords,port:identity.handle.port,database:id.database,admin:id.admin},workflows:[{id:'workflow',postgresIds:['business'],javaHome:resolve(process.argv[3]),workDirectory:work,jarFile:flow.binding.jar,jarSha256:flow.binding.jarSha256,runtimeFile:flowFile('runtime'),cancelFile:flowFile('cancel')??null,reservationFile:flowFile('reservation')??null,port}],applicationManifestFile:manifestFile};
 // The identity fixture account includes the bootstrap host/port; the lifecycle
 // configuration has an exact dedicated database shape.
 ctx.config.identity.database={host:id.database.host,port:id.database.port,database:id.database.database,user:id.database.user,password:id.database.password};await privateNewFile(join(root,'platform.private.json'),canonical(ctx.config));
 await worker?.close();setWorker(null);await local?.close();setLocal(null);await site.flow.quiesce();await stopIdentityLifecycleV1(identity.handle);await cluster.stop();await identityCluster.stop();ctx.warmdown=true;
 note('all this-case SQL controls and old JVMs quiesced normally; target and identity PG cleanly stopped, frozen recovery source stays offline, sealed client graph retained and original public endpoint reserved for the new direct JVM');
 try{
  ctx.api=await createPlatformDependenciesV3(ctx.config);assert.equal(ctx.api.status().fullyReady,false);assert.equal(typeof ctx.api.close,'function');const ready=await within(ctx.api.ready,300000,'CORE_QA_READY_OBSERVATION');ctx.capture();assert.equal(ready.phase,'READY');assert.equal(ready.components.length,5);assert(ready.components.every(c=>c.bound&&!c.retiredProven));
  const accounts=await json(join(work,'background-users.private.json')),cases=await json(join(work,'application-positive-cases.private.json'));
  async function call(tenant,path,body){const a=accounts[tenant].operator,r=await fetch(site.origin+path,{method:body?'POST':'GET',headers:{cookie:'idms_session='+a.sid,origin:site.origin,'x-tenant-id':tenant,'x-idms-actor-id':a.id,'x-csrf-token':a.csrf,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});return{status:r.status,value:await r.json()};}
  for(const tenant of original.tenantIds){const r=await call(tenant,'/api/v4/site/context');assert.equal(r.status,200);assert.equal(r.value.modules.length,4);const row=cases.find(c=>c.tenant===tenant),order=await call(tenant,'/api/v4/maintenance/orders/'+row.orderId);assert.equal(order.status,200);assert.equal(order.value.item.state,tenant==='acme'?'ASSIGNED':'IN_PROGRESS');}
  const chosen=cases.find(c=>c.tenant==='acme'),prior=await call('acme','/api/v4/maintenance/orders/'+chosen.orderId),commandId=randomUUID(),accepted=await call('acme','/api/v4/maintenance/jobs',{commandId,command:{id:chosen.orderId,action:'start',input:{expectedVersion:prior.value.item.version}}});assert.equal(accepted.status,202);let committed=false;
  for(let i=0;i<300;i++){const r=await call('acme','/api/v4/maintenance/orders/'+chosen.orderId);assert.equal(r.status,200);if(r.value.item.state==='IN_PROGRESS'&&r.value.item.workflow?.status==='SYNCED'){committed=true;break;}await sleep(200);}assert(committed);
  note('core controller owns two PGs, new Keycloak JVM, new Flowable JVM and a nine-member application group; both tenant sessions and prior orders survive restart and a new maintenance command syncs through direct real Flowable');
  const wf=ctx.resources.find(e=>e.kind==='WORKFLOW'),pgBusiness=ctx.resources.find(e=>e.id==='business'),runtime=await json(ctx.config.workflows[0].runtimeFile),databases=Object.values(runtime.tenants).map(a=>/^jdbc:postgresql:\/\/[^/]+\/(.+)$/.exec(a.jdbcUrl)[1]);
  ctx.blocker=new pg.Client({...cluster.account,application_name:'idms-core-stop-preflight-blocker'});await ctx.blocker.connect();const before=(await ctx.blocker.query("SELECT pid,datid::text,usesysid::text FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND application_name='PostgreSQL JDBC Driver' ORDER BY pid",[databases])).rows;assert(before.length>0);
  const requestId=randomUUID(),stopping=ctx.api.close({requestId});assert.equal(ctx.api.close({requestId}),stopping);assert.throws(()=>ctx.api.close({requestId:randomUUID()}),/PLATFORM_DEPENDENCY_STOP_REQUEST_CHANGED/);const blocked=await within(stopping,180000,'CORE_QA_STOP_BLOCK_OBSERVATION');assert.equal(blocked.phase,'BLOCKED');assert(!blocked.allOwnedResourcesRetired);assert.deepEqual(blocked.blocked,[{id:'business',errorCode:'PG_LIFECYCLE_CLIENTS_REMAIN'}]);assert.equal(pgBusiness.handle.helperAttempts,0);await assert.rejects(lstat(join(pgBusiness.handle.directory,'stop-intent.json')),{code:'ENOENT'});
  const after=(await ctx.blocker.query("SELECT pid FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND application_name='PostgreSQL JDBC Driver'",[databases])).rows;assert.deepEqual(after,[]);assert.equal(pgBusiness.handle.process.exitCode,null);
  note('an actual independent SQL client blocks only the final business-PG preflight after application/JVM drain; zero PG stop helpers or target stop intents sent, and actual workflow JDBC clients are zero');
  await ctx.blocker.end();ctx.blocker=null;const result=await within(ctx.api.close({requestId}),180000,'CORE_QA_CLOSE_OBSERVATION');assert(result.normal&&result.allOwnedResourcesRetired);assert.equal(result.phase,'CLOSED');assert.deepEqual(await ctx.api.closed,result);assert.deepEqual(await ctx.api.close({requestId}),result);ctx.capture();
  const resources=[];for(const e of ctx.resources){const proof=e.kind==='APPLICATIONS'?await e.handle.terminal:e.handle.stopProof;assert(proof);resources.push({id:e.id,kind:e.kind,pid:e.handle.process.pid,directory:e.handle.directory,binding:e.handle.binding??null,proof});if(e.kind!=='APPLICATIONS')assert.equal(e.handle.helperAttempts,1);}
  const appResource=resources.find(e=>e.kind==='APPLICATIONS'),appTrust=await json(join(app.registryDirectory,'trust.json')),registry=await readApplicationRegistryV1(appTrust);assert.equal(registry.header.ownerPid,appResource.pid);assert.equal(registry.events.at(-1).event,'GROUP_CLOSED');assert.equal(registry.events.filter(e=>e.event==='EXIT').length,9);
  const jdbc={pid:wf.handle.process.pid,before,after,proof:wf.handle.stopProof};await privateNewFile(join(wf.handle.directory,'jdbc-closure.json'),canonical(jdbc));
  report.platformCore={controllerDirectory:ctx.api.directory,configurationFile:join(root,'platform.private.json'),result,blockedResult:blocked,requestId,resources,applicationRegistryTrust:appTrust,normalApplicationMembers:9,actualJdbcClientsAfter:0,newMaintenanceCommand:commandId,backendSessionsExplicit:true,sourceProfile:report.sourceBundle.profile,coreNativeVerified:true,allProductionDependenciesRegistered:false,originalRuntimeSwitched:false};await privateNewFile(join(work,'platform-core-verification.json'),canonical(report.platformCore));
  note('releasing the known blocker permits same-request retry, two real smart PG stops and one durable reverse-order normal retirement of all five core components; no component stop operation retransmitted');
 }finally{ctx.capture();if(ctx.blocker){await ctx.blocker.end();ctx.blocker=null;}}
 return ctx;
}
