import type pg from 'pg';
import type {AccessContext} from './access.ts';
import {requireAccess} from './access.ts';
import {DomainError} from './service.ts';
import {sqlScheduler,memoryTask,requestSignal,CapacityError,accountValue} from './capacity.ts';
import {readLeanSnapshot} from './lean-snapshot.ts';
import {AuditPageCollector,auditHead,type AuditPageRow} from './audit-page.ts';
import type {AuditEvent} from './domain.ts';
import {streamRows} from './pg-row-stream.ts';
import {replayDeviceAccessSql} from './coverage-replay-sql.ts';
import {fieldRegistrySnapshot,fieldRegistryIntegrity,type FieldRegistrySnapshot} from './field-registry.ts';
import {fieldViewQuery,buildFieldGovernanceView} from './field-governance-view.ts';
import {digest,canonical} from './imports.ts';
const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'现场治理查询已取消','REQUEST_CANCELLED');};
async function access(client:pg.PoolClient,ctx:AccessContext,edge:string,device:string){
 await replayDeviceAccessSql(client,ctx,device);
 const rows=(await client.query(`/* IDMS_FIELD_WORKSPACE_SCOPE */ SELECT DISTINCT device FROM (
 SELECT p.value->>'deviceCode' AS device FROM business_templates t CROSS JOIN LATERAL(VALUES(t.body->'manifest'->'fieldChannelPolicy'),(t.body->'manifest'->'telemetrySourcePolicy')) p(value) WHERE t.tenant_id=$1 AND p.value->>'edgeId'=$2
 UNION ALL SELECT p.value->>'deviceCode' FROM audit_ledger a CROSS JOIN LATERAL(VALUES(a.event->'after'->'manifest'->'fieldChannelPolicy'),(a.event->'after'->'manifest'->'telemetrySourcePolicy')) p(value) WHERE a.tenant_id=$1 AND a.event->>'objectType'='TEMPLATE' AND a.event->>'action'='TEMPLATE_APPROVED' AND p.value->>'edgeId'=$2
 UNION ALL SELECT c->'profile'->'source'->>'deviceCode' FROM audit_ledger a CROSS JOIN LATERAL jsonb_array_elements(a.event->'after'->'channels') c WHERE a.tenant_id=$1 AND a.event->>'objectType'='FIELD_REGISTRY' AND c->'profile'->'source'->>'edgeId'=$2
 UNION ALL SELECT a.event->'metadata'->'leaseBody'->>'deviceCode' FROM audit_ledger a WHERE a.tenant_id=$1 AND a.event->>'objectType'='FIELD_LEASE' AND (a.event->>'actorId'=$2 OR a.event->'metadata'->'leaseBody'->>'edgeId'=$2)) identities`,[ctx.tenantId,edge])).rows;check();accountValue(rows);for(const r of rows){if(typeof r.device!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.device))throw fieldRegistryIntegrity();await replayDeviceAccessSql(client,ctx,r.device);}
}
export async function fieldGovernanceSqlRead(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,raw:FieldRegistrySnapshot|null,exporting:boolean,verify:(client:pg.PoolClient)=>Promise<void>,now=Date.now()){
 requireAccess(ctx,'read');const q=fieldViewQuery(params,now);if(!raw||raw.tenantId!==ctx.tenantId)throw new DomainError(404,'当前企业未配置现场通道');const snapshot=fieldRegistrySnapshot(raw),channel=snapshot.channels.find(c=>c.profile.source.edgeId===q.edge);if(!channel)throw new DomainError(404,'当前企业未配置此现场通道');
 return sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const client=await pool.connect();let collector:AuditPageCollector|undefined;const events:AuditEvent[]=[];try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verify(client);await access(client,ctx,q.edge,channel.profile.source.deviceCode);
  const data=(await readLeanSnapshot(client,ctx.tenantId)).data,heads=(await client.query('/* IDMS_FIELD_WORKSPACE_HEAD */ SELECT sequence_no::text AS sequence,tenant_id,event_id,hash FROM audit_ledger ORDER BY sequence_no DESC LIMIT 1')).rows;check();if(heads.length!==1||heads[0].tenant_id!==ctx.tenantId)throw fieldRegistryIntegrity();const identity=digest(canonical({tenant:ctx.tenantId,edge:q.edge}));collector=new AuditPageCollector({tenantId:ctx.tenantId,identity,scope:identity,pageSize:1,filters:{q:'',objectType:'',action:'',actorId:'',from:null,to:null}},auditHead(heads[0]),event=>{events.push(event);return false;});
  await streamRows<AuditPageRow>(client,'/* IDMS_FIELD_WORKSPACE_ROWS */ SELECT sequence_no::text AS sequence,tenant_id,event_id,hash,previous_hash,event FROM audit_ledger ORDER BY sequence_no',row=>{check();accountValue(row);if(Object.keys(row).length!==6||Object.keys(row).some(k=>!['sequence','tenant_id','event_id','hash','previous_hash','event'].includes(k)))throw fieldRegistryIntegrity();collector!.accept(row);},()=>{collector?.discard();events.length=0;});check();collector.finish();const result=buildFieldGovernanceView(data.store.templates,events,data.imports,snapshot,q,now,exporting);accountValue(result);await client.query('COMMIT');return result;
 }catch(e){events.length=0;collector?.discard();await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}},true),requestSignal());
}
