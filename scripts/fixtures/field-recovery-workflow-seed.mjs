import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {writePrivate} from '../keycloak-local.mjs';
import {mutate,consistentRead} from '../../server/import-api.ts';
import {WorkflowService} from '../../server/workflow.ts';
import {approvePredictiveAlert} from '../../server/predictive.ts';
export async function seedRecoveryWorkflow({store,history,directory,runtime}){
 assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.IDMS_FIELD_REVIEW_WORKFLOW_QA,'1');assert.match(runtime.tenants.acme.database,/^idms_fieldarchiveqa_acme_[a-f0-9]{10}$/);
 const input=JSON.parse(await readFile(process.env.IDMS_FIELD_REVIEW_WORKFLOW_SEED,'utf8'));assert.equal(input.format,'idms-field-recovery-workflow-seed-v1');assert.match(input.client.baseUrl,/^http:\/\/127\.0\.0\.1:[0-9]+$/);for(const actor of [input.approver,input.technician])assert.match(actor,/^[a-f0-9-]{36}$/);assert.notEqual(input.approver,input.technician);
 const file=resolve(directory,'workflow-client.json');await writePrivate(file,JSON.stringify({baseUrl:input.client.baseUrl,tenants:Object.fromEntries(Object.keys(runtime.tenants).map(t=>[t,{serviceToken:t==='acme'?input.client.serviceToken:'unconfigured-sandbox-no-network-000000000000'}]))}));process.env.IDMS_WORKFLOW_CLIENT_CONFIG=file;
 const workflow=new WorkflowService(),ctx=(actorId,roles)=>({tenantId:'acme',actorId,actorType:'USER',authMode:'oidc',roles,scope:{provided:true,sites:['*'],lines:['*'],devices:['*']},correlationId:randomUUID()}),approver=()=>ctx(input.approver,['final-approver']),technician=()=>ctx(input.technician,['maintenance-engineer']);
 const read=()=>consistentRead(store,'acme',async w=>structuredClone(w.store.workOrders)),ids=[];
 const synced=async id=>{const deadline=Date.now()+30000;for(;;){await workflow.flush(store);const o=(await read()).find(o=>o.id===id);assert.ok(o);if(o.workflow?.status==='SYNCED')return o;assert.notEqual(o.workflow?.status,'HUMAN_REVIEW');assert.ok(Date.now()<deadline,'Actual workflow outbox failed to synchronize');await new Promise(ok=>setTimeout(ok,25));}};
 const change=async(id,action,input,who)=>{const o=await synced(id);await mutate(store,(client,w)=>workflow.change(client,w.store,id,action,{...input,expectedVersion:o.version},who(),w.imports),'acme');return synced(id);};
 const resolution=o=>({failureCode:'QA-FLOW',cause:'隔离恢复流程核验',action:'复核维修动作',verification:'复核状态和证据',minutes:15,partsUsed:[],...(o.templateBinding?{customFields:Object.fromEntries(o.templateBinding.fields.map(f=>[f.key,f.type==='BOOLEAN'?true:f.type==='NUMBER'?(f.min??f.max??1):f.type==='SELECT'?f.options[0]:'恢复核验'.slice(0,f.maxLength??200)]))}:{})});
 try{
  await workflow.start(store,history);
  for(const stage of ['UNASSIGNED','IN_PROGRESS','AWAITING_APPROVAL','CLOSED']){
   const id=await mutate(store,async(client,w)=>{const base=w.store.predictiveAlerts.find(a=>a.tenantId==='acme'),rec=w.store.maintenanceRecommendations.find(r=>r.tenantId==='acme'&&r.alertId===base.id);assert.ok(base&&rec);const alert={...structuredClone(base),id:randomUUID(),title:'归档恢复流程 '+stage,state:'AWAITING_APPROVAL',version:1};for(const k of ['workOrderId','approvedBy','approvalComment','approvedAt'])delete alert[k];w.store.predictiveAlerts.push(alert);w.store.maintenanceRecommendations.push({...structuredClone(rec),id:randomUUID(),alertId:alert.id,status:'PROPOSED'});approvePredictiveAlert(w.store,alert.id,'APPROVED','真实业务事务生成恢复工单',approver(),w.imports);const o=w.store.workOrders.find(o=>o.id===alert.workOrderId);await workflow.queueCreate(w.store,client,o,approver());return o.id;},'acme');ids.push(id);let o=await synced(id);
   if(stage!=='UNASSIGNED'){o=await change(id,'claim',{},technician);o=await change(id,'start',{},technician);o=await change(id,'submit',resolution(o),technician);if(stage!=='AWAITING_APPROVAL')o=await change(id,'approval',{decision:stage==='CLOSED'?'APPROVED':'RETURNED',snapshotDigest:o.resolution.digest,comment:'不同主体核对维修证据'},approver);}
   assert.equal(o.state,stage);
  }
  const orders=await read();assert.equal(orders.length,4);assert.ok(orders.every(o=>ids.includes(o.id)&&o.workflow.status==='SYNCED'));await writePrivate(resolve(directory,'workflow-seeded-orders.json'),JSON.stringify(orders));
  return {actualDomainTransactionsAndWorkflowOutbox:true,actualFourWorkOrders:4,states:orders.map(o=>o.state).sort(),actualIndependentRepairApprovalAndReturn:true,allOutboxReceiptsSyncedBeforeSourceFreeze:true};
 }finally{await workflow.close();}
}
