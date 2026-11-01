import {loadReadinessPolicy,RuntimeReadiness} from './runtime-readiness.ts';
import {runtimeDependencyTasks} from './runtime-adapters.ts';
import {runtimeResources} from './runtime-resources.ts';
import {runtimeStatusRoutes} from './runtime-status-route.ts';
import {PostgresAuthStore} from './auth-store.ts';
import {readSparesHistoryCurrent} from './spares-history-db.ts';
import {applicationVersion} from './version.ts';
import {readSparesQuery} from './spares-query-db.ts';
import type {SpareEndpoint} from './spares-query-plan.ts';
import {beginHttpResponse,publicFailure,failureDiagnostic,readPublicAsset} from './http-boundary.ts';
import {FieldIntakeService} from './field-intake.ts';
import {readSpares,commandSparesCurrent} from './spares-db.ts';
import {fieldGovernanceSqlRead} from './field-governance-sql.ts';
import {FieldPlatformService} from './field-platform.ts';
import {telemetryCoverageSqlRead} from './plan-coverage-sql.ts';
import {coverageReplaySqlReadV2} from './coverage-replay-sql-v2.ts';
import {telemetryQualitySqlReadV2} from './telemetry-quality-sql-v2.ts';
import {telemetryCoverageSqlReadV2} from './plan-coverage-sql-v2.ts';
import {qualityPolicySqlReadV2} from './quality-policy-sql-v2.ts';
import {coverageReplaySqlRead} from './coverage-replay-sql.ts';
import {operationalMetricsSqlRead} from './operational-metrics-sql.ts';
import {isReportPath,reportCommandSql,reportReadSql,reportListSql} from './report-api-sql.ts';
import {telemetryQualitySqlRead} from './telemetry-quality-sql.ts';
import {sourceGovernanceSqlRead} from './source-governance-sql.ts';
import {readBatchSql,batchReadPath} from './batch-read-sql.ts';
import {BatchReadError} from './batch-pages.ts';
import {streamCsvExport,closeCsvExports} from './data-export-stream.ts';
import {CsvExportError} from './csv-chunks.ts';
import type {ReadWorkspace} from './read-model.ts';
import {readRuntimeApi} from './read-api.ts';
import {parseAuditPage} from './audit-page.ts';
import {AuditPageError} from './audit-cursor.ts';
import {withRequestCapacity,bindRequestTenant,readRequestBytes,reserveResponse,stopHttpAdmission} from './request-capacity.ts';
import {CapacityError,workScheduler,sqlScheduler,accountValue} from './capacity.ts';
import type {Workspace} from './tenant-workspace.ts';
import {workerInstanceId} from './outbox-worker.ts';
import {createRuntimeAuthStore} from './auth-store.ts';
import {verifySqlRead,verifiedReadStamp} from './read-integrity.ts';
import {commandAccess} from './command-access.ts';
import {equipmentBindingForDevice,profilePoints} from './equipment-profiles.ts';
import {dataScope} from './data-scope.ts';
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { appendAudit } from "./audit.ts";
import { authConfigFromEnv, createAuth } from './auth.ts';
import { requireAccess } from './access.ts';
import { approveAlarm, DomainError, reviewAlarm } from "./service.ts";
import { approvePredictiveAlert } from "./predictive.ts";
import { seedStore } from "./store.ts";
import { clearImports, importApi, importWriteApi, importData as rootImportData, loadRuntimeImports, mutate, transactionalRequest, waitForWrites,consistentRead,clearWorkspaceCache } from "./import-api.ts";
import { canonical, digest, authorize,createBatch,present } from "./imports.ts";
import { closePostgres, storageMode,tenantPool,runtimeDatabaseBindings } from "./postgres-repository.ts";
import { analyzeDevice } from "./predictive-analysis.ts";
import { TelemetryService } from './telemetry.ts';
import { WorkflowService } from './workflow.ts';
import { AiImportService } from './ai-import-review.ts';
import type pg from 'pg';
import {dataOverview,dataMeasurements} from './data-management.ts';
import {exportFilters,assetCsv,measurementCsv} from './data-export.ts';
import {dataOverviewSql,dataMeasurementsSql} from './data-management-sql.ts';
import { approveTemplate, activatePlugin, certifyPlugin, createPlugin, createTemplate, submitTemplate, editTemplate, importTemplate, loadPluginTrust } from './catalog.ts';

