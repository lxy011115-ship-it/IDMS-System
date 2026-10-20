import {accountValue,memoryTask,workScheduler,requestSignal} from './capacity.ts';
import {jsonWireClone} from './canonical-state.ts';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Store} from './store.ts';
import type {ImportData} from './imports.ts';
import type {TenantPayload} from './entity-repository.ts';
import {validateTenantBoundary} from './entity-repository.ts';
import {DomainError} from './service.ts';

export interface Workspace {store:Store;imports:ImportData}
export function tenantWorkspace(payload:TenantPayload):Workspace{
 if(payload.business.tenants.length!==1||payload.business.tenants[0].status!=='ACTIVE')throw new DomainError(403,'企业不存在或已停用');
 accountValue(payload);const data=structuredClone(payload);
 return {store:{...data.business,audits:data.audits,idempotency:new Map(data.idempotency)},imports:data.imports};
}
export function workspacePayload(workspace:Workspace,tenantId:string):TenantPayload{
 const {audits,idempotency,...business}=workspace.store;
 // Preserve the existing wire normalization, but never filter foreign rows away.
 accountValue({business,imports:workspace.imports,audits,idempotency:[...idempotency]});
 const payload=jsonWireClone({business,imports:workspace.imports,audits,idempotency:[...idempotency]}) as TenantPayload;
 validateTenantBoundary(payload,tenantId);return payload;
}
class ReadOnlyMap<K,V> extends Map<K,V>{
 constructor(entries:Iterable<readonly [K,V]>){super();for(const [key,value]of entries)Map.prototype.set.call(this,key,value);}
 override set(_key:K,_value:V):this{throw new DomainError(409,'只读工作区不能修改幂等记录');}
 override delete(_key:K):boolean{throw new DomainError(409,'只读工作区不能删除幂等记录');}
 override clear():void{throw new DomainError(409,'只读工作区不能清除幂等记录');}
}
export function freezeValue(value:unknown):void{
 if(!value||typeof value!=='object'||Object.isFrozen(value))return;
 if(value instanceof Map)for(const item of value.values())freezeValue(item);
 else for(const item of Object.values(value))freezeValue(item);
 Object.freeze(value);
}
export function freezeWorkspace(workspace:Workspace):Workspace{
 if(!Object.isFrozen(workspace.store))workspace.store.idempotency=new ReadOnlyMap(workspace.store.idempotency);
 freezeValue(workspace);return workspace;
}
// Data is explicit; async context is used only to detect recursive queue waits.
const queueContext=new AsyncLocalStorage<ReadonlySet<string>>();
export class TenantQueue {
 private pending=new Set<Promise<unknown>>();private context=queueContext;
 run<T>(tenant:string,task:()=>Promise<T>):Promise<T>{
  const parents=this.context.getStore();if(parents?.has(tenant))return Promise.reject(new DomainError(409,'同一企业事务不可嵌套排队'));
  const result=workScheduler.run(tenant,()=>this.context.run(new Set([...(parents||[]),tenant]),()=>memoryTask(task,true)),requestSignal());
  this.pending.add(result);void result.then(()=>this.pending.delete(result),()=>this.pending.delete(result));return result;
 }
 async drain(){while(this.pending.size)await Promise.allSettled([...this.pending]);}
 get size(){return this.pending.size;}
}
