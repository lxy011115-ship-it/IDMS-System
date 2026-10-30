import {DomainError} from './service.ts';
import type {SpareEntity,SparesState} from './spares.ts';

/** Trusted repository facts, never part of a request, entity, event or response. */
export interface SparesFacts {
 persistedIds:Set<string>;
 stocks:Map<string,{quantityMilli:number;revision:number}>;
 supplierReturns:Map<string,number>;
 issueReturns:Map<string,number>;
 issueInstalled:Map<string,number>;
 documents:Map<string,number>;
 codeConflict:boolean;
 documentConflict:boolean;
 linkConflict:boolean;
 materialPlanConflict?:boolean;
}
export const factKey=(...values:string[])=>JSON.stringify(values);
export function exactFact(value:unknown,nonnegative=true){
 if(typeof value!=='string'||!/^(-?)(0|[1-9][0-9]*)$/.test(value)||value==='-0')throw new DomainError(503,'备件聚合事实无效');
 const n=Number(value);if(!Number.isSafeInteger(n)||nonnegative&&n<0)throw new DomainError(503,'备件聚合事实超出安全范围');return n;
}
export function localEntities(state:SparesState){return state.facts?state.entities.filter(e=>!state.facts!.persistedIds.has(e.id)):state.entities;}
export function relatedTotal(state:SparesState,kind:'supplierReturns'|'issueReturns'|'issueInstalled'|'documents',key:string,matches:(e:SpareEntity)=>boolean,amount:(e:SpareEntity)=>number){
 const base=state.facts?.[kind].get(key);if(state.facts&&base===undefined)throw new DomainError(503,'备件命令缺少必要聚合事实');
 const total=(base||0)+localEntities(state).filter(matches).reduce((sum,e)=>sum+amount(e),0);if(!Number.isSafeInteger(total)||total<0)throw new DomainError(503,'备件关联数量或金额无效');return total;
}