export const store = seedStore();
const rootStore=store;
if (process.env.NODE_ENV === "production") throw new Error("生产发布门禁：仍需完成容量/高可用、TLS与秘密管理、跨服务备份恢复及部署验收；本机OIDC与共享会话集成不等同于商用验收。");
const runtimeHistory=await loadRuntimeImports(store);
const authConfig=authConfigFromEnv(),authState=await createRuntimeAuthStore(authConfig,storageMode);
const auth = createAuth(authConfig, async (who, action) => {
  if (!store.tenants.some(t => t.id === who.tenantId && t.status === 'ACTIVE')) throw new DomainError(403, '企业不存在或已停用');
  await mutate(store, (_client,{store}) => appendAudit(store, { tenantId: who.tenantId, objectType: 'AUTHENTICATION', objectId: who.actorId, action, actorType: 'USER', actorId: who.actorId, correlationId: randomUUID(), metadata: { authMode: 'oidc', roles: who.roles || [] } }),storageMode==='postgres-tenant-databases'?who.tenantId:undefined);
},authState);
const telemetry=new TelemetryService();await telemetry.start(store);
const fieldPlatform=new FieldPlatformService();await fieldPlatform.start(store);
const fieldIntake=new FieldIntakeService(fieldPlatform);await fieldIntake.start();
const workflow = new WorkflowService();
await workflow.start(store,runtimeHistory);
const ai=new AiImportService();await ai.start(store,runtimeHistory);
const readinessConfiguration=await loadReadinessPolicy(process.env.IDMS_READINESS_CONFIG);
const readiness=new RuntimeReadiness(readinessConfiguration.policy,runtimeDependencyTasks({
  databases:runtimeDatabaseBindings(),authConfig,authState,workflow,ai,telemetry,predictorUrl:process.env.IDMS_PREDICTOR_URL
}),{code:readinessConfiguration.code,enterprise:storageMode==='postgres-tenant-databases' && authConfig.mode==='oidc'});
const handleRuntimeStatus=runtimeStatusRoutes(readiness,()=>{
  const pools=runtimeDatabaseBindings().flatMap(b=>[b.pool,...(b.workerPool?[b.workerPool]:[])]);
  if(authState instanceof PostgresAuthStore)pools.push(authState.pool);
  return runtimeResources(pools);
},process.env.IDMS_SERVICE_TOKEN,()=>({contract:'IDMS_EXISTING_MAIN_V1',telemetryConnected:telemetry.connected,telemetrySubscribed:telemetry.subscribed,telemetryClosing:telemetry.closing,telemetryIntake:telemetry.intake.snapshot()}));
readiness.start();
const PORT = Number(process.env.PORT || 4010);
const MAX_BODY_BYTES = 1024 * 1024;

function json(res: ServerResponse, status: number, data: unknown) {
  if(res.destroyed||res.writableEnded)return;
  const text=JSON.stringify(data);if(status<400)reserveResponse(Buffer.byteLength(text));res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}
async function body(req: IncomingMessage,maximum=MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared=req.headers['content-length'];
  const readLimit=maximum>MAX_BODY_BYTES&&typeof declared==='string'&&/^\d+$/.test(declared)&&Number(declared)<=MAX_BODY_BYTES?MAX_BODY_BYTES:maximum;
  const raw=await readRequestBytes(req,readLimit);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString("utf8")); } catch { throw new DomainError(400, "JSON 请求体无效"); }
}
async function context(req: IncomingMessage) {
  const ctx = await auth.context(req), tenantId = ctx.tenantId;
  if (!tenantId || !store.tenants.some(t => t.id === tenantId && t.status === "ACTIVE")) throw new DomainError(401, "缺少或无效的 X-Tenant-Id");
  return ctx;
}
function page<T>(items: T[]) { return { items, total: items.length, page: 1, pageSize: 100 }; }

