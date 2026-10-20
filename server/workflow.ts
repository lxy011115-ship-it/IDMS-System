import type {StoreView} from './read-model.ts';
import {snapshotHistory,assertWorkflowHistory,type RuntimeHistory} from './runtime-bootstrap.ts';
import type {ImportData,ImportView} from './imports.ts';
import {OutboxDispatcher,type OutboxLease} from './outbox-worker.ts';
import {readLimited} from '../integrations/ai.ts';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { storageMode,tenantPool,tenantWorkerPool } from './postgres-repository.ts';
import { mutate } from './import-api.ts';
import { canonical,digest } from './imports.ts';
import { appendAudit } from './audit.ts';
import { requireAccess,permissionsFor,type AccessContext } from './access.ts';
import { changeWorkOrder,orderFor } from './maintenance.ts';
import { DomainError } from './service.ts';
import type { WorkOrder } from './domain.ts';
import type { Store } from './store.ts';
import {verifyModule} from './postgres-security.ts';
type Config={baseUrl:string;tenants:Record<string,{serviceToken:string}>};
function business(order:WorkOrder){const {workflow,...body}=order;return body;}
function permissions(ctx:AccessContext){return ctx.authMode==='oidc'?permissionsFor(ctx.roles||[]):ctx.actorId==='demo.approver'?['predictive:approve','maintenance:approve']:ctx.actorId==='demo.technician'?['maintenance:execute']:[];}
export class WorkflowService {
  config?:Config;timer?:ReturnType<typeof setInterval>;closing=false;private dispatcher?:OutboxDispatcher;private errors=new Map<string,string|null>();
  async start(store:Store,history:RuntimeHistory=snapshotHistory(store,{batches:[]})){
    const path=process.env.IDMS_WORKFLOW_CLIENT_CONFIG;
    if(!path){assertWorkflowHistory(history,false);return;}
    if(storageMode!=='postgres-tenant-databases')throw Error('Flowable integration requires PostgreSQL outbox');
    const c:Config=JSON.parse(await readFile(path,'utf8')),url=new URL(c.baseUrl);
    if(url.username||url.password||url.pathname!=='/'||(url.protocol!=='https:'&&!(url.protocol==='http:'&&url.hostname==='127.0.0.1')))throw Error('Invalid trusted workflow URL');
    if(Object.keys(c.tenants).some(id=>!store.tenants.some(t=>t.id===id)))throw Error('Unknown workflow tenant binding');
    for(const tenant of store.tenants){if(!c.tenants[tenant.id]||c.tenants[tenant.id].serviceToken.length<32)throw Error('Missing workflow tenant service binding');await verifyModule(tenantPool(tenant.id),'workflow_outbox');}
    this.config=c;this.dispatcher=new OutboxDispatcher('workflow',Object.keys(c.tenants),tenantWorkerPool,lease=>this.dispatch(store,lease),tenant=>this.errors.set(tenant,'工作流任务领取或租约处理未确认'));this.timer=setInterval(()=>void this.flush(store),1000);void this.flush(store);
  }
  async request(tenantId:string,path:string,body?:unknown,timeoutMs=8000,signal?:AbortSignal){
    const config=this.config,account=config?.tenants[tenantId];if(!config||!account)throw new DomainError(503,'工作流服务未配置');
    const response=await fetch(new URL(path,config.baseUrl),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+account.serviceToken,'X-IDMS-Tenant':tenantId,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),redirect:'error'});
    const text=await readLimited(response.body,256000);
    if(!response.ok)throw new DomainError(response.status>=500?503:409,'工作流拒绝或暂不可用 HTTP '+response.status);
    return JSON.parse(text);
  }
  async queueCreate(store:Store,client:pg.PoolClient|undefined,order:WorkOrder,ctx:AccessContext){
    if(!this.config)return;
    if(!client)throw Error('Workflow must be queued in business transaction');
    requireAccess(ctx,'predictive:approve');
    await this.enqueue(store,client,order,structuredClone(order),'create',{},ctx);
  }
  async change(client:pg.PoolClient|undefined,store:Store,id:string,action:string,input:Record<string,unknown>,ctx:AccessContext,data:ImportData){
    const order=orderFor(store,id,ctx,data);
    if(!order.workflow)return changeWorkOrder(store,id,action,input,ctx,data);
    if(!this.config||!client)throw new DomainError(503,'Flowable工单不能降级到本地状态机');
    if(order.workflow.status!=='SYNCED')throw new DomainError(409,'工作流命令尚未确认或需人工处理，请勿重复推进');
    const proposedStore=structuredClone(store);changeWorkOrder(proposedStore,id,action,input,ctx,data);
    const proposed=orderFor(proposedStore,id,ctx,data);
    await this.enqueue(store,client,order,proposed,action,input,ctx);
    return order;
  }
  async enqueue(store:Store,client:pg.PoolClient,order:WorkOrder,proposed:WorkOrder,action:string,input:Record<string,unknown>,ctx:AccessContext){
    const commandId=randomUUID();
    // Hash the exact JSON wire representation, not JavaScript-only undefined properties.
    const envelope=JSON.parse(JSON.stringify({commandId,entityId:order.id,action,expectedVersion:order.version,actor:{id:ctx.actorId,type:ctx.actorType,permissions:permissions(ctx)},assignee:order.assignee,evidenceDigest:action==='submit'?proposed.resolution?.digest:order.resolution?.digest,decision:input.decision,comment:input.comment,correlationId:ctx.correlationId}));
    const requestDigest=digest(canonical(envelope));
    await client.query("INSERT INTO workflow_outbox(command_id,entity_id,request_digest,envelope,proposed,before_digest,context,status) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING')",[commandId,order.id,requestDigest,{...envelope,requestDigest},business(proposed),digest(canonical(business(order))),ctx]);
    order.workflow={...order.workflow,engine:'Flowable',status:'PENDING',commandId};
    appendAudit(store,{tenantId:ctx.tenantId,objectType:'WORK_ORDER',objectId:order.id,action:'FLOWABLE_COMMAND_QUEUED',actorType:'USER',actorId:ctx.actorId,correlationId:ctx.correlationId,metadata:{commandId,requestDigest,action,expectedVersion:order.version}});
  }
  async flush(_store:Store){if(!this.closing)await this.dispatcher?.pump();}
  private async failure(store:Store,lease:OutboxLease,error:string,forceTerminal=false){
    if(lease.lost)return;const {tenantId,row}=lease.claim;
    try{const result=await mutate(store,async (client,{store,imports:importData})=>lease.fenced(client!,async current=>{
      const terminal=forceTerminal||current.attempts>=7;
      await client!.query("UPDATE workflow_outbox SET attempts=attempts+1,last_error=$2,status=$3,next_attempt=clock_timestamp()+($4*interval '1 second') WHERE command_id=$1",[row.command_id,error,terminal?'HUMAN_REVIEW':'PENDING',Math.min(60,2**Math.min(6,current.attempts))]);
      const order=store.workOrders.find(o=>o.id===row.entity_id&&o.tenantId===tenantId),workflow=order?.workflow;
      if(workflow&&workflow.commandId===row.command_id){workflow.status=terminal?'HUMAN_REVIEW':'PENDING';workflow.lastError=error;}
      if(terminal)appendAudit(store,{tenantId,objectType:'WORK_ORDER',objectId:row.entity_id,action:'FLOWABLE_HUMAN_REVIEW_REQUIRED',actorType:'SYSTEM',actorId:'idms.workflow-outbox',correlationId:row.context.correlationId,metadata:{commandId:row.command_id,error}});
    }),tenantId);if(result.accepted)this.errors.set(tenantId,error);}catch{if(!lease.lost)this.errors.set(tenantId,'工作流失败状态事务未确认，保留原命令');}
  }
  private async dispatch(store:Store,lease:OutboxLease){
    const {tenantId,row}=lease.claim;if(lease.lost)return;let response:any;
    try{
      const {requestDigest,...wire}=row.envelope;
      if(wire.commandId!==row.command_id||wire.entityId!==row.entity_id||requestDigest!==row.request_digest||digest(canonical(wire))!==row.request_digest||row.context.tenantId!==tenantId||wire.actor?.id!==row.context.actorId)throw new DomainError(409,'工作流冻结请求绑定无效');
      response=await this.request(tenantId,'/v1/commands',row.envelope,8000,lease.signal);
      if(response.commandId!==row.command_id||response.requestDigest!==row.request_digest||response.entityId!==row.entity_id||response.version!==row.proposed.version||response.state!==row.proposed.state||typeof response.processInstanceId!=='string'||typeof response.definitionId!=='string'||!Array.isArray(response.tasks))throw new DomainError(502,'工作流回执与冻结请求不一致');
    }catch(e){if(!lease.lost)await this.failure(store,lease,e instanceof DomainError?e.message:'工作流网络未确认',e instanceof DomainError&&e.status===409);return;}
    try{const result=await mutate(store,async (client,{store,imports:importData})=>lease.fenced(client!,async()=>{
            const order=store.workOrders.find(o=>o.tenantId===tenantId&&o.id===row.entity_id);
            if(!order||order.workflow?.commandId!==row.command_id||digest(canonical(business(order)))!==row.before_digest)throw new DomainError(409,'本地工单与流程命令冻结版本冲突');
            const before=structuredClone(order);
            // Assignment alone would retain fields deliberately removed by the next state
            // (e.g. a returned approval after a new evidence submission).
            for(const key of Object.keys(order))if(key!=='workflow')delete (order as unknown as Record<string,unknown>)[key];
            Object.assign(order,row.proposed);
            order.workflow={engine:'Flowable',status:'SYNCED',commandId:row.command_id,processInstanceId:response.processInstanceId,definitionId:response.definitionId,taskKey:response.tasks[0]?.key};
            if(order.state==='CLOSED'){
              const alert=store.predictiveAlerts.find(a=>a.tenantId===tenantId&&a.id===order.alertId);if(alert){alert.state='RESOLVED';alert.version++;}
              const rec=store.maintenanceRecommendations.find(r=>r.tenantId===tenantId&&r.alertId===order.alertId);if(rec)rec.status='EXECUTED';
            }
            appendAudit(store,{tenantId,objectType:'WORK_ORDER',objectId:order.id,action:'FLOWABLE_'+String(row.envelope.action).toUpperCase()+'_CONFIRMED',actorType:'USER',actorId:row.context.actorId,correlationId:row.context.correlationId,before,after:structuredClone(order),metadata:{commandId:row.command_id,requestDigest:row.request_digest,processInstanceId:response.processInstanceId,definitionId:response.definitionId,evidenceDigest:row.envelope.evidenceDigest}});
            await client!.query("UPDATE workflow_outbox SET status='SYNCED',response=$2,synced_at=now(),last_error=NULL WHERE command_id=$1",[row.command_id,response]);
    }),tenantId);if(result.accepted)this.errors.set(tenantId,null);
    }catch(e){if(lease.lost)return;if(e instanceof DomainError&&e.status===409)await this.failure(store,lease,e.message,true);else this.errors.set(tenantId,'工作流回执事务未确认，保留原命令重试');}
  }
  async retry(store:Store,client:pg.PoolClient|undefined,id:string,ctx:AccessContext,data:ImportData){
    requireAccess(ctx,'maintenance:approve');const order=orderFor(store,id,ctx,data);
    if(!client||order.workflow?.status!=='HUMAN_REVIEW')throw new DomainError(409,'仅人工处理状态允许重试同一流程命令');
    const reset=await client.query("UPDATE workflow_outbox SET status='PENDING',attempts=0,next_attempt=clock_timestamp(),worker_id=NULL,claim_token=NULL,lease_until=NULL WHERE command_id=$1 AND entity_id=$2 AND status='HUMAN_REVIEW'",[order.workflow.commandId,id]);if(reset.rowCount!==1)throw new DomainError(409,'流程待办状态已变化，请刷新后重试');order.workflow.status='PENDING';
    appendAudit(store,{tenantId:ctx.tenantId,objectType:'WORK_ORDER',objectId:id,action:'FLOWABLE_RETRY_REQUESTED',actorType:'USER',actorId:ctx.actorId,correlationId:ctx.correlationId,metadata:{commandId:order.workflow.commandId}});return order;
  }
  async status(tenantId:string){if(!this.config)return {enabled:false,connected:false,mode:'LOCAL_STATE_MACHINE'};try{return {enabled:true,connected:true,mode:'FLOWABLE',...await this.request(tenantId,'/v1/status',undefined,1500)};}catch{return {enabled:true,connected:false,mode:'FLOWABLE',lastError:this.errors.get(tenantId)||'工作流暂不可用'};}}
  async details(store:StoreView,id:string,ctx:AccessContext,data:ImportView){const order=orderFor(store,id,ctx,data);if(!order.workflow)return {mode:'LEGACY_LOCAL',notice:'原工单未迁移，不补写虚假流程历史'};return {local:order.workflow,...await this.request(ctx.tenantId,'/v1/cases/'+encodeURIComponent(id))};}
  async close(){this.closing=true;if(this.timer)clearInterval(this.timer);await this.dispatcher?.close();}
}
