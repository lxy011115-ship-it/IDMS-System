import {readLeanSnapshot} from './lean-snapshot.ts';
import type pg from 'pg';
import type {BatchBody,ImportData} from './imports.ts';
import {digest} from './imports.ts';
import type {AuditEvent} from './domain.ts';
import type {Store} from './store.ts';
import type {TenantPayload} from './entity-repository.ts';
import type {ReadWorkspace,ReadWorkspaceData,StoreView} from './read-model.ts';
import {verifiedReadStamp} from './read-integrity.ts';
import {freezeValue} from './tenant-workspace.ts';
import {accountValue,accountAllocation,holdValue,requestSignal,CapacityError} from './capacity.ts';
import {AuditPageCollector,auditHead,auditIntegrityError,type AuditPageRow,type AuditPagePlan} from './audit-page.ts';
import {reserveResponse} from './request-capacity.ts';
import {DomainError} from './service.ts';
import {verifyAuditChain} from './audit.ts';
import {streamRows} from './pg-row-stream.ts';

function activeTenant(data:ReadWorkspaceData,tenant:string){if(data.store.tenants.length!==1||data.store.tenants[0].id!==tenant||data.store.tenants[0].status!=='ACTIVE')throw new DomainError(403,'企业不存在或已停用');}
export function projectVerifiedRead(payload:TenantPayload):ReadWorkspaceData{
 const data={store:payload.business,imports:{batches:payload.imports.batches.map(({originalBase64,...body})=>body),records:payload.imports.records}};
 accountValue(data);const copy=structuredClone(data);freezeValue(copy);return copy;
}
async function readProvenData(client:pg.PoolClient,tenant:string):Promise<ReadWorkspaceData>{return (await readLeanSnapshot(client,tenant)).data;}
export async function readWorkspaceSnapshot(pool:pg.Pool,client:pg.PoolClient,tenant:string,lookup:(stamp:string)=>ReadWorkspaceData|undefined){
 let loaded:ReadWorkspaceData|undefined;const stamp=await verifiedReadStamp(pool,client,tenant,payload=>{loaded=payload;},true);
 let data=lookup(stamp);if(data)accountValue(data);else data=loaded||await readProvenData(client,tenant);loaded=undefined;activeTenant(data,tenant);return {stamp,data};
}
export function bindReadWorkspace(data:ReadWorkspaceData,client:pg.PoolClient,tenant:string){
 activeTenant(data,tenant);let open=true;const pending=new Set<Promise<unknown>>(),members=new Set(data.imports.batches);
 const check=()=>{if(!open)throw new DomainError(503,'只读正文快照已结束');if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
 const run=<T>(work:()=>Promise<T>):Promise<T>=>{try{check();}catch(e){return Promise.reject(e);}const task=work();pending.add(task);void task.then(()=>pending.delete(task),()=>pending.delete(task));return task;};
 const workspace:ReadWorkspace=Object.freeze({...data,
  readOriginal:(batch:BatchBody)=>run(async()=>{
   if(!members.has(batch)||batch.tenantId!==tenant)throw new DomainError(503,'原文件与当前只读批次不匹配');
   const meta=(await client.query('/* IDMS_ORIGINAL_META */ SELECT sha256,octet_length(content) AS bytes FROM business_import_files WHERE tenant_id=$1 AND batch_id=$2',[tenant,batch.batchId])).rows;
   check();if(meta.length!==1||meta[0].sha256!==batch.fileSha256||!Number.isSafeInteger(meta[0].bytes)||meta[0].bytes<0)throw new DomainError(503,'原文件绑定不可验证');
   reserveResponse(meta[0].bytes);accountAllocation(meta[0].bytes*4+65536);
   const rows=(await client.query('/* IDMS_ORIGINAL_BYTES */ SELECT sha256,content FROM business_import_files WHERE tenant_id=$1 AND batch_id=$2',[tenant,batch.batchId])).rows;check();
   if(rows.length!==1||rows[0].sha256!==batch.fileSha256||!Buffer.isBuffer(rows[0].content)||rows[0].content.length!==meta[0].bytes||digest(rows[0].content)!==batch.fileSha256)throw new DomainError(503,'原文件内容校验失败');return rows[0].content as Buffer;
  }),
  readAuditPage:(plan:AuditPagePlan,visible:(event:AuditEvent)=>boolean)=>run(async()=>{
   if(plan.tenantId!==tenant)throw auditIntegrityError();
   const rows=(await client.query('/* IDMS_AUDIT_PAGE_HEAD */ SELECT sequence_no::text AS sequence,tenant_id,event_id,hash FROM audit_ledger ORDER BY sequence_no DESC LIMIT 1')).rows;check();
   if(rows.length&&rows[0].tenant_id!==tenant)throw auditIntegrityError();
   const collector=new AuditPageCollector(plan,auditHead(rows[0]),visible);let releaseRow=()=>{};
   try{
    await streamRows<AuditPageRow>(client,'/* IDMS_AUDIT_PAGE_ROWS */ SELECT sequence_no::text AS sequence,tenant_id,event_id,hash,previous_hash,event FROM audit_ledger ORDER BY sequence_no',row=>{releaseRow();releaseRow=()=>{};check();releaseRow=holdValue(row);collector.accept(row);},()=>{releaseRow();collector.discard();});
    check();return collector.finish();
   }catch(error){collector.discard();throw error;}finally{releaseRow();}
  }),
  readAudits:()=>run(async()=>{
   const events:AuditEvent[]=[];await streamRows<any>(client,'/* IDMS_ON_DEMAND_AUDIT */ SELECT tenant_id,event_id,hash,previous_hash,event FROM audit_ledger ORDER BY sequence_no',row=>{check();accountValue(row);if(row.tenant_id!==tenant||row.event.tenantId!==tenant||row.event.eventId!==row.event_id||row.event.hash!==row.hash||row.event.previousHash!==row.previous_hash)throw new DomainError(503,'审计列与事件绑定不一致');events.push(row.event);},()=>{events.length=0;});check();if(!verifyAuditChain(events,tenant))throw new DomainError(503,'完整企业审计链校验失败');return events;
  })
 });
 return {workspace,async close(){open=false;await Promise.allSettled([...pending]);}};
}
export function fileReadWorkspace(store:Store,imports:ImportData,tenant:string):ReadWorkspace{
 return {store,imports,async readOriginal(batch){const source=imports.batches.find(b=>b===batch&&b.tenantId===tenant);if(!source)throw new DomainError(503,'原文件与当前批次不匹配');const bytes=Buffer.from(source.originalBase64,'base64');if(digest(bytes)!==source.fileSha256)throw new DomainError(503,'原文件校验失败');return bytes;},async readAudits(){if(!verifyAuditChain(store.audits,tenant))throw new DomainError(503,'完整企业审计链校验失败');return store.audits;},async readAuditPage(plan,visible){
  if(plan.tenantId!==tenant)throw auditIntegrityError();let count=0,last:AuditEvent|undefined;for(const event of store.audits)if(event.tenantId===tenant){count++;last=event;}
  const collector=new AuditPageCollector(plan,auditHead(last?{sequence:String(count),event_id:last.eventId,hash:last.hash}:undefined),visible);let position=0;
  try{for(const event of store.audits)if(event.tenantId===tenant)collector.accept({sequence:String(++position),tenant_id:tenant,event_id:event.eventId,hash:event.hash,previous_hash:event.previousHash,event});return collector.finish();}catch(error){collector.discard();throw error;}
 }};
}
