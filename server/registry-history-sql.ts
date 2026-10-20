import type pg from 'pg';
import {RegistryChain,registryIntegrity,registryObservation,registrySnapshot,registryRowHash,type RegistryRow,type RegistrySnapshot,type RegistryHead} from './registry-history.ts';
import {streamRows} from './pg-row-stream.ts';
import {canonical,digest} from './imports.ts';
import {DomainError} from './service.ts';
import {accountValue,holdValue,requestSignal,CapacityError,sqlScheduler,memoryTask} from './capacity.ts';

const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
const columns=`tenant_id,revision::text,to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,writer_id,configuration_hash,previous_hash,hash,body`;
export async function registryLock(client:pg.PoolClient,tenant:string){await client.query("/* IDMS_REGISTRY_LOCK */ SELECT pg_advisory_xact_lock(hashtextextended('idms-registry-history-v1:'||$1::text,0))",[tenant]);check();}
export async function readRegistrySql(client:pg.PoolClient,tenant:string,knownAt:number){
 const state=new RegistryChain(tenant,knownAt);let releaseLast=()=>{},releaseSelected=()=>{};
 try{
  const heads=(await client.query(`/* IDMS_REGISTRY_HEAD */ SELECT $1::text AS tenant_id,count(*)::text AS count,COALESCE(max(revision),0)::text AS revision,COALESCE((SELECT hash FROM registry_history WHERE tenant_id=$1 ORDER BY revision DESC LIMIT 1),'GENESIS') AS hash FROM registry_history`,[tenant])).rows;check();accountValue(heads);if(heads.length!==1)throw registryIntegrity();
  await streamRows<RegistryRow>(client,`/* IDMS_REGISTRY_ROWS */ SELECT ${columns} FROM registry_history WHERE tenant_id=$1 ORDER BY revision`,row=>{
   check();releaseLast();releaseLast=()=>{};releaseLast=holdValue(row);state.accept(row);if(state.selected===row){releaseSelected();releaseSelected=()=>{};releaseSelected=holdValue(row);}
  },()=>{state.discard();releaseLast();releaseLast=()=>{};releaseSelected();releaseSelected=()=>{};},[tenant]);check();const result=state.finish(heads[0] as RegistryHead);accountValue(result);return result;
 }catch(error){state.discard();throw error;}finally{releaseLast();releaseSelected();}
}
export async function observeRegistrySql(pool:pg.Pool,tenant:string,snapshot:RegistrySnapshot,writerId:string){
 const parsed=registrySnapshot(snapshot);if(parsed.tenantId!==tenant)throw registryIntegrity();
 return sqlScheduler.run(tenant,()=>memoryTask(async()=>{
  const client=await pool.connect();try{
   await client.query('BEGIN');await registryLock(client,tenant);const history=await readRegistrySql(client,tenant,Date.now()),times=(await client.query(`/* IDMS_REGISTRY_CLOCK */ SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`)).rows;check();if(times.length!==1)throw registryIntegrity();
   const row=registryObservation(parsed,history.last,times[0].at,writerId);if(row){accountValue(row);const saved=await client.query(`/* IDMS_REGISTRY_APPEND */ INSERT INTO registry_history(tenant_id,revision,observed_at,writer_id,configuration_hash,previous_hash,hash,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,[row.tenant_id,row.revision,row.observed_at,row.writer_id,row.configuration_hash,row.previous_hash,row.hash,JSON.stringify(row.body)]);check();if(saved.rowCount!==1||saved.rows.length!==1||canonical(saved.rows[0])!==canonical(row))throw registryIntegrity();}
   check();await client.query('COMMIT');return {changed:!!row,revision:row?.revision||history.last?.revision||'0',configurationHash:row?.configuration_hash||history.last?.configuration_hash||null};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
 },true),requestSignal());
}
// An old instance must not keep ingesting after another instance observes a
// different registry. The same tenant lock also orders intake and observations.
export async function assertRegistryCurrent(client:pg.PoolClient,tenant:string,snapshot:RegistrySnapshot){
 if(snapshot.tenantId!==tenant)throw registryIntegrity();await registryLock(client,tenant);
 const rows=(await client.query(`/* IDMS_REGISTRY_CURRENT */ SELECT ${columns},(SELECT count(*)::text FROM registry_history WHERE tenant_id<>$1) AS foreign_count FROM registry_history WHERE tenant_id=$1 ORDER BY revision DESC LIMIT 1`,[tenant])).rows;check();accountValue(rows);const row=rows[0];
 if(rows.length!==1||row.foreign_count!=='0'||row.tenant_id!==tenant||row.configuration_hash!==digest(canonical(registrySnapshot(row.body)))||row.hash!==registryRowHash(row))throw registryIntegrity();
 if(row.configuration_hash!==digest(canonical(registrySnapshot(snapshot))))throw new DomainError(409,'运行实例的接入配置已过期，须核对配置后重新启动');
 return {revision:row.revision,configurationHash:row.configuration_hash};
}
