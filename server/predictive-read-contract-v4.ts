import type {AccessContext} from './access.ts';
import {scopeFilter} from './access.ts';
import {domainReadAccessV4} from './domain-read-api-v4.ts';
import {canonicalDigest} from './canonical-state.ts';
import type {AuditCursorCodec} from './audit-cursor.ts';
import type {StateHead} from './state-map-sql-v1.ts';
import {DomainError} from './service.ts';
export type PredictiveReadRouteV4='HEALTH'|'ALERTS'|'JOBS';
export interface PredictiveReadCursorV4 {purpose:'PREDICTIVE_PAGE_V4_1';identity:string;deployment:string;configuration:string;catalog:string;route:PredictiveReadRouteV4;device:string;state:string;pageSize:number;root:StateHead;position:string;createdAt:number;expiresAt:number}
export function predictiveReadFailV4(status:number,code:string):never{throw new DomainError(status,code);}
export function predictiveReadNeedV4(v:unknown,code='PREDICTIVE_QUERY_INTEGRITY'):asserts v{if(!v)predictiveReadFailV4(503,code);}
export const predictiveReadHashV4=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const predictiveReadOrdinalV4=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=9223372036854775807n;
export function predictiveReadRootV4(v:any):v is StateHead{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')==='count,receiptHash,revision,rootHash,rootId'&&predictiveReadOrdinalV4(v.count)&&predictiveReadOrdinalV4(v.revision)&&(v.rootId===null||predictiveReadHashV4(v.rootId))&&predictiveReadHashV4(v.rootHash)&&predictiveReadHashV4(v.receiptHash);}
export function predictiveReadIdentityV4(ctx:AccessContext){const ordered=(v:string[]|null)=>v===null?null:[...new Set(v)].sort(),scope=scopeFilter(ctx);return canonicalDigest({tenant:ctx.tenantId,actor:ctx.actorId,type:ctx.actorType,auth:ctx.authMode,roles:ordered(ctx.roles||[]),scope:{sites:ordered(scope.sites),lines:ordered(scope.lines),devices:ordered(scope.devices)},provided:ctx.scope?.provided===true});}
export function predictiveReadDeviceV4(v:unknown):v is string{return typeof v==='string'&&v.length>0&&v.length<=128&&!/[\u0000-\u001f\u007f]/.test(v);}
export function parsePredictiveReadPageV4(params:URLSearchParams,route:PredictiveReadRouteV4,ctx:AccessContext,codec:AuditCursorCodec,devicePath?:string,now=Date.now()){
 domainReadAccessV4(ctx);const seen=new Set<string>();for(const [k]of params){if(!['cursor','pageSize','device','state'].includes(k)||seen.has(k))predictiveReadFailV4(400,'PREDICTIVE_QUERY');seen.add(k);}
 let prior:PredictiveReadCursorV4|undefined;const identity=predictiveReadIdentityV4(ctx),states=['','OPEN','AWAITING_APPROVAL','WORK_ORDER_CREATED','RESOLVED','DISMISSED'];
 if(params.has('cursor')){let v:any;try{v=codec.open(params.get('cursor')!);}catch{predictiveReadFailV4(400,'PREDICTIVE_CURSOR');}
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='catalog,configuration,createdAt,deployment,device,expiresAt,identity,pageSize,position,purpose,root,route,state'||v.purpose!=='PREDICTIVE_PAGE_V4_1'||v.route!==route||v.identity!==identity||![v.identity,v.deployment,v.configuration,v.catalog].every(predictiveReadHashV4)||!(v.device===''||predictiveReadDeviceV4(v.device))||!states.includes(v.state)||route!=='ALERTS'&&v.state!==''||!Number.isInteger(v.pageSize)||v.pageSize<1||v.pageSize>20||!predictiveReadRootV4(v.root)||!predictiveReadOrdinalV4(v.position)||!Number.isSafeInteger(v.createdAt)||v.createdAt<0||v.createdAt>now+30000||!Number.isSafeInteger(v.expiresAt)||v.expiresAt-v.createdAt!==1800000)predictiveReadFailV4(400,'PREDICTIVE_CURSOR');
  if(v.expiresAt<=now)predictiveReadFailV4(410,'PREDICTIVE_CURSOR_EXPIRED');prior=v;
 }
 const raw=params.get('pageSize');if(raw!==null&&(!/^[1-9][0-9]?$/.test(raw)||Number(raw)>20))predictiveReadFailV4(400,'PREDICTIVE_QUERY');const pageSize=raw===null?prior?.pageSize||10:Number(raw),device=devicePath??params.get('device')??prior?.device??'',state=params.get('state')??prior?.state??'';
 if(device!==''&&!predictiveReadDeviceV4(device)||devicePath!==undefined&&params.has('device')&&params.get('device')!==devicePath||!states.includes(state)||route!=='ALERTS'&&state!==''||route==='JOBS'&&device===''||prior&&(prior.pageSize!==pageSize||prior.device!==device||prior.state!==state))predictiveReadFailV4(400,'PREDICTIVE_QUERY_CHANGED');
 return {prior,identity,pageSize,device,state,now,route};
}
