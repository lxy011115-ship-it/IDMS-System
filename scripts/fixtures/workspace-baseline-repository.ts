// Frozen pre-workspace implementation for isolated capacity comparison only.
if(!process.send||!/^workspaceqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned workspace QA IPC required');
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {canonical,digest,type ImportData} from '../../server/imports.ts';
import {DomainError} from '../../server/service.ts';
import type {Store} from '../../server/store.ts';
import {verifyDataProjection,projectApprovedData} from './workspace-baseline-projection.ts';
import {validateRuntimeConfig,verifyDatabaseSecurity,connectionFor} from '../../server/postgres-security.ts';
import {readEntities,writeEntities,tenantPayload,type TenantPayload} from './workspace-baseline-entities.ts';
export interface PlatformSnapshot {version:number;imports:ImportData;audits:Store['audits'];business:Omit<Store,'audits'|'idempotency'>;idempotency:[string,unknown][]}
interface TenantDatabase {pool:pg.Pool;workerPool?:pg.Pool;connection:pg.PoolConfig}
export interface TenantTransaction {tenantId:string;client:pg.PoolClient;payload:TenantPayload;revision:number}
const databases=new Map<string,TenantDatabase>();
const enabled=process.env.IDMS_STORAGE==='postgres';
export const storageMode=enabled?'postgres-tenant-databases':'atomic-local-snapshot';
export async function loadPostgres(seed:PlatformSnapshot):Promise<PlatformSnapshot>{
 if(!enabled)return seed;
 const config=validateRuntimeConfig(JSON.parse(await readFile(resolve(process.env.IDMS_POSTGRES_CONFIG||'.local/postgres-business.json'),'utf8'))),combined=structuredClone(seed);
 combined.imports={batches:[],records:[],requests:[]};combined.audits=[];combined.idempotency=[];
 for(const key of Object.keys(combined.business))(combined.business as any)[key]=[];
 for(const tenant of seed.business.tenants){
  const account=config.tenants[tenant.id];if(!account)throw Error('Missing independent database configuration for tenant '+tenant.id);
  const pool=new pg.Pool({...connectionFor(config,account),max:4,application_name:'idms-business',idle_in_transaction_session_timeout:20000,query_timeout:20000});pool.on('connect',client=>client.on('error',()=>console.error('[IDMS database] checked-out connection failed; current transaction must abort')));pool.on('error',()=>console.error('[IDMS database] tenant '+tenant.id+' idle connection failed'));
  let client:pg.PoolClient;try{client=await pool.connect();}catch(e){await pool.end();await closePostgres();throw e;}
  try{
   await client.query('BEGIN');await verifyDatabaseSecurity(client,account,tenant.id);
   await client.query('SELECT revision FROM business_state WHERE tenant_id=$1 FOR SHARE',[tenant.id]);
   const {payload}=await readEntities(client,tenant.id);await verifyDataProjection(client,payload.imports,tenant.id);
   for(const [key,items]of Object.entries(payload.business))(combined.business as any)[key].push(...items);
   for(const key of ['batches','records','requests'] as const)combined.imports[key].push(...payload.imports[key] as never[]);
   combined.audits.push(...payload.audits);combined.idempotency.push(...payload.idempotency);
   await client.query('COMMIT');databases.set(tenant.id,{pool,connection:connectionFor(config,account)});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();if(!databases.has(tenant.id)){await pool.end();await closePostgres();}}
 }
 return combined;
}
// Domain diffs, append-only facts/audit and outboxes commit in the same tenant transaction.
export async function savePostgres(snapshot:PlatformSnapshot,tx?:TenantTransaction){
 if(!tx)throw new DomainError(503,'Business writes require an explicit tenant transaction');
 const payload=tenantPayload(snapshot,tx.tenantId);if(canonical(payload)===canonical(tx.payload))return;
 await writeEntities(tx.client,tx.payload,payload,tx.tenantId);await projectApprovedData(tx.client,payload.imports,tx.tenantId);
 const rebuilt=(await readEntities(tx.client,tx.tenantId,false)).payload;
 if(canonical(rebuilt)!==canonical(payload)){
  const difference=(a:any,b:any,path='payload'):string=>{if(canonical(a)===canonical(b))return '';if(a&&b&&typeof a==='object'&&typeof b==='object'){for(const key of new Set([...Object.keys(a),...Object.keys(b)])){const found=difference(a[key],b[key],path+'.'+key);if(found)return found;}}return path;};
  throw Error('Normalized write reconstruction mismatch at '+difference(payload,rebuilt));
 }
 const result=await tx.client.query('UPDATE business_state SET revision=revision+1,payload_digest=$3,updated_at=now() WHERE tenant_id=$1 AND revision=$2 RETURNING revision',[tx.tenantId,tx.revision,digest(canonical(payload))]);
 if(result.rowCount!==1)throw new DomainError(409,'Business revision changed during locked transaction');
}
async function stateTransaction<T>(tenantId:string,write:boolean,task:(tx:TenantTransaction)=>Promise<T>){
 const db=databases.get(tenantId);if(!db)throw new DomainError(503,'企业数据库未配置');const client=await db.pool.connect();
 try{
  // READ COMMITTED takes the lock before loading, so a waiter sees the winner's commit.
  await client.query('BEGIN');await client.query(`SELECT revision FROM business_state WHERE tenant_id=$1 FOR ${write?'UPDATE':'SHARE'}`,[tenantId]);
  const loaded=await readEntities(client,tenantId);const tx:TenantTransaction={tenantId,client,...loaded};
  const result=await task(tx);await client.query('COMMIT');return result;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export function tenantTransaction<T>(tenantId:string,task:(tx:TenantTransaction)=>Promise<T>){return stateTransaction(tenantId,true,task);}
export function tenantRead<T>(tenantId:string,task:(tx:TenantTransaction)=>Promise<T>){return stateTransaction(tenantId,false,task);}
// Legacy handlers can query service projections on another connection. Preserve
// their business SHARE lock while avoiding repeated workspace reconstruction.
export async function tenantLockedRead<T>(tenantId:string,task:(client:pg.PoolClient,pool:pg.Pool)=>Promise<T>){
 const db=databases.get(tenantId);if(!db)throw new DomainError(503,'企业数据库未配置');
 for(let attempt=0;;attempt++){
  const client=await db.pool.connect();let taskStarted=false;
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query('SELECT revision FROM business_state WHERE tenant_id=$1 FOR SHARE',[tenantId]);taskStarted=true;const value=await task(client,db.pool);await client.query('COMMIT');return value;}
  catch(e){await client.query('ROLLBACK').catch(()=>{});if(!taskStarted&&(e as any).code==='40001'&&attempt<2)continue;throw e;}finally{client.release();}
 }
}
export function tenantPool(tenantId:string){const db=databases.get(tenantId);if(!db)throw new DomainError(503,'企业数据库未配置');return db.pool;}
export function tenantWorkerPool(tenantId:string){const db=databases.get(tenantId);if(!db)throw new DomainError(503,'企业后台数据库未配置');if(!db.workerPool){db.workerPool=new pg.Pool({...db.connection,max:2,application_name:'idms-dispatcher',connectionTimeoutMillis:1500,statement_timeout:3000,query_timeout:4000,idle_in_transaction_session_timeout:5000} as pg.PoolConfig);db.workerPool.on('connect',client=>client.on('error',()=>console.error('[IDMS dispatcher] connection failed; lease cannot be trusted')));db.workerPool.on('error',()=>console.error('[IDMS dispatcher] idle database connection failed'));}return db.workerPool;}
export async function closePostgres(){await Promise.all([...databases.values()].flatMap(d=>[d.pool.end(),...(d.workerPool?[d.workerPool.end()]:[])]));databases.clear();}
