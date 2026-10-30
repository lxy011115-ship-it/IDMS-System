import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {canonical,digest} from './imports.ts';
import {DomainError} from './service.ts';
import {scopeFilter,permissionsFor,type AccessContext} from './access.ts';

export const spareLists=['stock','part','warehouse','supplier','purchase','receipt','movement','link','replacement','adjustment','document'] as const;
export type SpareList=typeof spareLists[number];
export type SpareEndpoint='summary'|'list'|'detail'|'options'|'workorder-usage'|'material-plans'|'stock-insight'|'replacement-insight';
export interface SpareQueryPlan {endpoint:SpareEndpoint;kind:string;limit:number;q:string;id:string;supplierId:string;purchaseId:string;workOrderId:string;deviceCode:string;partId:string;warehouseId:string;linkId:string;basis:string;active:boolean;cursor:string}
const invalid=()=>new DomainError(400,'备件查询或分页参数无效');
export const spareUuid=(s:string)=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s);
export function spareQueryPlan(endpoint:SpareEndpoint,params:URLSearchParams):SpareQueryPlan{
 const fields:Record<SpareEndpoint,string[]>={summary:[],list:['kind','limit','q','supplierId','purchaseId','deviceCode','workOrderId','cursor'],detail:['id'],options:['kind','limit','q','id','deviceCode','partId','cursor'], 'workorder-usage':['workOrderId','limit','cursor'],'material-plans':['workOrderId','limit','cursor'],'stock-insight':['partId','warehouseId','basis','limit','cursor'],'replacement-insight':['linkId','limit','cursor']};
 if(!Object.hasOwn(fields,endpoint))throw invalid();const seen=new Set<string>();
 for(const [k,v]of params){if(!fields[endpoint].includes(k)||seen.has(k)||v.length>2048||/[\u0000-\u001f\u007f]/.test(v))throw invalid();seen.add(k);}
 const read=(k:string)=>params.get(k)||'',kind=read('kind'),raw=params.get('limit')??'30';
 if(!/^[1-9][0-9]{0,2}$/.test(raw)||Number(raw)>100||read('q').length>160)throw invalid();
 if(endpoint==='list'&&!spareLists.includes(kind as SpareList)||endpoint==='options'&&!['part','warehouse','supplier','link','device','order'].includes(kind))throw invalid();
 const id=read('id').toLowerCase(),supplierId=read('supplierId').toLowerCase(),purchaseId=read('purchaseId').toLowerCase(),workOrderId=read('workOrderId'),deviceCode=read('deviceCode'),partId=read('partId'),warehouseId=read('warehouseId'),linkId=read('linkId'),basis=endpoint==='stock-insight'?(read('basis')||'plans'):'';
 for(const v of [supplierId,purchaseId,partId,warehouseId,linkId])if(v&&!spareUuid(v))throw invalid();
 if(deviceCode&&(deviceCode.length>128||endpoint==='list'&&!['movement','link','replacement'].includes(kind)||endpoint==='options'&&!['order','link'].includes(kind)))throw invalid();
 if(partId&&!(endpoint==='options'&&kind==='link'||endpoint==='stock-insight')||workOrderId&&(workOrderId.length>128||endpoint==='list'&&!['movement','replacement'].includes(kind)))throw invalid();
 if((supplierId&&kind!=='purchase')||(purchaseId&&!['receipt','movement','document'].includes(kind)))throw invalid();
 if(endpoint==='detail'&&!spareUuid(id))throw invalid();
 // Device codes are case-sensitive. A selected option keeps the exact original ID.
 const optionId=read('id');if(endpoint==='options'&&optionId&&(optionId.length>128||(!['device','order'].includes(kind)&&!spareUuid(optionId))))throw invalid();
 if(['workorder-usage','material-plans'].includes(endpoint)&&(!workOrderId||workOrderId.length>128))throw invalid();
 if(endpoint==='stock-insight'&&(!partId||!warehouseId||!['plans','purchases'].includes(basis))||endpoint==='replacement-insight'&&!linkId)throw invalid();
 if(params.has('cursor')&&!read('cursor'))throw invalid();
 return {endpoint,kind,limit:Number(raw),q:read('q').trim().toLowerCase(),id:endpoint==='options'?optionId:id,supplierId,purchaseId,workOrderId,deviceCode,partId,warehouseId,linkId,basis,active:endpoint==='options',cursor:read('cursor')};
}
export interface SpareQueryStamp {publicRevision:string;revision:string}
export interface SparePageAnchor {first:string;second:string}
// Process-local signing keys deliberately expire old page tokens on service restart.
const signingKey=randomBytes(32);
const binding=(ctx:AccessContext,plan:SpareQueryPlan,stamp:SpareQueryStamp)=>digest(canonical({tenant:ctx.tenantId,actor:ctx.actorId,type:ctx.actorType,mode:ctx.authMode,roles:[...(ctx.roles||[])].sort(),grants:permissionsFor(ctx.roles||[]).sort(),scope:scopeFilter(ctx),query:{...plan,cursor:''},...stamp}));
export function sparePageCursor(ctx:AccessContext,plan:SpareQueryPlan,stamp:SpareQueryStamp,anchor:SparePageAnchor){
 const body=Buffer.from(JSON.stringify({v:1,b:binding(ctx,plan,stamp),a:anchor})).toString('base64url'),mac=createHmac('sha256',signingKey).update(body).digest('base64url');return body+'.'+mac;
}
export function sparePageAnchor(ctx:AccessContext,plan:SpareQueryPlan,stamp:SpareQueryStamp):SparePageAnchor|null{
 if(!plan.cursor)return null;const [body,mac,...extra]=plan.cursor.split('.');
 if(extra.length||!body||!/^[A-Za-z0-9_-]+$/.test(body)||!mac||!/^[A-Za-z0-9_-]{43}$/.test(mac))throw invalid();
 const expected=createHmac('sha256',signingKey).update(body).digest(),actual=Buffer.from(mac,'base64url');if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw invalid();
 let decoded:any;try{decoded=JSON.parse(Buffer.from(body,'base64url').toString());}catch{throw invalid();}
 if(decoded?.v!==1||typeof decoded.b!=='string'||!decoded.a||Object.keys(decoded.a).length!==2||typeof decoded.a.first!=='string'||typeof decoded.a.second!=='string'||decoded.a.first.length>128||decoded.a.second.length>128)throw invalid();
 if(decoded.b!==binding(ctx,plan,stamp))throw new DomainError(409,'资料、权限范围或查询条件已变化，请从首页重新查询');return decoded.a;
}
