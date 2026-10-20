import type {AccessContext} from './access.ts';
import {MaintenanceMapV4,type MaintenanceJobV4} from './maintenance-map-v4.ts';
import {MaintenanceWorkflowTransportV4,MaintenanceTransportErrorV4} from './maintenance-workflow-transport-v4.ts';
/** Resolution must consult current trusted identity state; job.context is historical evidence only. */
export class MaintenanceWorkflowWorkerV4 {
 #map:MaintenanceMapV4;#transport:MaintenanceWorkflowTransportV4;#resolve:(job:MaintenanceJobV4)=>Promise<AccessContext>;
 #phase?:(phase:'RESPONSE_VERIFIED'|'BUSINESS_COMMITTED',job:MaintenanceJobV4)=>Promise<void>;
 constructor(options:{map:MaintenanceMapV4;transport:MaintenanceWorkflowTransportV4;resolveCurrent:(job:MaintenanceJobV4)=>Promise<AccessContext>;onPhase?:(phase:'RESPONSE_VERIFIED'|'BUSINESS_COMMITTED',job:MaintenanceJobV4)=>Promise<void>}){this.#map=options.map;this.#transport=options.transport;this.#resolve=options.resolveCurrent;this.#phase=options.onPhase;}
 async runOne(){const next=await this.#map.next();if(!next)return null;const {job,position}=next;if(job.status!=='PENDING'||job.queuePosition!==position){await this.#map.acknowledgePosition(position,job.commandId);return {commandId:job.commandId,status:job.status};}
  const ctx=await this.#resolve(job);await this.#map.authorize(job,ctx);let proof;
  try{proof=await this.#transport.dispatch(job.envelope,job.proposed);}catch(e){if(!(e instanceof MaintenanceTransportErrorV4))throw e;const status=await this.#map.failure(job,e.message,e.terminal);if(status!=='PENDING')await this.#map.acknowledgePosition(position,job.commandId);return {commandId:job.commandId,status};}
  // Persistence errors occur outside the transport catch: they never spend the network budget.
  await this.#phase?.('RESPONSE_VERIFIED',job);const fresh=await this.#resolve(job);await this.#map.apply(job,proof,fresh);await this.#phase?.('BUSINESS_COMMITTED',job);await this.#map.acknowledgePosition(position,job.commandId);return {commandId:job.commandId,status:'SYNCED'};
 }
}
