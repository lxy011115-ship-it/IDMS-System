import {randomUUID} from 'node:crypto';
import type {ClientConfig} from 'pg';
import type {AccessContext} from './access.ts';
import {requireAccess} from './access.ts';
import {DomainError} from './service.ts';
import {DomainMapSnapshot,domainMapAssert as need} from './domain-map-v4.ts';
import type {StateMapBinding,StateHead} from './state-map-sql-v1.ts';
import {stateRequestDigest,stateReceiptHash,type StateOperation,type StateReceipt} from './state-map-v1.ts';
import {inspectStateMapCatalog} from './state-map-catalog-v1.ts';
import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {domainReadAccessV4} from './domain-read-api-v4.ts';
import {PredictiveJobStoreV4,PredictiveQueueCommitUnknownV4,type PredictiveQueueBindingV4,type PredictiveQueueClaimV4,type PredictiveQueueJobV4} from './predictive-job-store-v4.ts';
import {predictiveFormatV4,predictiveReadVersionV4,predictiveJobKeyV4,predictivePlanV4,predictiveAuditsV4,type PredictiveJobV4,type PredictivePlanV4} from './predictive-state-v4.ts';
import {PredictiveConsoleReadV4} from './predictive-console-http-v4.ts';
import type {PredictiveConsoleQueryV4} from './predictive-console-query-v4.ts';
import {verifyLocalDomainAudit,auditPositionKey} from './telemetry-map-v4.ts';
import {predictiveAnalysisRequestV4} from './predictive-input-v4.ts';
import {predictiveReviewRequestV4} from './predictive-map-v4.ts';
export const predictiveAdoptionFormatV4='IDMS_PREDICTIVE_LEGACY_ADOPTION_V4_1';
export const predictiveAdoptionUuidV4=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const fail=(status:number,code:string):never=>{throw new DomainError(status,code);};
export interface PredictiveAdoptionPinsV4 {nativeHash:string;planDigest:string;nativeGrantRevision:string;nativeStatus:PredictiveJobV4['status'];migrationId:string;externalPossible:boolean}
export interface PredictiveAdoptionRequestV4 extends PredictiveAdoptionPinsV4 {controlId:string;queueGrantRevision:string}
export interface PredictiveAdoptionControlV4 {controlId:string;nativeHash:string;recoverClosedAcceptance:boolean;commandId:string;superseded:boolean;job:PredictiveQueueJobV4}
export function predictiveAdoptionCommandV4(plan:PredictivePlanV4){return plan.kind==='REVIEW'?predictiveReviewRequestV4(plan.request):predictiveAnalysisRequestV4({kind:'ANALYZE',deviceCode:plan.input.deviceCode,source:plan.input.sourceEdgeId?'TELEMETRY':'APPROVED_IMPORT',...(plan.input.sourceEdgeId?{edgeId:plan.input.sourceEdgeId}:{})});}
/** Historical context remains evidence. Callers supply the original user's current verified context. */
export async function predictiveAdoptionCandidateV4(s:DomainMapSnapshot,commandId:string,ctx:AccessContext){
 domainReadAccessV4(ctx);if(!predictiveAdoptionUuidV4(commandId))fail(400,'PREDICTIVE_COMMAND_ID');if(ctx.tenantId!==s.tenantId||ctx.actorType!=='USER')fail(403,'PREDICTIVE_ADOPTION_ACTOR');
 const key=predictiveJobKeyV4(s.tenantId,ctx.actorId,commandId),state=await s.state('predictive_job',key);if(!state.present)fail(404,'PREDICTIVE_LEGACY_JOB_NOT_FOUND');const job=state.value as PredictiveJobV4;
 need(job.format===predictiveFormatV4&&job.tenantId===s.tenantId&&job.actorId===ctx.actorId&&job.commandId===commandId&&job.key===key&&job.context.actorId===ctx.actorId&&job.context.tenantId===s.tenantId&&job.context.actorType==='USER'&&/^[1-9][0-9]*$/.test(job.grantRevision)&&['PENDING','WAITING_AUTH','HUMAN_REVIEW','COMMITTED','CANCELLED'].includes(job.status),'PREDICTIVE_ADOPTION_JOB');
 const plan=await predictivePlanV4(s,job),command=predictiveAdoptionCommandV4(plan),reconciliation=await s.get<any>('predictive_reconciliation',key),marker=await s.get<any>('domain_head','predictive'),migrationId=reconciliation.operationId;
 need(reconciliation.format==='IDMS_PREDICTIVE_READ_MIGRATION_V4_1'&&reconciliation.authority==='NONE'&&reconciliation.tenantId===s.tenantId&&reconciliation.jobKey===key&&reconciliation.actorId===job.actorId&&reconciliation.commandId===commandId&&reconciliation.requestHash===job.requestHash&&reconciliation.planDigest===job.planDigest&&predictiveAdoptionUuidV4(migrationId),'PREDICTIVE_ADOPTION_MIGRATION');
 const migration=await s.get<any>('receipt','predictive_read_migration:'+migrationId),checkpoint=await s.get<any>('predictive_read_migration',migrationId),control=await s.get<any>('domain_head','control');
 need(marker.format===predictiveFormatV4&&marker.tenantId===s.tenantId&&marker.readIndexVersion===predictiveReadVersionV4&&migration.format===reconciliation.format&&migration.tenantId===s.tenantId&&migration.operationId===migrationId&&migration.configuration===marker.configuration&&checkpoint.format===reconciliation.format&&checkpoint.tenantId===s.tenantId&&checkpoint.operationId===migrationId&&checkpoint.phase==='COMMITTED','PREDICTIVE_ADOPTION_MIGRATION');
 if(control.status!=='ACTIVE')fail(409,'PREDICTIVE_ADOPTION_FENCED');need(control.tenantId===s.tenantId,'PREDICTIVE_ADOPTION_MIGRATION');
 const externalPossible=plan.kind==='REVIEW'&&!!plan.order;need(externalPossible===reconciliation.externalCreationMayHaveStarted,'PREDICTIVE_ADOPTION_EXTERNAL');
 if(job.status==='CANCELLED'&&externalPossible)fail(409,'PREDICTIVE_CREATION_RECOVERY_REQUIRED');
 if(job.status==='COMMITTED'||job.status==='CANCELLED'){
  const r=await s.get<any>('receipt',(job.status==='COMMITTED'?'predictive:':'predictive_cancel:')+key),event=verifyLocalDomainAudit(await s.get<any>('audit',r.auditEventId),s.tenantId),order=await s.get<any>('audit_order',auditPositionKey(r.auditPosition));
  need(r.format===predictiveFormatV4&&r.tenantId===s.tenantId&&r.key===key&&r.requestHash===job.requestHash&&r.planDigest===job.planDigest&&r.auditHash===event.hash&&order.tenantId===s.tenantId&&order.position===r.auditPosition&&order.eventId===event.eventId&&(event.actorId===job.actorId||event.metadata.requestedBy===job.actorId),'PREDICTIVE_ADOPTION_TERMINAL_PROOF');
  if(job.status==='COMMITTED')need(canonicalEqual(r.result,job.result),'PREDICTIVE_ADOPTION_RESULT');else need(!job.result&&event.actorId===job.actorId&&event.action==='PREDICTIVE_COMMAND_CANCELLED','PREDICTIVE_ADOPTION_CANCEL_PROOF');
 }
 return {job,plan,command,deviceCode:plan.kind==='ANALYZE'?plan.input.deviceCode:plan.deviceCode,pins:{nativeHash:state.valueHash!,planDigest:job.planDigest,nativeGrantRevision:job.grantRevision,nativeStatus:job.status,migrationId,externalPossible} satisfies PredictiveAdoptionPinsV4,host:await s.state('predictive_host',key)};
}
export class PredictiveLegacyReadV4 {
 #account:ClientConfig;#binding:StateMapBinding;#read:PredictiveConsoleReadV4;#query:Pick<PredictiveConsoleQueryV4,'device'>;
 constructor(account:ClientConfig,binding:StateMapBinding,query:Pick<PredictiveConsoleQueryV4,'device'>){this.#account={...account};this.#binding={...binding};this.#read=new PredictiveConsoleReadV4(account,binding);this.#query=query;}
 async candidate(command:string,ctx:AccessContext){const s=await DomainMapSnapshot.open(this.#account,this.#binding);let c;try{c=await predictiveAdoptionCandidateV4(s,command,ctx);}finally{await s.close();}await this.#query.device(c.deviceCode,ctx);if(!['COMMITTED','CANCELLED'].includes(c.job.status))await this.#read.access(c.command,ctx);return c;}
 async proof(job:PredictiveQueueJobV4,ctx:AccessContext){if(job.actorId!==ctx.actorId||job.tenantId!==ctx.tenantId)fail(404,'PREDICTIVE_LEGACY_JOB_NOT_FOUND');const c=await this.candidate(job.commandId,ctx);need(c.job.requestHash===job.requestHash,'PREDICTIVE_ADOPTION_BINDING');return {result:await this.#read.completion(job),cancellation:await this.#read.cancellation(job)};}
}
export class PredictiveAdoptionStoreV4 {
 readonly queue:PredictiveJobStoreV4;
 constructor(queue:PredictiveJobStoreV4){this.queue=queue;}
 #args(l:PredictiveQueueClaimV4){return [l.tenantId,l.id,l.owner,l.token,l.fence,l.grantRevision];}
 async probe(worker:boolean){await this.queue.extension('ADOPTION_PROBE','probe',async c=>{const values=(await c.query("SELECT p.proname,has_function_privilege(session_user,p.oid,'EXECUTE') AS allowed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='predictive_jobs_v4' AND p.proname=ANY($1::text[])",[['read_adoption_v4','enqueue_adoption_v4','claim_adoption_v4','prepare_adoption_v4']])).rows;need(values.length===4&&values.every(r=>r.allowed===(worker||['read_adoption_v4','enqueue_adoption_v4'].includes(r.proname))),'PREDICTIVE_ADOPTION_PROTOCOL');});}
 async read(actor:string,control:string){need(predictiveAdoptionUuidV4(control),'PREDICTIVE_ADOPTION_ID');return this.queue.extension('READ_ADOPTION',control,async c=>{const r=(await c.query('SELECT predictive_jobs_v4.read_adoption_v4($1,$2,$3) AS value',[this.queue.binding.tenantId,actor,control])).rows[0].value as PredictiveAdoptionControlV4|null;if(r)need(r.controlId===control&&r.job.tenantId===this.queue.binding.tenantId&&r.job.actorId===actor&&r.commandId===r.job.commandId,'PREDICTIVE_ADOPTION_CONTROL');return r;});}
 async enqueue(meta:{id:string;actorId:string;commandId:string;action:string;requestHash:string},sealedCommand:unknown,sealedGrant:unknown,until:number,control:string,expectedSqlGrant:string,pins:PredictiveAdoptionPinsV4,recoverClosed:boolean){return this.queue.extension('ENQUEUE_ADOPTION',control,async c=>(await c.query('SELECT predictive_jobs_v4.enqueue_adoption_v4($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) AS value',[this.queue.binding.tenantId,meta.actorId,meta.id,meta.commandId,meta.action,meta.requestHash,sealedCommand,sealedGrant,new Date(until),control,expectedSqlGrant,JSON.stringify(pins),recoverClosed])).rows[0].value as PredictiveQueueJobV4);}
 async claim(l:PredictiveQueueClaimV4){return this.queue.extension('CLAIM_ADOPTION',l.id,async c=>(await c.query('SELECT predictive_jobs_v4.claim_adoption_v4($1,$2,$3,$4,$5,$6) AS value',this.#args(l))).rows[0].value as PredictiveAdoptionRequestV4|null);}
 async prepare(l:PredictiveQueueClaimV4,control:string,binding:StateMapBinding,head:StateHead,command:string,operations:StateOperation[],deadline:number){
  const hash=stateRequestDigest(l.tenantId,command,head.revision,head.rootHash,operations),verify=(r:StateReceipt)=>{need(r&&r.tenantId===l.tenantId&&r.commandId===command&&r.requestHash===hash&&r.beforeRevision===head.revision&&r.beforeRoot===head.rootHash&&r.beforeReceiptHash===head.receiptHash&&BigInt(r.revision)===BigInt(head.revision)+1n&&r.receiptHash===stateReceiptHash(r),'PREDICTIVE_ADOPTION_COMMIT_PROOF');return r;};
  const check=async(c:import('pg').Client)=>need(binding.tenantId===l.tenantId&&binding.roleOid===this.queue.binding.roleOid&&binding.databaseOid===this.queue.binding.databaseOid&&await inspectStateMapCatalog(c)===binding.catalogHash,'PREDICTIVE_ADOPTION_BUSINESS_CATALOG');
  try{return await this.queue.extension('PREPARE_ADOPTION',command,async c=>{await check(c);const r=verify((await c.query('SELECT predictive_jobs_v4.prepare_adoption_v4($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) AS value',[...this.#args(l),new Date(deadline),control,command,head.revision,Buffer.from(head.rootHash,'hex'),JSON.stringify(operations)])).rows[0].value);await check(c);return r;});}
  catch(e){if(!(e instanceof PredictiveQueueCommitUnknownV4))throw e;const r=await this.queue.extension('RESOLVE_ADOPTION',command,async c=>{await check(c);const v=(await c.query('SELECT state_map_v1.read_receipt_v1($1,$2,$3) AS value',[l.tenantId,command,Buffer.from(hash,'hex')])).rows[0].value;await check(c);return v===null?null:verify(v);});if(r)return r;throw e;}
 }
}
/** Bind only the claimed original command. No legacy queue-head dispatch. */
export async function preparePredictiveAdoptionV4(o:{account:ClientConfig;binding:StateMapBinding;store:PredictiveAdoptionStoreV4;lease:PredictiveQueueClaimV4;request:PredictiveAdoptionRequestV4;current:()=>Promise<{context:AccessContext;deadline:number}>}){
 const {lease:l,request:r}=o,live=await o.current(),s=await DomainMapSnapshot.open(o.account,o.binding);let operations:StateOperation[]=[],head=s.head;
 try{
  const c=await predictiveAdoptionCandidateV4(s,l.commandId,live.context);need(c.job.requestHash===l.requestHash&&c.job.key===l.businessKey&&c.job.action===l.action,'PREDICTIVE_ADOPTION_BINDING');
  if(c.host.present){const h=c.host.value as any;need(h.format==='IDMS_PREDICTIVE_HOST_V4_1'&&h.tenantId===l.tenantId&&h.jobId===l.id&&h.actorId===l.actorId&&h.commandId===l.commandId&&h.requestHash===l.requestHash&&/^[1-9][0-9]*$/.test(h.grantRevision)&&BigInt(h.grantRevision)<=BigInt(l.grantRevision),'PREDICTIVE_ADOPTION_HOST_CONFLICT');const receipt=await s.get<any>('receipt','predictive_adoption:'+r.controlId);need(receipt.format===predictiveAdoptionFormatV4&&receipt.jobId===l.id&&receipt.controlId===r.controlId&&receipt.tenantId===l.tenantId&&receipt.planDigest===c.job.planDigest&&receipt.actorId===l.actorId&&receipt.requestHash===l.requestHash&&receipt.beforeNativeHash===r.nativeHash,'PREDICTIVE_ADOPTION_HOST_PROOF');return 'BOUND' as const;}
  const {controlId,queueGrantRevision,...pins}=r;need(canonicalEqual(pins,c.pins)&&BigInt(queueGrantRevision)<=BigInt(l.grantRevision),'PREDICTIVE_ADOPTION_STALE');if(l.cancelRequested)fail(409,'PREDICTIVE_ADOPTION_CANCEL_PENDING');
  if(!['COMMITTED','CANCELLED'].includes(c.job.status))requireAccess(live.context,c.job.action==='ANALYZE'?'analyze':'predictive:approve');
  const job=['COMMITTED','CANCELLED'].includes(c.job.status)?c.job:{...c.job,status:c.job.status==='HUMAN_REVIEW'?'HUMAN_REVIEW':'PENDING',grantRevision:String(BigInt(c.job.grantRevision)+1n),nextAttempt:0,updatedAt:new Date().toISOString(),...(c.job.status==='HUMAN_REVIEW'?{}:{lastError:'PREDICTIVE_ORIGINAL_ACTOR_REAUTHORIZED'})};
  const audit=await predictiveAuditsV4(s,[{tenantId:l.tenantId,objectType:'PREDICTIVE_REVIEW',objectId:l.commandId,action:'PREDICTIVE_LEGACY_JOB_ADOPTED',actorType:'USER',actorId:l.actorId,correlationId:live.context.correlationId,metadata:{adoptionId:controlId,jobKey:l.businessKey,planDigest:c.job.planDigest,originalActor:l.actorId}}]),event=audit.events[0],tip=await s.get<any>('domain_head','audit');
  const receipt={format:predictiveAdoptionFormatV4,tenantId:l.tenantId,controlId,jobId:l.id,jobKey:l.businessKey,actorId:l.actorId,commandId:l.commandId,requestHash:l.requestHash,planDigest:c.job.planDigest,beforeNativeHash:pins.nativeHash,migrationId:pins.migrationId,sdkRevision:job.grantRevision,sqlGrantRevision:l.grantRevision,auditEventId:event.eventId,auditPosition:String(BigInt(tip.count)+1n),auditHash:event.hash};
  need(!(await s.state('receipt','predictive_adoption:'+controlId)).present,'PREDICTIVE_ADOPTION_RECEIPT_EXISTS');operations=[await s.operation('predictive_host',l.businessKey,{format:'IDMS_PREDICTIVE_HOST_V4_1',tenantId:l.tenantId,jobId:l.id,actorId:l.actorId,commandId:l.commandId,requestHash:l.requestHash,grantRevision:l.grantRevision}),...audit.ops,await s.operation('receipt','predictive_adoption:'+controlId,receipt)];
  if(job!==c.job)operations.push(await s.operation('predictive_job',l.businessKey,job));
 }finally{await s.close();}
 const current=await o.current();need(current.context.actorId===live.context.actorId&&current.context.tenantId===live.context.tenantId&&canonicalDigest({roles:current.context.roles,scope:current.context.scope})===canonicalDigest({roles:live.context.roles,scope:live.context.scope}),'PREDICTIVE_ADOPTION_AUTH_CHANGED');await o.store.prepare(l,r.controlId,o.binding,head,randomUUID(),operations,current.deadline);return 'ADOPTED' as const;
}
