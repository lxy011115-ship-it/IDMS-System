import type pg from 'pg';
import {publicRegistry,registrySnapshot,registryRowHash,type RegistryRow} from './registry-history.ts';
import {readRegistrySql} from './registry-history-sql.ts';
import {publicGovernedSource,type PublicGovernedSource} from './source-governance.ts';
import {canonical,digest} from './imports.ts';
import type {EdgeSource} from '../integrations/telemetry.ts';
import {streamRows} from './pg-row-stream.ts';
import {accountValue,requestSignal,CapacityError} from './capacity.ts';
import {sourceGovernanceIntegrity} from './source-policy-references.ts';
export interface SourceRegistryState {revision:string|null;configurationHash:string|null;instanceConfigurationHash:string;current:boolean}
export async function sourceRegistryEvidence(client:pg.PoolClient,tenant:string,edge:string,sources:readonly EdgeSource[],now:number){
 const history=await readRegistrySql(client,tenant,now),observations=new Map<string,{configurationHash:string;source:PublicGovernedSource|null}>();let count=0n;
 await streamRows<RegistryRow>(client,`/* IDMS_SOURCE_REGISTRY_WITNESSES */ SELECT tenant_id,revision::text,to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,writer_id,configuration_hash,previous_hash,hash,body FROM registry_history WHERE tenant_id=$1 ORDER BY revision`,row=>{
  if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');if(row.tenant_id!==tenant||observations.has(row.revision)||row.configuration_hash!==digest(canonical(registrySnapshot(row.body)))||row.hash!==registryRowHash(row))throw sourceGovernanceIntegrity();count++;const list=row.body.sources.filter(s=>s.edgeId===edge);if(list.length>1)throw sourceGovernanceIntegrity();const value={configurationHash:row.configuration_hash,source:list.length?publicGovernedSource(list[0]):null};accountValue(value);observations.set(row.revision,value);
 },()=>observations.clear(),[tenant]);if(String(count)!==history.verifiedRevisions)throw sourceGovernanceIntegrity();const instanceConfigurationHash=digest(canonical(publicRegistry(sources,tenant))),state:SourceRegistryState={revision:history.last?.revision||null,configurationHash:history.last?.configuration_hash||null,instanceConfigurationHash,current:history.last?.configuration_hash===instanceConfigurationHash};return {state,observations};
}
