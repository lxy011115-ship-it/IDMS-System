import type {ClientConfig} from 'pg';
import type {StateMapBinding,StateHead} from './state-map-sql-v1.ts';
import type {AccessContext} from './access.ts';
import {permissionsFor,scopeAllows,requiredScope} from './access.ts';
import type {WorkOrder} from './domain.ts';
import {DomainReadSnapshotV4} from './domain-read-snapshot-v4.ts';
import {domainReadAccessV4} from './domain-read-api-v4.ts';
import {domainEntityKey,domainOrderKey} from './domain-entities-v4.ts';
import {decodeLegacyText} from './legacy-map-v4.ts';
import {readAssetKey,readCatalogFormat,type DomainReadCatalogV4} from './domain-read-catalog-v4.ts';
import {maintenanceFormatV4} from './maintenance-map-common-v4.ts';
import {telemetryDomainFormat} from './telemetry-map-v4.ts';
import {canonicalDigest} from './canonical-state.ts';
import type {AuditCursorCodec} from './audit-cursor.ts';
import {DomainError} from './service.ts';
function fail(status:number,code:string):never{throw new DomainError(status,code);}
function need(v:unknown,code='MAINTENANCE_READ_INTEGRITY'):asserts v{if(!v)fail(503,code);}
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const number=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=9223372036854775807n;
const lifetime=30*60*1000;
type Cursor={purpose:'IDMS_MAINTENANCE_PAGE_V4';binding:string;identity:string;catalog:string;root:StateHead;position:string;pageSize:number;createdAt:number;expiresAt:number;state:string};
const identity=(ctx:AccessContext)=>canonicalDigest({tenant:ctx.tenantId,actor:ctx.actorId,type:ctx.actorType,auth:ctx.authMode,roles:[...new Set(ctx.roles||[])].sort(),scope:ctx.scope});
/** QI/HTTP reads from the immutable map through READER; no business APP credential. */
export class MaintenanceConsoleReadV4 {
 #account:ClientConfig;#binding:StateMapBinding;#codec:AuditCursorCodec;#deployment:string;
 constructor(account:ClientConfig,binding:StateMapBinding,codec:AuditCursorCodec,deployment:string){this.#account={...account};this.#binding=Object.freeze({...binding});this.#codec=codec;this.#deployment=canonicalDigest({binding,deployment});}
 async #entity<T=any>(s:DomainReadSnapshotV4,collection:string,id:string,root?:StateHead):Promise<T|null>{const k=domainEntityKey(collection,{id}),v=await s.state('v4_entity',k,root);if(!v.present)return null;const row=JSON.parse(await decodeLegacyText('v4_entity',k,(ns,key)=>s.get(ns,key,root)));need(row.id===id&&(collection==='business/tenants'?row.id===s.tenantId:row.tenantId===s.tenantId));return row;}
 async #open(ctx:AccessContext){domainReadAccessV4(ctx);if(ctx.tenantId!==this.#binding.tenantId)fail(404,'MAINTENANCE_NOT_FOUND');const s=await DomainReadSnapshotV4.open(this.#account,this.#binding);try{
  const control=await s.get<any>('domain_head','control'),catalog=await s.get<DomainReadCatalogV4>('domain_head','read_catalog'),marker=await s.get<any>('domain_head','maintenance'),tenant=await this.#entity(s,'business/tenants',ctx.tenantId);
  need(control.format===telemetryDomainFormat&&control.tenantId===ctx.tenantId&&['ACTIVE','PAUSED','UPDATING'].includes(control.status));if(tenant?.status!=='ACTIVE')fail(403,'MAINTENANCE_TENANT_INACTIVE');
  need(marker.format===maintenanceFormatV4&&marker.tenantId===ctx.tenantId&&catalog.format===readCatalogFormat&&catalog.tenantId===ctx.tenantId&&catalog.governanceAnchorDigest===control.governanceAnchorDigest);return {s,control,catalog,tenant};
 }catch(e){await s.close();throw e;}}
 async #visible(s:DomainReadSnapshotV4,ctx:AccessContext,o:WorkOrder,catalog:DomainReadCatalogV4,root?:StateHead){need(o.tenantId===ctx.tenantId&&Number.isSafeInteger(o.version)&&o.version>0);const key=readAssetKey(catalog.generation,o.deviceCode),v=await s.state('blob',key,root);let scope:Record<string,unknown>={device_code:o.deviceCode};if(v.present){const asset=JSON.parse(await decodeLegacyText('blob',key,(ns,k)=>s.get(ns,k,root)));need(asset.tenantId===ctx.tenantId&&asset.deviceCode===o.deviceCode&&asset.scope.device_code===o.deviceCode);scope=asset.scope;}return scopeAllows(ctx,scope)&&(requiredScope(ctx.roles||[])!=='OWN_TASKS'||o.assignee===ctx.actorId);}
 async context(ctx:AccessContext){const {s,control,tenant}=await this.#open(ctx);try{return {tenant:{id:tenant.id,name:tenant.name},phase:control.status,permissions:permissionsFor(ctx.roles||[]),readStats:{...s.stats}};}finally{await s.close();}}
 async detail(id:string,ctx:AccessContext){const {s,catalog,control}=await this.#open(ctx);try{if(control.status!=='ACTIVE')fail(409,'MAINTENANCE_FENCED');const item=await this.#entity<WorkOrder>(s,'business/workOrders',id);if(!item||!await this.#visible(s,ctx,item,catalog))fail(404,'MAINTENANCE_NOT_FOUND');let workflowActorId:string|null=null,workflowAction:string|null=null;if(item.workflow&&item.workflow.status!=='SYNCED'){const job=await s.get<any>('maintenance_job',item.workflow.commandId);need(job.format===maintenanceFormatV4&&job.tenantId===ctx.tenantId&&job.orderId===item.id&&job.commandId===item.workflow.commandId&&typeof job.context?.actorId==='string'&&['claim','start','submit','approval'].includes(job.envelope?.action),'MAINTENANCE_FLOW_DETAIL');workflowActorId=job.context.actorId;workflowAction=job.envelope.action;}return {item,workflowActorId,workflowAction,readStats:{...s.stats}};}finally{await s.close();}}
 async list(params:URLSearchParams,ctx:AccessContext){const now=Date.now(),seen=new Set<string>();for(const [key]of params){if(!['cursor','pageSize','state'].includes(key)||seen.has(key))fail(400,'MAINTENANCE_QUERY');seen.add(key);}const states=['','UNASSIGNED','ASSIGNED','IN_PROGRESS','AWAITING_APPROVAL','CLOSED'];
  let prior:Cursor|undefined;if(params.has('cursor')){let v:any;try{v=this.#codec.open(params.get('cursor')!);}catch{fail(400,'MAINTENANCE_CURSOR');}if(!v||Object.keys(v).sort().join(',')!=='binding,catalog,createdAt,expiresAt,identity,pageSize,position,purpose,root,state'||v.purpose!=='IDMS_MAINTENANCE_PAGE_V4'||v.binding!==this.#deployment||v.identity!==identity(ctx)||!hash(v.catalog)||!number(v.position)||!Number.isInteger(v.pageSize)||v.pageSize<1||v.pageSize>20||!states.includes(v.state)||!Number.isSafeInteger(v.createdAt)||v.createdAt>now+30000||v.createdAt<0||v.expiresAt-v.createdAt!==lifetime||!v.root||Object.keys(v.root).sort().join(',')!=='count,receiptHash,revision,rootHash,rootId'||!number(v.root.revision)||!number(v.root.count)||!hash(v.root.rootHash)||!hash(v.root.receiptHash)||!(v.root.rootId===null||hash(v.root.rootId)))fail(400,'MAINTENANCE_CURSOR');if(v.expiresAt<=now)fail(410,'MAINTENANCE_CURSOR_EXPIRED');prior=v;}
  const pageRaw=params.get('pageSize');if(pageRaw!==null&&(!/^[1-9][0-9]?$/.test(pageRaw)||Number(pageRaw)>20))fail(400,'MAINTENANCE_QUERY');const pageSize=pageRaw===null?prior?.pageSize||20:Number(pageRaw),state=params.get('state')??prior?.state??'';if(!states.includes(state)||prior&&(prior.pageSize!==pageSize||prior.state!==state))fail(400,'MAINTENANCE_QUERY');
  const {s,catalog,control}=await this.#open(ctx);try{if(control.status!=='ACTIVE')fail(409,'MAINTENANCE_FENCED');const catalogHash=canonicalDigest(catalog);if(prior&&prior.catalog!==catalogHash)fail(409,'MAINTENANCE_CATALOG_CHANGED');const root=prior?.root||s.currentHead,c=await s.get<any>('v4_collection','business/workOrders',root);need(c.tenantId===ctx.tenantId&&c.collection==='business/workOrders'&&number(c.count));let position=BigInt(prior?.position||'1'),scanned=0;need(position>=1n&&position<=BigInt(c.count)+1n);const items:Record<string,unknown>[]=[];
   while(position<=BigInt(c.count)&&items.length<pageSize&&scanned<48&&s.stats.keys<180){const p=position.toString(),slot=await s.get<any>('v4_order',domainOrderKey('business/workOrders',p),root);need(slot.tenantId===ctx.tenantId&&slot.collection==='business/workOrders'&&slot.position===p&&typeof slot.entityKey==='string');const o=JSON.parse(await decodeLegacyText('v4_entity',slot.entityKey,(ns,k)=>s.get(ns,k,root))) as WorkOrder;need(domainEntityKey('business/workOrders',o)===slot.entityKey);const current=await this.#entity<WorkOrder>(s,'business/workOrders',o.id);
    if(current&&(!state||o.state===state)&&await this.#visible(s,ctx,o,catalog,root)&&await this.#visible(s,ctx,current,catalog))items.push({id:o.id,title:o.title,deviceCode:o.deviceCode,state:o.state,assignee:o.assignee,version:o.version,updatedAt:o.updatedAt,workflow:o.workflow?{status:o.workflow.status,engine:o.workflow.engine}:null});position++;scanned++;
   }
   const next:Cursor={purpose:'IDMS_MAINTENANCE_PAGE_V4',binding:this.#deployment,identity:identity(ctx),catalog:catalogHash,root,position:position.toString(),pageSize,createdAt:prior?.createdAt||now,expiresAt:prior?.expiresAt||now+lifetime,state};return {items,nextCursor:position<=BigInt(c.count)?this.#codec.seal(next):null,scanned,readStats:{...s.stats}};
  }finally{await s.close();}
 }
}
