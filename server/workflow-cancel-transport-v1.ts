import {canonical,digest} from './imports.ts';
import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {readLimited} from '../integrations/ai.ts';
import type {MaintenanceEnvelopeV4,MaintenanceEngineResponseV4} from './maintenance-workflow-transport-v4.ts';
const brand=Symbol('WORKFLOW_CANCEL_RECONCILIATION_V1');
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
export interface WorkflowCancelDecisionV1 {format:'IDMS_WORKFLOW_CANCEL_RECONCILIATION_V1';tenantId:string;authorityId:string;catalogHash:string;controlId:string;commandId:string;entityId:string;requestDigest:string;outcome:'CREATED'|'BLOCKED';creation:MaintenanceEngineResponseV4|null}
export class WorkflowCancelTransportErrorV1 extends Error {readonly terminal:boolean;constructor(code:string,terminal:boolean){super(code);this.terminal=terminal;}}
function need(ok:unknown,code:string):asserts ok {if(!ok)throw new WorkflowCancelTransportErrorV1(code,true);}
export class WorkflowCancelProofV1 {
 #envelope:MaintenanceEnvelopeV4;#binding:string;#decision:WorkflowCancelDecisionV1;
 constructor(token:symbol,envelope:MaintenanceEnvelopeV4,binding:string,decision:WorkflowCancelDecisionV1){need(token===brand,'WORKFLOW_CANCEL_PROOF_CONSTRUCTOR');this.#envelope=clone(envelope);this.#binding=binding;this.#decision=clone(decision);}
 forCancellation(envelope:MaintenanceEnvelopeV4,binding:string,controlId:string){need(binding===this.#binding&&controlId===this.#decision.controlId&&canonicalEqual(envelope,this.#envelope),'WORKFLOW_CANCEL_PROOF_BINDING');return clone(this.#decision);}
}
export interface WorkflowCancelTransportConfigV1 {baseUrl:string;tenantId:string;token:string;authorityId:string;catalogHash:string}
export class WorkflowCancelTransportV1 {
 readonly binding:string;#config:WorkflowCancelTransportConfigV1;#url:URL;
 constructor(config:WorkflowCancelTransportConfigV1){
  const u=new URL(config.baseUrl);need(!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname))&&/^[a-z][a-z0-9_-]{0,63}$/.test(config.tenantId)&&typeof config.token==='string'&&config.token.length>=32&&config.token.length<=4096&&!/[\r\n]/.test(config.token)&&uuid(config.authorityId)&&/^[a-f0-9]{64}$/.test(config.catalogHash),'WORKFLOW_CANCEL_CONFIG');
  this.#config={...config};this.#url=u;this.binding=canonicalDigest({origin:u.origin,tenantId:config.tenantId,authorityId:config.authorityId,catalogHash:config.catalogHash,credentialWitness:digest(config.token)});
 }
 #envelope(value:MaintenanceEnvelopeV4){need(value&&typeof value==='object'&&!Array.isArray(value),'WORKFLOW_CANCEL_ORIGINAL_ENVELOPE');const {requestDigest,...body}=value;need(uuid(value.commandId)&&uuid(value.entityId)&&value.action==='create'&&value.expectedVersion===1&&digest(canonical(body))===requestDigest,'WORKFLOW_CANCEL_ORIGINAL_ENVELOPE');}
 async #call(controlId:string,envelope:MaintenanceEnvelopeV4,method:'GET'|'POST'){
  need(uuid(controlId),'WORKFLOW_CANCEL_CONTROL_ID');this.#envelope(envelope);envelope=clone(envelope);let response:Response,body:string;
  try{response=await fetch(new URL('/v1/cancel-reconciliations'+(method==='GET'?'/'+controlId:''),this.#url),{method,headers:{Authorization:'Bearer '+this.#config.token,'X-IDMS-Tenant':this.#config.tenantId,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify({controlId,envelope})}:{}),redirect:'error',signal:AbortSignal.timeout(12000)});body=await readLimited(response.body,256000);}catch{throw new WorkflowCancelTransportErrorV1('WORKFLOW_CANCEL_NETWORK_UNCONFIRMED',false);}
  if(method==='GET'&&response.status===404)return null;
  if(!response.ok)throw new WorkflowCancelTransportErrorV1('WORKFLOW_CANCEL_HTTP_'+response.status,response.status<500&&response.status!==429);
  let value:WorkflowCancelDecisionV1;try{value=JSON.parse(body);}catch{throw new WorkflowCancelTransportErrorV1('WORKFLOW_CANCEL_RECEIPT_INVALID',true);}
  need(value&&Object.keys(value).sort().join(',')==='authorityId,catalogHash,commandId,controlId,creation,entityId,format,outcome,requestDigest,tenantId'&&value.format==='IDMS_WORKFLOW_CANCEL_RECONCILIATION_V1'&&value.tenantId===this.#config.tenantId&&value.authorityId===this.#config.authorityId&&value.catalogHash===this.#config.catalogHash&&value.controlId===controlId&&value.commandId===envelope.commandId&&value.entityId===envelope.entityId&&value.requestDigest===envelope.requestDigest&&['CREATED','BLOCKED'].includes(value.outcome),'WORKFLOW_CANCEL_RECEIPT_BINDING');
  if(value.outcome==='BLOCKED')need(value.creation===null,'WORKFLOW_CANCEL_BLOCKED_RESULT');
  else{const c=value.creation;need(c&&c.commandId===envelope.commandId&&c.entityId===envelope.entityId&&c.requestDigest===envelope.requestDigest&&c.version===1&&c.state===(envelope.assignee?'ASSIGNED':'UNASSIGNED')&&typeof c.processInstanceId==='string'&&c.processInstanceId.length>0&&c.processInstanceId.length<=256&&typeof c.definitionId==='string'&&c.definitionId.length>0&&c.definitionId.length<=512&&Array.isArray(c.tasks)&&c.tasks.length===1&&c.tasks[0]?.key===(envelope.assignee?'startRepair':'claim'),'WORKFLOW_CANCEL_CREATION_PROOF');}
  return new WorkflowCancelProofV1(brand,envelope,this.binding,value);
 }
 decide(controlId:string,envelope:MaintenanceEnvelopeV4){return this.#call(controlId,envelope,'POST') as Promise<WorkflowCancelProofV1>;}
 read(controlId:string,envelope:MaintenanceEnvelopeV4){return this.#call(controlId,envelope,'GET');}
}