export async function handler(req: IncomingMessage, res: ServerResponse) {
  const requestId=beginHttpResponse(res);
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (handleRuntimeStatus(req,res,url)) return;
    if (url.pathname === "/api/v1/health") return json(res, 200, { status: "UP", version: applicationVersion, mode: "predictive-maintenance-development", receiptIdentity:'persisted-uuid-receipt-binding-2.0.0',fieldTransactionalIntake:fieldIntake.state(),fieldChannelGovernance:storageMode==='postgres-tenant-databases'?'scoped-field-channel-view-v1':'disabled',fieldLeaseCurrentCheck:fieldPlatform.configured?'signed-read-only-field-check-v1':'disabled',fieldLeaseIssuance:fieldPlatform.configured?'approved-audited-field-lease-v1':'disabled',sourceGovernance:'approved-source-binding-v1',operationalMetrics:'approved-frozen-operational-v1', qualityPolicyGovernance:'approved-effective-quality-rules-v1',coverageReplay:'asof-all-inputs-v1',frozenCoverageReports:'append-only-independent-report-v1',configurationHistory:'observed-registry-chain-v1',calendarHistory:'effective-and-known-at-v1',calendarRecurrence:'frozen-weekly-exceptions-v1',plannedCoverage:'approved-operation-calendar-v1',coverageDefinitionNormalization:'approved-point-values-v1',telemetryQuality:'scoped-snapshot-quality-v1',coldInputProof:storageMode==='postgres-tenant-databases'?'dual-stream-input-proof-v1':'full-file-snapshot',coldImportProof:storageMode==='postgres-tenant-databases'?'batchwise-input-fact-proof-v1':'full-file-snapshot',batchReads:storageMode==='postgres-tenant-databases'?'verified-input-fact-pages-v1':'bounded-file-array-pages-v1', coldReadVerification:storageMode==='postgres-tenant-databases'?'segmented-canonical-proof-v1':'full-file-snapshot', csvExport:storageMode==='postgres-tenant-databases'?'verified-two-pass-cursor-v1':'bounded-file-array-v1', writePostImage:storageMode==='postgres-tenant-databases'?'single-statement-row-compare-v1':'atomic-file-snapshot', auditPagination:storageMode==='postgres-tenant-databases'?'verified-window-keyset-v1':'file-demo-window-keyset-v1', readBodies:storageMode==='postgres-tenant-databases'?'scoped-original-and-audit-v1':'file-demo-snapshot',runtimeBootstrap:storageMode==='postgres-tenant-databases'?'verified-bindings-only-v1':'full-file-demo', resourceAdmission:storageMode==='postgres-tenant-databases'?'bounded-resource-admission-v1':'bounded-http-demo-v1',stateReconstruction:storageMode==='postgres-tenant-databases'?'single-statement-row-stream-v1':'atomic-local-snapshot',commandWorkspaces:storageMode==='postgres-tenant-databases'?'explicit-tenant-workspace-v1':'serialized-file-snapshot',backgroundDispatch:storageMode==='postgres-tenant-databases'?'leased-fenced-outbox-v1':'disabled',dispatcherInstanceId:workerInstanceId,authentication: auth.mode,sessionStorage:auth.storage, storage: storageMode, dataReadIsolation:storageMode==='postgres-tenant-databases'?'verified-mvcc-repeatable-read-v1':'serialized-file-snapshot',dataManagementQueries:storageMode==='postgres-tenant-databases'?'typed-sql-read-model':'file-snapshot', dataImportMappings:'published-file-mapping-v1',equipmentProfiles:'frozen-inherited-equipment-profile-v1',businessPersistence:storageMode==='postgres-tenant-databases'?'normalized-entities-v3':'atomic-local-snapshot',crossInstanceTransactions:storageMode==='postgres-tenant-databases',time: new Date().toISOString() });
    return await withRequestCapacity(req,res,async()=>{
    if (!url.pathname.startsWith("/api/")) {
      if(!['GET','HEAD'].includes(req.method||'')){res.setHeader('Allow','GET, HEAD');throw new DomainError(405,'页面资源仅支持GET和HEAD');}
      const {file,contentType}=await readPublicAsset(url.pathname);
      reserveResponse(file.length);res.writeHead(200,{'content-type':contentType,'content-length':file.length,'cache-control':'no-cache'});res.end(req.method==='HEAD'?undefined:file);return;
    }
    if(['/api/v1/field-channel/lease','/api/v1/field-channel/lease/check'].includes(url.pathname)){
      if(req.method!=='POST')throw new DomainError(404,'现场签发接口不存在');if(url.search)throw new DomainError(400,'现场签发不接受查询参数');if(req.headers.origin!==undefined||req.headers.cookie!==undefined)throw new DomainError(401,'现场签发仅接受来源机器认证');if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw new DomainError(415,'现场签发需要JSON请求');return json(res,200,await (url.pathname.endsWith('/check')?fieldPlatform.checkCurrent(rootStore,await body(req,4096)):fieldPlatform.issue(rootStore,await body(req,4096))));
    }
    if (await auth.handle(req, res, url)) return;

    const ctx = await context(req);
    authorize(ctx, "read");bindRequestTenant(ctx.tenantId);
    if(['/api/v1/spares/summary','/api/v1/spares/list','/api/v1/spares/detail','/api/v1/spares/options','/api/v1/spares/workorder-usage','/api/v1/spares/material-plans','/api/v1/spares/stock-insight','/api/v1/spares/replacement-insight'].includes(url.pathname)){
      if(storageMode!=='postgres-tenant-databases')throw new DomainError(503,'备件采购模块需要企业PostgreSQL数据库');
      if(req.method!=='GET'){res.setHeader('Allow','GET');throw new DomainError(405,'备件查询仅支持GET');}const pool=tenantPool(ctx.tenantId),endpoint=url.pathname.slice('/api/v1/spares/'.length) as SpareEndpoint;
      return json(res,200,await readSparesQuery(pool,ctx,endpoint,url.searchParams,c=>verifySqlRead(pool,c,ctx.tenantId)));
    }
    if(['/api/v1/spares','/api/v1/spares/commands','/api/v1/spares/history'].includes(url.pathname)){
      if(storageMode!=='postgres-tenant-databases')throw new DomainError(503,'备件采购模块需要企业PostgreSQL数据库');
      const write=url.pathname.endsWith('/commands'),history=url.pathname.endsWith('/history');if(req.method!==(write?'POST':'GET')||!history&&url.search)throw new DomainError(400,'备件接口方法或参数无效');
      const payload=write?await body(req):{};if(write&&(typeof payload.action!=='string'||!payload.input||typeof payload.input!=='object'||Array.isArray(payload.input)||Object.keys(payload).some(k=>!['action','input'].includes(k))))throw new DomainError(400,'备件请求须包含action和input');
      const pool=tenantPool(ctx.tenantId);
      if(write)return json(res,200,await commandSparesCurrent(pool,ctx,payload.action as string,payload.input as Record<string,unknown>,String(req.headers['idempotency-key']||''),async c=>{await verifiedReadStamp(pool,c,ctx.tenantId,undefined,true);}));
      if(history)return json(res,200,await readSparesHistoryCurrent(pool,ctx,url.searchParams,c=>verifySqlRead(pool,c,ctx.tenantId)));
      // Explicit legacy full-state compatibility entrance; current UI never uses it.
      return json(res,200,await consistentRead(rootStore,ctx.tenantId,async workspace=>{const view=dataScope(workspace.imports,ctx,workspace.store),refs={devices:[...view.assets].filter(([code])=>view.device(code)).map(([code,a])=>({code,name:String(a.device_name),siteCode:String(a.site_code)})),orders:workspace.store.workOrders.filter(o=>view.order(o)).map(o=>({id:o.id,deviceCode:o.deviceCode,assignee:o.assignee,state:o.state}))};return readSpares(pool,ctx,refs);}));
    }
    if(['/api/v1/field-channel/governance','/api/v1/field-channel/governance/export'].includes(url.pathname)){
      if(req.method!=='GET')throw new DomainError(404,'现场治理视图仅支持读取');if(storageMode!=='postgres-tenant-databases')throw new DomainError(503,'现场治理视图需要独立企业PostgreSQL');const pool=tenantPool(ctx.tenantId),exporting=url.pathname.endsWith('/export'),result=await fieldGovernanceSqlRead(pool,ctx,url.searchParams,fieldPlatform.publicSnapshot(ctx.tenantId),exporting,c=>verifySqlRead(pool,c,ctx.tenantId));await fieldPlatform.verifyRecoveryCurrent(ctx.tenantId);if(exporting)res.setHeader('Content-Disposition','attachment; filename="idms-field-governance-view.json"');return json(res,200,result);
    }
    if(url.pathname==='/api/v1/telemetry/source-governance'||url.pathname==='/api/v1/telemetry/source-governance/export'){
      if(req.method!=='GET')throw new DomainError(404,'来源治理证据仅支持读取');if(storageMode!=='postgres-tenant-databases')throw new DomainError(503,'来源治理证据要求PostgreSQL存储');const pool=tenantPool(ctx.tenantId),exporting=url.pathname.endsWith('/export'),result=await sourceGovernanceSqlRead(pool,ctx,url.searchParams,telemetry.config?.sources||[],exporting,client=>verifySqlRead(pool,client,ctx.tenantId));if(exporting)res.setHeader('Content-Disposition','attachment; filename="idms-source-governance.json"');return json(res,200,result);
    }
    if(['/api/v1/quality-policy-evaluation','/api/v1/quality-policy-evaluation/export','/api/v1/quality-policy-evaluation-v2','/api/v1/quality-policy-evaluation-v2/export'].includes(url.pathname)){
      if(req.method!=='GET')throw new DomainError(404,'质量策略评估仅支持读取');if(storageMode!=='postgres-tenant-databases')throw new DomainError(503,'历史质量策略评估要求PostgreSQL存储');const pool=tenantPool(ctx.tenantId),exporting=url.pathname.endsWith('/export'),result=await (url.pathname.includes('evaluation-v2')?qualityPolicySqlReadV2:qualityPolicySqlRead)(pool,ctx,url.searchParams,exporting,client=>verifySqlRead(pool,client,ctx.tenantId));if(exporting)res.setHeader('Content-Disposition','attachment; filename="idms-quality-policy-evaluation.json"');return json(res,200,result);
    }
    if(url.pathname==='/api/v1/coverage-replay'||url.pathname==='/api/v1/coverage-replay-v2'||url.pathname==='/api/v1/operational-metrics'||isReportPath(url.pathname)){
      if(storageMode!=='postgres-tenant-databases')throw new DomainError(503,'完整历史复核与冻结报告要求PostgreSQL存储');
      const pool=tenantPool(ctx.tenantId),verify=(client:pg.PoolClient)=>verifySqlRead(pool,client,ctx.tenantId);
      if(url.pathname==='/api/v1/coverage-replay'||url.pathname==='/api/v1/coverage-replay-v2'){if(req.method!=='GET')throw new DomainError(404,'历史复核接口仅支持读取');return json(res,200,await (url.pathname.endsWith('-v2')?coverageReplaySqlReadV2:coverageReplaySqlRead)(pool,ctx,url.searchParams,verify));}
      if(url.pathname==='/api/v1/operational-metrics'){if(req.method!=='GET')throw new DomainError(404,'运营指标接口仅支持读取');return json(res,200,await operationalMetricsSqlRead(pool,ctx,url.searchParams,verify));}
      if(req.method==='POST'){if(url.searchParams.size)throw new DomainError(400,'报告写入不接受URL查询参数');const input=await body(req);if(!input||typeof input!=='object'||Array.isArray(input))throw new DomainError(400,'报告请求体须为JSON对象');return json(res,200,await reportCommandSql(pool,ctx,url.pathname,input,String(req.headers['idempotency-key']||'')));}
      if(req.method!=='GET')throw new DomainError(404,'报告接口不存在');
      const family=url.pathname.startsWith('/api/v1/operational-reports')?'OPERATIONAL_METRICS':url.pathname.startsWith('/api/v1/coverage-v2-reports')?'COVERAGE_V2':'COVERAGE';
      if(url.pathname==='/api/v1/coverage-reports'||url.pathname==='/api/v1/coverage-v2-reports'||url.pathname==='/api/v1/operational-reports')return json(res,200,await reportListSql(pool,ctx,url.searchParams,verify,family));
      if(url.searchParams.size)throw new DomainError(400,'报告详情不接受查询参数');const match=/^\/api\/v1\/(?:coverage(?:-v2)?|operational)-reports\/([a-f0-9-]+)(\/export)?$/.exec(url.pathname);if(!match)throw new DomainError(404,'报告读取接口不存在');const result=await reportReadSql(pool,ctx,match[1],!!match[2],verify,family);if(match[2])res.setHeader('Content-Disposition',`attachment; filename="idms-${family==='COVERAGE'?'coverage':family==='COVERAGE_V2'?'coverage-v2':'operational'}-report-${match[1]}.json"`);return json(res,200,result);
    }
    const auditPage=req.method==='GET'&&url.pathname==='/api/v1/audit'?parseAuditPage(url.searchParams,ctx,auth.auditCursors):undefined;
    if(req.method==='GET'&&storageMode==='postgres-tenant-databases'&&['/api/v1/telemetry/coverage','/api/v1/telemetry/coverage-v2'].includes(url.pathname)){const pool=tenantPool(ctx.tenantId);return json(res,200,await (url.pathname.endsWith('-v2')?telemetryCoverageSqlReadV2:telemetryCoverageSqlRead)(pool,ctx,url.searchParams,telemetry.config?.sources||[],client=>verifySqlRead(pool,client,ctx.tenantId)));}
    if(req.method==='GET'&&storageMode==='postgres-tenant-databases'&&['/api/v1/telemetry/quality','/api/v1/telemetry/quality-v2'].includes(url.pathname)){const pool=tenantPool(ctx.tenantId);return json(res,200,await (url.pathname.endsWith('-v2')?telemetryQualitySqlReadV2:telemetryQualitySqlRead)(pool,ctx,url.searchParams,telemetry.config?.sources||[],client=>verifySqlRead(pool,client,ctx.tenantId)));}
    if(req.method==='GET'&&storageMode==='postgres-tenant-databases'&&batchReadPath(url.pathname)){const pool=tenantPool(ctx.tenantId);return json(res,200,await readBatchSql(pool,ctx,url,client=>verifySqlRead(pool,client,ctx.tenantId)));}
    // Data SQL reads use one independently verified MVCC snapshot. They neither
    // rebuild/apply global state nor queue behind unrelated business/network work.
    if(req.method==='GET'&&storageMode==='postgres-tenant-databases'&&['/api/v1/data-management/overview','/api/v1/data-management/measurements','/api/v1/data-management/assets/export','/api/v1/data-management/measurements/export'].includes(url.pathname)){
      const exporting=url.pathname.endsWith('/export'),assets=url.pathname.endsWith('/overview')||url.pathname.endsWith('/assets/export'),pool=tenantPool(ctx.tenantId),params=exporting?exportFilters(url.searchParams):url.searchParams;
      const verify=(client:pg.PoolClient)=>verifySqlRead(pool,client,ctx.tenantId);
      if(exporting)return await streamCsvExport(pool,ctx,params,assets,res,verify);
      const result=assets?await dataOverviewSql(pool,ctx,params,false,verify):await dataMeasurementsSql(pool,ctx,params,false,verify);
      if(!res.destroyed)return json(res,200,result);return;
    }
    const respondRead=async(workspace:ReadWorkspace)=>{
     const {store,imports}=workspace;
     if(await importApi(req,res,url,ctx,store,ai,imports,workspace.readOriginal))return;
     if(['/api/v1/data-management/assets/export','/api/v1/data-management/measurements/export'].includes(url.pathname)){
      const params=exportFilters(url.searchParams),assets=url.pathname.endsWith('/assets/export');
      const content=assets?assetCsv(dataOverview(imports,ctx,params,true)):measurementCsv(dataMeasurements(imports,ctx,params,true));
      if(res.destroyed)return;reserveResponse(Buffer.byteLength(content));res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="idms-${assets?'assets':'measurements'}.csv"`,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(content);return;
     }
     return json(res,200,await readRuntimeApi(url,ctx,workspace,{telemetry,workflow,ai,authMode:auth.mode,auditPage,auditCursors:auth.auditCursors}));
    };
    const respond=async(workspace:Workspace={store:rootStore,imports:rootImportData})=>{
    const {store,imports:importData}=workspace;
    if (await importWriteApi(req, res, url, ctx, store,ai)) return;
    const key = String(req.headers["idempotency-key"] || "");
    const writing = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "");
    if (writing && url.pathname === '/api/v1/demo/reset' && (auth.mode !== 'demo' || storageMode === 'postgres-tenant-databases')) throw new DomainError(403, '数据库或真实身份模式禁止演示重置');
    if (writing && (key.length < 8 || key.length > 128)) throw new DomainError(400, "写接口须提供8–128字符的 Idempotency-Key");
    const catalogBody=/^\/api\/v1\/templates(?:\/import|\/[^/]+\/edit)?$/.test(url.pathname);
    const requestInput = writing ? await body(req,catalogBody?8*1024*1024:MAX_BODY_BYTES) : {};
    if (!requestInput || typeof requestInput !== "object" || Array.isArray(requestInput)) throw new DomainError(400, "请求体须为JSON对象");
    const cachedKey = `${ctx.tenantId}:${ctx.actorId}:${ctx.actorType}:${req.method}:${url.pathname}:${key}`;
    const execute = async (client?: pg.PoolClient,commandWorkspace:Workspace=workspace) => {
    if(storageMode==='postgres-tenant-databases'&&commandWorkspace.store===rootStore)throw new DomainError(503,'业务执行必须加载当前企业工作区');
    const {store,imports:importData}=commandWorkspace;
    const view=dataScope(importData,ctx,store);
    let result: unknown;
if (req.method==='POST'&&url.pathname==='/api/v1/equipment-profiles/points') {
      if(Object.keys(requestInput).some(k=>k!=='deviceCode')||typeof requestInput.deviceCode!=='string')throw new DomainError(400,'仅允许指定已批准设备编码');
      const binding=equipmentBindingForDevice(store,importData,requestInput.deviceCode,ctx),asset=view.records.find(r=>r.dataType==='DEVICE'&&r.value.device_code===requestInput.deviceCode)!,rows=profilePoints(binding,requestInput.deviceCode);
      const batch=createBatch(importData,store,{dataType:'POINT_DEFINITION',templateVersion:'1.0.0',sourceSystem:asset.sourceSystem,rows,original:Buffer.from(JSON.stringify({binding,deviceCode:requestInput.deviceCode,rows})),filename:'generated-point-definitions.json',mime:'application/json',sourceKind:'PROFILE_GENERATED',profileDeviceCode:requestInput.deviceCode,aiMode:ai.mode('demo',ctx)},ctx);await ai.enqueue(store,client,batch,ctx);result=present(batch);
    }
else if (req.method==='POST'&&url.pathname==='/api/v1/telemetry/analyze') {
      if(Object.keys(requestInput).some(k=>k!=='edgeId')||typeof requestInput.edgeId!=='string')throw new DomainError(400,'只允许指定授权采集源edgeId');
      result=await telemetry.analyze(store,requestInput.edgeId,ctx,importData);
    }
else if (req.method === "POST" && url.pathname === "/api/v1/predictive/analyze") {
      if (typeof requestInput.deviceCode !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(requestInput.deviceCode)) throw new DomainError(400,"设备编码无效");
      result = await analyzeDevice(store, importData, requestInput.deviceCode, ctx);
    }
else if (req.method === "POST" && /^\/api\/v1\/work-orders\/[^/]+\/(claim|start|submit|approval)$/.test(url.pathname)) result = await workflow.change(client, store, url.pathname.split("/")[4], url.pathname.split("/")[5], requestInput, ctx,importData);
else if (req.method === "POST" && /^\/api\/v1\/work-orders\/[^/]+\/workflow\/retry$/.test(url.pathname)) result = await workflow.retry(store, client, url.pathname.split("/")[4], ctx,importData);
else if (req.method === "POST" && /^\/api\/v1\/alarms\/[^/]+\/ai-review$/.test(url.pathname)) { requireAccess(ctx, 'alarm:review'); result = reviewAlarm(store, url.pathname.split("/")[4], ctx,importData); }
else if (req.method === "POST" && /^\/api\/v1\/alarms\/[^/]+\/approval$/.test(url.pathname)) {
      requireAccess(ctx, 'alarm:approve');
      const input = requestInput; result = approveAlarm(store, url.pathname.split("/")[4], String(input.decision) as "APPROVED" | "REJECTED" | "RETURNED", String(input.comment || ""), ctx,importData);
    }
else if (req.method === "POST" && /^\/api\/v1\/predictive\/alerts\/[^/]+\/approval$/.test(url.pathname)) {
      const input = requestInput;
      const alert = store.predictiveAlerts.find(a => a.id === url.pathname.split("/")[5] && a.tenantId === ctx.tenantId && view.device(a.deviceCode));
      if (!alert) throw new DomainError(404, "预测告警不存在");
      if (input.expectedVersion !== alert.version) throw new DomainError(409, "预测告警版本已变化，请刷新");
      result = approvePredictiveAlert(store, alert.id, String(input.decision) as "APPROVED" | "RETURNED", String(input.comment || ""), ctx,importData);
      if (String(input.decision) === "APPROVED") {
        const created = store.workOrders.find(order => order.alertId === alert.id && order.tenantId === ctx.tenantId);
        if (created) await workflow.queueCreate(store, client, created, ctx);
      }
    }
else if (req.method === 'POST' && url.pathname === '/api/v1/templates/import') {
      result=importTemplate(store,requestInput,ctx,importData,accountValue);
    }
else if (req.method === 'POST' && /^\/api\/v1\/templates\/[^/]+\/edit$/.test(url.pathname)) {
      result=editTemplate(store,url.pathname.split('/')[4],requestInput,ctx,importData,accountValue);
    }
else if (req.method === "POST" && url.pathname === "/api/v1/templates") {
      requireAccess(ctx, 'template:edit');
      result = createTemplate(store, requestInput, ctx,importData,accountValue);
    }
else if (req.method === "POST" && /^\/api\/v1\/templates\/[^/]+\/submit$/.test(url.pathname)) {
      requireAccess(ctx, 'template:submit'); result = submitTemplate(store, url.pathname.split("/")[4], requestInput, ctx,importData);
    }
else if (req.method === "POST" && /^\/api\/v1\/templates\/[^/]+\/approval$/.test(url.pathname)) {
      requireAccess(ctx, 'template:publish'); result = approveTemplate(store, url.pathname.split("/")[4], requestInput, ctx,importData);
    }
else if (req.method === "POST" && url.pathname === "/api/v1/plugins") {
      requireAccess(ctx, 'plugin:submit'); result = createPlugin(store, requestInput, ctx,await loadPluginTrust());
    }
else if (req.method === "POST" && /^\/api\/v1\/plugins\/[^/]+\/certify$/.test(url.pathname)) {
      requireAccess(ctx, 'plugin:certify'); result = certifyPlugin(store, url.pathname.split("/")[4], ctx,await loadPluginTrust());
    }
else if (req.method === "POST" && /^\/api\/v1\/plugins\/[^/]+\/activate$/.test(url.pathname)) {
      requireAccess(ctx, 'plugin:activate'); result = activatePlugin(store, url.pathname.split("/")[4], ctx);
    }
else if (req.method === "POST" && url.pathname === "/api/v1/demo/reset") {
      if (auth.mode !== 'demo' || ctx.tenantId !== "acme" || ctx.actorId !== "demo.admin" || ctx.actorType !== "USER") throw new DomainError(403, "演示重置仅允许演示模式管理员");
      if (storageMode === "postgres-tenant-databases") throw new DomainError(403, "数据库模式禁止清除历史和审计，请使用独立沙箱");
      clearImports(store, ctx.tenantId);
      const fresh = seedStore();
      store.devices = fresh.devices; store.alarms = fresh.alarms; store.approvals = fresh.approvals;
      for (const field of ["devices", "alarms", "approvals", "templates", "plugins", "healthSnapshots", "predictiveAlerts", "maintenanceRecommendations", "predictiveModels", "workOrders"] as const) {
        (store as unknown as Record<string, unknown>)[field] = [...store[field].filter(x => x.tenantId !== ctx.tenantId), ...fresh[field].filter(x => x.tenantId === ctx.tenantId)];
      }
      for (const key of store.idempotency.keys()) if (key.startsWith(ctx.tenantId + ":")) store.idempotency.delete(key);
      result = { reset:true, scenario:"spindle-alarm", message:"演示场景已重置" };
    }
else throw new DomainError(404, "接口不存在");    return result;
    };
    const result = writing ? await transactionalRequest(store, cachedKey, digest(canonical(requestInput)), execute, storageMode === 'postgres-tenant-databases' ? ctx.tenantId : undefined,({store,imports})=>commandAccess(url.pathname,req.method||'',requestInput,ctx,imports,store,telemetry.config?.sources||[])) : await execute();
    return json(res, 200, result);
    };
    return req.method==='GET'?await consistentRead(rootStore,ctx.tenantId,respondRead):await respond();
    });
  } catch (error) {
    if(res.destroyed||res.writableEnded)return;
    if(error instanceof BatchReadError)return json(res,error.status,{error:error.message,code:error.code});
    if(error instanceof CsvExportError)return json(res,error.status,{error:error.message,code:error.code});
    if(error instanceof AuditPageError)return json(res,error.status,{error:error.message,code:error.code});
    if(error instanceof CapacityError){res.setHeader('Retry-After',String(error.retryAfter));if(!req.complete)res.setHeader('Connection','close');return json(res,error.status,{error:error.message,code:error.code,retryAfterSeconds:error.retryAfter});}
    const failure=publicFailure(error,requestId);if(!(error instanceof DomainError))console.error('[IDMS request]',JSON.stringify(failureDiagnostic(error,requestId)));
    return json(res,failure.status,failure.body);
  }
}

export async function closeRuntime(){readiness.beginClose();stopHttpAdmission();await readiness.close();await fieldIntake.close();await fieldPlatform.close();await telemetry.close();await workflow.close();await ai.close();await closeCsvExports();await Promise.all([workScheduler.close(),sqlScheduler.close()]);await waitForWrites();clearWorkspaceCache();await auth.close();await closePostgres();}

if (process.env.NODE_ENV !== "test") {
  const server = createServer({headersTimeout:15000,requestTimeout:20000,maxHeaderSize:16384},handler);
  server.maxConnections=128;
  server.on("error", (error) => {
    console.error(`[IDMS startup] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`IDMS API http://127.0.0.1:${PORT}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {readiness.beginClose();stopHttpAdmission();server.close(async () => {await closeRuntime(); process.exit(0);});});
}
import {qualityPolicySqlRead} from './quality-policy-sql.ts';

