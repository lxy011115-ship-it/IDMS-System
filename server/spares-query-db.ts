import type pg from 'pg';
import {requireAccess,type AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import {currentQuery} from './revision-projection.ts';
import {accountValue} from './capacity.ts';
import {verifySpareAudit,checkSparesRead} from './spares-audit.ts';
import {validateSpareRow} from './spares-workset.ts';
import {exactFact} from './spares-facts.ts';
import {businessDay,sparesCapabilities} from './spares.ts';
import {spareQueryScope} from './spares-query-scope.ts';
import {spareQueryPlan,sparePageCursor,sparePageAnchor,type SpareEndpoint,type SpareQueryPlan,type SpareQueryStamp} from './spares-query-plan.ts';
import {spareTransaction} from './spares-transaction.ts';

const integrity=()=>new DomainError(503,'备件查询资料暂无法核验');
const integer=(value:unknown,negative=false)=>exactFact(value,!negative);
const due=`CASE WHEN COALESCE(e.body->>'lastDate','')<>'' AND (e.body->>'cycleDays')::int>0 THEN ((e.body->>'lastDate')::date+(e.body->>'cycleDays')::int)::text END`;
const purchaseMoney=`LEFT JOIN LATERAL (
 SELECT COALESCE(sum((x.body->>'amountCents')::numeric) FILTER(WHERE x.body->>'type'='PAYMENT'),0)::text AS payment,
 COALESCE(sum((x.body->>'amountCents')::numeric) FILTER(WHERE x.body->>'type'='INVOICE'),0)::text AS invoice
 FROM spare_visible x WHERE x.kind='document' AND x.body->>'purchaseId'=e.id::text
 ) finance ON true LEFT JOIN LATERAL (
 SELECT COALESCE(sum(floor(((l->>'receivedMilli')::numeric*(l->>'unitPriceCents')::numeric+500)/1000)),0)::text AS received
 FROM jsonb_array_elements(e.body->'lines') l) received ON true`;
const stockCte=`,spare_stock AS (
 SELECT p.id AS part_id,w.id AS warehouse_id,p.body AS part,w.body AS warehouse,
 COALESCE(m.quantity,0)::text AS quantity,COALESCE(m.revision,0)::text AS revision,
 COALESCE(m.quantity,0)<(p.body->>'safetyMilli')::numeric AS low
 FROM spare_visible p JOIN spare_visible w ON w.kind='warehouse' AND w.site_code=p.site_code
 LEFT JOIN (SELECT body->>'partId' AS part_id,body->>'warehouseId' AS warehouse_id,
 sum((body->>'deltaMilli')::numeric) AS quantity,count(*) AS revision
 FROM idms_spares.entities WHERE tenant_id=$1 AND kind='movement' GROUP BY body->>'partId',body->>'warehouseId') m
 ON m.part_id=p.id::text AND m.warehouse_id=w.id::text WHERE p.kind='part'
 ) `;

/** A single borrowed connection owns scope, public revision, inventory revision,
 * complete audit verification and each bounded query. Not yet the legacy API. */
export async function readSparesQuery(pool:pg.Pool,ctx:AccessContext,endpoint:SpareEndpoint,params:URLSearchParams,verifyCurrent:(c:pg.PoolClient)=>Promise<void>){
 requireAccess(ctx,'spares:read');const plan=spareQueryPlan(endpoint,params);
 return spareTransaction(pool,ctx,{},async c=>{
   if(!(await c.query("SELECT to_regclass('idms_spares.state') AS relation")).rows[0]?.relation)return {available:false,notice:'备件采购模块待初始化'};
   if(!(await c.query("SELECT to_regclass('idms_spares.migrations') AS relation")).rows[0]?.relation||(await c.query("SELECT version FROM idms_spares.migrations WHERE name='capacity'")).rows[0]?.version!==1)throw new DomainError(503,'请先完成备件容量索引迁移');
   // Verification belongs to the caller's established current-business proof.
   // It must run on this connection, never through a second pool acquisition.
   await verifyCurrent(c);checkSparesRead();
   const heads=(await c.query('SELECT p.revision::text AS public_revision,s.revision::text AS revision FROM public.business_state p JOIN idms_spares.state s ON s.tenant_id=p.tenant_id WHERE p.tenant_id=$1',[ctx.tenantId])).rows;
   if(heads.length!==1||!/^\d+$/.test(heads[0].revision)||!/^\d+$/.test(heads[0].public_revision))throw integrity();
   const stamp={revision:heads[0].revision,publicRevision:heads[0].public_revision};
   const anchor=sparePageAnchor(ctx,plan,stamp);await verifySpareAudit(c,ctx.tenantId,stamp.revision);
   const scope=spareQueryScope(ctx),values=[...scope.values];
   const param=(v:unknown)=>{values.push(v);return '$'+values.length;};
   const query=async(text:string)=>{checkSparesRead();const rows=(await currentQuery(c,scope.cte+text,values)).rows;checkSparesRead();accountValue(rows);return rows;};
   const result=endpoint==='summary'?await summary():endpoint==='detail'?await detail():endpoint==='options'?await options():endpoint==='workorder-usage'?await usage():await list();
   checkSparesRead();accountValue(result);return {available:true,...stamp,capabilities:sparesCapabilities(ctx),...result};

   function page(rows:Record<string,any>[],map:(r:any)=>any){
    if(rows.length>plan.limit+1)throw integrity();const hasMore=rows.length>plan.limit,selected=rows.slice(0,plan.limit);
    const last=selected.at(-1);return {items:selected.map(map),hasMore,nextCursor:hasMore&&last?sparePageCursor(ctx,plan,stamp,{first:last.key_first,second:last.key_second}):null,limit:plan.limit};
   }
   function pageWhere(first:string,second:string){return anchor?` AND (${first},${second})>(${param(anchor.first)}::text,${param(anchor.second)}::text)` : '';}
   function search(expressions:string[]){if(!plan.q)return '';const p=param(plan.q);return ` AND (${expressions.map(x=>`strpos(lower(COALESCE(${x},'')),${p})>0`).join(' OR ')})`;}
   function entity(row:any){const e=validateSpareRow(row,ctx.tenantId);if(!e.createdAt||!Number.isFinite(Date.parse(e.createdAt)))throw integrity();return e;}
   function money(row:any){return {paymentCents:integer(row.payment),invoiceCents:integer(row.invoice),netReceivedCents:integer(row.received),financeReview:BigInt(row.payment)>BigInt(row.received)};}
   function stock(row:any){return {partId:row.part_id,warehouseId:row.warehouse_id,part:row.part,warehouse:row.warehouse,quantityMilli:integer(row.quantity,true),revision:integer(row.revision),low:row.low};}
   async function list(){
    if(plan.kind==='stock'){
     const where=search(["part->>'code'","part->>'name'","warehouse->>'name'","warehouse->>'location'"])+pageWhere('part_id::text','warehouse_id::text'),limit=param(plan.limit+1);
     return page(await query(stockCte+`SELECT *,part_id::text AS key_first,warehouse_id::text AS key_second FROM spare_stock WHERE true ${where} ORDER BY part_id::text,warehouse_id::text LIMIT ${limit}`),stock);
    }
    const kind=param(plan.kind);let where=`e.kind=${kind}`+search(["e.body->>'code'","e.body->>'name'","e.body->>'number'","e.body->>'model'","e.body->>'reason'","e.body->>'deviceCode'","e.body->>'position'","e.body->>'supplierName'"]);
    if(plan.supplierId)where+=` AND e.body->>'supplierId'=${param(plan.supplierId)}`;
    if(plan.purchaseId)where+=` AND e.body->>'purchaseId'=${param(plan.purchaseId)}`;
    if(plan.deviceCode)where+=` AND e.body->>'deviceCode'=${param(plan.deviceCode)}`;
    if(plan.workOrderId)where+=` AND e.body->>'workOrderId'=${param(plan.workOrderId)}`;
    where+=pageWhere("e.body->>'createdAt'",'e.id::text');const limit=param(plan.limit+1),isPurchase=plan.kind==='purchase';
    // Select the bounded base page before looking up related labels. Otherwise
    // unanalysed large partitions can amplify missing-label joins before LIMIT.
    const rows=await query(`,spare_page AS MATERIALIZED (
     SELECT e.* FROM spare_visible e WHERE ${where} ORDER BY e.body->>'createdAt',e.id::text LIMIT ${limit}
     ) SELECT e.*,e.body->>'createdAt' AS key_first,e.id::text AS key_second,
     p.body AS part,w.body AS warehouse,l.body AS link,po.body->>'number' AS purchase_number,
     ${isPurchase?'finance.payment,finance.invoice,received.received,':' '}${due} AS due_date
     FROM spare_page e
     LEFT JOIN spare_visible p ON p.kind='part' AND p.id=NULLIF(e.body->>'partId','')::uuid
     LEFT JOIN spare_visible w ON w.kind='warehouse' AND w.id=NULLIF(e.body->>'warehouseId','')::uuid
     LEFT JOIN spare_visible l ON l.kind='link' AND l.id=NULLIF(e.body->>'linkId','')::uuid
     LEFT JOIN spare_visible po ON po.kind='purchase' AND po.id=NULLIF(e.body->>'purchaseId','')::uuid
     ${isPurchase?purchaseMoney:''} ORDER BY e.body->>'createdAt',e.id::text`);
    return page(rows,r=>({entity:{...entity(r),...(isPurchase?money(r):{}),...(plan.kind==='link'?{dueDate:r.due_date}: {})},related:{part:label(r.part),warehouse:label(r.warehouse),link:label(r.link),purchaseNumber:r.purchase_number||''}}));
   }
   async function detail(){
    const id=param(plan.id),rows=await query(`SELECT e.*,finance.payment,finance.invoice,received.received,w.body AS warehouse FROM spare_visible e LEFT JOIN spare_visible w ON w.kind='warehouse' AND w.id::text=e.body->>'warehouseId' ${purchaseMoney} WHERE e.kind='purchase' AND e.id::text=${id} LIMIT 2`);
    if(!rows.length)throw new DomainError(404,'采购单不存在或不在授权范围');if(rows.length!==1)throw integrity();
    const item=entity(rows[0]);if(!Array.isArray(item.lines)||item.lines.length>50)throw integrity();
    return {item:{...item,...money(rows[0])},warehouse:label(rows[0].warehouse),notice:'收货、流水及票款记录请按采购单分页查询。付款仅登记凭证，不执行支付。'};
   }
   async function options(){
    const optionKind=plan.kind;let from:string,where:string,key:string,body:string;
    if(optionKind==='device'){from='spare_devices e';where='true';key='e.device_code';body="jsonb_build_object('id',e.device_code,'code',e.device_code,'name',e.device_name,'siteCode',e.site_code)";}
    else if(optionKind==='order'){from='spare_orders e';where='true';key='e.id';body="jsonb_build_object('id',e.id,'deviceCode',e.body->>'deviceCode','assignee',e.body->>'assignee','state',e.body->>'state')";}
    else{from='spare_visible e';where=`e.kind=${param(optionKind)}`;key='e.id::text';body="jsonb_build_object('id',e.id,'code',e.body->>'code','name',e.body->>'name','siteCode',e.site_code,'unit',e.body->>'unit','active',e.body->'active','deviceCode',e.body->>'deviceCode','partId',e.body->>'partId','position',e.body->>'position')";}
    if(plan.deviceCode)where+=` AND e.body->>'deviceCode'=${param(plan.deviceCode)}`;
    if(plan.partId)where+=` AND e.body->>'partId'=${param(plan.partId)}`;
    // A selected inactive option is returned separately, with current scope checks.
    // It is never silently restored to the set usable for new business.
    let selected=null;if(plan.id){const count=values.length,id=param(plan.id),rows=await query(`SELECT ${body} AS item FROM ${from} WHERE ${where} AND ${key}=${id} LIMIT 2`);values.length=count;if(rows.length!==1)throw new DomainError(404,'已选资料不在当前授权范围');selected=rows[0].item;}
    const itemSearch=search([`(${body})->>'code'`,`(${body})->>'name'`,`(${body})->>'deviceCode'`,`(${body})->>'position'`,key]);
    const active=['device','order'].includes(optionKind)?'':" AND COALESCE(e.body->>'active','true')='true'";
    const after=pageWhere(key,key),limit=param(plan.limit+1);
    return {...page(await query(`SELECT ${body} AS item,${key} AS key_first,${key} AS key_second FROM ${from} WHERE ${where}${active}${itemSearch}${after} ORDER BY ${key} LIMIT ${limit}`),r=>r.item),selected,notice:'仅显示本页匹配资料；还有更多时请继续翻页或搜索。'};
   }
   async function usage(){
    const order=param(plan.workOrderId),allowed=await query(`SELECT id FROM spare_orders WHERE id=${order} LIMIT 2`);if(allowed.length!==1)throw new DomainError(404,'工单不存在或不在当前范围');
    const after=pageWhere('u.part_id','u.part_id'),limit=param(plan.limit+1);
    const rows=await query(`,spare_usage AS (SELECT e.body->>'partId' AS part_id,-sum((e.body->>'deltaMilli')::numeric) AS quantity FROM spare_visible e WHERE e.kind='movement' AND e.body->>'workOrderId'=${order} AND e.body->>'type' IN ('ISSUE','RETURN') GROUP BY e.body->>'partId') SELECT u.part_id,u.quantity::text,p.body AS part,u.part_id AS key_first,u.part_id AS key_second FROM spare_usage u LEFT JOIN spare_visible p ON p.kind='part' AND p.id::text=u.part_id WHERE true ${after} ORDER BY u.part_id LIMIT ${limit}`);
    return {...page(rows,r=>({partId:r.part_id,quantityMilli:integer(r.quantity,true),part:label(r.part)})),workOrderId:plan.workOrderId};
   }
   async function summary(){
    const today=param(businessDay()),approve=param(sparesCapabilities(ctx).approve);
    const rows=await query(stockCte+`,spare_purchase_money AS (SELECT e.id,e.body,finance.payment,received.received FROM spare_visible e ${purchaseMoney} WHERE e.kind='purchase')
     SELECT (SELECT count(*)::text FROM spare_stock WHERE low) AS low,
     (SELECT count(*)::text FROM spare_visible e WHERE ${approve}::boolean AND e.body->>'status'='SUBMITTED' AND
       ((e.kind='adjustment' AND e.body->>'createdBy'<>$6) OR (e.kind='purchase' AND e.body->>'createdBy'<>$6 AND COALESCE(e.body->>'submittedBy','')<>$6 AND NOT COALESCE(e.body->'contributors','[]'::jsonb)?$6))) AS pending,
     (SELECT count(*)::text FROM spare_visible e WHERE e.kind='purchase' AND e.body->>'status' IN ('APPROVED','ORDERED','PART_RECEIVED') AND e.body->>'dueDate'<${today}) AS overdue,
     (SELECT count(*)::text FROM spare_visible e WHERE e.kind='link' AND ${due}<=${today}) AS replacement_due,
     (SELECT count(*)::text FROM spare_purchase_money WHERE payment::numeric>received::numeric) AS finance_review,
     (SELECT count(*)::text FROM spare_visible e WHERE e.kind='part' AND e.body->>'active'='true') AS parts,
     (SELECT count(*)::text FROM spare_visible e WHERE e.kind='supplier' AND e.body->>'active'='true') AS suppliers,
     (SELECT count(*)::text FROM spare_visible e WHERE e.kind='warehouse' AND e.body->>'active'='true') AS warehouses`);
    if(rows.length!==1)throw integrity();const r=rows[0];return {summary:{low:integer(r.low),pending:integer(r.pending),overdue:integer(r.overdue),replacementDue:integer(r.replacement_due),financeReview:integer(r.finance_review)},activeCounts:{part:integer(r.parts),supplier:integer(r.suppliers),warehouse:integer(r.warehouses)},notice:'汇总覆盖当前全部授权范围；数量按各备件档案单位展示，不将不同单位相加。'};
   }
 });
}
function label(e:Record<string,unknown>|null){if(!e)return null;const {id,code,name,siteCode,unit,position,deviceCode,active}=e;return {id,code,name,siteCode,unit,position,deviceCode,active};}
