import {canonical} from './imports.ts';
import {SparesAuditChain,sparesAuditFailure} from './spares-audit.ts';
import {scopeFilter,type AccessContext} from './access.ts';
import {spareVisible,type SpareEntity,type SpareReferences} from './spares.ts';
import {DomainError} from './service.ts';
import {holdValue} from './capacity.ts';

export const sparesActionLabels:Record<string,string>={
 'part.create':'建立备件','part.update':'修改备件','supplier.create':'建立供应商','supplier.update':'修改供应商','warehouse.create':'建立仓库','warehouse.update':'修改仓库',
 'purchase.create':'编制采购单','purchase.edit':'修订采购单','purchase.submit':'提交采购审批','purchase.approve':'采购独立审批','purchase.order':'登记已下单','purchase.receive':'分批收货','purchase.close':'关闭采购单','purchase.cancel':'取消采购草稿',
 'stock.issue':'设备领料','stock.return':'未用退料','stock.supplier-return':'供应商退货','stock.transfer':'仓库调拨','adjustment.create':'提交期初/盘点/报损','adjustment.approve':'库存调整独立审批','link.create':'关联设备备件','replacement.create':'登记实际更换','document.create':'登记票款凭证'
};
export interface SparesHistoryPlan {limit:number;before:bigint|null;q:string;action:string;entityId:string;from:string;to:string;start:number|null;end:number|null}
const invalid=()=>new DomainError(400,'业务历史筛选或分页参数无效');
export const historyIntegrity=sparesAuditFailure;
const day=(value:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw invalid();return Date.parse(value+'T00:00:00+08:00');};
export function sparesHistoryPlan(params:URLSearchParams):SparesHistoryPlan{
 const allowed=['limit','before','q','action','entityId','from','to'],seen=new Set<string>();for(const [key]of params){if(!allowed.includes(key)||seen.has(key))throw invalid();seen.add(key);}
 const text=(key:string,max:number)=>{const value=params.get(key)||'';if(value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw invalid();return value.trim();};
 const raw=params.get('limit')??'30',anchor=params.get('before')??'';if(!/^[1-9][0-9]{0,2}$/.test(raw)||Number(raw)>100)throw invalid();
 if(params.has('before')&&(!/^[1-9][0-9]{0,18}$/.test(anchor)||BigInt(anchor)>9223372036854775807n))throw invalid();
 const action=text('action',80),entityId=text('entityId',36),from=text('from',10),to=text('to',10);
 if(action&&!Object.hasOwn(sparesActionLabels,action)||entityId&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entityId))throw invalid();
 const start=from?day(from):null,end=to?day(to)+86400000:null;if(start!==null&&end!==null&&start>=end)throw invalid();
 return {limit:Number(raw),before:anchor?BigInt(anchor):null,q:text('q',160).toLocaleLowerCase(),action,entityId:entityId.toLowerCase(),from,to,start,end};
}
const statuses:Record<string,string>={DRAFT:'草稿',SUBMITTED:'待独立审批',APPROVED:'已批准',ORDERED:'已下单',PART_RECEIVED:'部分到货',RECEIVED:'已收齐',CLOSED:'已关闭',CANCELLED:'已取消',RETURNED:'已退回',REJECTED:'已驳回'};
const fields:Record<string,string>={name:'名称',model:'规格型号',brand:'品牌',category:'分类',active:'启用状态',safetyMilli:'安全库存',location:'库位',status:'状态',dueDate:'需求日期',totalCents:'采购金额',deltaMilli:'库存变化',quantityMilli:'数量',amountCents:'凭证金额',date:'实际日期',lastDate:'最近更换日',cycleDays:'更换周期（天）',reason:'业务依据',closeReason:'关闭依据'};
const kindLabels:Record<string,string>={warehouse:'仓库',supplier:'供应商',part:'备件',purchase:'采购单',receipt:'收货记录',movement:'库存流水',link:'适用备件',replacement:'实际更换',adjustment:'库存调整',document:'票款凭证'};
function value(key:string,v:unknown){if(v===undefined||v===null)return '—';if(key==='active')return v?'启用':'停用';if(key==='status')return statuses[String(v)]||String(v);if(key.endsWith('Milli'))return String(Number(v)/1000)+'（按备件档案单位）';if(key.endsWith('Cents'))return '¥'+(Number(v)/100).toFixed(2);return String(v).length>500?String(v).slice(0,500)+'…':String(v);}
function references(e:SpareEntity){return [...new Set([e.id,e.partId,e.warehouseId,e.purchaseId,e.receiptId,e.issueId,e.linkId,e.adjustmentId,e.supplierId,e.workOrderId,...(Array.isArray(e.lines)?e.lines.map((l:any)=>l.partId):[])].filter(v=>typeof v==='string'&&v))] as string[];}
export function historySummary(row:{sequence:string;site_code:string;body:any}){
 const b=row.body,changes=b.after.map((after:SpareEntity,i:number)=>{const prior=b.before[i];const changed=Object.keys(fields).filter(key=>canonical(prior?.[key])!==canonical(after[key])).map(key=>({label:fields[key],before:value(key,prior?.[key]),after:value(key,after[key])}));
  if(after.approval?.comment&&canonical(prior?.approval)!==canonical(after.approval))changed.push({label:'审批意见',before:'—',after:value('comment',after.approval.comment)});
  return {id:after.id,kind:after.kind,label:String(after.code||after.number||after.deviceCode||after.name||kindLabels[after.kind]||'业务记录'),deviceCode:typeof after.deviceCode==='string'?after.deviceCode:'',references:references(after),changeType:prior?'UPDATE':'CREATE',fields:changed};});
 return {sequence:row.sequence,siteCode:row.site_code,action:b.action,actionLabel:sparesActionLabels[b.action]||'备件业务操作',actorId:b.actor,at:b.at,correlationId:typeof b.correlationId==='string'?b.correlationId:'',changes};
}
export type SparesHistoryItem=ReturnType<typeof historySummary>;
/** Selection is separate from audit verification and searches public summaries only. */
export function selectHistoryItem(row:{sequence:string;site_code:string;body:any},ctx:AccessContext,refs:SpareReferences,plan:SparesHistoryPlan,trustedScopeVisible?:boolean){
 const b=row.body,records=[...b.after,...b.before.filter(Boolean)],scope=scopeFilter(ctx);
 if(scope.sites!==null&&!scope.sites.includes(row.site_code)||(trustedScopeVisible===undefined?!records.every(e=>spareVisible(e,ctx,refs)):!trustedScopeVisible))return null;
 if(plan.before!==null&&BigInt(row.sequence)>=plan.before||plan.action&&b.action!==plan.action)return null;
 const at=Date.parse(b.at);if(plan.start!==null&&at<plan.start||plan.end!==null&&at>=plan.end)return null;
 const item=historySummary(row);if(plan.entityId&&!item.changes.some((e:any)=>e.references.includes(plan.entityId)))return null;
 if(plan.q&&!JSON.stringify(item).toLocaleLowerCase().includes(plan.q))return null;return item;
}
export class SparesHistoryCollector{
 private chain:SparesAuditChain;maxRetained=0;private retained:{item:SparesHistoryItem;release:()=>void}[]=[];
 get sequence(){return this.chain.sequence;}get previous(){return this.chain.previous;}
 private ctx:AccessContext;private refs:SpareReferences;private plan:SparesHistoryPlan;
 constructor(ctx:AccessContext,refs:SpareReferences,plan:SparesHistoryPlan){this.ctx=ctx;this.refs=refs;this.plan=plan;this.chain=new SparesAuditChain(ctx.tenantId);}
 accept(row:{sequence:string;site_code:string;body:any;hash:string},trustedScopeVisible?:boolean){
  this.chain.accept(row);const item=selectHistoryItem(row,this.ctx,this.refs,this.plan,trustedScopeVisible);if(!item)return;
  this.retained.push({item,release:holdValue(item)});if(this.retained.length>this.plan.limit+1)this.retained.shift()!.release();this.maxRetained=Math.max(this.maxRetained,this.retained.length);
 }
 discard(){for(const entry of this.retained)entry.release();this.retained=[];}
 finish(revision:string){this.chain.finish(revision);const hasMore=this.retained.length>this.plan.limit,items=this.retained.slice().reverse().slice(0,this.plan.limit).map(r=>r.item);this.discard();return {items,hasMore,nextBefore:hasMore?items.at(-1)!.sequence:null};}
}
