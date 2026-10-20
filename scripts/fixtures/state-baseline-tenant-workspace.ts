// Frozen 1.11 state path, restricted to owned QA IPC.
if(!process.send||!/^stateqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('State QA IPC required');
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Store} from '../../server/store.ts';
import type {ImportData} from '../../server/imports.ts';
import type {TenantPayload} from './state-baseline-entity-repository.ts';
import {validateTenantBoundary} from './state-baseline-entity-repository.ts';
import {DomainError} from '../../server/service.ts';

export interface Workspace {store:Store;imports:ImportData}
export function tenantWorkspace(payload:TenantPayload):Workspace{
 if(payload.business.tenants.length!==1||payload.business.tenants[0].status!=='ACTIVE')throw new DomainError(403,'企业不存在或已停用');
 const data=structuredClone(payload);
 return {store:{...data.business,audits:data.audits,idempotency:new Map(data.idempotency)},imports:data.imports};
}
export function workspacePayload(workspace:Workspace,tenantId:string):TenantPayload{
 const {audits,idempotency,...business}=workspace.store;
 // Preserve the existing wire normalization, but never filter foreign rows away.
 const payload=JSON.parse(JSON.stringify({business,imports:workspace.imports,audits,idempotency:[...idempotency]})) as TenantPayload;
 validateTenantBoundary(payload,tenantId);return payload;
}
class ReadOnlyMap<K,V> extends Map<K,V>{
 constructor(entries:Iterable<readonly [K,V]>){super();for(const [key,value]of entries)Map.prototype.set.call(this,key,value);}
 override set(_key:K,_value:V):this{throw new DomainError(409,'只读工作区不能修改幂等记录');}
 override delete(_key:K):boolean{throw new DomainError(409,'只读工作区不能删除幂等记录');}
 override clear():void{throw new DomainError(409,'只读工作区不能清除幂等记录');}
}
function freeze(value:unknown):void{
 if(!value||typeof value!=='object'||Object.isFrozen(value))return;
 if(value instanceof Map)for(const item of value.values())freeze(item);
 else for(const item of Object.values(value))freeze(item);
 Object.freeze(value);
}
export function freezeWorkspace(workspace:Workspace):Workspace{
 if(!Object.isFrozen(workspace.store))workspace.store.idempotency=new ReadOnlyMap(workspace.store.idempotency);
 freeze(workspace);return workspace;
}
// Data is explicit; async context is used only to detect recursive queue waits.
const queueContext=new AsyncLocalStorage<ReadonlySet<string>>();
export class TenantQueue {
 private tails=new Map<string,Promise<void>>();private context=queueContext;
 run<T>(tenant:string,task:()=>Promise<T>):Promise<T>{
  const parents=this.context.getStore();if(parents?.has(tenant))return Promise.reject(new DomainError(409,'同一企业事务不可嵌套排队'));
  const previous=this.tails.get(tenant)||Promise.resolve();
  const result=previous.then(()=>this.context.run(new Set([...(parents||[]),tenant]),task));
  const tail=result.then(()=>undefined,()=>undefined).then(()=>{if(this.tails.get(tenant)===tail)this.tails.delete(tenant);});this.tails.set(tenant,tail);return result;
 }
 async drain(){while(this.tails.size)await Promise.all([...this.tails.values()]);}
 get size(){return this.tails.size;}
}
