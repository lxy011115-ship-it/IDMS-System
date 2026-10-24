import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createAuth} from '../../server/auth.ts';
import {PredictiveMapV4} from '../../server/predictive-map-v4.ts';
import {PredictiveWorkerV4} from '../../server/predictive-worker-v4.ts';
import {PredictiveRuleTransportV4} from '../../server/predictive-transport-v4.ts';
import {MaintenanceMapV4} from '../../server/maintenance-map-v4.ts';
import {MaintenanceWorkflowTransportV4} from '../../server/maintenance-workflow-transport-v4.ts';
import {MaintenanceWorkflowWorkerV4} from '../../server/maintenance-workflow-worker-v4.ts';
import {authorityJsonV1} from '../../server/identity-authority-live-v1.ts';
import {createPlatformFieldAdminQaV1} from './platform-field-admin-v1-qa.mjs';

/** New native source only: genuine domain writes and genuine engine commands with fresh OIDC actors. */
export async function seedColdReviewConsistentBusinessQaV1({site,identity,work,save}){
 const privateIdentity=JSON.parse(await readFile(join(work,'identity.private.json'),'utf8'));
 const api=createPlatformFieldAdminQaV1({issuer:identity.runtime.issuer,admin:privateIdentity.admin});
 const auth=createAuth(site.auth),cases={},participants={};
 const predictor=JSON.parse(await readFile(join(work,'predictor.private.json'),'utf8'));
 const rule=new PredictiveRuleTransportV4({baseUrl:'http://127.0.0.1:'+predictor.port,serviceToken:predictor.serviceToken});
 try{
  for(const tenant of ['acme','sandbox']){
   const users={};
   for(const [name,roles]of Object.entries({author:['tenant-admin','data-uploader'],reviewer:['final-approver'],engineer:['maintenance-engineer']})){
    const username='recovery-'+tenant+'-'+name,password=randomBytes(32).toString('base64url');
    await api(identity.realm+'/users','POST',{username,enabled:true,firstName:'Recovery',lastName:'QA',email:username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:[tenant],idms_sites:['*'],idms_lines:['*'],idms_devices:['*']},credentials:[{type:'password',value:password,temporary:false}]});
    const found=await api(identity.realm+'/users?username='+username+'&exact=true');assert.equal(found.length,1);const user=found[0];
    const mappings=[];for(const role of roles)mappings.push(await api(identity.realm+'/roles/'+role));
    await api(identity.realm+'/users/'+user.id+'/role-mappings/realm','POST',mappings);users[name]={id:user.id,username,password};
   }
   const live=async name=>{const u=users[name],tokens=await authorityJsonV1(identity.runtime.issuer+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:site.auth.clientId,username:u.username,password:u.password,scope:'openid'})}),checked=await auth.verify(tokens.access_token);assert.equal(checked.identity.actorId,u.id);assert.equal(checked.identity.tenantId,tenant);return{context:{...checked.identity,correlationId:'cold-review-consistent-business-v1'},deadline:checked.expiresAt};};
   const target=site.qa.targets[tenant],base=JSON.parse(await readFile(site.workers[tenant],'utf8'));
   const transport=new MaintenanceWorkflowTransportV4(site.flow.config(tenant).workflow);
   const map=new PredictiveMapV4(target.account,target.binding,{predictorBinding:rule.binding,workflowBinding:transport.binding,sources:base.read.sources});
   const worker=new PredictiveWorkerV4({map,predictor:rule,workflow:transport,resolveCurrent:async job=>{const name=Object.keys(users).find(n=>users[n].id===job.actorId);assert(name);return live(name);}});
   await map.submit({kind:'ANALYZE',deviceCode:'READ-004',source:'APPROVED_IMPORT'},randomUUID(),(await live('author')).context);
   const analysis=await worker.runOne();assert.equal(analysis.status,'COMMITTED');assert(analysis.result.alertId&&analysis.result.evidenceDigest);
   await map.submit({kind:'REVIEW',alertId:analysis.result.alertId,expectedVersion:1,evidenceDigest:analysis.result.evidenceDigest,decision:'APPROVED',comment:'真实当前身份独立批准恢复验证工单'},randomUUID(),(await live('reviewer')).context);
   const reviewed=await worker.runOne();assert.equal(reviewed.status,'COMMITTED');assert.equal(reviewed.result.status,'WORK_ORDER_CREATED');let order=reviewed.result.order;
   const maintenance=new MaintenanceMapV4(target.account,target.binding,{workflowBinding:transport.binding});
   const maintenanceWorker=new MaintenanceWorkflowWorkerV4({map:maintenance,transport,resolveCurrent:async job=>{const name=Object.keys(users).find(n=>users[n].id===job.context.actorId);assert(name);return(await live(name)).context;}});
   const change=async(action,input,name)=>{await maintenance.execute({id:order.id,action,input:{expectedVersion:order.version,...input}},randomUUID(),(await live(name)).context);const result=await maintenanceWorker.runOne();assert.equal(result.status,'SYNCED');order=await maintenance.get(order.id,(await live(name)).context);};
   await change('claim',{},'engineer');
   if(tenant==='acme'){
    await change('start',{},'engineer');
    await change('submit',{failureCode:'BEARING',cause:'测试轴承异常',action:'更换测试轴承',verification:'额定负载复测通过',minutes:30,partsUsed:['QA轴承'],customFields:{post_vibration:3.1,guard_checked:true,load_level:'额定负载',verification_note:'隔离验证'}},'engineer');
    await change('approval',{decision:'APPROVED',snapshotDigest:order.resolution.digest,comment:'当前独立用户核验测试维修证据'},'reviewer');assert.equal(order.state,'CLOSED');
   }else assert.equal(order.state,'ASSIGNED');
   cases[tenant]={entityId:order.id,state:order.state,version:order.version,commandId:order.workflow.commandId,actualDomainAndWorkflowWrites:true};participants[tenant]=users;
  }
  await save('consistent-source-participants.private.json',participants);
  return cases;
 }finally{await auth.close();}
}
