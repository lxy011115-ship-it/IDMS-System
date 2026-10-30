import type pg from 'pg';
import {DomainError} from './service.ts';
import {sparesActionLabels} from './spares-history.ts';
import {authorizeSpare,type SparesState,type SpareEntity,type SpareReferences} from './spares.ts';
import type {AccessContext} from './access.ts';
import {factKey,exactFact,type SparesFacts} from './spares-facts.ts';
import {checkSparesRead} from './spares-audit.ts';

const bad=()=>new DomainError(503,'备件命令资料边界暂无法核验');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const kinds=new Set(['warehouse','supplier','part','purchase','receipt','movement','link','replacement','adjustment','document']);
export function validateSpareRow(row:any,tenant:string):SpareEntity{
 const e=row?.body;if(!e||row.tenant_id!==tenant||e.tenantId!==tenant||e.id!==row.id||e.kind!==row.kind||e.siteCode!==row.site_code||typeof e.id!=='string'||!uuid.test(e.id)||!kinds.has(e.kind)||typeof e.siteCode!=='string'||!Number.isSafeInteger(e.version)||e.version<1)throw bad();return e;
}
const idsOf=(e:Record<string,any>)=>[e.id,e.partId,e.warehouseId,e.targetWarehouseId,e.supplierId,e.purchaseId,e.receiptId,e.issueId,e.linkId,e.adjustmentId,...(Array.isArray(e.lines)?e.lines.map((l:any)=>l?.partId):[])].filter(v=>v!==undefined&&v!==null&&v!=='');
export type SpareReferenceResolver=(entities:SpareEntity[])=>Promise<SpareReferences>;
export async function prepareSpareCommand(client:pg.PoolClient,ctx:AccessContext,source:SpareReferences|SpareReferenceResolver,action:string,input:Record<string,any>){
 checkSparesRead();if(!Object.hasOwn(sparesActionLabels,action))throw new DomainError(404,'备件采购操作不存在');
 let refs=typeof source==='function'?await source([]):source;
 authorizeSpare({entities:[]},action,{siteCode:input.siteCode,deviceCode:input.deviceCode,workOrderId:input.workOrderId},ctx,refs);
 if(Array.isArray(input.lines)&&input.lines.length>50)throw new DomainError(400,'采购明细须为1至50项');
 const ready=(await client.query("SELECT to_regclass('idms_spares.migrations') AS relation")).rows[0]?.relation;
 if(!ready||(await client.query("SELECT version FROM idms_spares.migrations WHERE name='capacity'")).rows[0]?.version!==1)throw new DomainError(503,'请先完成备件容量索引迁移');
 const pending=new Set<string>(),seen=new Set<string>(),entities:SpareEntity[]=[];
 const enqueue=(value:unknown,stored=false)=>{if(typeof value!=='string'||!uuid.test(value))throw stored?bad():new DomainError(400,'备件关联标识无效');const id=value.toLowerCase();if(!seen.has(id))pending.add(id);};
 for(const id of idsOf(input))enqueue(id);
 while(pending.size){
  checkSparesRead();const ids=[...pending];pending.clear();for(const id of ids)seen.add(id);if(seen.size>256)throw bad();
  const rows=(await client.query('/* IDMS_SPARES_COMMAND_ENTITIES */ SELECT tenant_id,id::text,kind,site_code,body FROM idms_spares.entities WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id,kind',[ctx.tenantId,ids])).rows;
  const returned=new Set<string>();for(const row of rows){const e=validateSpareRow(row,ctx.tenantId);if(returned.has(e.id)||!ids.includes(e.id))throw bad();returned.add(e.id);entities.push(e);for(const id of idsOf(e))enqueue(id,true);}
 }
 const facts:SparesFacts={persistedIds:new Set(entities.map(e=>e.id)),stocks:new Map(),supplierReturns:new Map(),issueReturns:new Map(),issueInstalled:new Map(),documents:new Map(),codeConflict:false,documentConflict:false,linkConflict:false};
 const state={entities,facts};if(typeof source==='function')refs=await source(entities);authorizeSpare(state,action,input,ctx,refs);
 if(['part.create','supplier.create','warehouse.create'].includes(action)&&typeof input.code==='string')facts.codeConflict=(await client.query("/* IDMS_SPARES_CODE_CONFLICT */ SELECT EXISTS(SELECT 1 FROM idms_spares.entities WHERE tenant_id=$1 AND kind=$2 AND lower(body->>'code')=lower($3)) AS conflict",[ctx.tenantId,action.split('.')[0],input.code.trim()])).rows[0].conflict;
 if(action==='document.create'&&typeof input.type==='string'&&typeof input.number==='string')facts.documentConflict=(await client.query("/* IDMS_SPARES_DOCUMENT_CONFLICT */ SELECT EXISTS(SELECT 1 FROM idms_spares.entities WHERE kind='document' AND tenant_id=$1 AND body->>'type'=$2 AND body->>'number'=$3) AS conflict",[ctx.tenantId,input.type,input.number.trim()])).rows[0].conflict;
 if(action==='link.create'&&typeof input.position==='string')facts.linkConflict=(await client.query("/* IDMS_SPARES_LINK_CONFLICT */ SELECT EXISTS(SELECT 1 FROM idms_spares.entities WHERE kind='link' AND tenant_id=$1 AND body->>'partId'=$2 AND body->>'deviceCode'=$3 AND body->>'position'=$4) AS conflict",[ctx.tenantId,input.partId,input.deviceCode,input.position.trim()])).rows[0].conflict;
 const affectsStock=['purchase.receive','stock.issue','stock.return','stock.supplier-return','stock.transfer','adjustment.create','adjustment.approve'].includes(action);
 if(affectsStock){
  const pairs=entities.filter(e=>e.kind==='part').flatMap(p=>entities.filter(w=>w.kind==='warehouse'&&w.siteCode===p.siteCode).map(w=>({part:p.id,warehouse:w.id})));if(pairs.length>256)throw bad();
  if(pairs.length){const rows=(await client.query(`/* IDMS_SPARES_COMMAND_STOCK */ WITH wanted AS (SELECT * FROM unnest($2::text[],$3::text[]) AS p(part,warehouse)) SELECT p.part,p.warehouse,COALESCE(sum((m.body->>'deltaMilli')::numeric),0)::text AS quantity,count(m.id)::text AS revision FROM wanted p LEFT JOIN idms_spares.entities m ON m.kind='movement' AND m.tenant_id=$1 AND m.body->>'partId'=p.part AND m.body->>'warehouseId'=p.warehouse GROUP BY p.part,p.warehouse`,[ctx.tenantId,pairs.map(p=>p.part),pairs.map(p=>p.warehouse)])).rows;
   if(rows.length!==pairs.length)throw bad();for(const row of rows){if(!pairs.some(p=>p.part===row.part&&p.warehouse===row.warehouse))throw bad();facts.stocks.set(factKey(row.part,row.warehouse),{quantityMilli:exactFact(row.quantity),revision:exactFact(row.revision)});}
  }
 }
 const receipts=entities.filter(e=>e.kind==='receipt').map(e=>e.id);for(const id of receipts)facts.supplierReturns.set(id,0);
 if(receipts.length){const rows=(await client.query("/* IDMS_SPARES_RECEIPT_RETURN_TOTAL */ SELECT body->>'receiptId' AS id,(-sum((body->>'deltaMilli')::numeric))::text AS total FROM idms_spares.entities WHERE kind='movement' AND tenant_id=$1 AND body->>'receiptId'=ANY($2::text[]) AND body->>'type'='SUPPLIER_RETURN' GROUP BY body->>'receiptId'",[ctx.tenantId,receipts])).rows;for(const row of rows){if(!facts.supplierReturns.has(row.id))throw bad();facts.supplierReturns.set(row.id,exactFact(row.total));}}
 const issues=entities.filter(e=>e.kind==='movement'&&e.type==='ISSUE').map(e=>e.id);for(const id of issues){facts.issueReturns.set(id,0);facts.issueInstalled.set(id,0);}
 if(issues.length){
  const returns=(await client.query("/* IDMS_SPARES_ISSUE_RETURN_TOTAL */ SELECT body->>'issueId' AS id,sum((body->>'deltaMilli')::numeric)::text AS total FROM idms_spares.entities WHERE kind='movement' AND tenant_id=$1 AND body->>'issueId'=ANY($2::text[]) AND body->>'type'='RETURN' GROUP BY body->>'issueId'",[ctx.tenantId,issues])).rows;
  const installs=(await client.query("/* IDMS_SPARES_ISSUE_INSTALL_TOTAL */ SELECT body->>'issueId' AS id,sum((body->>'quantityMilli')::numeric)::text AS total FROM idms_spares.entities WHERE kind='replacement' AND tenant_id=$1 AND body->>'issueId'=ANY($2::text[]) GROUP BY body->>'issueId'",[ctx.tenantId,issues])).rows;
  for(const [map,rows] of [[facts.issueReturns,returns],[facts.issueInstalled,installs]] as const)for(const row of rows){if(!map.has(row.id))throw bad();map.set(row.id,exactFact(row.total));}
 }
 const purchases=entities.filter(e=>e.kind==='purchase').map(e=>e.id);for(const id of purchases)for(const type of ['INVOICE','PAYMENT'])facts.documents.set(factKey(id,type),0);
 if(purchases.length){const rows=(await client.query("/* IDMS_SPARES_PURCHASE_DOCUMENT_TOTAL */ SELECT body->>'purchaseId' AS id,body->>'type' AS type,sum((body->>'amountCents')::numeric)::text AS total FROM idms_spares.entities WHERE kind='document' AND tenant_id=$1 AND body->>'purchaseId'=ANY($2::text[]) GROUP BY body->>'purchaseId',body->>'type'",[ctx.tenantId,purchases])).rows;for(const row of rows){const key=factKey(row.id,row.type);if(!facts.documents.has(key))throw bad();facts.documents.set(key,exactFact(row.total));}}
 checkSparesRead();return {state,refs};
}
export async function loadSpareWorkset(client:pg.PoolClient,ctx:AccessContext,refs:SpareReferences,action:string,input:Record<string,any>):Promise<SparesState>{return (await prepareSpareCommand(client,ctx,refs,action,input)).state;}
