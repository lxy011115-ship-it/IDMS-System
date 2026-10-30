import type {AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import {exactFact} from './spares-facts.ts';
import {remainingMaterialDemand} from './spares-material-plan.ts';
import {sparesCapabilities} from './spares.ts';
import {validateSpareRow} from './spares-workset.ts';
import type {SpareQueryPlan,SparePageAnchor} from './spares-query-plan.ts';
import {readReplacementInsight} from './spares-replacement-insight.ts';

export type InsightQuery=(text:string,values:unknown[])=>Promise<Record<string,any>[]>;
export type InsightPage=(rows:Record<string,any>[],map:(row:any)=>any)=>Record<string,any>;
export function insightParameters(){const values:unknown[]=[];return {values,param(v:unknown){values.push(v);return '$'+(values.length+6);}};}
export function insightAfter(anchor:SparePageAnchor|null,first:string,second:string,param:(v:unknown)=>string){return anchor?` AND (${first},${second})>(${param(anchor.first)}::text,${param(anchor.second)}::text)`:'';}
const broken=()=>new DomainError(503,'备件洞察计算依据暂无法核验');
const openStates="('OPEN','ASSIGNED','IN_PROGRESS','AWAITING_APPROVAL')";
// Scope is supplied by currentQuery on the caller's verified RR connection.
// Net issues use only the exact tuple of each visible plan. Installation is
// already part of an issue and is intentionally not subtracted again.
function materialFacts(filter:string){return `,insight_plan_scope AS MATERIALIZED (
 SELECT e.*,o.body->>'state' AS order_state,o.body->>'assignee' AS assignee,
 (o.body->>'deviceCode'=e.body->>'deviceCode' AND d.site_code=e.site_code) AS reference_valid,
 p.body AS part,w.body AS warehouse FROM spare_visible e
 JOIN spare_orders o ON o.id=e.body->>'workOrderId'
 JOIN spare_devices d ON d.device_code=e.body->>'deviceCode'
 JOIN spare_visible p ON p.kind='part' AND p.id::text=e.body->>'partId'
 JOIN spare_visible w ON w.kind='warehouse' AND w.id::text=e.body->>'warehouseId'
 WHERE e.kind='material-plan' ${filter}
 ),insight_plan_net AS (
 SELECT p.id,COALESCE(-sum((m.body->>'deltaMilli')::numeric),0) AS net
 FROM insight_plan_scope p LEFT JOIN idms_spares.entities m ON m.tenant_id=$1 AND m.kind='movement'
 AND m.body->>'workOrderId'=p.body->>'workOrderId' AND m.body->>'partId'=p.body->>'partId'
 AND m.body->>'warehouseId'=p.body->>'warehouseId' AND m.body->>'type' IN ('ISSUE','RETURN') GROUP BY p.id
 ),insight_plans AS (
 SELECT p.*,n.net,CASE WHEN p.reference_valid AND p.body->>'status'='ACTIVE' AND p.order_state IN ${openStates}
 THEN GREATEST(0,(p.body->>'quantityMilli')::numeric-n.net) ELSE 0 END AS remaining
 FROM insight_plan_scope p JOIN insight_plan_net n USING(id)
 ) `;}
function related(e:any){if(!e)return null;const {id,code,name,siteCode,unit,precision,active}=e;return {id,code,name,siteCode,unit,precision,active};}
function planItem(row:any,ctx:AccessContext){
 const entity=validateSpareRow(row,ctx.tenantId),netIssuedMilli=exactFact(row.net),caps=sparesCapabilities(ctx);
 const quantities=remainingMaterialDemand(entity as any,netIssuedMilli,row.order_state);
 const remainingMilli=row.reference_valid?quantities.remainingMilli:0;if(exactFact(row.remaining)!==remainingMilli)throw broken();
 const allowed=row.reference_valid&&(caps.manage||caps.move&&row.assignee===ctx.actorId),open=['OPEN','ASSIGNED','IN_PROGRESS','AWAITING_APPROVAL'].includes(row.order_state),catalogActive=row.part.active!==false&&row.warehouse.active!==false;
 const editable=allowed&&open&&catalogActive&&(caps.manage||row.order_state==='IN_PROGRESS');
 return {entity,related:{part:related(row.part),warehouse:related(row.warehouse)},orderState:row.order_state,referenceValid:row.reference_valid,
  quantities:{plannedMilli:entity.quantityMilli,netIssuedMilli,remainingMilli,overPlanMilli:quantities.overPlanMilli,reserved:false},
  operations:{edit:editable&&entity.status==='ACTIVE',close:allowed&&entity.status==='ACTIVE',reopen:editable&&['CLOSED','CANCELLED'].includes(entity.status)}};
}
export async function readSpareInsights(ctx:AccessContext,plan:SpareQueryPlan,query:InsightQuery,page:InsightPage,anchor:SparePageAnchor|null){
 if(plan.endpoint==='replacement-insight')return readReplacementInsight(ctx,plan,query,page,anchor);
 if(plan.endpoint==='material-plans'){
  const check=await query("SELECT o.id,o.body,EXISTS(SELECT 1 FROM spare_devices d WHERE d.device_code=o.body->>'deviceCode') AS device_available FROM spare_orders o WHERE o.id=$7 LIMIT 2",[plan.workOrderId]);if(check.length!==1)throw new DomainError(404,'工单不存在或不在当前范围');
  const args=insightParameters(),order=args.param(plan.workOrderId),after=insightAfter(anchor,"body->>'needDate'",'id::text',args.param),limit=args.param(plan.limit+1);
  const rows=await query(materialFacts(`AND e.body->>'workOrderId'=${order}`)+`SELECT *,net::text,remaining::text,body->>'needDate' AS key_first,id::text AS key_second FROM insight_plans WHERE true ${after} ORDER BY body->>'needDate',id::text LIMIT ${limit}`,args.values);
  const caps=sparesCapabilities(ctx),orderBody=check[0].body;
  return {...page(rows,r=>planItem(r,ctx)),workOrderId:plan.workOrderId,deviceAvailable:check[0].device_available,canCreate:check[0].device_available&&(caps.manage&&['OPEN','ASSIGNED','IN_PROGRESS','AWAITING_APPROVAL'].includes(orderBody.state)||caps.move&&orderBody.assignee===ctx.actorId&&orderBody.state==='IN_PROGRESS'),missingConditions:check[0].device_available?[]:['NO_APPROVED_DEVICE'],notice:'计划不预留库存；剩余量扣除该工单、备件、仓库的实际净领用，实际安装不重复扣减。'};
 }
 const pair=`,insight_pair AS (SELECT p.body AS part,w.body AS warehouse FROM spare_visible p JOIN spare_visible w ON w.kind='warehouse' AND w.site_code=p.site_code WHERE p.kind='part' AND p.id::text=$7 AND w.id::text=$8) `;
 const plans=materialFacts("AND e.body->>'partId'=$7 AND e.body->>'warehouseId'=$8");
 const purchases=`,insight_purchases AS (
 SELECT e.id,e.body->>'number' AS number,e.body->>'status' AS status,e.body->>'createdAt' AS created_at,
 e.body->>'dueDate' AS due_date,l->>'id' AS line_id,(l->>'quantityMilli')::numeric AS ordered,
 (l->>'receivedMilli')::numeric AS received,
 CASE WHEN e.body->>'status' IN ('ORDERED','PART_RECEIVED') THEN GREATEST(0,(l->>'quantityMilli')::numeric-(l->>'receivedMilli')::numeric) ELSE 0 END AS outstanding
 FROM spare_visible e CROSS JOIN LATERAL jsonb_array_elements(e.body->'lines') l
 WHERE e.kind='purchase' AND e.body->>'warehouseId'=$8 AND l->>'partId'=$7
 ) `;
 const rows=await query(pair+plans+purchases+`SELECT part,warehouse,
 (SELECT COALESCE(sum((body->>'deltaMilli')::numeric),0)::text FROM idms_spares.entities WHERE tenant_id=$1 AND kind='movement' AND body->>'partId'=$7 AND body->>'warehouseId'=$8) AS on_hand,
 (SELECT count(*)::text FROM insight_plans) AS plan_count,
 (SELECT count(*)::text FROM insight_plans WHERE reference_valid AND body->>'status'='ACTIVE' AND order_state IN ${openStates}) AS active_count,
 (SELECT count(*)::text FROM insight_plans WHERE NOT reference_valid) AS changed_count,
 (SELECT COALESCE(sum(remaining),0)::text FROM insight_plans) AS remaining,
 (SELECT COALESCE(sum(outstanding),0)::text FROM insight_purchases) AS outstanding,
 (SELECT COALESCE(sum(ordered),0)::text FROM insight_purchases WHERE status='APPROVED') AS approved
 FROM insight_pair`,[plan.partId,plan.warehouseId]);
 if(!rows.length)throw new DomainError(404,'备件或仓库不存在、不属同工厂或不在当前范围');if(rows.length!==1)throw broken();
 const r=rows[0],onHandMilli=exactFact(r.on_hand),safetyMilli=exactFact(String(r.part.safetyMilli)),remainingDemandMilli=exactFact(r.remaining),registeredOutstandingMilli=exactFact(r.outstanding),activePlanCount=exactFact(r.active_count),changedReferenceCount=exactFact(r.changed_count);
 const active=r.part.active!==false&&r.warehouse.active!==false;
 const suggested=BigInt(safetyMilli)+BigInt(remainingDemandMilli)-BigInt(onHandMilli)-BigInt(registeredOutstandingMilli);
 const suggestedMilli=active?exactFact((suggested>0n?suggested:0n).toString()):null;
 const args=insightParameters();args.param(plan.partId);args.param(plan.warehouseId);let basis:Record<string,any>;
 if(plan.basis==='plans'){
  const after=insightAfter(anchor,"body->>'needDate'",'id::text',args.param),limit=args.param(plan.limit+1);
  const items=await query(plans+`SELECT *,net::text,remaining::text,body->>'needDate' AS key_first,id::text AS key_second FROM insight_plans WHERE true ${after} ORDER BY body->>'needDate',id::text LIMIT ${limit}`,args.values);
  basis=page(items,row=>planItem(row,ctx));
 }else{
  const after=insightAfter(anchor,'created_at',"id::text||':'||line_id",args.param),limit=args.param(plan.limit+1);
  const items=await query(purchases+`SELECT *,ordered::text,received::text,outstanding::text,created_at AS key_first,id::text||':'||line_id AS key_second FROM insight_purchases WHERE true ${after} ORDER BY created_at,id::text||':'||line_id LIMIT ${limit}`,args.values);
  basis=page(items,row=>({purchaseId:row.id,lineId:row.line_id,number:row.number,status:row.status,needDate:row.due_date,orderedMilli:exactFact(row.ordered),netReceivedMilli:exactFact(row.received),outstandingMilli:exactFact(row.outstanding),arrivalDate:null}));
 }
 return {part:{...related(r.part),safetyMilli,referencePriceCents:r.part.referencePriceCents},warehouse:related(r.warehouse),
  calculation:{onHandMilli,safetyMilli,remainingDemandMilli,registeredOutstandingMilli,approvedNotOrderedMilli:exactFact(r.approved),visiblePlanCount:exactFact(r.plan_count),activePlanCount,changedReferenceCount,demandRegistered:activePlanCount>0,currentDemandGapMilli:Math.max(0,remainingDemandMilli-onHandMilli),suggestedMilli,reserved:false,demandScope:'CURRENT_VISIBLE_ORDERS',stockScope:'FULL_SHARED_LEDGER'},
  canRequest:active&&sparesCapabilities(ctx).request,basis:{kind:plan.basis,...basis},
  missingConditions:[...(!activePlanCount?['DEMAND_NOT_REGISTERED']:[]),...(!active?['INACTIVE_CATALOG']:[]),...(changedReferenceCount?['PLAN_REFERENCE_CHANGED']:[])],
  notice:'当前授权范围内的计划，未预留库存。未收量来自登记下单；到货日期未确认，采购需求日期不是供应商承诺。拟补充量须由本人核对后编制采购草稿。'};
}
