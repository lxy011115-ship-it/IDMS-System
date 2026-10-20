import type pg from 'pg';
import {verifyAnalysisSchema} from './analysis-schema-check.ts';
import {requireAccess,scopeFilter,type AccessContext} from './access.ts';
import {canonical,digest} from './imports.ts';
import {DomainError} from './service.ts';
import {object,keys,text} from './schema-primitives.ts';
import {replayQuery,replayInputsSql,replayDeviceAccessSql} from './coverage-replay-sql.ts';
import {replayInputsSqlV2} from './coverage-replay-sql-v2.ts';
import {freezeCoveragePayloadV2} from './frozen-coverage-v2.ts';
import {freezeCoveragePayload} from './frozen-coverage-v1.ts';
import {operationalQuery,operationalInputsSql} from './operational-metrics-sql.ts';
import {freezeOperationalPayload} from './frozen-operational-v1.ts';
import type {ReportFamily} from './report-events.ts';
import {reportGenerated,reportChanged,appendReportState,reportRequestKey,reportReceipt,reportIntegrity} from './report-events.ts';
import {readReportSql,insertReportEventSql,reportClockSql} from './report-store-sql.ts';
import {currentQuery} from './revision-projection.ts';
import {verifiedReadStamp} from './read-integrity.ts';
import {reserveCommandResult} from './request-capacity.ts';
import {sqlScheduler,workScheduler,memoryTask,accountValue,requestSignal,CapacityError} from './capacity.ts';
const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
const count=(v:unknown)=>{if(!/^(0|[1-9][0-9]*)$/.test(String(v))||!Number.isSafeInteger(Number(v)))throw reportIntegrity();return Number(v);};
function queryBody(raw:unknown,family:ReportFamily){const q=object(raw,'历史复核参数');keys(q,family!=='OPERATIONAL_METRICS'?['source','deviceCode','edgeId','tagCode','from','to','knownAt']:['source','deviceCode','from','to','knownAt']);if(Object.values(q).some(v=>typeof v!=='string'))throw new DomainError(400,'历史复核参数须为明确字符串');return family!=='OPERATIONAL_METRICS'?replayQuery(new URLSearchParams(q as Record<string,string>)):operationalQuery(new URLSearchParams(q as Record<string,string>));}
export function isReportPath(path:string){return /^\/api\/v1\/(?:coverage(?:-v2)?|operational)-reports(?:\/[a-f0-9-]+(?:\/(?:submit|approval|export))?)?$/.test(path);}
export async function reportCommandSql(pool:pg.Pool,ctx:AccessContext,path:string,input:Record<string,unknown>,key:string){
 const family:ReportFamily=path.startsWith('/api/v1/operational-reports')?'OPERATIONAL_METRICS':path.startsWith('/api/v1/coverage-v2-reports')?'COVERAGE_V2':'COVERAGE',creating=path==='/api/v1/coverage-reports'||path==='/api/v1/coverage-v2-reports'||path==='/api/v1/operational-reports',match=/^\/api\/v1\/(?:coverage(?:-v2)?|operational)-reports\/([a-f0-9-]+)\/(submit|approval)$/.exec(path);if(!creating&&!match)throw new DomainError(404,'报告写接口不存在');requireAccess(ctx,creating?'template:edit':match![2]==='submit'?'template:submit':'template:publish');
 const requestKey=reportRequestKey(ctx,path,key),requestDigest=digest(canonical(input));let q:ReturnType<typeof queryBody>|undefined;
 if(creating){keys(input,['title','query','expectedInputDigest']);text(input.title,'报告标题',200);if(typeof input.expectedInputDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedInputDigest))throw new DomainError(400,'生成报告须提供预览的完整输入摘要');q=queryBody(input.query,family);}
 else keys(input,match![2]==='submit'?['expectedRevision','expectedPayloadDigest']:['expectedRevision','expectedPayloadDigest','decision','comment']);
 return workScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{
  for(let attempt=0;attempt<3;attempt++){
   const client=await pool.connect();try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await verifyAnalysisSchema(client);await client.query('SELECT revision FROM business_state WHERE tenant_id=$1 FOR SHARE',[ctx.tenantId]);await verifiedReadStamp(pool,client,ctx.tenantId,undefined,true);check();
    const existing=creating?null:await readReportSql(client,ctx,match![1],true,family);if(q)await replayDeviceAccessSql(client,ctx,q.device);
    const prior=(await client.query('/* IDMS_REPORT_RECEIPT */ SELECT tenant_id,report_id::text,revision,request_digest FROM analysis_report_events WHERE tenant_id=$1 AND request_key=$2',[ctx.tenantId,requestKey])).rows;check();accountValue(prior);
    if(prior.length){if(prior.length!==1||prior[0].tenant_id!==ctx.tenantId)throw reportIntegrity();const loaded=existing||await readReportSql(client,ctx,prior[0].report_id,true,family);if(prior[0].report_id!==loaded.state.reportId)throw reportIntegrity();if(prior[0].request_digest!==requestDigest)throw new DomainError(409,'报告幂等键已用于不同请求');let state=null;for(const event of loaded.events){state=appendReportState(state,event);if(event.revision===prior[0].revision){if(event.request_key!==requestKey||event.request_digest!==requestDigest)throw reportIntegrity();break;}}if(!state||state.revision!==prior[0].revision)throw reportIntegrity();const result=reportReceipt(state);reserveCommandResult(result);check();await client.query('COMMIT');return result;}
    let event,payload=null;
    if(creating){payload=family==='COVERAGE'?freezeCoveragePayload(await replayInputsSql(client,ctx,q!)):family==='COVERAGE_V2'?freezeCoveragePayloadV2(await replayInputsSqlV2(client,ctx,q!)):freezeOperationalPayload(await operationalInputsSql(client,ctx,q as ReturnType<typeof operationalQuery>));accountValue(payload);if(payload.inputDigest!==input.expectedInputDigest)throw new DomainError(409,'历史输入或当前权限已变化，请重新预览后冻结');event=reportGenerated(payload,input.title,ctx,requestKey,requestDigest,await reportClockSql(client));}
    else {const action=match![2]==='submit'?'SUBMITTED':input.decision;if(action!=='SUBMITTED'&&action!=='APPROVED'&&action!=='RETURNED'&&action!=='REJECTED')throw new DomainError(400,'报告审批决定无效');event=reportChanged(existing!.state,action,input,ctx,requestKey,requestDigest,await reportClockSql(client));}
    await insertReportEventSql(client,event,payload);const state=appendReportState(existing?.state||null,event),result=reportReceipt(state);reserveCommandResult(result);check();await client.query('COMMIT');return result;
   }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['23505','40001'].includes(String((error as {code?:unknown})?.code))&&attempt<2){check();continue;}if(error instanceof DomainError)throw error;throw reportIntegrity();}finally{client.release();}
  }throw reportIntegrity();
 },true),requestSignal());
}
export async function reportReadSql(pool:pg.Pool,ctx:AccessContext,id:string,exporting:boolean,verify:(c:pg.PoolClient)=>Promise<void>,family:ReportFamily='COVERAGE'){
 requireAccess(ctx,'read');return sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const client=await pool.connect();try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verifyAnalysisSchema(client);await verify(client);const loaded=await readReportSql(client,ctx,id,true,family),result=exporting?{format:family==='COVERAGE'?'idms-frozen-coverage-export-v1':family==='COVERAGE_V2'?'idms-frozen-coverage-export-v2':'idms-frozen-operational-export-v1',report:loaded.state,events:loaded.events,payload:loaded.payload,verification:'SHA_AND_RECOMPUTATION_NOT_AN_EXTERNAL_SIGNATURE',notice:'包包含完整冻结计算输入和审批事件；可独立验证摘要与重算。普通SHA不能证明外部签名或独立可信时间。'}:{...loaded.state,events:loaded.events,payload:loaded.payload,bodyVerified:true,readOnly:true,fieldCommissioned:false};accountValue(result);check();await client.query('COMMIT');return result;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});if(e instanceof DomainError)throw e;throw reportIntegrity();}finally{client.release();}},true),requestSignal());
}
export async function reportListSql(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,verify:(c:pg.PoolClient)=>Promise<void>,family:ReportFamily='COVERAGE'){
 requireAccess(ctx,'read');const allowed=['page','pageSize','deviceCode'];if([...params.keys()].some(k=>!allowed.includes(k))||new Set(params.keys()).size!==[...params.keys()].length)throw new DomainError(400,'报告列表含未知或重复参数');const page=Number(params.get('page')||1),pageSize=Number(params.get('pageSize')||20),device=params.get('deviceCode');if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100||device!==null&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(device))throw new DomainError(400,'报告分页或设备筛选无效');const scope=scopeFilter(ctx),values=[ctx.tenantId,scope.sites,scope.lines,scope.devices,device];
 const selected=`FROM analysis_report_events e JOIN current_assets a ON a.tenant_id=e.tenant_id AND a.device_code=e.metadata->>'deviceCode' WHERE e.tenant_id=$1 AND e.action='GENERATED' AND ${family==='COVERAGE'?"NOT(e.metadata ? 'kind')":family==='COVERAGE_V2'?"e.metadata->'kind'=to_jsonb('COVERAGE_V2'::text)":"e.metadata->'kind'=to_jsonb('OPERATIONAL_METRICS'::text)"} AND ($2::text[] IS NULL OR a.site_code=ANY($2)) AND ($3::text[] IS NULL OR a.line_code=ANY($3)) AND ($4::text[] IS NULL OR a.device_code=ANY($4)) AND ($5::text IS NULL OR a.device_code=$5)`;
 return sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const client=await pool.connect();try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verifyAnalysisSchema(client);await verify(client);const integrity=(await client.query("/* IDMS_REPORT_LIST_INTEGRITY */ SELECT (SELECT count(*)::text FROM analysis_report_events WHERE tenant_id<>$1) AS foreign_count,(SELECT count(*)::text FROM (SELECT report_id FROM analysis_report_events WHERE tenant_id=$1 GROUP BY report_id HAVING count(*) FILTER(WHERE action='GENERATED')<>1 OR max(revision)<>count(*) OR count(*)>3 OR count(*) FILTER(WHERE action='GENERATED' AND metadata ? 'kind' AND metadata->'kind' IS DISTINCT FROM to_jsonb('OPERATIONAL_METRICS'::text) AND metadata->'kind' IS DISTINCT FROM to_jsonb('COVERAGE_V2'::text))>0) q) AS invalid_count",[ctx.tenantId])).rows;check();if(integrity.length!==1||integrity[0].foreign_count!=='0'||integrity[0].invalid_count!=='0')throw reportIntegrity();
  const heads=(await currentQuery(client,`/* IDMS_REPORT_LIST_HEAD */ SELECT count(*)::text AS count ${selected}`,values)).rows;check();if(heads.length!==1)throw reportIntegrity();const total=count(heads[0].count),ids=(await currentQuery(client,`/* IDMS_REPORT_LIST_IDS */ SELECT e.tenant_id,e.report_id::text ${selected} ORDER BY e.occurred_at DESC,e.report_id DESC LIMIT $6 OFFSET $7`,[...values,pageSize,(page-1)*pageSize])).rows;check();if(ids.length!==Math.max(0,Math.min(pageSize,total-(page-1)*pageSize))||new Set(ids.map(r=>r.report_id)).size!==ids.length)throw reportIntegrity();const items=[];
  for(const id of ids){if(id.tenant_id!==ctx.tenantId)throw reportIntegrity();const {state}=await readReportSql(client,ctx,id.report_id,false,family);if(device&&state.summary.deviceCode!==device)throw reportIntegrity();items.push({...state,bodyVerified:false});}
  const result={items,total,page,pageSize,readOnly:true,notice:'列表校验当前权限与审批摘要链；打开报告时核验完整冻结输入并独立重算。旧权限不会恢复，SHA不等于外部签名。'};accountValue(result);check();await client.query('COMMIT');return result;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});if(e instanceof DomainError)throw e;throw reportIntegrity();}finally{client.release();}},true),requestSignal());
}

