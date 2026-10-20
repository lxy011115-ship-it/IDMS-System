import {createHash} from 'node:crypto';
import type {AccessContext} from './access.ts';
import {scopeFilter,requiredScope} from './access.ts';
import type {AuditEvent} from './domain.ts';
import {AuditChainVerifier} from './audit.ts';
import {holdValue} from './capacity.ts';
import {AuditPageError,type AuditCursorCodec} from './audit-cursor.ts';
export const auditPageLifetime=30*60*1000;
export interface AuditAnchor {sequence:string;eventId:string|null;hash:string}
export const emptyAuditAnchor:AuditAnchor=Object.freeze({sequence:'0',eventId:null,hash:'GENESIS'});
export interface AuditFilters {q:string;objectType:string;action:string;actorId:string;from:number|null;to:number|null}
interface AuditWindow {head:AuditAnchor;capturedAt:number;expiresAt:number}
interface Visibility {digest:string;total:number}
interface Move {direction:'OLDER'|'NEWER';anchor:AuditAnchor}
export interface AuditCursorBody {v:1;identity:string;scope:string;pageSize:number;filters:AuditFilters;window:AuditWindow;expected:Visibility;move:Move}
export interface AuditPagePlan {tenantId:string;identity:string;scope:string;pageSize:number;filters:AuditFilters;prior?:AuditCursorBody}
export interface AuditPageRow {sequence:string;tenant_id:string;event_id:string;hash:string;previous_hash:string;event:AuditEvent}
interface Entry {event:AuditEvent;anchor:AuditAnchor;ordinal:number;release:()=>void}
export interface AuditPageSlice {items:AuditEvent[];window:AuditWindow;expected:Visibility;newest?:{anchor:AuditAnchor;ordinal:number};oldest?:{anchor:AuditAnchor;ordinal:number}}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex'),hex=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const invalid=()=>new AuditPageError(400,'AUDIT_CURSOR_INVALID','分页标记无效，请刷新追溯');
const queryError=()=>new AuditPageError(400,'AUDIT_QUERY_INVALID','追溯筛选或分页参数无效');
export const auditIntegrityError=()=>new AuditPageError(503,'AUDIT_INTEGRITY','企业审计链暂无法核验，请稍后重试或联系管理员');
const changed=()=>new AuditPageError(409,'AUDIT_WINDOW_CHANGED','追溯范围已变化，请刷新最新记录');
const scopeChanged=()=>new AuditPageError(409,'AUDIT_SCOPE_CHANGED','授权可见范围已变化，请刷新追溯');
const expired=()=>new AuditPageError(410,'AUDIT_CURSOR_EXPIRED','本次追溯已过期，请刷新最新记录');
const exact=(value:any,names:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(n=>Object.hasOwn(value,n));
const epoch=(v:unknown):v is number=>Number.isSafeInteger(v)&&Math.abs(v as number)<=8640000000000000;
const text=(value:unknown,max:number)=>{if(typeof value!=='string'||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw queryError();return value.trim();};
const sequence=(value:unknown,allowZero=false)=>typeof value==='string'&&(allowZero&&value==='0'||/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n);
function anchor(value:any,allowEmpty:boolean,fail:()=>Error):AuditAnchor{if(!exact(value,['sequence','eventId','hash'])||!sequence(value.sequence,allowEmpty))throw fail();if(value.sequence==='0'){if(!allowEmpty||value.eventId!==null||value.hash!=='GENESIS')throw fail();}else if(typeof value.eventId!=='string'||!/^[-\w]{1,128}$/.test(value.eventId)||!hex(value.hash))throw fail();return {sequence:value.sequence,eventId:value.eventId,hash:value.hash};}
const same=(a:AuditAnchor,b:AuditAnchor)=>a.sequence===b.sequence&&a.eventId===b.eventId&&a.hash===b.hash;
export function auditHead(row:any):AuditAnchor{return row?anchor({sequence:row.sequence,eventId:row.event_id,hash:row.hash},false,auditIntegrityError):emptyAuditAnchor;}
function storedFilters(value:any):AuditFilters{if(!exact(value,['q','objectType','action','actorId','from','to']))throw invalid();try{const result={q:text(value.q,160),objectType:text(value.objectType,80),action:text(value.action,120),actorId:text(value.actorId,160),from:value.from,to:value.to};if(result.q!==result.q.toLowerCase()||[result.from,result.to].some(v=>v!==null&&!epoch(v))||result.from!==null&&result.to!==null&&result.from>result.to)throw invalid();return result;}catch{throw invalid();}}
function cursorBody(value:any):AuditCursorBody{
 if(!exact(value,['v','identity','scope','pageSize','filters','window','expected','move'])||value.v!==1||!hex(value.identity)||!hex(value.scope)||!Number.isInteger(value.pageSize)||value.pageSize<1||value.pageSize>200||!exact(value.window,['head','capturedAt','expiresAt'])||!epoch(value.window.capturedAt)||value.window.capturedAt<0||!epoch(value.window.expiresAt)||value.window.expiresAt-value.window.capturedAt!==auditPageLifetime||!exact(value.expected,['digest','total'])||!hex(value.expected.digest)||!Number.isSafeInteger(value.expected.total)||value.expected.total<1||!exact(value.move,['direction','anchor'])||!['OLDER','NEWER'].includes(value.move.direction))throw invalid();
 const head=anchor(value.window.head,false,invalid),position=anchor(value.move.anchor,false,invalid);if(BigInt(position.sequence)>BigInt(head.sequence))throw invalid();return {v:1,identity:value.identity,scope:value.scope,pageSize:value.pageSize,filters:storedFilters(value.filters),window:{head,capturedAt:value.window.capturedAt,expiresAt:value.window.expiresAt},expected:{digest:value.expected.digest,total:value.expected.total},move:{direction:value.move.direction,anchor:position}};
}
function date(value:string):number|null{if(!value.trim())return null;if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))throw queryError();const n=Date.parse(value),day=new Date(value.slice(0,10)+'T00:00:00Z');if(!epoch(n)||!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==value.slice(0,10))throw queryError();return n;}
function bindings(ctx:AccessContext){const sorted=(values:string[]|null|undefined)=>values===null?null:[...new Set(values||[])].sort(),scope=scopeFilter(ctx);return {identity:sha(JSON.stringify({tenantId:ctx.tenantId,actorId:ctx.actorId,actorType:ctx.actorType,authMode:ctx.authMode||'demo'})),scope:sha(JSON.stringify({v:1,roles:sorted(ctx.roles),permissions:sorted(ctx.permissions),sites:sorted(scope.sites),lines:sorted(scope.lines),devices:sorted(scope.devices),provided:!!ctx.scope?.provided,own:ctx.authMode==='oidc'&&requiredScope(ctx.roles||[])==='OWN_TASKS'}))};}
export function parseAuditPage(params:URLSearchParams,ctx:AccessContext,codec:AuditCursorCodec,now=Date.now()):AuditPagePlan|undefined{
 if(!params.size)return;const allowed=['pageSize','cursor','q','objectType','action','actorId','from','to'],seen=new Set<string>();for(const [name]of params){if(!allowed.includes(name)||seen.has(name))throw queryError();seen.add(name);}
 const prior=params.has('cursor')?cursorBody(codec.open(params.get('cursor')!)):undefined,identity=bindings(ctx);
 if(prior){if(prior.identity!==identity.identity)throw invalid();if(prior.scope!==identity.scope)throw scopeChanged();if(prior.window.capturedAt>now+30000)throw invalid();if(prior.window.expiresAt<=now)throw expired();}
 let pageSize=prior?.pageSize||50;if(params.has('pageSize')){const raw=params.get('pageSize')!;if(!/^[1-9][0-9]{0,2}$/.test(raw)||Number(raw)>200)throw queryError();pageSize=Number(raw);}
 const old=prior?.filters;const filters:AuditFilters={q:params.has('q')?text(params.get('q'),160).toLowerCase():old?.q||'',objectType:params.has('objectType')?text(params.get('objectType'),80):old?.objectType||'',action:params.has('action')?text(params.get('action'),120):old?.action||'',actorId:params.has('actorId')?text(params.get('actorId'),160):old?.actorId||'',from:params.has('from')?date(params.get('from')!):old?.from??null,to:params.has('to')?date(params.get('to')!):old?.to??null};
 if(filters.from!==null&&filters.to!==null&&filters.from>filters.to)throw queryError();if(prior&&(pageSize!==prior.pageSize||JSON.stringify(filters)!==JSON.stringify(prior.filters)))throw new AuditPageError(400,'AUDIT_QUERY_CHANGED','筛选条件已变化，请刷新追溯');return {tenantId:ctx.tenantId,...identity,pageSize,filters,prior};
}
function matches(event:AuditEvent,f:AuditFilters){if(f.objectType&&event.objectType!==f.objectType||f.action&&event.action!==f.action||f.actorId&&event.actorId!==f.actorId)return false;if(f.from!==null||f.to!==null){const n=Date.parse(event.businessTime);if(!Number.isFinite(n)||f.from!==null&&n<f.from||f.to!==null&&n>f.to)return false;}return !f.q||[event.action,event.objectId,event.objectType,event.actorId,String(event.metadata?.comment||'')].join(' ').toLowerCase().includes(f.q);}
// Retains at most one page while validating every row, including hidden rows and
// events appended after the fixed visible window.
export class AuditPageCollector {
 private chain:AuditChainVerifier;private previous=0n;private last:AuditAnchor=emptyAuditAnchor;private ring:Entry[]=[];private next=0;private total=0;private visibleDigest=createHash('sha256');private headSeen=false;private moveSeen=false;private moveVisible=false;private finished=false;private peak=0;
 readonly window:AuditWindow;readonly plan:AuditPagePlan;private current:AuditAnchor;private visible:(event:AuditEvent)=>boolean;private retain:(value:unknown)=>()=>void;private clock:()=>number;
 constructor(plan:AuditPagePlan,current:AuditAnchor,visible:(event:AuditEvent)=>boolean,options:{retain?:(value:unknown)=>()=>void;clock?:()=>number}={}){this.plan=plan;this.current=anchor(current,true,auditIntegrityError);this.chain=new AuditChainVerifier(plan.tenantId);this.visible=visible;this.retain=options.retain||holdValue;this.clock=options.clock||Date.now;const now=this.clock();this.window=plan.prior?.window||{head:this.current,capturedAt:now,expiresAt:now+auditPageLifetime};if(this.window.expiresAt<=now)throw expired();if(BigInt(this.window.head.sequence)>BigInt(this.current.sequence))throw changed();this.headSeen=this.window.head.sequence==='0';}
 accept(row:AuditPageRow){
  if(this.finished)throw Error('Audit page collector already finalized');const position=anchor({sequence:row.sequence,eventId:row.event_id,hash:row.hash},false,auditIntegrityError),n=BigInt(position.sequence);
  if(n<=this.previous||row.tenant_id!==this.plan.tenantId||!row.event||typeof row.event!=='object'||row.event.tenantId!==row.tenant_id||row.event.eventId!==row.event_id||row.event.hash!==row.hash||row.event.previousHash!==row.previous_hash||!this.chain.accept(row.event))throw auditIntegrityError();this.previous=n;this.last=position;
  if(position.sequence===this.window.head.sequence){if(!same(position,this.window.head))throw changed();this.headSeen=true;}
  const move=this.plan.prior?.move;if(move&&position.sequence===move.anchor.sequence){if(!same(position,move.anchor))throw changed();this.moveSeen=true;}
  if(n>BigInt(this.window.head.sequence))return;
  const eligible=this.visible(row.event)&&matches(row.event,this.plan.filters);if(move&&position.sequence===move.anchor.sequence)this.moveVisible=eligible;if(!eligible)return;
  if(!Number.isSafeInteger(this.total+1))throw auditIntegrityError();this.total++;this.visibleDigest.update(row.event.hash+'\n');
  if(move&&(move.direction==='OLDER'?n>=BigInt(move.anchor.sequence):n<=BigInt(move.anchor.sequence)))return;
  if(move?.direction==='NEWER'&&this.ring.length>=this.plan.pageSize)return;
  const index=this.ring.length<this.plan.pageSize?this.ring.length:this.next;this.ring[index]?.release();const release=this.retain({event:row.event,anchor:position});this.ring[index]={event:row.event,anchor:position,ordinal:this.total,release};this.next=(index+1)%this.plan.pageSize;this.peak=Math.max(this.peak,this.ring.length);
 }
 finish():AuditPageSlice{
  if(this.finished)throw Error('Audit page collector already finalized');if(!same(this.last,this.current))throw auditIntegrityError();if(this.window.expiresAt<=this.clock())throw expired();if(!this.headSeen)throw changed();const digest=this.visibleDigest.digest('hex'),prior=this.plan.prior;
  if(prior&&(prior.expected.total!==this.total||prior.expected.digest!==digest))throw scopeChanged();if(prior&&(!this.moveSeen||!this.moveVisible))throw changed();const entries=[...this.ring].sort((a,b)=>b.ordinal-a.ordinal);if(this.total&&!entries.length)throw changed();this.finished=true;
  const newest=entries[0],oldest=entries.at(-1);return {items:entries.map(e=>e.event),window:this.window,expected:{digest,total:this.total},...(newest?{newest:{anchor:newest.anchor,ordinal:newest.ordinal},oldest:{anchor:oldest!.anchor,ordinal:oldest!.ordinal}}:{})};
 }
 discard(){for(const entry of this.ring)entry.release();this.ring.length=0;this.finished=true;}
 get retainedPeak(){return this.peak;}
}
export function auditPageResponse(slice:AuditPageSlice,plan:AuditPagePlan,codec:AuditCursorCodec,partialView:boolean){
 const body=(move:Move):AuditCursorBody=>({v:1,identity:plan.identity,scope:plan.scope,pageSize:plan.pageSize,filters:plan.filters,window:slice.window,expected:slice.expected,move});return {items:slice.items,paged:true,total:slice.expected.total,pageSize:plan.pageSize,range:{from:slice.newest?slice.expected.total-slice.newest.ordinal+1:0,to:slice.oldest?slice.expected.total-slice.oldest.ordinal+1:0},previousCursor:slice.newest&&slice.newest.ordinal<slice.expected.total?codec.seal(body({direction:'NEWER',anchor:slice.newest.anchor})):null,nextCursor:slice.oldest&&slice.oldest.ordinal>1?codec.seal(body({direction:'OLDER',anchor:slice.oldest.anchor})):null,snapshot:{capturedAt:new Date(slice.window.capturedAt).toISOString(),expiresAt:new Date(slice.window.expiresAt).toISOString()},filters:{...plan.filters,from:plan.filters.from===null?'':new Date(plan.filters.from).toISOString(),to:plan.filters.to===null?'':new Date(plan.filters.to).toISOString()},chainValid:true,verificationScope:'SERVER_FULL_TENANT_CHAIN',partialView};
}
