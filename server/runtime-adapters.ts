import type pg from 'pg';
import type {AuthConfig} from './auth.ts';
import type {AuthStateStore} from './auth-state.ts';
import {openState} from './auth-state.ts';
import {PostgresAuthStore,keyWitnessBinding} from './auth-store.ts';
import {authSchemaChecksum} from './auth-store-schema.ts';
import {runtimeReadOnly} from './runtime-db-probe.ts';
import {runtimeHttpJson} from './runtime-http.ts';
import {RuntimeProbeError,probeNeed,probeSignal,loopbackUrl} from './runtime-probe-error.ts';
import type {ReadinessComponent,ReadinessTask,ProbeResult} from './runtime-readiness.ts';

interface TenantBinding {tenantId:string;pool:pg.Pool;database?:string;user?:string}
interface ClientConfig {baseUrl:string;tenants:Record<string,{serviceToken:string}>;model?:{name:string;digest:string}}
interface EdgeSource {edgeId:string;tenantId:string;origin:string;statusUrl:string;statusKey:string}
export interface RuntimeDependencies {
  databases: readonly TenantBinding[]; authConfig: AuthConfig; authState: AuthStateStore;
  workflow: {config?:ClientConfig}; ai: {config?:ClientConfig}; predictorUrl?:string;
  telemetry: {config?:{sources:EdgeSource[];edge?:{capacity?:number}};connected:boolean;subscribed:boolean;closing:boolean};
}
function localEndpoint(value:string){try{return loopbackUrl(value);}catch{throw new RuntimeProbeError('LOCAL_ENDPOINT_REQUIRED','UNKNOWN');}}
const pass = (evidence:string):ProbeResult => ({status:'PASS',code:'CHECK_PASSED',evidence});
function missing():never {throw new RuntimeProbeError('NOT_CONFIGURED','NOT_CONFIGURED');}
export function runtimeDependencyTasks(d:RuntimeDependencies):Record<ReadinessComponent,ReadinessTask> {
  // Copy immutable startup bindings; retain live connection state and actual pools.
  const bindings = d.databases.map(b=>Object.freeze({...b})), auth = {...d.authConfig};
  const workflow = d.workflow.config ? structuredClone(d.workflow.config) : undefined;
  const ai = d.ai.config ? structuredClone(d.ai.config) : undefined;
  const telemetryConfig = d.telemetry.config ? structuredClone(d.telemetry.config) : undefined;
  const count = () => probeNeed(bindings.length>=1 && bindings.length<=16,'CONFIG_INVALID');
  const http = (ctx:Parameters<ReadinessTask>[0],url:string,headers:Record<string,string>={}) => {
    probeSignal(ctx.signal,ctx.deadline); return runtimeHttpJson(url,{signal:ctx.signal,timeoutMs:ctx.timeoutMs,headers});
  };
  async function service(c:ClientConfig|undefined,ctx:Parameters<ReadinessTask>[0],kind:'ai'|'workflow') {
    if (!c) missing(); count(); const origin = localEndpoint(c.baseUrl);
    probeNeed(origin.pathname==='/' && JSON.stringify(Object.keys(c.tenants).sort())===JSON.stringify(bindings.map(b=>b.tenantId).sort()),'CONFIG_INVALID');
    for (const b of bindings) {
      const token=c.tenants[b.tenantId]?.serviceToken;
      probeNeed(typeof token==='string' && token.length>=32 && token.length<=4096 && !/[\r\n]/.test(token),'CONFIG_INVALID');
      const s=await http(ctx,origin.origin+'/v1/status',{Authorization:'Bearer '+token,'X-IDMS-Tenant':b.tenantId});
      if(kind==='workflow') probeNeed(s?.engine==='Flowable' && s.version==='7.2.0' && typeof s.definitionId==='string' && s.definitionId.length>0,'WORKFLOW_CONTRACT_MISMATCH');
      else probeNeed(s?.service==='IDMS_AI_GATEWAY' && s.mode==='SHADOW' && s.modelReady===true && typeof c.model?.digest==='string'
        && /^sha256:[a-f0-9]{64}$/.test(c.model.digest) && s.model?.digest===c.model.digest && s.model?.name===c.model.name,'AI_CONTRACT_MISMATCH');
    }
    return pass('AUTHENTICATED_RUNNING_CLIENT_STATUS');
  }
  return {
    business:async ctx=>{
      count();
      for(const b of bindings) {
        probeSignal(ctx.signal,ctx.deadline);
        await runtimeReadOnly(b.pool,async (client,signal)=>{
          probeSignal(signal,ctx.deadline);
          const actual=(await client.query('SELECT current_database() AS database,current_user AS role')).rows[0];
          probeSignal(signal,ctx.deadline);
          const rows=(await client.query('SELECT tenant_id=$1 AS tenant_matches FROM public.business_state LIMIT 2',[b.tenantId])).rows;
          probeNeed(actual?.database===b.database && actual?.role===b.user && rows.length===1 && rows[0].tenant_matches===true,'DATABASE_BINDING_MISMATCH');
        },{signal:ctx.signal,timeoutMs:ctx.timeoutMs});
      }
      return pass('RUNNING_TENANT_POOL_MINIMUM_BINDING');
    },
    sessions:async ctx=>{
      if(!(d.authState instanceof PostgresAuthStore)) missing(); const a=d.authState;
      await runtimeReadOnly(a.pool,async (client,signal)=>{
        probeSignal(signal,ctx.deadline);
        const actual=(await client.query('SELECT current_database() AS database,current_user AS role')).rows[0];
        probeNeed(actual?.database===a.runtime.account.database && actual?.role===a.runtime.account.user,'SESSION_BINDING_MISMATCH');
        probeSignal(signal,ctx.deadline);
        const rows=(await client.query('SELECT deployment_digest=$1 AS deployment_matches,CASE WHEN pg_column_size(key_check)<=8192 THEN key_check ELSE NULL END AS key_check FROM public.auth_store_meta LIMIT 2',[a.runtime.deploymentDigest])).rows;
        probeSignal(signal,ctx.deadline);
        const migrations=(await client.query('SELECT version=1 AND checksum=$1 AND deployment_digest=$2 AS migration_matches FROM public.auth_schema_migrations ORDER BY version LIMIT 2',[authSchemaChecksum,a.runtime.deploymentDigest])).rows;
        probeNeed(rows.length===1 && rows[0].deployment_matches===true && migrations.length===1 && migrations[0].migration_matches===true,'SESSION_BINDING_MISMATCH');
        let witness:any;
        try {witness=openState(rows[0].key_check,keyWitnessBinding(a.runtime.deploymentDigest),a.ring);} catch {throw new RuntimeProbeError('SESSION_BINDING_MISMATCH');}
        probeNeed(witness?.marker==='IDMS_AUTH_STORE_V1' && witness.deploymentDigest===a.runtime.deploymentDigest,'SESSION_BINDING_MISMATCH');
      },{signal:ctx.signal,timeoutMs:ctx.timeoutMs});
      return pass('RUNNING_SESSION_POOL_AND_KEY_WITNESS');
    },
    identity:async ctx=>{
      if(auth.mode!=='oidc' || !auth.issuer) missing(); localEndpoint(auth.issuer);
      const s=await http(ctx,auth.issuer+'/.well-known/openid-configuration'); probeNeed(s?.issuer===auth.issuer,'ISSUER_MISMATCH');
      return pass('RUNNING_OIDC_ISSUER_DISCOVERY');
    },
    workflow:ctx=>service(workflow,ctx,'workflow'),
    ai:ctx=>service(ai,ctx,'ai'),
    predictor:async ctx=>{
      if(!d.predictorUrl) missing(); const u=localEndpoint(d.predictorUrl); probeNeed(u.pathname==='/','CONFIG_INVALID');
      const s=await http(ctx,u.origin+'/health'); probeNeed(s?.status==='UP' && s.algorithm==='engineering-rule' && s.rulAvailable===false,'PREDICTOR_CONTRACT_MISMATCH');
      return pass('RUNNING_PREDICTOR_PROCESS_CONTRACT');
    },
    telemetry:async ctx=>{
      if(!telemetryConfig) missing(); const sources=telemetryConfig.sources;
      probeNeed(Array.isArray(sources) && sources.length>=1 && sources.length<=16 && new Set(sources.map(s=>s.edgeId)).size===sources.length,'CONFIG_INVALID');
      probeNeed(!d.telemetry.closing && d.telemetry.connected && d.telemetry.subscribed,'TELEMETRY_CONNECTION_FAILED');
      for(const source of sources) {
        probeNeed(source.origin==='SIMULATOR' && bindings.some(b=>b.tenantId===source.tenantId),'TELEMETRY_CONTRACT_MISMATCH');
        const url=localEndpoint(source.statusUrl); probeNeed(url.pathname==='/status' && typeof source.statusKey==='string' && source.statusKey.length>=32 && !/[\r\n]/.test(source.statusKey),'CONFIG_INVALID');
        const s=await http(ctx,url.href,{Authorization:'Bearer '+source.statusKey});
        probeNeed(s?.edgeId===source.edgeId && s.tenantId===source.tenantId && s.origin==='SIMULATOR' && s.mode==='READ_ONLY_POLL','TELEMETRY_CONTRACT_MISMATCH');
        for(const k of ['pending','rejected','acknowledged']) probeNeed(Number.isSafeInteger(s[k]) && s[k]>=0,'TELEMETRY_CONTRACT_MISMATCH');
        if(s.spoolVersion===2){
          for(const k of ['records','logicalBytes','databaseBytes','walBytes'])probeNeed(Number.isSafeInteger(s[k])&&s[k]>=0,'TELEMETRY_CONTRACT_MISMATCH');
          probeNeed(!s.storageBlocked,'TELEMETRY_STORAGE_LIMIT');
          probeNeed(s.records===0,'TELEMETRY_QUARANTINE_PENDING');
        }
        const capacity=s.capacity ?? (sources.length===1 ? telemetryConfig.edge?.capacity : null) ?? null;
        probeNeed(capacity===null || Number.isSafeInteger(capacity) && capacity>0,'TELEMETRY_CONTRACT_MISMATCH');
        probeNeed(Number.isSafeInteger(s.pending+s.rejected),'TELEMETRY_CONTRACT_MISMATCH');
        probeNeed(!(s.lastError==='SPOOL_CAPACITY_REACHED' || s.capacityBlocked===true || capacity!==null && s.pending+s.rejected>=capacity),'TELEMETRY_BUFFER_FULL');
        probeNeed(s.mqttConnected===true && s.opcConnected===true,'TELEMETRY_CONNECTION_FAILED');
        if(!s.lastSample || !Number.isFinite(Date.parse(s.lastSample)) || s.lastError) throw new RuntimeProbeError('TELEMETRY_SAMPLE_UNCONFIRMED','UNKNOWN');
      }
      // Recheck live local state after network waits, never substitute edge state.
      probeNeed(!d.telemetry.closing && d.telemetry.connected && d.telemetry.subscribed,'TELEMETRY_CONNECTION_FAILED');
      return pass('MAIN_SUBSCRIPTION_AND_SIMULATOR_STATUS_ONLY');
    }
  };
}
