import type {ColdImportBindings} from './cold-import-proof.ts';
import type {ReadWorkspaceData,StoreView} from './read-model.ts';
import type {ImportView} from './imports.ts';
import type {Store} from './store.ts';
import type {ImportData} from './imports.ts';
import type {TenantPayload} from './entity-repository.ts';
import {DomainError} from './service.ts';

export interface RuntimeHistory {readonly workflowRequired:boolean;readonly aiModelDigests:readonly string[]}
export interface RuntimeBootstrap {readonly tenants:Store['tenants'];readonly history:RuntimeHistory}
const roots=new WeakSet<object>();
export function snapshotHistory(store:Pick<StoreView,'workOrders'>,imports:Pick<ImportView,'batches'>):RuntimeHistory{
 assertBusinessSnapshot(store);const pins=new Set<string>();for(const batch of imports.batches){const gateway=batch.aiReview.gateway;if(gateway){if(typeof gateway.modelDigest!=='string'||!gateway.modelDigest)throw Error('Invalid historical AI model pin');pins.add(gateway.modelDigest);}}
 return Object.freeze({workflowRequired:store.workOrders.some(order=>!!order.workflow),aiModelDigests:Object.freeze([...pins].sort())});
}
// Only the verified tenant's small binding fields escape the loading callback.
export class BootstrapBuilder {
 private tenants:Store['tenants']=[];private models=new Set<string>();private workflow=false;private finished=false;
 acceptVerifiedTenant(tenantId:string,payload:TenantPayload){this.accept(tenantId,payload.business,payload.imports);}
 acceptVerifiedRead(tenantId:string,data:ReadWorkspaceData){this.accept(tenantId,data.store,data.imports);}
 acceptVerifiedBindings(tenantId:string,bindings:ColdImportBindings){this.append(tenantId,bindings.tenants,bindings.history);}
 private accept(tenantId:string,business:StoreView,imports:ImportView){this.append(tenantId,business.tenants,snapshotHistory(business,imports));}
 private append(tenantId:string,tenants:Store['tenants'],history:RuntimeHistory){
  if(this.finished)throw Error('Bootstrap builder is already finalized');
  if(tenants.length!==1||tenants[0].id!==tenantId||this.tenants.some(t=>t.id===tenantId))throw Error('Invalid runtime tenant binding');
  const source=tenants[0],tenant={id:source.id,name:source.name,plan:source.plan,status:source.status,modules:[...source.modules]};Object.freeze(tenant.modules);Object.freeze(tenant);this.tenants.push(tenant);
  this.workflow ||=history.workflowRequired;for(const pin of history.aiModelDigests)this.models.add(pin);
 }
 finish():RuntimeBootstrap{if(this.finished)throw Error('Bootstrap builder is already finalized');if(!this.tenants.length)throw Error('No runtime tenant bindings');this.finished=true;Object.freeze(this.tenants);return Object.freeze({tenants:this.tenants,history:Object.freeze({workflowRequired:this.workflow,aiModelDigests:Object.freeze([...this.models].sort())})});}
}
export function applyRuntimeBootstrap(store:Store,bindings:RuntimeBootstrap){
 for(const key of Object.keys(store).filter(k=>!['audits','idempotency','tenants'].includes(k)))(store as any)[key]=[];
 store.tenants=bindings.tenants;store.audits=[];store.idempotency=new Map();roots.add(store);
}
export function assertBusinessSnapshot(store:object){if(roots.has(store))throw new DomainError(503,'启动绑定不包含业务快照；请加载当前企业工作区');}
export function assertWorkflowHistory(history:RuntimeHistory,configured:boolean){if(history.workflowRequired&&!configured)throw Error('Existing Flowable cases require workflow configuration; local fallback is prohibited');}
export function assertAiHistory(history:RuntimeHistory,modelDigest?:string){if(history.aiModelDigests.length&&!modelDigest)throw Error('Existing AI review history requires its pinned gateway configuration; fallback is prohibited');if(modelDigest&&history.aiModelDigests.some(pin=>pin!==modelDigest))throw Error('Historical AI model pin differs; explicit version migration required');}
