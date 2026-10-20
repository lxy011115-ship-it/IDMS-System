import {WorkerReplyGate,exerciseOutboxHa,launchPeerWorker,observedWorkerArgs} from './outbox-ha-qa.mjs';
import {readEntities,writeEntities} from '../server/entity-repository.ts';
import {projectApprovedData} from '../server/data-projection.ts';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import pg from 'pg';
import { chromium } from 'playwright';
import { launchWorkflow, workflowReady, buildWorkflow } from './workflow-local.mjs';
import { localConfig, adminApi, adminToken, writePrivate } from './keycloak-local.mjs';
import { canonical, digest } from '../server/imports.ts';
import { seedStore } from '../server/store.ts';
import {migrateQaDatabases,cleanupQaRoles,qaAdminAccount,updateQaPayload} from './qa-database.mjs';

const suffix=randomUUID().replaceAll('-','').slice(0,10),namespace='workflow-qa-'+suffix;
const database=JSON.parse(await readFile('.local/postgres-runtime.json','utf8'));
const directory=resolve('.local',namespace),base='http://127.0.0.1:4036',engineBase='http://127.0.0.1:4037',proxyBase='http://127.0.0.1:4039';
const identity=await localConfig(),clientId='idms-workflow-qa-'+suffix,users=[],accounts=[];
const configuration={host:database.host,port:database.port,tenants:{}};
const engineConfig={tenants:{}},clientConfig={baseUrl:proxyBase,tenants:{}};
const admin=new pg.Client({host:database.host,port:database.port,user:'idms_bootstrap',password:database.bootstrapPassword,database:'postgres'});
let engine,core,browser,keycloakClient,proxy,dropResponse=false,engineLog='',coreLog='',connection,flowConnection;
const evidence={namespace,flowableVersion:'7.2.0',productionAcceptance:false};
const workerHa=process.env.IDMS_VERIFY_WORKER_HA==='1',haGate=new WorkerReplyGate(),haLost=[new Set(),new Set()];let apiBase=base,peer,peerBase,coreEnv,haSandboxSql,haSandboxFlow;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;const stopped=new Promise(r=>child.once('exit',r));child.kill();await stopped;}
async function startEngine(){
  engine=launchWorkflow(join(directory,'engine.json'),4037);engineLog='';
  for(const s of [engine.stdout,engine.stderr])s.on('data',b=>engineLog=(engineLog+b).slice(-12000));
  for(let i=0;i<180;i++){if(engine.exitCode!==null)throw Error('Engine exited: '+engineLog);if(await workflowReady({...clientConfig,baseUrl:engineBase}))return;await pause(300);}
  throw Error('Engine startup unconfirmed: '+engineLog);
}
async function startCore(oidc=true,workflow=true){
  const env={...process.env,PORT:'4036',IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:join(directory,'postgres.json'),IDMS_DEMO_NAMESPACE:namespace,IDMS_TELEMETRY_CONFIG:'',IDMS_WORKFLOW_CLIENT_CONFIG:workflow?join(directory,'client.json'):'',IDMS_AUTH_MODE:oidc?'oidc':'demo',IDMS_PUBLIC_ORIGIN:base,IDMS_OIDC_ISSUER:identity.origin+'/realms/idms',IDMS_OIDC_CLIENT_ID:clientId,IDMS_OIDC_AUDIENCE:'idms-api'};
  coreEnv=env;core=spawn(process.execPath,workerHa?observedWorkerArgs():['server/index.ts'],{env,windowsHide:true,stdio:workerHa?['ignore','pipe','pipe','ipc']:['ignore','pipe','pipe']});core.on('message',m=>{if(m.type==='QA_OUTBOX_LOST')haLost[0].add(m.jobId);});coreLog='';
  for(const s of [core.stdout,core.stderr])s.on('data',b=>coreLog=(coreLog+b).slice(-12000));
  for(let i=0;i<100;i++){if(core.exitCode!==null)throw Error('Core exited: '+coreLog);try{if((await fetch(base+'/api/v1/health')).ok)return;}catch{}await pause(100);}
  throw Error('Core startup unconfirmed: '+coreLog);
}
async function createUser(label,roles,tenant='acme'){
  const user={username:'wfqa-'+suffix+'-'+label,password:'Qa9-'+randomBytes(24).toString('base64url'),roles,tenant};
  const token=await adminToken(identity);
  await adminApi(identity,token,'idms/users','POST',{username:user.username,enabled:true,firstName:label,lastName:'QA',email:user.username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:[tenant],idms_sites:[' * '],idms_lines:[' * '],idms_devices:[' * ']},credentials:[{type:'password',value:user.password,temporary:false}]});
  user.id=(await adminApi(identity,token,`idms/users?username=${user.username}&exact=true`))[0].id;users.push(user);
  const mapped=[];for(const role of roles)mapped.push(await adminApi(identity,token,'idms/roles/'+role));
  await adminApi(identity,token,`idms/users/${user.id}/role-mappings/realm`,'POST',mapped);return user;
}
async function login(user){
  if(user.context)await user.context.close();user.context=await browser.newContext({viewport:{width:1440,height:1000}});user.page=await user.context.newPage();
  user.page.on('pageerror',e=>{evidence.pageErrors??=[];evidence.pageErrors.push(e.message);});
  await user.page.goto(base+'/?view=work-orders');await user.page.getByTestId('oidc-login').click();
  await user.page.locator('#username').fill(user.username);await user.page.locator('#password').fill(user.password);await user.page.locator('#kc-login').click();
  await user.page.getByTestId('verified-identity').waitFor();await user.page.waitForFunction(()=>!document.querySelector('.busy-line'));
}
async function api(user,path,body,expected=200,key=randomUUID()){
  const auth=await (await user.context.request.get(apiBase+'/api/v1/auth/session')).json();
  const r=await user.context.request.fetch(apiBase+'/api/v1'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','Idempotency-Key':key,'X-Correlation-Id':randomUUID(),'X-CSRF-Token':auth.csrfToken,Origin:base}:{},...(body?{data:body}:{})});
  const value=await r.json();assert.equal(r.status(),expected,JSON.stringify(value));return value;
}
async function synced(user,id){
  for(let i=0;i<120;i++){const order=await api(user,'/work-orders/'+id);if(order.workflow.status==='SYNCED')return order;if(order.workflow.status==='HUMAN_REVIEW')throw Error('Manual workflow review: '+order.workflow.lastError);await pause(150);}
  throw Error('Workflow confirmation timed out');
}
async function engineApi(path,body,expected=200,tenant='acme',token=clientConfig.tenants[tenant].serviceToken){
  const r=await fetch(engineBase+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'X-IDMS-Tenant':tenant,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  assert.equal(r.status,expected);return r.json();
}
try{
  await mkdir(directory,{recursive:true});await admin.connect();
  for(const tenant of ['acme','sandbox'])for(const kind of ['business','flow']){
    const name=`idms_wfqa_${tenant}_${kind}_${suffix}`,account={database:name,user:name,password:randomBytes(32).toString('base64url')};accounts.push(account);
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${account.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "${name}"`);
    if(kind==='business')configuration.tenants[tenant]=account;
    else{const serviceToken=randomBytes(32).toString('base64url');engineConfig.tenants[tenant]={jdbcUrl:`jdbc:postgresql://${database.host}:${database.port}/${name}`,user:name,password:account.password,serviceToken};clientConfig.tenants[tenant]={serviceToken};}
  }
  await writePrivate(join(directory,'postgres.json'),JSON.stringify(await migrateQaDatabases(configuration,database)));await writePrivate(join(directory,'engine.json'),JSON.stringify(engineConfig));await writePrivate(join(directory,'client.json'),JSON.stringify(clientConfig));
  await buildWorkflow();
  // A deliberate legacy fixture is created through the old API, before Flowable is enabled.
  await startCore(false,false);
  let r=await fetch(base+'/api/v1/predictive/alerts/palert-001/approval',{method:'POST',headers:{'X-Tenant-Id':'acme','X-Actor-Id':'demo.approver','X-Actor-Type':'USER','Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({decision:'APPROVED',comment:'QA历史兼容工单',expectedVersion:1})});assert.equal(r.status,200);const legacy=(await r.json()).workOrderId;
  await stop(core);
  connection=new pg.Client(qaAdminAccount(database,configuration.tenants.acme));await connection.connect();
  flowConnection=new pg.Client({host:database.host,port:database.port,user:engineConfig.tenants.acme.user,password:engineConfig.tenants.acme.password,database:engineConfig.tenants.acme.user});await flowConnection.connect();
  // Add a clearly synthetic second maintenance episode to this isolated QA fixture only.
  const payload=(await connection.query('SELECT payload FROM runtime_state')).rows[0].payload,seed=seedStore(),alertId=randomUUID();
  payload.business.predictiveAlerts.push({...seed.predictiveAlerts[0],id:alertId});payload.business.maintenanceRecommendations.push({...seed.maintenanceRecommendations[0],id:randomUUID(),alertId});
  await updateQaPayload(connection,'acme',payload);
  proxy=createServer(async(req,res)=>{try{const buffers=[];for await(const b of req)buffers.push(b);const requestBody=Buffer.concat(buffers),dispatchId=req.method==='POST'?JSON.parse(requestBody).commandId:undefined;if(dispatchId)haGate.started(dispatchId);const response=await fetch(engineBase+req.url,{method:req.method,headers:{Authorization:req.headers.authorization||'','X-IDMS-Tenant':req.headers['x-idms-tenant']||'','Content-Type':'application/json'},...(req.method==='POST'?{body:requestBody}:{})});const raw=await response.text();if(dropResponse&&req.method==='POST'){dropResponse=false;res.destroy();return;}const reply=dispatchId?await haGate.response(dispatchId,response.status,raw):{status:response.status,body:raw};res.writeHead(reply.status,{'content-type':'application/json'});res.end(reply.body);}catch{res.writeHead(503);res.end('{}');}});await new Promise((ok,fail)=>{proxy.once('error',fail);proxy.listen(4039,'127.0.0.1',ok);});
  await startEngine();
  const kcToken=await adminToken(identity),web=(await adminApi(identity,kcToken,'idms/clients?clientId=idms-web'))[0],mappers=await adminApi(identity,kcToken,`idms/clients/${web.id}/protocol-mappers/models`);
  await adminApi(identity,kcToken,'idms/clients','POST',{clientId,enabled:true,publicClient:true,fullScopeAllowed:false,standardFlowEnabled:true,directAccessGrantsEnabled:false,implicitFlowEnabled:false,protocol:'openid-connect',redirectUris:[base+'/api/v1/auth/callback'],webOrigins:[],attributes:{'pkce.code.challenge.method':'S256'},protocolMappers:mappers.map(({id,...m})=>m)});
  keycloakClient=(await adminApi(identity,kcToken,'idms/clients?clientId='+clientId))[0].id;await adminApi(identity,kcToken,`idms/clients/${keycloakClient}/scope-mappings/realm`,'POST',await adminApi(identity,kcToken,`idms/clients/${web.id}/scope-mappings/realm`));
  const approver=await createUser('approver',['final-approver']),technician=await createUser('technician',['maintenance-engineer','final-approver']),sandbox=await createUser('sandbox',['auditor'],'sandbox');
  await startCore();browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});await login(approver);await login(technician);await login(sandbox);
  assert.equal((await api(approver,'/workflow/status')).connected,true);await engineApi('/v1/status',undefined,401,'sandbox',clientConfig.tenants.acme.serviceToken);
  assert.equal((await api(approver,`/work-orders/${legacy}/workflow`)).mode,'LEGACY_LOCAL');assert.equal((await api(approver,`/work-orders/${legacy}`)).workflow,undefined);evidence.legacyNotFalsified=true;
  // Outbox SQL failure must roll back the business approval, order and audit together.
  await connection.query("CREATE FUNCTION qa_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA outbox insert failure'; END $$; CREATE TRIGGER qa_outbox_failure BEFORE INSERT ON workflow_outbox FOR EACH ROW EXECUTE FUNCTION qa_fail_insert()");
  const before=await api(approver,'/audit'),approvalInput={decision:'APPROVED',comment:'核查现场维护证据',expectedVersion:1},approvalKey=randomUUID();
  await api(approver,`/predictive/alerts/${alertId}/approval`,approvalInput,500,approvalKey);
  assert.equal((await api(approver,'/work-orders')).total,1);assert.deepEqual(await api(approver,'/audit'),before);
  await connection.query('DROP TRIGGER qa_outbox_failure ON workflow_outbox; DROP FUNCTION qa_fail_insert()');evidence.atomicApprovalOutboxRollback=true;
  // The engine commits, but one response is lost. The core must retry the same command.
  dropResponse=true;
  const alert=await api(approver,`/predictive/alerts/${alertId}/approval`,approvalInput,200,approvalKey),id=alert.workOrderId;
  let order=await synced(approver,id);assert.equal(order.state,'UNASSIGNED');assert.ok(order.workflow.processInstanceId);
  assert.deepEqual(await api(approver,`/predictive/alerts/${alertId}/approval`,approvalInput,200,approvalKey),alert);
  const receipt=(await connection.query("SELECT * FROM workflow_outbox WHERE entity_id=$1 AND envelope->>'action'='create'",[id])).rows[0];assert.ok(receipt.attempts>=1);assert.equal(Number((await flowConnection.query('SELECT count(*) FROM idms_workflow_cases WHERE entity_id=$1',[id])).rows[0].count),1);
  const repeated=await engineApi('/v1/commands',receipt.envelope);assert.deepEqual(repeated,receipt.response);await engineApi('/v1/commands',{...receipt.envelope,requestDigest:'f'.repeat(64)},400);
  const altered={...receipt.envelope,comment:'同一命令ID不同业务内容'};delete altered.requestDigest;altered.requestDigest=digest(canonical(altered));await engineApi('/v1/commands',altered,409);
  evidence.commandDigestVerified=true;evidence.lostResponseSameCommand=true;evidence.idempotentEngineReceipt=true;
  await api(sandbox,`/work-orders/${id}`,undefined,404);await engineApi('/v1/cases/'+id,undefined,404,'sandbox');evidence.crossTenantIsolation=true;
  // Claim from the real authenticated browser; no caller-selected actor ID reaches the engine.
  await technician.page.reload();await technician.page.waitForSelector(`#wo-${id} [data-action=wo-claim]`);await technician.page.waitForFunction(()=>!document.querySelector('.busy-line'));
  await technician.page.locator(`#wo-${id} [data-action=wo-claim]`).click();order=await synced(technician,id);assert.equal(order.assignee,technician.id);assert.equal(order.state,'ASSIGNED');
  // Deliberately fail the core commit after the engine confirms. No local advance is allowed.
  await connection.query("CREATE FUNCTION qa_fail_sync() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='SYNCED' AND NEW.envelope->>'action'='start' THEN RAISE EXCEPTION 'QA core sync failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER qa_sync_failure BEFORE UPDATE ON workflow_outbox FOR EACH ROW EXECUTE FUNCTION qa_fail_sync()");
  const pending=await api(technician,`/work-orders/${id}/start`,{expectedVersion:order.version});assert.equal(pending.state,'ASSIGNED');assert.equal(pending.workflow.status,'PENDING');
  for(let i=0;i<60;i++){if((await engineApi('/v1/cases/'+id)).state==='IN_PROGRESS')break;await pause(100);}
  assert.equal((await engineApi('/v1/cases/'+id)).state,'IN_PROGRESS');assert.equal((await api(technician,`/work-orders/${id}`)).state,'ASSIGNED');
  await connection.query('DROP TRIGGER qa_sync_failure ON workflow_outbox; DROP FUNCTION qa_fail_sync()');order=await synced(technician,id);assert.equal(order.state,'IN_PROGRESS');evidence.engineCommittedCoreRollbackRecovery=true;
  const resolution={failureCode:'BRG-WEAR',cause:'现场确认轴承磨损',action:'更换轴承并润滑',verification:'同负载复测振动与温度正常',minutes:45,partsUsed:['6205轴承'],expectedVersion:order.version};
  // Stop the engine, enqueue evidence, and restart both services with the same persisted command.
  await stop(engine);engine=null;const outage=await api(technician,`/work-orders/${id}/submit`,resolution);assert.equal(outage.state,'IN_PROGRESS');assert.equal(outage.workflow.status,'PENDING');
  await api(technician,`/work-orders/${id}/submit`,resolution,409);await stop(core);await startEngine();await startCore();await login(approver);await login(technician);await login(sandbox);
  order=await synced(technician,id);assert.equal(order.state,'AWAITING_APPROVAL');assert.equal(order.workflow.commandId,outage.workflow.commandId);evidence.engineAndCoreRestartRecovery=true;
  const decision={expectedVersion:order.version,snapshotDigest:order.resolution.digest,decision:'APPROVED',comment:'独立复核维修及复测记录'};
  await api(technician,`/work-orders/${id}/approval`,decision,403);
  const self={commandId:randomUUID(),entityId:id,action:'approval',expectedVersion:order.version,actor:{id:technician.id,type:'USER',permissions:['maintenance:approve']},assignee:technician.id,evidenceDigest:order.resolution.digest,decision:'APPROVED',comment:'尝试自行关单',correlationId:randomUUID()};self.requestDigest=digest(canonical(self));await engineApi('/v1/commands',self,403);evidence.independentHumanFinalApproval=true;
  for(const [patch,expected] of [[{actor:{id:approver.id,type:'AI',permissions:['maintenance:approve']}},400],[{actor:{id:approver.id,type:'USER',permissions:[]}},403],[{actor:{id:approver.id,type:'USER',permissions:['maintenance:approve']},evidenceDigest:'0'.repeat(64)},409],[{actor:{id:approver.id,type:'USER',permissions:['maintenance:approve']},expectedVersion:order.version-1},409]]){
    const command={...self,...patch,commandId:randomUUID()};delete command.requestDigest;command.requestDigest=digest(canonical(command));await engineApi('/v1/commands',command,expected);
  }
  evidence.engineRechecksActorPermissionEvidenceVersion=true;
  await api(approver,`/work-orders/${id}/approval`,{...decision,decision:'RETURNED',comment:'补充不同负载下的复测证据'});order=await synced(approver,id);assert.equal(order.state,'IN_PROGRESS');
  await api(technician,`/work-orders/${id}/submit`,{...resolution,verification:'不同负载复测合格，附现场记录',expectedVersion:order.version});order=await synced(technician,id);assert.equal(order.approval,undefined);assert.equal(order.state,'AWAITING_APPROVAL');evidence.returnedEvidenceReapproval=true;
  // Exhausted delivery needs an explicitly authorized recovery; no bypass or new command is created.
  await stop(engine);engine=null;
  await api(approver,`/work-orders/${id}/approval`,{...decision,expectedVersion:order.version,snapshotDigest:order.resolution.digest});
  await connection.query("UPDATE workflow_outbox SET attempts=7,next_attempt=now() WHERE entity_id=$1 AND status='PENDING'",[id]);
  for(let i=0;i<50;i++){order=await api(approver,`/work-orders/${id}`);if(order.workflow.status==='HUMAN_REVIEW')break;await pause(150);}
  assert.equal(order.workflow.status,'HUMAN_REVIEW');assert.equal(order.state,'AWAITING_APPROVAL');const recoverCommand=order.workflow.commandId;
  await api(sandbox,`/work-orders/${id}/workflow/retry`,{},403);await startEngine();
  await approver.page.reload();await approver.page.waitForSelector(`#wo-${id} [data-action=workflow-retry]`);await approver.page.waitForFunction(()=>!document.querySelector('.busy-line'));
  await approver.page.locator(`#wo-${id} [data-action=workflow-retry]`).click();order=await synced(approver,id);assert.equal(order.state,'CLOSED');assert.equal(order.workflow.commandId,recoverCommand);evidence.humanRetrySameCommand=true;
  const details=await api(approver,`/work-orders/${id}/workflow`);assert.equal(details.ended,true);assert.equal(details.history.length,6);assert.equal(details.history.at(-1).assignee,approver.id);assert.equal(details.tasks.length,0);
  assert.ok(details.history.some(t=>t.key==='claim'&&t.assignee===technician.id));assert.ok(details.definitionId===order.workflow.definitionId);evidence.realBpmnHistoryAndPinnedDefinition=true;
  await approver.page.reload();await approver.page.waitForSelector(`#wo-${id} .badge.CLOSED`);await approver.page.waitForFunction(()=>!document.querySelector('.busy-line'));await approver.page.locator(`#wo-${id} [data-action=workflow-history]`).click();await approver.page.locator(`#wo-${id} .workflow-history`).waitFor();
  await mkdir('outputs/demo-preview',{recursive:true});await approver.page.screenshot({path:'outputs/demo-preview/22-flowable-history.png',fullPage:true});await approver.page.setViewportSize({width:390,height:844});await approver.page.screenshot({path:'outputs/demo-preview/23-flowable-mobile.png',fullPage:true});assert.equal(await approver.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);evidence.mobileOverflow=false;
  const audit=await api(approver,'/audit');assert.equal(audit.chainValid,true);assert.ok(audit.items.some(a=>a.action==='FLOWABLE_APPROVAL_CONFIRMED'&&a.actorId===approver.id));assert.equal((await api(approver,'/predictive/overview')).alerts.find(a=>a.id===alertId).state,'RESOLVED');
  const cross=new pg.Client({host:database.host,port:database.port,user:engineConfig.tenants.acme.user,password:engineConfig.tenants.acme.password,database:engineConfig.tenants.sandbox.user});await assert.rejects(cross.connect(),/permission denied/);await cross.end().catch(()=>{});evidence.flowDatabaseConnectIsolation=true;
  assert.equal(Number((await flowConnection.query('SELECT count(*) FROM act_hi_procinst WHERE business_key_=$1',[id])).rows[0].count),1);assert.equal(Number((await connection.query("SELECT count(*) FROM workflow_outbox WHERE entity_id=$1 AND status<>'SYNCED'",[id])).rows[0].count),0);
  assert.deepEqual(evidence.pageErrors||[],[]);evidence.pageErrors=0;evidence.auditChain=true;evidence.realOidcActors=true;evidence.closedAlertFeedback=true;
  if(workerHa){
    const sandboxApprover=await createUser('ha-sandbox',['final-approver'],'sandbox');await login(sandboxApprover);for(const user of users)await user.page?.close();
    haSandboxSql=new pg.Client(qaAdminAccount(database,configuration.tenants.sandbox));await haSandboxSql.connect();haSandboxFlow=new pg.Client({host:database.host,port:database.port,user:engineConfig.tenants.sandbox.user,password:engineConfig.tenants.sandbox.password,database:engineConfig.tenants.sandbox.user});await haSandboxFlow.connect();
    async function newCase(tenant){
      const c=tenant==='acme'?connection:haSandboxSql,id=randomUUID(),blue=seedStore();await c.query('BEGIN');try{await c.query('SELECT revision FROM business_state WHERE tenant_id=$1 FOR UPDATE',[tenant]);const before=(await readEntities(c,tenant)).payload,after=structuredClone(before);after.business.predictiveAlerts.push({...blue.predictiveAlerts[0],id,tenantId:tenant});after.business.maintenanceRecommendations.push({...blue.maintenanceRecommendations[0],id:randomUUID(),alertId:id,tenantId:tenant});await writeEntities(c,before,after,tenant);await projectApprovedData(c,after.imports,tenant);await c.query('UPDATE business_state SET revision=revision+1,payload_digest=$2 WHERE tenant_id=$1',[tenant,digest(canonical(after))]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}
      const who=tenant==='acme'?approver:sandboxApprover,result=await api(who,'/predictive/alerts/'+id+'/approval',{decision:'APPROVED',comment:'隔离多核心合成情景独立核验',expectedVersion:1});const order=await api(who,'/work-orders/'+result.workOrderId);return {id:order.workflow.commandId,objectId:order.id,tenant,action:'create'};
    }
    evidence.workerHa=await exerciseOutboxHa({kind:'workflow',sql:connection,gate:haGate,
      start:async i=>{if(i===0)await startCore();else{const p=await launchPeerWorker(coreEnv,id=>haLost[1].add(id));peer=p.child;peerBase=p.base;}},stop:i=>stop(i===0?core:peer),alive:i=>{const p=i===0?core:peer;return p&&p.exitCode===null&&p.signalCode===null;},route:i=>{apiBase=i===0?base:peerBase;},health:async i=>(await fetch((i===0?base:peerBase)+'/api/v1/health')).json(),lost:(i,id)=>haLost[i].has(id),
      enqueue:async(tenant,stage)=>{if(stage!=='crash')return newCase(tenant);haGate.all();const initial=await newCase('acme');let o=await synced(approver,initial.objectId);await api(technician,'/work-orders/'+o.id+'/claim',{expectedVersion:o.version});o=await synced(technician,o.id);await api(technician,'/work-orders/'+o.id+'/start',{expectedVersion:o.version});o=await synced(technician,o.id);await api(technician,'/work-orders/'+o.id+'/submit',{...resolution,expectedVersion:o.version});o=await synced(technician,o.id);const body={expectedVersion:o.version,snapshotDigest:o.resolution.digest,decision:'APPROVED',comment:'多核心独立终审核验'};await api(technician,'/work-orders/'+o.id+'/approval',body,403);haGate.holdAll=true;const pending=await api(approver,'/work-orders/'+o.id+'/approval',body);return {id:pending.workflow.commandId,objectId:o.id,tenant:'acme',action:'approval'};},
      settled:job=>synced(job.tenant==='acme'?approver:sandboxApprover,job.objectId),
      assertDurable:async job=>{const c=job.tenant==='acme'?flowConnection:haSandboxFlow,b=job.tenant==='acme'?connection:haSandboxSql;assert.equal(Number((await c.query('SELECT count(*) FROM idms_workflow_commands WHERE command_id=$1',[job.id])).rows[0].count),1);assert.equal(Number((await c.query('SELECT count(*) FROM act_hi_procinst WHERE business_key_=$1',[job.objectId])).rows[0].count),1);assert.equal(Number((await b.query("SELECT count(*) FROM audit_ledger WHERE event->>'objectId'=$1 AND event->>'action'=$2 AND event->'metadata'->>'commandId'=$3",[job.objectId,'FLOWABLE_'+job.action.toUpperCase()+'_CONFIRMED',job.id])).rows[0].count),1);},
      afterCrash:async job=>{const o=await api(approver,'/work-orders/'+job.objectId);assert.equal(o.state,'CLOSED');assert.equal(o.approval.approver,approver.id);assert.equal((await api(approver,'/audit')).chainValid,true);}
    });await writeFile('outputs/workflow-worker-ha-verification.json',JSON.stringify({verifiedAt:new Date().toISOString(),realFlowable:true,independentFinalApprovalOwnerCrashAndTakeover:true,...evidence.workerHa,productionHaAcceptance:false},null,2));
  }
  await stop(core);await assert.rejects(startCore(true,false),/Existing Flowable cases require workflow configuration/);evidence.missingConfigurationCannotFallback=true;
  await writeFile('outputs/workflow-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{
  haGate.all();await stop(peer);await haSandboxSql?.end();await haSandboxFlow?.end();if(browser)await browser.close();await stop(core);await stop(engine);if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}
  await connection?.end();await flowConnection?.end();
  const token=await adminToken(identity);for(const user of users){assert.ok(user.username.startsWith('wfqa-'+suffix+'-'));await adminApi(identity,token,`idms/users/${user.id}`,'DELETE');}if(keycloakClient)await adminApi(identity,token,`idms/clients/${keycloakClient}`,'DELETE');
  for(const a of accounts){assert.match(a.database,new RegExp('^idms_wfqa_(acme|sandbox)_(business|flow)_'+suffix+'$'));await admin.query(`DROP DATABASE IF EXISTS "${a.database}" WITH (FORCE)`);await admin.query(`DROP ROLE IF EXISTS "${a.user}"`);}await cleanupQaRoles(admin,configuration);
  await admin.end();for(const file of ['postgres.json','engine.json','client.json'])await unlink(join(directory,file)).catch(()=>{});
}
