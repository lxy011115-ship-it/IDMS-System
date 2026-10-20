import {canonical,digest} from './imports.ts';
import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {readLimited} from '../integrations/ai.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {maintenanceWireV4} from './maintenance-map-common-v4.ts';
export interface MaintenanceEnvelopeV4 {commandId:string;entityId:string;action:string;expectedVersion:number;actor:{id:string;type:string;permissions:string[]};assignee:string;evidenceDigest?:string;decision?:unknown;comment?:unknown;correlationId:string;requestDigest:string}
export interface MaintenanceEngineResponseV4 {commandId:string;requestDigest:string;entityId:string;version:number;state:string;processInstanceId:string;definitionId:string;tasks:{key:string}[]}
const brand=Symbol('MAINTENANCE_WORKFLOW_RESPONSE_V4');
export class MaintenanceWorkflowProofV4 {
 #envelope:MaintenanceEnvelopeV4;#binding:string;#response:MaintenanceEngineResponseV4;
 constructor(token:symbol,envelope:MaintenanceEnvelopeV4,binding:string,response:MaintenanceEngineResponseV4){need(token===brand,'MAINTENANCE_RESPONSE_CONSTRUCTOR');this.#envelope=maintenanceWireV4(envelope);this.#binding=binding;this.#response=maintenanceWireV4(response);}
 forCommand(envelope:MaintenanceEnvelopeV4,binding:string){need(binding===this.#binding&&canonicalEqual(envelope,this.#envelope),'MAINTENANCE_RESPONSE_BINDING');return maintenanceWireV4(this.#response);}
}
export class MaintenanceTransportErrorV4 extends Error {readonly terminal:boolean;constructor(code:string,terminal:boolean){super(code);this.terminal=terminal;}}
export class MaintenanceWorkflowTransportV4 {
 readonly binding:string;#url:URL;#tenant:string;#token:string;
 constructor(config:{baseUrl:string;tenantId:string;serviceToken:string}){
  const u=new URL(config.baseUrl);need(!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname))&&/^[a-z][a-z0-9_-]{0,63}$/.test(config.tenantId)&&typeof config.serviceToken==='string'&&config.serviceToken.length>=32&&config.serviceToken.length<=4096&&!/[\r\n]/.test(config.serviceToken),'MAINTENANCE_WORKFLOW_CONFIG');this.#url=u;this.#tenant=config.tenantId;this.#token=config.serviceToken;this.binding=canonicalDigest({origin:u.origin,tenant:config.tenantId,credentialWitness:digest(config.serviceToken)});
 }
 async dispatch(envelope:MaintenanceEnvelopeV4,expected:{version:number;state:string}):Promise<MaintenanceWorkflowProofV4>{
  const {requestDigest,...wire}=envelope;need(digest(canonical(wire))===requestDigest,'MAINTENANCE_ENVELOPE_DIGEST');let response:Response,body:string;
  try{response=await fetch(new URL('/v1/commands',this.#url),{method:'POST',headers:{Authorization:'Bearer '+this.#token,'X-IDMS-Tenant':this.#tenant,'Content-Type':'application/json'},body:JSON.stringify(envelope),redirect:'error',signal:AbortSignal.timeout(8000)});body=await readLimited(response.body,256000);}catch{throw new MaintenanceTransportErrorV4('MAINTENANCE_ENGINE_NETWORK_UNCONFIRMED',false);}
  if(!response.ok)throw new MaintenanceTransportErrorV4('MAINTENANCE_ENGINE_HTTP_'+response.status,response.status<500&&response.status!==429);
  let v:MaintenanceEngineResponseV4;try{v=JSON.parse(body);}catch{throw new MaintenanceTransportErrorV4('MAINTENANCE_ENGINE_RECEIPT_INVALID',true);}
  if(v.commandId!==envelope.commandId||v.requestDigest!==requestDigest||v.entityId!==envelope.entityId||v.version!==expected.version||v.state!==expected.state||typeof v.processInstanceId!=='string'||!v.processInstanceId||v.processInstanceId.length>256||typeof v.definitionId!=='string'||!v.definitionId||v.definitionId.length>512||!Array.isArray(v.tasks)||v.tasks.length>32||v.tasks.some(t=>!t||typeof t.key!=='string'||!t.key||t.key.length>128))throw new MaintenanceTransportErrorV4('MAINTENANCE_ENGINE_RECEIPT_INVALID',true);
  return new MaintenanceWorkflowProofV4(brand,envelope,this.binding,v);
 }
}
