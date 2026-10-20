import {verifyColdImports} from './cold-import-proof.ts';
import {BootstrapBuilder,type RuntimeBootstrap} from './runtime-bootstrap.ts';
import {memoryTask} from './capacity.ts';
import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {canonical,digest,type ImportData} from './imports.ts';
import {DomainError} from './service.ts';
import type {Store} from './store.ts';
import {verifyDataProjection,projectApprovedData} from './data-projection.ts';
import {validateRuntimeConfig,verifyDatabaseSecurity,connectionFor} from './postgres-security.ts';
import {readEntities,writeEntities,type TenantPayload} from './entity-repository.ts';
import {verifyPostImage} from './write-postimage.ts';
export interface PlatformSnapshot {version:number;imports:ImportData;audits:Store['audits'];business:Omit<Store,'audits'|'idempotency'>;idempotency:[string,unknown][]}
interface TenantDatabase {pool:pg.Pool;workerPool?:pg.Pool;connection:pg.PoolConfig}
export interface TenantTransaction {tenantId:string;client:pg.PoolClient;payload:TenantPayload;revision:number}
const databases=new Map<string,TenantDatabase>();
const enabled=process.env.IDMS_STORAGE==='postgres';
export const storageMode=enabled?'postgres-tenant-databases':'atomic-local-snapshot';
async function loadTenantDatabases<T>(tenants:Store['tenants'],read:(client:pg.PoolClient,tenant:string)=>Promise<T>,consume:(tenantId:string,value:T)=>void,ephemeral=false){
 const config=validateRuntimeConfig(JSON.parse(await readFile(resolve(process.env.IDMS_POSTGRES_CONFIG||'.local/postgres-business.json'),'utf8')));
 for(const tenant of tenants){
  const account=config.tenants[tenant.id];if(!account)throw Error('Missing independent database configuration for tenant '+tenant.id);
  const pool=new pg.Pool({...connectionFor(config,account),max:4,application_name:'idms-business',idle_in_transaction_session_timeout:20000,query_timeout:20000});pool.on('connect',client=>client.on('error',()=>console.error('[IDMS database] checked-out connection failed; current transaction must abort')));pool.on('error',()=>console.error('[IDMS database] tenant '+tenant.id+' idle connection failed'));
  const load=async()=>{
   let client:pg.PoolClient;try{client=await pool.connect();}catch(e){await pool.end();await closePostgres();throw e;}
   try{for(let attempt=0;;attempt++){let locked=false;try{
    await client.query(ephemeral?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');await verifyDatabaseSecurity(client,account,tenant.id);
    await client.query('SELECT revision FROM business_state WHERE tenant_id=$1 FOR SHARE',[tenant.id]);locked=true;
    const value=await read(client,tenant.id);consume(tenant.id,value);
    await client.query('COMMIT');databases.set(tenant.id,{pool,connection:connectionFor(config,account)});break;
   }catch(e){await client.query('ROLLBACK').catch(()=>{});if(ephemeral&&!locked&&(e as any).code==='40001'&&attempt<2)continue;throw e;}}}
   finally{client.release();if(!databases.has(tenant.id)){await pool.end();await closePostgres();}}
  };
  await (ephemeral?memoryTask(load,true):load());
 }
}
// Full snapshots are reserved for maintenance and explicit compatibility callers.
export async function loadPostgres(seed:PlatformSnapshot):Promise<PlatformSnapshot>{
 if(!enabled)return seed;const combined=structuredClone(seed);
 combined.imports={batches:[],records:[],requests:[]};combined.audits=[];combined.idempotency=[];
 for(const key of Object.keys(combined.business))(combined.business as any)[key]=[];
 await loadTenantDatabases(seed.business.tenants,async(client,tenant)=>{const loaded=await readEntities(client,tenant);await verifyDataProjection(client,loaded.payload.imports,tenant);return loaded.payload;},(_tenant,payload)=>{
  for(const [key,items]of Object.entries(payload.business))(combined.business as any)[key].push(...items);
  for(const key of ['batches','records','requests'] as const)combined.imports[key].push(...payload.imports[key] as never[]);
  combined.audits.push(...payload.audits);combined.idempotency.push(...payload.idempotency);
 });return combined;
}
export async function loadPostgresBootstrap(tenants:Store['tenants']):Promise<RuntimeBootstrap>{
 if(!enabled)throw Error('Runtime database bootstrap requires PostgreSQL');const builder=new BootstrapBuilder();
 await loadTenantDatabases(tenants,async(client,tenant)=>verifyColdImports(client,tenant),(tenant,bindings)=>builder.acceptVerifiedBindings(tenant,bindings),true);return builder.finish();
}
// Domain diffs, append-only facts/audit and outboxes commit in the same tenant transaction.
export async function savePostgres(payload:TenantPayload,tx?:TenantTransaction){
 if(!tx)throw new DomainError(503,'Business writes require an explicit tenant transaction');
 if(canonicalEqual(payload,tx.payload))return;
 await writeEntities(tx.client,tx.payload,payload,tx.tenantId);await projectApprovedData(tx.client,payload.imports,tx.tenantId);
 await verifyPostImage(tx.client,tx.tenantId,payload,tx.revision,canonicalDigest(tx.payload));
 const result=await tx.client.query('UPDATE business_state SET revision=revision+1,payload_digest=$3,updated_at=now() WHERE tenant_id=$1 AND revision=$2 RETURNING revision',[tx.tenantId,tx.revision,canonicalDigest(payload)]);
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
