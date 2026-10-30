import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import {MaintenanceMapV4,maintenanceCommandAccessV4,type MaintenanceCommandV4} from './maintenance-map-v4.ts';
import {MaintenanceJobStoreV4,type MaintenanceQueueClaimV4} from './maintenance-job-store-v4.ts';
import {MaintenanceJobCryptoV4} from './maintenance-job-crypto-v4.ts';
import {MaintenanceFlowStoreV4} from './maintenance-flow-store-v4.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import type {GovernanceAuthReferenceV4} from './governance-job-crypto-v4.ts';
import {canonicalDigest} from './canonical-state.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {DomainError} from './service.ts';
import {startMaintenanceHeartbeatV4} from './maintenance-job-heartbeat-v4.ts';
export interface MaintenanceCommandWorkerOptionsV4 {queue:MaintenanceJobStoreV4;crypto:MaintenanceJobCryptoV4;auth:Pick<GovernanceJobAuthV4,'resolve'>;account:ClientConfig;binding:StateMapBinding;workflowBinding?:string;onError?:(e:unknown)=>Promise<void>}
export function openMaintenanceCommandV4(job:{id:string;actorId:string;commandId:string;requestHash:string;action:string;sealedCommand:unknown},crypto:MaintenanceJobCryptoV4){const command=crypto.open(job.sealedCommand,job,'COMMAND') as MaintenanceCommandV4;need(command&&canonicalDigest(command)===job.requestHash&&command.action===job.action,'MAINTENANCE_COMMAND_BINDING');return command;}
export class MaintenanceCommandWorkerV4 {
 #o:MaintenanceCommandWorkerOptionsV4;#busy=false;
 constructor(options:MaintenanceCommandWorkerOptionsV4){this.#o=options;}
 async runOne(){if(this.#busy)throw Error('MAINTENANCE_WORKER_BUSY');this.#busy=true;let lease:MaintenanceQueueClaimV4|null=null,heartbeat:ReturnType<typeof startMaintenanceHeartbeatV4>|undefined;
  try{lease=await this.#o.queue.claim();if(!lease)return null;const claim=lease;heartbeat=startMaintenanceHeartbeatV4(this.#o.account,this.#o.queue.binding,claim);const command=openMaintenanceCommandV4(claim,this.#o.crypto),ref=this.#o.crypto.open(claim.sealedGrant,claim,'GRANT',claim.grantRevision) as GovernanceAuthReferenceV4,flows=new MaintenanceFlowStoreV4(this.#o.queue);
   const authorize=async()=>{heartbeat!.assertLive();const live=await this.#o.auth.resolve(ref);need(live.context.tenantId===claim.tenantId&&live.context.actorId===claim.actorId,'MAINTENANCE_AUTH_IDENTITY');if(!claim.cancelRequested)maintenanceCommandAccessV4(command,live.context);await new MaintenanceMapV4(this.#o.account,this.#o.binding).get(command.id,live.context);await this.#o.queue.checkLease(claim,live.deadline);return live;};
   let live=await authorize();if(claim.cancelRequested)return await this.#o.queue.cancel(claim,live.deadline);
   const map=new MaintenanceMapV4(this.#o.account,this.#o.binding,{workflowBinding:this.#o.workflowBinding,hooks:{commit:async(head,id,ops)=>{live=await authorize();return this.#o.queue.prepare(claim,this.#o.binding,head,id,ops,live.deadline);}}});
   try{await map.execute(command,claim.commandId,live.context);}catch(e){if(e instanceof DomainError&&[400,404,409,413].includes(e.status)&&e.message!=='MAINTENANCE_FENCED'){live=await authorize();return await flows.fail(claim,live.deadline,{status:e.status,message:e.message});}throw e;}
   const job=await this.#o.queue.read(claim.actorId,claim.id);need(job?.status==='COMMITTED','MAINTENANCE_ATOMIC_COMPLETION');return job;
  }catch(e){await this.#o.onError?.(e);if(!lease)throw e;const known=await this.#o.queue.read(lease.actorId,lease.id);if(known&&['COMMITTED','FAILED','CANCELLED'].includes(known.status))return known;await this.#o.queue.defer(lease,e instanceof DomainError&&[401,403].includes(e.status),e instanceof DomainError&&[401,403].includes(e.status)?'MAINTENANCE_AUTH_REQUIRED':'MAINTENANCE_RETRY');return await this.#o.queue.read(lease.actorId,lease.id);
  }finally{await heartbeat?.stop();this.#busy=false;}
 }
}
