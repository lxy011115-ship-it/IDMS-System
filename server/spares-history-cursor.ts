import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {canonical,digest} from './imports.ts';
import {scopeFilter,permissionsFor,type AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import {sparesHistoryPlan,type SparesHistoryPlan} from './spares-history.ts';
import type {SpareQueryStamp} from './spares-query-plan.ts';

export interface CurrentHistoryPlan extends SparesHistoryPlan {cursor:string}
const key=randomBytes(32),invalid=()=>new DomainError(400,'业务历史分页参数无效，请从最新一页重新查询');
const sequence=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
export function currentHistoryPlan(params:URLSearchParams):CurrentHistoryPlan{
 const cursor=params.get('before')??'';
 if(params.getAll('before').length>1||params.has('before')&&(!cursor||cursor.length>2048||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)))throw invalid();
 const filters=new URLSearchParams(params);filters.delete('before');return {...sparesHistoryPlan(filters),cursor};
}
const binding=(ctx:AccessContext,plan:CurrentHistoryPlan,stamp:SpareQueryStamp)=>digest(canonical({tenant:ctx.tenantId,actor:ctx.actorId,type:ctx.actorType,mode:ctx.authMode,roles:[...(ctx.roles||[])].sort(),grants:permissionsFor(ctx.roles||[]).sort(),scope:scopeFilter(ctx),filters:{...plan,before:null,cursor:''},...stamp}));
/** Process-local key intentionally expires old history tokens after restart. */
export function historyPageCursor(ctx:AccessContext,plan:CurrentHistoryPlan,stamp:SpareQueryStamp,before:string){
 if(!sequence(before))throw invalid();const body=Buffer.from(JSON.stringify({v:1,b:binding(ctx,plan,stamp),s:before})).toString('base64url');return body+'.'+createHmac('sha256',key).update(body).digest('base64url');
}
export function historyPageAnchor(ctx:AccessContext,plan:CurrentHistoryPlan,stamp:SpareQueryStamp){
 if(!plan.cursor)return null;const [body,mac,...extra]=plan.cursor.split('.');if(extra.length||!body||!mac)throw invalid();
 const expected=createHmac('sha256',key).update(body).digest(),actual=Buffer.from(mac,'base64url');if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw invalid();
 let value:any;try{value=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{throw invalid();}
 if(value?.v!==1||typeof value.b!=='string'||!sequence(value.s))throw invalid();if(value.b!==binding(ctx,plan,stamp))throw new DomainError(409,'业务资料、权限范围或筛选已变化，请从最新一页重新查询');return BigInt(value.s);
}
