import {canonical} from './imports.ts';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {outboxKinds,type OutboxKind} from './outbox-schema.ts';

export const workerLeaseMs=30000,workerHeartbeatMs=10000;
export const workerInstanceId=randomUUID();
export interface OutboxClaim {kind:OutboxKind;tenantId:string;id:string;owner:string;token:string;fence:string;row:Record<string,any>}
const spec=(kind:OutboxKind)=>{if(!Object.hasOwn(outboxKinds,kind))throw Error('Unknown outbox kind');return outboxKinds[kind];};
export function ownsClaim(row:Record<string,any>|undefined,claim:OutboxClaim){
 return !!row&&row[spec(claim.kind).key]===claim.id&&row.status==='PENDING'&&row.worker_id===claim.owner&&row.claim_token===claim.token&&typeof row.claim_fence==='string'&&row.claim_fence===claim.fence&&row.lease_live===true;
}
export async function claimOutbox(pool:pg.Pool,kind:OutboxKind,tenantId:string,owner=workerInstanceId,excludeIds:string[]=[]):Promise<OutboxClaim|undefined>{
 const {table,key}=spec(kind),token=randomUUID();
 const row=(await pool.query(`WITH due AS (
  SELECT ${key} FROM ${table} WHERE status='PENDING' AND context->>'tenantId'=$4 AND next_attempt<=clock_timestamp()
  AND ${key}<>ALL($5::uuid[]) AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY created_at,${key} FOR UPDATE SKIP LOCKED LIMIT 1
 ) UPDATE ${table} q SET worker_id=$1,claim_token=$2,claim_fence=q.claim_fence+1,
 lease_until=clock_timestamp()+($3*interval '1 millisecond'),claimed_at=clock_timestamp()
 FROM due WHERE q.${key}=due.${key} RETURNING q.*`,[owner,token,workerLeaseMs,tenantId,excludeIds])).rows[0];
 if(!row)return;return {kind,tenantId,id:row[key],owner,token,fence:row.claim_fence,row};
}
export class OutboxLease {
 readonly claim:OutboxClaim;readonly pool:pg.Pool;private controller=new AbortController();private timer?:ReturnType<typeof setInterval>;private renewing?:Promise<void>;private stopped=false;
 constructor(pool:pg.Pool,claim:OutboxClaim){this.pool=pool;this.claim=claim;}
 get signal(){return this.controller.signal;}
 get lost(){return this.controller.signal.aborted;}
 cancel(){if(!this.lost)this.controller.abort();if(this.timer)clearInterval(this.timer);}
 start(){this.timer=setInterval(()=>{if(!this.renewing&&!this.stopped)this.renewing=this.renew().finally(()=>{this.renewing=undefined;});},workerHeartbeatMs);}
 async renew(){
  if(this.lost||this.stopped)return;const c=this.claim,{table,key}=spec(c.kind);
  try{const r=await this.pool.query(`UPDATE ${table} SET lease_until=clock_timestamp()+($5*interval '1 millisecond') WHERE ${key}=$1 AND worker_id=$2 AND claim_token=$3 AND claim_fence=$4 AND status='PENDING' AND lease_until>clock_timestamp() RETURNING ${key}`,[c.id,c.owner,c.token,c.fence,workerLeaseMs]);if(r.rowCount!==1)this.cancel();}catch{this.cancel();}
 }
 // Called only inside the tenant business transaction. The locked outbox row
 // fences all proposed domain/audit/retry changes until that transaction commits.
 async fenced<T>(client:pg.PoolClient,task:(current:Record<string,any>)=>Promise<T>):Promise<{accepted:boolean;value?:T}>{
  if(this.lost||this.stopped)return {accepted:false};const c=this.claim,{table,key}=spec(c.kind),row=(await client.query(`SELECT *,lease_until>clock_timestamp() AS lease_live FROM ${table} WHERE ${key}=$1 FOR UPDATE`,[c.id])).rows[0];
  const frozen=c.kind==='ai'?['request_id','batch_id','request_digest','envelope','expected_version','context']:['command_id','entity_id','request_digest','envelope','proposed','before_digest','context'];
  if(this.lost||!ownsClaim(row,c)||frozen.some(key=>canonical(row[key])!==canonical(c.row[key]))){this.cancel();return {accepted:false};}
  const value=await task(row);
  const release=await client.query(`UPDATE ${table} SET worker_id=NULL,claim_token=NULL,lease_until=NULL WHERE ${key}=$1 AND worker_id=$2 AND claim_token=$3 AND claim_fence=$4`,[c.id,c.owner,c.token,c.fence]);
  if(release.rowCount!==1)throw Error('Outbox claim changed while locked');return {accepted:true,value};
 }
 async release(){
  this.stopped=true;if(this.timer)clearInterval(this.timer);await this.renewing;
  const c=this.claim,{table,key}=spec(c.kind);
  try{await this.pool.query(`UPDATE ${table} SET worker_id=NULL,claim_token=NULL,lease_until=NULL,next_attempt=GREATEST(next_attempt,clock_timestamp()+interval '1 second') WHERE ${key}=$1 AND worker_id=$2 AND claim_token=$3 AND claim_fence=$4 AND status='PENDING'`,[c.id,c.owner,c.token,c.fence]);}catch{/* Expiry provides recovery; never claim a failed release succeeded. */}
 }
}

// Scheduling is bounded per process; external requests never hold a DB client.
export class OutboxDispatcher {
 readonly kind:OutboxKind;readonly tenants:string[];readonly pool:(tenantId:string)=>pg.Pool;readonly handle:(lease:OutboxLease)=>Promise<void>;readonly onError:(tenantId:string)=>void;
 private cursor=0;private active=new Map<string,{lease:OutboxLease;task:Promise<void>}>();private pumping?:Promise<void>;private closing=false;
 constructor(kind:OutboxKind,tenants:string[],pool:(tenantId:string)=>pg.Pool,handle:(lease:OutboxLease)=>Promise<void>,onError:(tenantId:string)=>void){this.kind=kind;this.tenants=[...tenants];this.pool=pool;this.handle=handle;this.onError=onError;}
 get busy(){return !!this.pumping||this.active.size>0;}
 async pump(){if(this.closing||this.pumping)return;this.pumping=this.poll();try{await this.pumping;}finally{this.pumping=undefined;}}
 private async poll(){
  for(let inspected=0;!this.closing&&this.active.size<2&&inspected<this.tenants.length*2;inspected++){
   const tenantId=this.tenants[this.cursor++%this.tenants.length];let claim:OutboxClaim|undefined;
   try{claim=await claimOutbox(this.pool(tenantId),this.kind,tenantId,workerInstanceId,[...this.active.values()].filter(a=>a.lease.claim.tenantId===tenantId).map(a=>a.lease.claim.id));}catch{this.onError(tenantId);continue;}
   if(!claim)continue;const lease=new OutboxLease(this.pool(tenantId),claim);
   if(this.closing){lease.cancel();await lease.release();break;}lease.start();
   const task=Promise.resolve().then(()=>this.handle(lease)).catch(()=>this.onError(tenantId)).finally(async()=>{await lease.release();this.active.delete(claim!.token);});
   this.active.set(claim.token,{lease,task});
  }
 }
 async close(){this.closing=true;for(const {lease}of this.active.values())lease.cancel();await this.pumping;await Promise.all([...this.active.values()].map(a=>a.task));}
}
