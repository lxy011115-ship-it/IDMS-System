import type {ClientConfig} from 'pg';
import type {PublicGovernedSource} from './source-governance.ts';
import {AiImportSourceV4,type AiImportApplicationClaimV4} from './ai-import-source-v4.ts';
import {VerifiedAiImportResultV4} from './ai-import-result-proof-v4.ts';
import {GovernanceAiCommandServiceV4} from './governance-ai-command-v4.ts';
import {startAiImportHeartbeatV4} from './ai-import-heartbeat-v4.ts';
import {aiReviewNeedV4 as need} from './ai-review-request-v4.ts';
export interface AiImportApplicationWorkerOptionsV4 {source:AiImportSourceV4;account:ClientConfig;sources:readonly PublicGovernedSource[];onPhase?:(phase:string,value:unknown)=>Promise<void>;onError?:(code:string,requestId:string,error?:unknown)=>Promise<void>}
export class AiImportApplicationWorkerV4 {
 #o:AiImportApplicationWorkerOptionsV4;#busy=false;
 constructor(options:AiImportApplicationWorkerOptionsV4){this.#o=options;}
 async runOne(){need(!this.#busy,'AI_IMPORT_APPLICATION_WORKER_BUSY');this.#busy=true;const o=this.#o;let claim:AiImportApplicationClaimV4|null=null,heartbeat:Awaited<ReturnType<typeof startAiImportHeartbeatV4>>|undefined;
  try{claim=await o.source.claimApplication();if(!claim)return null;const lease=claim;heartbeat=await startAiImportHeartbeatV4(o.account,o.source.binding,lease);await o.onPhase?.('CLAIMED',lease);const proof=await VerifiedAiImportResultV4.verify(o.source,lease),p=proof.data(),ctx={tenantId:p.intent.header.tenantId,actorType:'SYSTEM',actorId:'idms.ai-import-v4',correlationId:p.identity.commandId};
   const check=async()=>{heartbeat!.assertLive();await o.source.checkApplicationClaim(lease);await o.source.intent(p.intent.header);};
   const service=new GovernanceAiCommandServiceV4(o.account,o.source.stateBinding,o.sources,{kind:'APPLY',configuration:o.source.configuration,proof},{commit:async(h,id,ops)=>{await check();return o.source.prepareApplication(lease,h,id,ops);},onPhase:async(phase,value)=>{if(phase!=='PUBLISHED')await check();await o.onPhase?.(phase,value);},publish:async(b,id)=>{await check();return o.source.publishApplication(lease,b,id);}});
   await service.execute(p.identity.commandId,p.identity.command,ctx);const found=await o.source.readApplication(lease.requestId);need(found?.status==='APPLIED','AI_IMPORT_APPLICATION_UNCONFIRMED');return found;
  }catch(error){if(!claim)throw error;await heartbeat?.stop();heartbeat=undefined;const found=await o.source.readApplication(claim.requestId);if(found?.status==='APPLIED')return found;const message=(error as Error).message,code=message==='AI_IMPORT_TENANT_NOT_ACTIVE'?'TENANT_NOT_ACTIVE':message==='AI_IMPORT_POLICY_CHANGED'?'POLICY_CHANGED':/GOVERNANCE_INTAKE_(BUSY|CLOSED)|AI_IMPORT_OTHER_MAINTENANCE/.test(message)?'BUSINESS_BUSY':'APPLICATION_UNCONFIRMED';await o.onError?.(code,claim.requestId,error);await o.source.deferApplication(claim,code).catch(()=>{});return {requestId:claim.requestId,status:'RETRY',errorCode:code};
  }finally{await heartbeat?.stop();this.#busy=false;}
 }
}
