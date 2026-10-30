import {MaintenanceJobStoreV4,MaintenanceQueueCommitUnknownV4,type MaintenanceQueueClaimV4,type MaintenanceQueueJobV4} from './maintenance-job-store-v4.ts';
import type {StateHead,StateMapBinding} from './state-map-sql-v1.ts';
import {stateRequestDigest,stateReceiptHash,type StateOperation,type StateReceipt} from './state-map-v1.ts';
import {inspectStateMapCatalog} from './state-map-catalog-v1.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
export interface MaintenanceFlowGrantV4 {commandId:string;actorId:string;revision:string;grantUntil:string;waitingAuth:boolean;ready:boolean;sealedGrant:unknown;job:MaintenanceQueueJobV4}
const raw=(s:string)=>Buffer.from(s,'hex');
export class MaintenanceFlowStoreV4 {
 readonly queue:MaintenanceJobStoreV4;
 constructor(queue:MaintenanceJobStoreV4){this.queue=queue;}
 read(commandId:string,actorId=''):Promise<MaintenanceFlowGrantV4|null>{return this.queue.extension('FLOW_READ',commandId,async c=>{const v=(await c.query('SELECT maintenance_jobs_v4.flow_read_v4($1,$2,$3) AS value',[this.queue.binding.tenantId,actorId,commandId])).rows[0].value;if(v)need(v.commandId===commandId&&v.job.tenantId===this.queue.binding.tenantId&&v.actorId===v.job.actorId&&/^[1-9][0-9]*$/.test(v.revision),'MAINTENANCE_FLOW_GRANT_BINDING');return v;});}
 authorize(grant:MaintenanceFlowGrantV4,sealed:unknown,until:number){return this.queue.extension('FLOW_AUTHORIZE',grant.commandId,async c=>(await c.query('SELECT maintenance_jobs_v4.flow_authorize_v4($1,$2,$3,$4,$5,$6) AS value',[this.queue.binding.tenantId,grant.actorId,grant.commandId,grant.revision,sealed,new Date(until)])).rows[0].value===true);}
 defer(grant:MaintenanceFlowGrantV4,waiting:boolean){return this.queue.extension('FLOW_DEFER',grant.commandId,async c=>(await c.query('SELECT maintenance_jobs_v4.flow_defer_v4($1,$2,$3,$4) AS value',[this.queue.binding.tenantId,grant.commandId,grant.revision,waiting])).rows[0].value===true);}
 fail(lease:MaintenanceQueueClaimV4,deadline:number,error:{status:number;message:string}){return this.queue.extension('FAIL',lease.id,async c=>(await c.query('SELECT maintenance_jobs_v4.fail_v4($1,$2,$3,$4,$5,$6,$7,$8) AS value',[lease.tenantId,lease.id,lease.owner,lease.token,lease.fence,lease.grantRevision,new Date(deadline),error])).rows[0].value as MaintenanceQueueJobV4);}
 async apply(grant:MaintenanceFlowGrantV4,binding:StateMapBinding,deadline:number,head:StateHead,id:string,ops:StateOperation[]){
  const request=stateRequestDigest(binding.tenantId,id,head.revision,head.rootHash,ops),check=(r:StateReceipt)=>{need(r&&r.tenantId===binding.tenantId&&r.commandId===id&&r.requestHash===request&&r.beforeRevision===head.revision&&r.beforeRoot===head.rootHash&&r.beforeReceiptHash===head.receiptHash&&BigInt(r.revision)===BigInt(head.revision)+1n&&r.receiptHash===stateReceiptHash(r),'MAINTENANCE_FLOW_WRITE_RECEIPT');return r;};
  try{return await this.queue.extension('FLOW_APPLY',id,async c=>{need(binding.databaseOid===this.queue.binding.databaseOid&&binding.roleOid===this.queue.binding.roleOid&&await inspectStateMapCatalog(c)===binding.catalogHash,'MAINTENANCE_FLOW_BUSINESS_BINDING');return check((await c.query('SELECT maintenance_jobs_v4.flow_apply_v4($1,$2,$3,$4,$5,$6,$7,$8::jsonb) AS value',[binding.tenantId,grant.commandId,grant.revision,new Date(deadline),id,head.revision,raw(head.rootHash),JSON.stringify(ops)])).rows[0].value);});}
  catch(e){if(!(e instanceof MaintenanceQueueCommitUnknownV4))throw e;const r=await this.queue.extension('FLOW_RESOLVE',id,async c=>(await c.query('SELECT state_map_v1.read_receipt_v1($1,$2,$3) AS value',[binding.tenantId,id,raw(request)])).rows[0].value);if(r)return check(r);throw e;}
 }
}
