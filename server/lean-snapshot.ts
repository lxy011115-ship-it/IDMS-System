import type pg from 'pg';
import type {BatchBody,Row as ImportRow} from './imports.ts';
import type {ReadWorkspaceData,StoreView} from './read-model.ts';
import {leanSnapshotRowsSql} from './entity-reader.ts';
import {entityTables} from './entity-schema.ts';
import {canonicalEqual,jsonWireClone} from './canonical-state.ts';
import {holdValue,holdAllocation,accountValue,requestSignal,CapacityError} from './capacity.ts';
import {freezeValue} from './tenant-workspace.ts';
import {streamRows} from './pg-row-stream.ts';
interface Row {kind:string;tenant_id:string;identity:string;ordinal:string;detail:any;content?:null}
interface HeldRow extends Row {rank:bigint}
export interface LeanSnapshot {data:ReadWorkspaceData;revision:number;payloadDigest:string;batchRanks:ReadonlyMap<string,bigint>}
const invalid=()=>Error('Invalid lean snapshot source or identity');
const object=(v:unknown)=>!!v&&typeof v==='object'&&!Array.isArray(v);
// Retains only business/metadata/input/facts. File, audit and receipt evidence
// belongs to the separate complete canonical replay, never an empty payload.
export class LeanRows {
 private tenant:string;private groups=new Map<string,HeldRow[]>();private releases:(()=>void)[]=[];private closed=false;
 constructor(tenant:string){this.tenant=tenant;}
 add(row:Row){
  if(this.closed||!row||row.tenant_id!==this.tenant||typeof row.identity!=='string'||typeof row.ordinal!=='string'||!/^\d+$/.test(row.ordinal)||row.content!==null)throw invalid();
  const rank=BigInt(row.ordinal);if(rank>9223372036854775807n||rank<0n||row.kind!=='mirror'&&rank===0n)throw invalid();
  if(!['state','batch','input','record','mirror',...Object.keys(entityTables).map(k=>'business:'+k)].includes(row.kind))throw invalid();
  const release=holdValue(row);let releaseIndex=()=>{};try{releaseIndex=holdAllocation(256);const rows=this.groups.get(row.kind)||[];rows.push({...row,rank});this.groups.set(row.kind,rows);this.releases.push(()=>{release();releaseIndex();});}catch(error){release();releaseIndex();throw error;}
 }
 finish():LeanSnapshot{
  if(this.closed)throw invalid();
  const take=(kind:string,unique=true)=>{const rows=this.groups.get(kind)||[];this.groups.delete(kind);rows.sort((a,b)=>a.rank<b.rank?-1:a.rank>b.rank?1:0);if(unique&&rows.some((r,i)=>i>0&&r.rank<=rows[i-1].rank))throw invalid();return rows;};
  const states=take('state'),state=states[0];if(states.length!==1||state.identity!==this.tenant||!object(state.detail)||Object.keys(state.detail).length!==2||state.detail.schemaVersion!==3||!Number.isSafeInteger(Number(state.rank))||!/^[a-f0-9]{64}$/.test(state.detail.payloadDigest))throw invalid();
  const store=Object.fromEntries(Object.keys(entityTables).map(key=>{
   const ids=new Set<string>();return [key,take('business:'+key).map(row=>{if(!object(row.detail)||row.detail.id!==row.identity||ids.has(row.identity)||(key==='tenants'?row.identity!==this.tenant:row.detail.tenantId!==this.tenant))throw invalid();ids.add(row.identity);return row.detail;})];
  })) as StoreView;
  if(store.tenants.length!==1)throw invalid();
  const input=new Map<string,HeldRow[]>();for(const row of take('input',false)){if(!object(row.detail)||Object.keys(row.detail).length!==2||!Object.hasOwn(row.detail,'body')||!Object.hasOwn(row.detail,'validOrdinal')||!object(row.detail.body)||row.detail.validOrdinal!==null&&(!Number.isSafeInteger(row.detail.validOrdinal)||row.detail.validOrdinal<1))throw invalid();const rows=input.get(row.identity)||[];rows.push(row);input.set(row.identity,rows);}
  const batchRanks=new Map<string,bigint>();const batches:BatchBody[]=take('batch').map(row=>{
   if(!object(row.detail)||row.detail.batchId!==row.identity||row.detail.tenantId!==this.tenant||batchRanks.has(row.identity)||['originalBase64','rows','validRows'].some(k=>Object.hasOwn(row.detail,k)))throw invalid();batchRanks.set(row.identity,row.rank);
   const inputs=input.get(row.identity)||[];input.delete(row.identity);inputs.sort((a,b)=>a.rank<b.rank?-1:a.rank>b.rank?1:0);if(inputs.some((r,i)=>i>0&&r.rank<=inputs[i-1].rank))throw invalid();
   const valid=inputs.filter(r=>r.detail.validOrdinal!==null).sort((a,b)=>a.detail.validOrdinal-b.detail.validOrdinal);if(valid.some((r,i)=>r.detail.validOrdinal!==i+1))throw invalid();
   return {...row.detail,rows:inputs.map(r=>r.detail.body as ImportRow),validRows:valid.map(r=>jsonWireClone(r.detail.body as ImportRow))};
  });if(input.size)throw invalid();
  const records=take('record').map(row=>{if(!object(row.detail)||row.detail.batchId!==row.identity||row.detail.tenantId!==this.tenant||!batchRanks.has(row.identity))throw invalid();return row.detail;});
  const mirrors=take('mirror',false).map(r=>{if(!object(r.detail)||r.detail.id!==r.identity)throw invalid();return r.detail;}).sort((a,b)=>a.id.localeCompare(b.id));if(!canonicalEqual(mirrors,[...store.workOrders].sort((a,b)=>a.id.localeCompare(b.id))))throw invalid();
  if(this.groups.size)throw invalid();const data={store,imports:{batches,records}};accountValue(data);freezeValue(data);return {data,revision:Number(state.rank),payloadDigest:state.detail.payloadDigest,batchRanks};
 }
 dispose(){if(this.closed)return;this.closed=true;this.groups.clear();for(const release of this.releases)release();this.releases.length=0;}
}
export async function readLeanSnapshot(client:pg.PoolClient,tenant:string):Promise<LeanSnapshot>{
 const state=new LeanRows(tenant);try{await streamRows<Row>(client,leanSnapshotRowsSql,row=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');state.add(row);},()=>state.dispose());return state.finish();}finally{state.dispose();}
}
