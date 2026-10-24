import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
/** Native QA seed through the real original command API; no direct SQL case or fake recovery response. */
export async function seedColdReviewSourceWorkflowsQaV2(flow){
 const cases={};
 for(const tenant of Object.keys(flow.tenants)){const config=flow.config(tenant).workflow,id=randomUUID(),engineer='cold-review-source-engineer';let version=1,last;
  const command=async(action,actor,extra={})=>{const body={commandId:randomUUID(),entityId:id,action,expectedVersion:version,actor:{id:actor,type:'USER',permissions:[action==='create'?'predictive:approve':action==='approval'?'maintenance:approve':'maintenance:execute']},correlationId:'cold-readonly-source-qa',...extra},digest=createHash('sha256').update(canonical(body)).digest('hex'),r=await fetch(config.baseUrl+'/v1/commands',{method:'POST',headers:{Authorization:'Bearer '+config.serviceToken,'X-IDMS-Tenant':tenant,'Content-Type':'application/json'},body:canonical({...body,requestDigest:digest}),signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);last=await r.json();version=last.version;};
  await command('create','cold-review-source-author',{assignee:engineer});
  if(tenant==='acme'){await command('start',engineer);await command('submit',engineer,{evidenceDigest:'e'.repeat(64)});await command('approval','cold-review-source-independent-approver',{evidenceDigest:'e'.repeat(64),decision:'APPROVED',comment:'QA independent repair review before cold archive'});}
  cases[tenant]={entityId:id,state:last.state,version:last.version,commandId:last.commandId};
 }return cases;
}
