import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import {MaintenanceMapV4} from './maintenance-map-v4.ts';
import {MaintenanceJobCryptoV4} from './maintenance-job-crypto-v4.ts';
import {MaintenanceFlowStoreV4,type MaintenanceFlowGrantV4} from './maintenance-flow-store-v4.ts';
import {MaintenanceWorkflowWorkerV4} from './maintenance-workflow-worker-v4.ts';
import {MaintenanceWorkflowTransportV4} from './maintenance-workflow-transport-v4.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import type {GovernanceAuthReferenceV4} from './governance-job-crypto-v4.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {DomainError} from './service.ts';
export interface MaintenanceFlowWorkerOptionsV4 {flows:MaintenanceFlowStoreV4;crypto:MaintenanceJobCryptoV4;auth:Pick<GovernanceJobAuthV4,'resolve'>;account:ClientConfig;binding:StateMapBinding;transport:MaintenanceWorkflowTransportV4;onError?:(e:unknown)=>Promise<void>}
export class MaintenanceFlowWorkerV4 {
 #o:MaintenanceFlowWorkerOptionsV4;#busy=false;
 constructor(o:MaintenanceFlowWorkerOptionsV4){this.#o=o;}
 async runOne(){if(this.#busy)throw Error('MAINTENANCE_FLOW_WORKER_BUSY');this.#busy=true;let grant:MaintenanceFlowGrantV4|null=null;
  try{const base=new MaintenanceMapV4(this.#o.account,this.#o.binding,{workflowBinding:this.#o.transport.binding}),next=await base.next();if(!next)return null;if(next.job.status!=='PENDING'||next.position!==next.job.queuePosition){await base.acknowledgePosition(next.position,next.job.commandId);return {status:next.job.status};}
   grant=await this.#o.flows.read(next.job.commandId);need(grant,'MAINTENANCE_FLOW_AUTH_MISSING');if(!grant.ready||grant.waitingAuth)return null;const initial=grant;
   const resolve=async()=>{const current=await this.#o.flows.read(initial.commandId);need(current&&current.revision===initial.revision&&!current.waitingAuth,'MAINTENANCE_FLOW_AUTH_CHANGED');const ref=this.#o.crypto.open(current.sealedGrant,current.job,'GRANT',current.revision) as GovernanceAuthReferenceV4,live=await this.#o.auth.resolve(ref);need(live.context.tenantId===next.job.tenantId&&live.context.actorId===next.job.context.actorId,'MAINTENANCE_FLOW_AUTH_IDENTITY');return live;};
   let live=await resolve();const map=new MaintenanceMapV4(this.#o.account,this.#o.binding,{workflowBinding:this.#o.transport.binding,hooks:{commit:async(head,id,ops)=>{live=await resolve();return this.#o.flows.apply(initial,this.#o.binding,live.deadline,head,id,ops);}}});
   return await new MaintenanceWorkflowWorkerV4({map,transport:this.#o.transport,resolveCurrent:async()=>{live=await resolve();return live.context;}}).runOne();
  }catch(e){await this.#o.onError?.(e);if(grant)await this.#o.flows.defer(grant,e instanceof DomainError&&[401,403].includes(e.status)).catch(()=>{});return {status:e instanceof DomainError&&[401,403].includes(e.status)?'WAITING_AUTH':'RETRY'};
  }finally{this.#busy=false;}
 }
}
