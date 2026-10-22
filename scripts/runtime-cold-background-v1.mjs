import {readFile,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {RuntimeColdGuardV1} from './runtime-cold-portable-entry-v1.mjs';
import {coldRuntimeNeedV1 as need,coldRuntimeHashV1 as hash} from './runtime-cold-facts-v1.mjs';
import {IdentityAuthorityGuardV1,authorityRuntimeV1} from '../server/identity-authority-live-v1.ts';
import {loadGovernanceConsoleAuthRuntimeV4} from '../server/governance-console-auth-runtime-v4.ts';
import {loadMaintenanceConsoleAuthRuntimeV4} from '../server/maintenance-console-auth-runtime-v4.ts';
import {loadPredictiveConsoleAuthRuntimeV4} from '../server/predictive-console-auth-runtime-v4.ts';
import {GovernanceConsoleWorkerV4} from '../server/governance-console-worker-v4.ts';
import {MaintenanceCommandWorkerV4} from '../server/maintenance-command-worker-v4.ts';
import {MaintenanceFlowStoreV4} from '../server/maintenance-flow-store-v4.ts';
import {MaintenanceFlowWorkerV4} from '../server/maintenance-flow-worker-v4.ts';
import {PredictiveCommandWorkerV4} from '../server/predictive-command-worker-v4.ts';
import {PredictiveConsoleReadV4} from '../server/predictive-console-http-v4.ts';
import {PredictiveConsoleQueryV4} from '../server/predictive-console-query-v4.ts';
import {PredictiveLegacyReadV4,PredictiveAdoptionStoreV4} from '../server/predictive-legacy-adoption-v4.ts';
import {PredictiveAdoptingJobStoreV4} from '../server/predictive-adopting-job-store-v4.ts';

const loaders={GOVERNANCE:loadGovernanceConsoleAuthRuntimeV4,MAINTENANCE:loadMaintenanceConsoleAuthRuntimeV4,PREDICTIVE:loadPredictiveConsoleAuthRuntimeV4};
const validPath=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
/** New owned processes only. Configuration files and authority stay outside PGDATA. */
export async function loadRuntimeColdBackgroundV1(file){
 const pins=new Map();
 async function json(path){path=resolve(path);const before=await lstat(path);need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size>0&&before.size<=2*1024**2,'COLD_BACKGROUND_FILE');const bytes=await readFile(path),after=await lstat(path);need(after.isFile()&&!after.isSymbolicLink()&&before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'COLD_BACKGROUND_FILE_CHANGED');const digest=hash(bytes);if(pins.has(path))need(pins.get(path)===digest,'COLD_BACKGROUND_CONFIG_CHANGED');else pins.set(path,digest);return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}
 const path=resolve(file),entry=await json(path),from=p=>resolve(dirname(path),p);
 need(entry&&Object.keys(entry).sort().join(',')==='authorityRuntimeFile,baseRuntimeFile,format,kind,purpose,trustFile'&&entry.format===1&&entry.purpose==='RUNTIME_COLD_BACKGROUND_V1'&&Object.hasOwn(loaders,entry.kind),'COLD_BACKGROUND_CONFIG');
 need([entry.baseRuntimeFile,entry.authorityRuntimeFile,entry.trustFile].every(validPath),'COLD_BACKGROUND_REFERENCE');
 const baseFile=from(entry.baseRuntimeFile),authorityFile=from(entry.authorityRuntimeFile),trustFile=from(entry.trustFile);need(new Set([path,baseFile,authorityFile,trustFile]).size===4,'COLD_BACKGROUND_REFERENCE_ALIAS');
 const authority=authorityRuntimeV1(await json(authorityFile)),guard=new RuntimeColdGuardV1(await json(trustFile),new IdentityAuthorityGuardV1(authority)),state=await guard.assertCurrent(),raw=await json(baseFile);
 need(raw.mode==='WORKER'&&raw.auth?.mode==='oidc'&&raw.auth.issuer===authority.issuer,'COLD_BACKGROUND_WORKER_MODE');
 const credentialFile=state.details.admission.credentialFile,credentials=await json(credentialFile);need(pins.get(resolve(credentialFile))===state.details.admission.credentialHash&&credentials.controlId===state.source.controlId,'COLD_BACKGROUND_CREDENTIAL_BINDING');
 function account(a,b){need(a&&b&&typeof a.user==='string'&&typeof a.password==='string'&&typeof a.database==='string'&&['127.0.0.1','::1'].includes(a.host)&&Number.isInteger(a.port)&&a.port>0&&a.port<=65535,'COLD_BACKGROUND_SQL_CONFIG');const db=state.source.inventory.databases.find(d=>d.datname===a.database),role=state.source.inventory.roles.find(r=>r.rolname===a.user);need(db&&role&&db.oid===b.databaseOid&&role.oid===b.roleOid&&role.rolcanlogin&&credentials.roles[a.user]===a.password&&state.source.active.some(d=>d.database===a.database&&d.databaseOid===b.databaseOid),'COLD_BACKGROUND_REGISTERED_SQL');}
 account(raw.business?.account,raw.business?.binding);account(raw.queue?.account,raw.queue?.binding);need(raw.business.binding.tenantId===raw.queue.binding.tenantId,'COLD_BACKGROUND_TENANT');
 need(validPath(raw.authRuntimeFile)&&validPath(raw.jobKeyFile),'COLD_BACKGROUND_PRIVATE_REFERENCES');const authFile=resolve(dirname(baseFile),raw.authRuntimeFile),auth=await json(authFile);account({host:auth.host,port:auth.port,...auth.account},raw.authAuditBinding);need(validPath(auth.keyFile),'COLD_BACKGROUND_AUTH_KEY');await json(resolve(dirname(authFile),auth.keyFile));await json(resolve(dirname(baseFile),raw.jobKeyFile));
 async function check(){for(const p of pins.keys())await json(p);return guard.assertCurrent();}
 let runtime,closing=false,inflight,closePromise;
 try{
  runtime=await loaders[entry.kind](baseFile);await check();
  const original=runtime.provider.resolve.bind(runtime.provider);runtime.provider.resolve=async(reference)=>{await check();if(reference?.kind==='SESSION')await guard.requireSession(reference.value);return original(reference);};
  const {config,queue,crypto,provider,transport,predictor,sources}=runtime;let next;
  if(entry.kind==='GOVERNANCE'){need(Array.isArray(config.sources)&&config.sources.length>0,'COLD_BACKGROUND_SOURCES');const worker=new GovernanceConsoleWorkerV4({queue,queueAccount:config.queue.account,crypto,auth:provider,account:config.business.account,binding:config.business.binding,sources:config.sources});next=()=>worker.runOne();}
  else if(entry.kind==='MAINTENANCE'){need(transport,'COLD_BACKGROUND_WORKFLOW');const options={queue,crypto,auth:provider,account:config.business.account,binding:config.business.binding,workflowBinding:transport.binding},commands=new MaintenanceCommandWorkerV4(options),flows=new MaintenanceFlowWorkerV4({...options,flows:new MaintenanceFlowStoreV4(queue),transport});next=async()=>{const command=await commands.runOne();if(closing)return command;await check();const flow=await flows.runOne();return command||flow;};}
  else{need(transport&&predictor&&sources,'COLD_BACKGROUND_PREDICTIVE_SERVICES');const read=new PredictiveConsoleReadV4(config.business.account,config.business.binding),query=new PredictiveConsoleQueryV4({account:config.business.account,binding:config.business.binding,codec:runtime.auth.auditCursors,queue,proof:read}),legacy=new PredictiveLegacyReadV4(config.business.account,config.business.binding,query),adoption=new PredictiveAdoptionStoreV4(queue);await adoption.probe(true);const adopting=new PredictiveAdoptingJobStoreV4({account:config.business.account,binding:config.business.binding,queueAccount:config.queue.account,queueBinding:config.queue.binding,crypto,auth:provider,read:legacy}),worker=new PredictiveCommandWorkerV4({queue:adopting,crypto,auth:provider,account:config.business.account,binding:config.business.binding,predictor,workflow:transport,sources});next=()=>worker.runOne();}
  return {kind:entry.kind,tenantId:config.business.binding.tenantId,sourcePins:[...pins].map(([path,sha256])=>({path,sha256})),async assertCurrent(){need(!closing,'COLD_BACKGROUND_CLOSING');return check();},async runOne(){need(!closing&&!inflight,'COLD_BACKGROUND_BUSY_OR_CLOSING');const task=(async()=>{await check();if(closing)return null;return next();})();inflight=task;try{return await task;}finally{if(inflight===task)inflight=undefined;}},close(){closing=true;return closePromise??=(async()=>{try{await inflight;}finally{await runtime.close();}})();}};
 }catch(e){await runtime?.close();throw e;}
}
