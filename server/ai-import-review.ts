import {snapshotHistory,assertAiHistory,type RuntimeHistory} from './runtime-bootstrap.ts';
import {OutboxDispatcher,type OutboxLease} from './outbox-worker.ts';
import {batchInputDigest} from './import-revisions.ts';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {Store} from './store.ts';
import type {Batch,ImportContext} from './imports.ts';
import {canonical,digest} from './imports.ts';
import {importData,mutate} from './import-api.ts';
import {storageMode,tenantPool,tenantWorkerPool} from './postgres-repository.ts';
import {appendAudit} from './audit.ts';
import {DomainError} from './service.ts';
import {AiError,sha,stable,requestHash,validateRequest,validateReceipt,promptVersion,policyVersion,findingLabels,readLimited} from '../integrations/ai.ts';
import type {ReviewRequest,ReviewReceipt,Evidence} from '../integrations/ai.ts';
import {verifyModule} from './postgres-security.ts';
interface Config {baseUrl:string;model:{name:string;digest:string};tenants:Record<string,{serviceToken:string}>}
export function buildReviewRequest(batch:Batch):ReviewRequest{
  const count=Math.min(12,batch.rows.length),indices=Array.from({length:count},(_,i)=>count===1?0:Math.round(i*(batch.rows.length-1)/(count-1)));
  const evidence:Evidence[]=[];
  function add(id:string,kind:Evidence['kind'],content:string){if(Buffer.byteLength(content)>2100)content=Buffer.from(content).subarray(0,2000).toString('utf8')+' [TRUNCATED SUMMARY]';evidence.push({id,kind,content,sha256:sha(content)});}
  add('RULE_SUMMARY','RULE_SUMMARY',stable({dataType:batch.dataType,template:batch.templateVersion,rule:'upload-rules-1.0.0',counts:batch.counts,sourceSystem:batch.sourceSystem,snapshotDigest:batch.snapshotDigest}));
  add('INPUT_SCOPE','INPUT_SCOPE','Only selected row summaries are reviewed. Deterministic validation covers the uploaded rows; semantic review does not. No final approval, fault probability or remaining-life prediction.');
  for(const index of indices)add('ROW_'+(index+1),'DATA_ROW',stable({line:batch.lineNumbers[index],value:batch.rows[index]}));
  const request:ReviewRequest={version:1,tenantId:batch.tenantId,requestId:randomUUID(),objectId:batch.batchId,snapshotDigest:batch.snapshotDigest,promptVersion,policyVersion,scope:{totalRows:batch.rows.length,sampledRows:count,fullContentReviewed:false},evidence,requestDigest:''};request.requestDigest=requestHash(request);return validateRequest(request,batch.tenantId);
}
export class AiImportService {
  config?:Config;timer?:ReturnType<typeof setInterval>;closing=false;private dispatcher?:OutboxDispatcher;private errors=new Map<string,string|null>();
  async start(store:Store,history:RuntimeHistory=snapshotHistory(store,importData)){
    const file=process.env.IDMS_AI_CLIENT_CONFIG;
    if(!file){assertAiHistory(history);return;}
    if(storageMode!=='postgres-tenant-databases')throw Error('Real AI import review requires PostgreSQL outbox');
    const c:Config=JSON.parse(await readFile(file,'utf8')),url=new URL(c.baseUrl);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!/^sha256:[a-f0-9]{64}$/.test(c.model?.digest)||c.model.name!=='qwen3:4b')throw Error('Invalid trusted local AI gateway configuration');
    if(Object.keys(c.tenants).some(id=>!store.tenants.some(t=>t.id===id)))throw Error('Unknown AI tenant binding');
    for(const t of store.tenants){if(!c.tenants[t.id]||typeof c.tenants[t.id].serviceToken!=='string'||c.tenants[t.id].serviceToken.length<32)throw Error('Missing AI tenant service identity');await verifyModule(tenantPool(t.id),'ai_review_outbox');}
    assertAiHistory(history,c.model.digest);
    this.config=c;this.dispatcher=new OutboxDispatcher('ai',Object.keys(c.tenants),tenantWorkerPool,lease=>this.dispatch(store,lease),tenant=>this.errors.set(tenant,'AI任务领取或租约处理未确认'));this.timer=setInterval(()=>void this.flush(store),1000);void this.flush(store);
  }
  mode(requested:string,ctx:ImportContext){if(!['demo','unavailable','gateway'].includes(requested))throw new DomainError(400,'未知AI审核模式');if(ctx.authMode==='oidc')return this.config?'gateway':'unavailable';if(requested==='gateway')throw new DomainError(400,'真实AI不允许演示身份调用');return requested||'demo';}
  async enqueue(store:Store,client:pg.PoolClient|undefined,batch:Batch,ctx:ImportContext){
    if(batch.status!=='AI_PENDING'||batch.aiReview.gateway)return;
    if(!this.config||!client)throw new DomainError(503,'AI任务必须与批次在同一企业数据库事务提交');
    const request=buildReviewRequest(batch);
    await client.query('INSERT INTO ai_review_outbox(request_id,batch_id,request_digest,envelope,expected_version,context,status) VALUES($1,$2,$3,$4,$5,$6,\'PENDING\')',[request.requestId,batch.batchId,request.requestDigest,request,batch.version,ctx]);
    batch.aiReview.gateway={requestId:request.requestId,requestDigest:request.requestDigest,mode:'SHADOW',promptVersion,policyVersion,modelDigest:this.config.model.digest,sampledRows:request.scope.sampledRows,totalRows:request.scope.totalRows};
    appendAudit(store,{tenantId:ctx.tenantId,objectType:'DATA_IMPORT',objectId:batch.batchId,action:'IMPORT_AI_QUEUED',actorType:'SYSTEM',actorId:'idms.ai-outbox',correlationId:ctx.correlationId,metadata:{...batch.aiReview.gateway,snapshotDigest:batch.snapshotDigest,fullContentReviewed:false}});
  }
  async request(tenantId:string,path:string,body?:ReviewRequest,timeoutMs=130000,signal?:AbortSignal){
    const account=this.config?.tenants[tenantId];if(!this.config||!account)throw new AiError('GATEWAY_NOT_CONFIGURED',503);
    const r=await fetch(new URL(path,this.config.baseUrl),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+account.serviceToken,'X-IDMS-Tenant':tenantId,...body?{'Content-Type':'application/json'}:{}},body:body?JSON.stringify(body):undefined,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
    const text=await readLimited(r.body,65536);if(!r.ok)throw new AiError('GATEWAY_HTTP_'+r.status,r.status);return JSON.parse(text);
  }
  async flush(_store:Store){if(!this.closing)await this.dispatcher?.pump();}
  private async dispatch(store:Store,lease:OutboxLease){
    const {tenantId,row}=lease.claim;if(lease.lost)return;let receipt:ReviewReceipt;
    try{
      const request=validateRequest(row.envelope,tenantId);
      if(request.requestId!==row.request_id||request.objectId!==row.batch_id||request.requestDigest!==row.request_digest||row.context.tenantId!==tenantId)throw new AiError('FROZEN_REQUEST_CONFLICT');
      receipt=validateReceipt(await this.request(tenantId,'/v1/reviews',request,130000,lease.signal),request,this.config!.tenants[tenantId].serviceToken);
      if(receipt.model.digest!==this.config!.model.digest||receipt.model.name!==this.config!.model.name)throw new AiError('MODEL_PIN_MISMATCH');
    }catch(e){
      if(lease.lost)return;const code=e instanceof AiError?e.code:'GATEWAY_NETWORK_OR_RESPONSE_ERROR';
      try{const result=await mutate(store,async (client,{store,imports:importData})=>lease.fenced(client!,async current=>{
        const terminal=e instanceof AiError&&![429,500,502,503,504].includes(e.status)||current.attempts>=2;
        await client!.query("UPDATE ai_review_outbox SET attempts=attempts+1,last_error=$2,status=$3,next_attempt=clock_timestamp()+interval '3 seconds' WHERE request_id=$1",[row.request_id,code,terminal?'HUMAN_REVIEW':'PENDING']);
        if(terminal){const b=importData.batches.find(b=>b.batchId===row.batch_id&&b.tenantId===tenantId);if(b?.status==='AI_PENDING'&&b.aiReview.gateway?.requestId===row.request_id){b.status='HUMAN_REVIEW';b.version++;b.aiReview.status='HUMAN_REQUIRED';b.aiReview.conclusion='真实AI审核未获有效回执，转人工复核：'+code;b.aiReview.evidence.push('失败关闭：不自动通过，不替代最终批准');}
          appendAudit(store,{tenantId,objectType:'DATA_IMPORT',objectId:row.batch_id,action:'IMPORT_AI_HUMAN_REQUIRED',actorType:'SYSTEM',actorId:'idms.ai-outbox',correlationId:row.context.correlationId,metadata:{requestId:row.request_id,requestDigest:row.request_digest,reason:code}});}
      }),tenantId);if(result.accepted)this.errors.set(tenantId,code);}catch{this.errors.set(tenantId,'AI失败状态事务未确认，保留原请求');}return;
    }
    // A successful provider receipt is not a failed inference if core persistence fails.
    try{const result=await mutate(store,async (client,{store,imports:importData})=>lease.fenced(client!,async()=>{
          const batch=importData.batches.find(b=>b.batchId===row.batch_id&&b.tenantId===tenantId);
          const actualDigest=batch&&batchInputDigest(batch);
          if(!batch||batch.status!=='AI_PENDING'||batch.version!==row.expected_version||batch.aiReview.gateway?.requestId!==row.request_id||batch.aiReview.gateway?.requestDigest!==row.request_digest||actualDigest!==receipt.snapshotDigest){
            await client!.query("UPDATE ai_review_outbox SET status='HUMAN_REVIEW',last_error='FROZEN_INPUT_CONFLICT',completed_at=now() WHERE request_id=$1",[row.request_id]);
            if(batch?.status==='AI_PENDING'){batch.status='HUMAN_REVIEW';batch.version++;batch.aiReview.status='HUMAN_REQUIRED';batch.aiReview.conclusion='冻结输入发生冲突，必须人工复核；未采用模型输出';}
            appendAudit(store,{tenantId,objectType:'DATA_IMPORT',objectId:row.batch_id,action:'IMPORT_AI_INPUT_CONFLICT',actorType:'SYSTEM',actorId:'idms.ai-outbox',correlationId:row.context.correlationId,metadata:{requestId:row.request_id}});return;
          }
          batch.status='HUMAN_REVIEW';batch.version++;batch.aiReview.status=receipt.status;batch.aiReview.modelVersion=receipt.model.name+'@'+receipt.model.digest;
          batch.aiReview.conclusion=receipt.output?'本地真实模型已完成影子审阅；需独立人员核实证据后终审':'AI策略或模型异常，必须人工复核：'+receipt.reason;
          batch.aiReview.evidence.push(...receipt.output?.findingCodes.map(code=>findingLabels[code])||[],...receipt.evidence.map(e=>'证据 '+e.id+' / SHA-256 '+e.sha256),'审阅范围：'+row.envelope.scope.sampledRows+'/'+row.envelope.scope.totalRows+' 行摘要；不声明全量语义审核','影子模式未获生产自动审核授权；自报置信度未经校准');
          batch.aiReview.gateway!.receipt=receipt;
          await client!.query("UPDATE ai_review_outbox SET status='DONE',response=$2,completed_at=now(),last_error=NULL WHERE request_id=$1",[row.request_id,receipt]);
          appendAudit(store,{tenantId,objectType:'DATA_IMPORT',objectId:batch.batchId,action:receipt.provenance==='LOCAL_MODEL'?'IMPORT_REAL_AI_SHADOW_REVIEWED':'IMPORT_AI_POLICY_FALLBACK',actorType:receipt.provenance==='LOCAL_MODEL'?'AI':'RULE',actorId:'idms.ai-gateway',correlationId:row.context.correlationId,metadata:{receipt,scope:row.envelope.scope}});
    }),tenantId);if(result.accepted)this.errors.set(tenantId,null);}catch{if(!lease.lost)this.errors.set(tenantId,'AI回执事务未确认，保留原请求重试');}
  }
  async status(tenantId:string){if(!this.config)return {enabled:false,connected:false,mode:'DEMO_RULES',finalApproval:false};try{const status=await this.request(tenantId,'/v1/status',undefined,3500);if(status.service!=='IDMS_AI_GATEWAY'||status.mode!=='SHADOW'||status.model.digest!==this.config.model.digest)throw Error('Gateway identity mismatch');return {...status,enabled:true,connected:status.modelReady===true,lastError:this.errors.get(tenantId)||null};}catch{return {enabled:true,connected:false,mode:'SHADOW',lastError:this.errors.get(tenantId)||'AI网关不可用',finalApproval:false};}}
  async close(){this.closing=true;if(this.timer)clearInterval(this.timer);await this.dispatcher?.close();}
}
