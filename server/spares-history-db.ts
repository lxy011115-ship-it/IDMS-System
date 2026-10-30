import type pg from 'pg';
import {requireAccess,type AccessContext} from './access.ts';
import type {SpareReferences} from './spares.ts';
import {sparesHistoryPlan,SparesHistoryCollector,sparesActionLabels,historyIntegrity,selectHistoryItem,type SparesHistoryItem} from './spares-history.ts';
import {currentHistoryPlan,historyPageCursor,historyPageAnchor,type CurrentHistoryPlan} from './spares-history-cursor.ts';
import {spareTransaction} from './spares-transaction.ts';
import {spareQueryScope} from './spares-query-scope.ts';
import {currentSql} from './revision-projection.ts';
import {streamRows} from './pg-row-stream.ts';
import {holdValue} from './capacity.ts';
import {checkSparesRead,verifySpareAudit} from './spares-audit.ts';
export async function readSparesHistory(pool:pg.Pool,ctx:AccessContext,refs:SpareReferences,params:URLSearchParams){
 requireAccess(ctx,'spares:history');const plan=sparesHistoryPlan(params);return spareTransaction(pool,ctx,{},c=>historyPage(c,ctx,refs,plan));
}
export async function readSparesHistoryCurrent(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,verify:(c:pg.PoolClient)=>Promise<void>){
 requireAccess(ctx,'spares:history');const plan=currentHistoryPlan(params);return spareTransaction(pool,ctx,{verify},c=>currentHistoryPage(c,ctx,plan));
}
async function currentHistoryPage(c:pg.PoolClient,ctx:AccessContext,plan:CurrentHistoryPlan){
 if(!(await c.query("SELECT to_regclass('idms_spares.state') AS relation")).rows[0]?.relation)return {available:false,notice:'备件业务历史待初始化'};
 const heads=(await c.query('SELECT p.revision::text AS public_revision,s.revision::text AS revision FROM public.business_state p JOIN idms_spares.state s ON s.tenant_id=p.tenant_id WHERE p.tenant_id=$1',[ctx.tenantId])).rows;
 if(heads.length!==1||!/^\d+$/.test(heads[0].revision)||!/^\d+$/.test(heads[0].public_revision))throw historyIntegrity();
 const stamp={revision:heads[0].revision,publicRevision:heads[0].public_revision},before=historyPageAnchor(ctx,plan,stamp);
 // Full-tenant integrity comes before visibility and page selection, including hidden events.
 await verifySpareAudit(c,ctx.tenantId,stamp.revision);
 const scope=spareQueryScope(ctx),values=[...scope.values],param=(v:unknown)=>{values.push(v);return '$'+values.length;};
 let where='h.tenant_id=$1 AND ($2::text[] IS NULL OR h.site_code=ANY($2))';
 if(before!==null)where+=` AND h.sequence<${param(before.toString())}::bigint`;
 if(plan.action)where+=` AND h.body->>'action'=${param(plan.action)}`;
 // Date filtering stays in the shared selector: the public summary defines search semantics.
 const query=currentSql(scope.cte+`/* IDMS_SPARES_CURRENT_HISTORY_PAGE */ SELECT h.sequence::text,h.site_code,h.body,
  NOT EXISTS(SELECT 1 FROM jsonb_array_elements((h.body->'after')||(h.body->'before')) r(value)
   WHERE r.value<>'null'::jsonb AND (
    (COALESCE(r.value->>'deviceCode','')<>'' AND (jsonb_typeof(r.value->'deviceCode')<>'string' OR NOT EXISTS(SELECT 1 FROM spare_devices a WHERE a.device_code=r.value->>'deviceCode')))
    OR (COALESCE(r.value->>'workOrderId','')<>'' AND (jsonb_typeof(r.value->'workOrderId')<>'string' OR NOT EXISTS(SELECT 1 FROM spare_orders o WHERE o.id=r.value->>'workOrderId'))))) AS current_visible
  FROM idms_spares.events h WHERE ${where} ORDER BY h.sequence DESC`);
 const selected:{item:SparesHistoryItem;release:()=>void}[]=[];let open=false;
 try{
  await c.query('DECLARE idms_spares_history_page NO SCROLL CURSOR FOR '+query,values);open=true;
  while(selected.length<=plan.limit){
   checkSparesRead();const rows=(await c.query('FETCH FORWARD 32 FROM idms_spares_history_page')).rows;if(rows.length>32)throw historyIntegrity();if(!rows.length)break;const release=holdValue(rows);
   try{for(const row of rows){checkSparesRead();if(typeof row.current_visible!=='boolean')throw historyIntegrity();const item=selectHistoryItem(row,ctx,{devices:[],orders:[]},{...plan,before},row.current_visible);if(item)selected.push({item,release:holdValue(item)});if(selected.length>plan.limit)break;}}finally{release();}
  }
  await c.query('CLOSE idms_spares_history_page');open=false;checkSparesRead();const items=selected.slice(0,plan.limit).map(r=>r.item),hasMore=selected.length>plan.limit;
  return {available:true,...stamp,items,hasMore,nextBefore:hasMore?historyPageCursor(ctx,plan,stamp,items.at(-1)!.sequence):null,limit:plan.limit,filters:{q:plan.q,action:plan.action,entityId:plan.entityId,from:plan.from,to:plan.to},actionLabels:sparesActionLabels,notice:'查询完整业务历史并核对当前授权范围；仅展示必要摘要。金额为人民币登记值。'};
 }finally{for(const entry of selected)entry.release();if(open)await c.query('CLOSE idms_spares_history_page').catch(()=>{});}
}
async function historyPage(c:pg.PoolClient,ctx:AccessContext,refs:SpareReferences,plan:ReturnType<typeof sparesHistoryPlan>){
 let collector:SparesHistoryCollector|undefined;
 try{
  if(!(await c.query("SELECT to_regclass('idms_spares.state') AS relation")).rows[0]?.relation)return {available:false,notice:'备件业务历史待初始化'};
  const head=(await c.query('SELECT revision::text FROM idms_spares.state WHERE tenant_id=$1',[ctx.tenantId])).rows[0];if(!head)throw historyIntegrity();
  collector=new SparesHistoryCollector(ctx,refs,plan);
  const plain='/* IDMS_SPARES_HISTORY_STREAM */ SELECT sequence::text,site_code,body,hash FROM idms_spares.events WHERE tenant_id=$1 ORDER BY idms_spares.events.sequence';
  await streamRows<any>(c,plain,row=>{checkSparesRead();const release=holdValue(row);try{collector!.accept(row);}finally{release();}},()=>collector?.discard(),[ctx.tenantId]);
  const result=collector.finish(head.revision);
  return {available:true,...result,limit:plan.limit,filters:{q:plan.q,action:plan.action,entityId:plan.entityId,from:plan.from,to:plan.to},actionLabels:sparesActionLabels,notice:'按当前授权范围查询；逐条核对完整审计链。仅展示必要业务摘要，金额为人民币登记值。'};
 }finally{collector?.discard();}
}
