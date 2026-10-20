import type pg from 'pg';
import type {BatchBody,Row,DataType} from '../../server/imports.ts';
import {definitions} from '../../server/imports.ts';
import type {StoreView} from '../../server/read-model.ts';
import {entityTables} from '../../server/entity-schema.ts';
import {canonicalEqual,jsonWireClone} from '../../server/canonical-state.ts';
import {holdAllocation,holdValue,requestSignal,CapacityError} from '../../server/capacity.ts';
import {streamRows} from '../../server/pg-row-stream.ts';
import {coldRank,coldObject,coldImportIntegrity} from './cold-input-baseline-corrections.ts';
export const checkColdImport=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
export const coldCount=(v:unknown)=>{if(typeof v!=='string'||!/^(0|[1-9][0-9]*)$/.test(v)||!Number.isSafeInteger(Number(v)))throw coldImportIntegrity();return Number(v);};
export interface ColdBatchHeader {tenantId:string;batchId:string;dataType:DataType;sourceSystem:string;status:string;snapshotDigest:string;fileSha256:string}
const headerKeys=['tenantId','batchId','dataType','sourceSystem','status','snapshotDigest','fileSha256'] as const;
export const coldBusinessSql='/* IDMS_COLD_IMPORT_BUSINESS */ '+Object.entries(entityTables).map(([key,table])=>`SELECT '${key}'::text AS kind,tenant_id,id AS identity,ordinal::text AS ordinal,body FROM ${table}`).join(' UNION ALL ');
export const coldHeaderSql=`/* IDMS_COLD_IMPORT_HEADERS */ SELECT b.tenant_id,b.batch_id::text,b.ordinal::text,jsonb_build_object(${headerKeys.map(k=>`'${k}',body->'${k}'`).join(',')}) AS header FROM business_import_batches b ORDER BY b.ordinal`;
export interface ColdHeaderSet {list:ColdBatchHeader[];byId:Map<string,ColdBatchHeader>;ranks:Map<string,bigint>;release:()=>void}
export async function readColdHeaders(client:pg.PoolClient,tenant:string):Promise<ColdHeaderSet>{
 const list:ColdBatchHeader[]=[],byId=new Map<string,ColdBatchHeader>(),ranks=new Map<string,bigint>(),releases:(()=>void)[]=[];const release=()=>{for(const f of releases)f();releases.length=0;list.length=0;byId.clear();ranks.clear();};let previous=0n;
 try{await streamRows<any>(client,coldHeaderSql,row=>{checkColdImport();const h=row.header,rank=coldRank(row.ordinal);if(row.tenant_id!==tenant||!coldObject(h)||Object.keys(h).length!==headerKeys.length||h.tenantId!==tenant||row.batch_id!==h.batchId||typeof h.batchId!=='string'||byId.has(h.batchId)||rank<=previous||!Object.hasOwn(definitions,h.dataType)||typeof h.sourceSystem!=='string'||typeof h.status!=='string'||!/^[a-f0-9]{64}$/.test(h.snapshotDigest)||!/^[a-f0-9]{64}$/.test(h.fileSha256))throw coldImportIntegrity();previous=rank;const releaseValue=holdValue(h);let releaseIndex=()=>{};try{releaseIndex=holdAllocation(256);releases.push(()=>{releaseValue();releaseIndex();});list.push(h as ColdBatchHeader);byId.set(h.batchId,h as ColdBatchHeader);ranks.set(h.batchId,rank);}catch(e){releaseValue();releaseIndex();throw e;}},release);return {list,byId,ranks,release};}catch(e){release();throw e;}
}
export async function readColdBusiness(client:pg.PoolClient,tenant:string){
 const groups=new Map<string,{rank:bigint;body:any}[]>(),releases:(()=>void)[]=[];let releaseStore=()=>{};const discard=()=>{groups.clear();for(const f of releases)f();releases.length=0;};
 try{await streamRows<any>(client,coldBusinessSql,row=>{checkColdImport();if(row.tenant_id!==tenant||!Object.hasOwn(entityTables,row.kind)||!coldObject(row.body)||row.body.id!==row.identity||(row.kind==='tenants'?row.identity!==tenant:row.body.tenantId!==tenant))throw coldImportIntegrity();const rank=coldRank(row.ordinal),release=holdValue(row);let slot=()=>{};try{slot=holdAllocation(128);const rows=groups.get(row.kind)||[];rows.push({rank,body:row.body});groups.set(row.kind,rows);releases.push(()=>{release();slot();});}catch(e){release();slot();throw e;}},discard);
 const store=Object.fromEntries(Object.keys(entityTables).map(kind=>{const rows=groups.get(kind)||[];rows.sort((a,b)=>a.rank<b.rank?-1:a.rank>b.rank?1:0);const ids=new Set<string>();for(let i=0;i<rows.length;i++){if(i&&rows[i].rank<=rows[i-1].rank||ids.has(rows[i].body.id))throw coldImportIntegrity();ids.add(rows[i].body.id);}return [kind,rows.map(r=>r.body)];})) as StoreView;if(store.tenants.length!==1)throw coldImportIntegrity();releaseStore=holdValue(store);
 const expected=new Map(store.workOrders.map(o=>[o.id,o])),seen=new Set<string>(),releaseMirror=holdAllocation(65536+store.workOrders.length*128);let rowLease=()=>{};
 try{await streamRows<any>(client,'/* IDMS_COLD_IMPORT_MIRRORS */ SELECT tenant_id,id::text,body FROM work_orders',row=>{rowLease();rowLease=()=>{};checkColdImport();rowLease=holdValue(row);if(row.tenant_id!==tenant||seen.has(row.id)||!coldObject(row.body)||row.body.id!==row.id||!canonicalEqual(expected.get(row.id),row.body))throw coldImportIntegrity();seen.add(row.id);},()=>{});if(seen.size!==expected.size)throw coldImportIntegrity();}finally{rowLease();releaseMirror();}
 discard();return {store,release:releaseStore};
 }catch(e){discard();releaseStore();throw e;}
}
export async function readColdBatch(client:pg.PoolClient,header:ColdBatchHeader){
 const result=(await client.query('/* IDMS_COLD_IMPORT_BATCH */ SELECT tenant_id,batch_id::text,body FROM business_import_batches WHERE tenant_id=$1 AND batch_id=$2::uuid',[header.tenantId,header.batchId])).rows;
 if(result.length!==1||result[0].tenant_id!==header.tenantId||result[0].batch_id!==header.batchId||!coldObject(result[0].body)||['rows','validRows','originalBase64'].some(k=>Object.hasOwn(result[0].body,k))||!canonicalEqual(Object.fromEntries(headerKeys.map(k=>[k,result[0].body[k]])),header))throw coldImportIntegrity();
 const meta=result[0].body,releaseMeta=holdValue(meta),rows:Row[]=[],valid=new Map<number,Row>(),leases:(()=>void)[]=[];let releaseBatch=()=>{},last=0n;
 const discard=()=>{for(const f of leases)f();leases.length=0;rows.length=0;valid.clear();releaseMeta();};
 try{await streamRows<any>(client,'/* IDMS_COLD_IMPORT_INPUTS */ SELECT r.tenant_id,r.batch_id::text,r.ordinal::text,r.valid_ordinal,r.body FROM business_import_input_rows r WHERE r.tenant_id=$1 AND r.batch_id=$2::uuid ORDER BY r.ordinal',row=>{checkColdImport();const rank=coldRank(row.ordinal);if(row.tenant_id!==header.tenantId||row.batch_id!==header.batchId||rank<=last||!coldObject(row.body)||row.valid_ordinal!==null&&(!Number.isSafeInteger(row.valid_ordinal)||row.valid_ordinal<1||valid.has(row.valid_ordinal)))throw coldImportIntegrity();last=rank;const release=holdValue(row);let slot=()=>{};try{slot=holdAllocation(128);leases.push(()=>{release();slot();});rows.push(row.body as Row);if(row.valid_ordinal!==null)valid.set(row.valid_ordinal,row.body as Row);}catch(e){release();slot();throw e;}},()=>{},[header.tenantId,header.batchId]);
 const selected=[...valid].sort((a,b)=>a[0]-b[0]);if(selected.some(([rank],i)=>rank!==i+1)||!Array.isArray(meta.lineNumbers)||meta.lineNumbers.length!==rows.length||meta.lineNumbers.some((n:unknown)=>!Number.isSafeInteger(n)||(n as number)<2))throw coldImportIntegrity();
 const batch={...meta,rows:[...rows],validRows:selected.map(([,row])=>jsonWireClone(row))} as BatchBody;releaseBatch=holdValue(batch);discard();return {batch,release:releaseBatch};
 }catch(e){discard();releaseBatch();throw e;}
}
