import {timelineCoverageResponse,coverageResponse,coverageQuery,uploadCoverage} from './plan-coverage.ts';
import {calendarTemplateVisible} from './operation-calendar.ts';
import {telemetryQualityQuery,qualityResponse,qualityIntake} from './telemetry-quality.ts';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {ReadWorkspace} from './read-model.ts';
import type {AccessContext} from './access.ts';
import {rolePermissions} from './access.ts';
import type {AuthConfig} from './auth.ts';
import type {TelemetryService} from './telemetry.ts';
import type {WorkflowService} from './workflow.ts';
import type {AiImportService} from './ai-import-review.ts';
import {dataScope,hasRestrictedScope,ownTaskScope} from './data-scope.ts';
import {DomainError} from './service.ts';
import {presentTemplate,exportTemplate,loadPluginTrust,pluginMetadataStatus} from './catalog.ts';
import {dataQuality} from './data-quality.ts';
import {recordHistory} from './import-revisions.ts';
import {dataOverview,dataMeasurements} from './data-management.ts';
import {storageMode} from './postgres-repository.ts';
import {predictiveOverview} from './predictive.ts';
import {orderFor} from './maintenance.ts';
import {auditPageResponse,type AuditPagePlan} from './audit-page.ts';
import type {AuditCursorCodec} from './audit-cursor.ts';
const page=<T>(items:T[])=>({items,total:items.length,page:1,pageSize:100});
export async function readRuntimeApi(url:URL,ctx:AccessContext,workspace:ReadWorkspace,services:{telemetry:TelemetryService;workflow:WorkflowService;ai:AiImportService;authMode:AuthConfig['mode'];auditPage?:AuditPagePlan;auditCursors:AuditCursorCodec}){
 const {store,imports:importData}=workspace,{telemetry,workflow,ai,authMode}=services,view=dataScope(importData,ctx,store);let result:unknown;
if (url.pathname==='/api/v1/equipment-profiles') result=page(store.templates.filter(t=>t.tenantId===ctx.tenantId&&t.manifest.purpose==='equipment-profile').map(presentTemplate));
else if (url.pathname==='/api/v1/telemetry/overview') result=await telemetry.overview(ctx.tenantId,ctx,workspace);
else if(url.pathname==='/api/v1/telemetry/coverage'){const now=Date.now();const q=coverageQuery(url.searchParams,now);result=q.planMode==='EFFECTIVE'?timelineCoverageResponse([],q,'TELEMETRY',null,now):coverageResponse([],q,'TELEMETRY',null,now);}
else if (url.pathname==='/api/v1/telemetry/quality') {const now=Date.now();result=qualityResponse([],telemetryQualityQuery(url.searchParams,now),now,false,qualityIntake([],0,0));}
else if(url.pathname==='/api/v1/data-management/coverage') result=uploadCoverage(importData,store,await workspace.readAudits(),ctx,url.searchParams);
else if (url.pathname==='/api/v1/data-management/quality') result=dataQuality(importData,ctx,url.searchParams);
else if (url.pathname==='/api/v1/data-management/history') result=recordHistory(importData,ctx,url.searchParams);
else if (url.pathname==='/api/v1/data-management/overview') result=dataOverview(importData,ctx,url.searchParams);
else if (url.pathname==='/api/v1/data-management/measurements') result=dataMeasurements(importData,ctx,url.searchParams);
else if (url.pathname==='/api/v1/telemetry/points') result=await telemetry.points(ctx.tenantId,url.searchParams.get('edgeId')||'',Number(url.searchParams.get('limit')||100),ctx,workspace);
else if (url.pathname==='/api/v1/telemetry/rejections') result=await telemetry.rejections(ctx.tenantId,url.searchParams.get('edgeId')||'',ctx,workspace);
else if (url.pathname === "/api/v1/overview") {
      const devices = store.devices.filter(x => x.tenantId === ctx.tenantId && view.device(x.code));
      const alarms = store.alarms.filter(x => x.tenantId === ctx.tenantId);
      const avg = (field: "oee" | "mtbf" | "mttr") => devices.length ? devices.reduce((s, d) => s + d[field], 0) / devices.length : 0;
      const visibleAlarms=alarms.filter(a=>view.alarm(a.id));
      result = { tenant: store.tenants.find(t => t.id === ctx.tenantId), metrics: { deviceCount: devices.length, running: devices.filter(d => d.status === "RUNNING").length, activeAlarms: visibleAlarms.filter(a => a.state !== "CLOSED").length, pendingApprovals: visibleAlarms.filter(a => a.state === "AWAITING_APPROVAL").length, oee: avg("oee"), mtbf: avg("mtbf"), mttr: avg("mttr") }, devices, alarms: visibleAlarms.slice(0, 6) };
    }
else if (url.pathname === "/api/v1/devices") result = page(store.devices.filter(x => x.tenantId === ctx.tenantId && view.device(x.code)));
else if (url.pathname === "/api/v1/alarms") result = page(store.alarms.filter(x => x.tenantId === ctx.tenantId && (()=>{const d=store.devices.find(y=>y.id===x.deviceId);return !!d&&view.alarm(x.id);})()));
else if (url.pathname === "/api/v1/templates") result = page(store.templates.filter(x => calendarTemplateVisible(x,store,importData,ctx)).map(presentTemplate));
else if (/^\/api\/v1\/templates\/[^/]+\/export$/.test(url.pathname)) result = exportTemplate(store,url.pathname.split('/')[4],ctx,importData);
else if (url.pathname === "/api/v1/plugins") {const trust=await loadPluginTrust();result=page(store.plugins.filter(x=>x.tenantId===ctx.tenantId).map(x=>({...x,signed:pluginMetadataStatus(x,trust).valid,verification:pluginMetadataStatus(x,trust),artifactVerified:false,runtimeEnabled:false})));}
else if (url.pathname === "/api/v1/roles") {
      const raw = await readFile(join(process.cwd(), "docs", "role-permissions.json"), "utf8");
      result = { ...(JSON.parse(raw) as Record<string, unknown>), tenantId: ctx.tenantId, runtimeRolePermissions: rolePermissions, runtimeAuthMode: authMode, currentScope: ctx.scope||{provided:false,sites:[],lines:[],devices:[]}, scopeNotice: '当前执行企业级与管理员分配的工厂/产线/设备数据范围；缺少范围声明的受限角色拒绝登录或返回空数据。权限包中仍有部分目标模块尚未上线。' };
    }
else if (url.pathname === '/api/v1/ai/status') result=await ai.status(ctx.tenantId);
else if (url.pathname === "/api/v1/integrations") {const aiStatus=await ai.status(ctx.tenantId);result = { items: [
      { id:"database", name:"PostgreSQL", category:"数据平台", status:storageMode==="postgres-tenant-databases"?"CONNECTED":"READY", mode:storageMode==="postgres-tenant-databases"?"企业独立业务数据库":"本机原子快照", detail:storageMode==="postgres-tenant-databases"?"已连接 PostgreSQL：业务、工单、幂等与追加式审计事务写入；开发存储仍需生产规模化改造":"未连接数据库，使用文件开发模式" },
      { id:"timescale", name:"TimescaleDB", category:"时序数据", status:"PLANNED", mode:"时序遥测与压缩", detail:"未安装、未联调；不得视为 PostgreSQL 已支持 TimescaleDB" },
      { id:"identity", name:"Keycloak / AD", category:"统一身份", status:authMode==='oidc'?"CONFIGURED":"PLANNED", mode:authMode==='oidc'?"真实OIDC / PKCE / 后端角色权限":"演示请求头（不是真实认证）", detail:authMode==='oidc'?"真实签名/issuer/audience/企业声明校验；登录以实际成功为准。AD/SAML/MFA尚未验收":"未配置真实登录；禁止公网部署" },
      { id:"ot", name:"MQTT / OPC UA", category:"设备接入", status:telemetry.connected&&telemetry.subscribed?'CONNECTED':telemetry.config?'READY':'PLANNED', mode:telemetry.config?'本机只读模拟器链路；现场尚未验收':'未启用采集', detail:telemetry.config?'代理订阅状态实时检查；测点、质量、缓存和新鲜度见设备采集页。不是现场设备验收。':'手动上传保留；采集未配置' },
      { id:"workflow", name:"Flowable", category:"工作流", status:(await workflow.status(ctx.tenantId)).connected?"CONNECTED":process.env.IDMS_WORKFLOW_CLIENT_CONFIG?"ERROR":"PLANNED", mode:process.env.IDMS_WORKFLOW_CLIENT_CONFIG?"Flowable BPMN维修闭环":"本地兼容状态机", detail:process.env.IDMS_WORKFLOW_CLIENT_CONFIG?"Flowable连接由实时健康检查确认；新工单失败关闭，旧工单保留原流程":"Flowable未配置；历史工单继续兼容状态机" },
      { id:"ai", name:"AI 模型网关", category:"智能服务", status:aiStatus.connected?'CONNECTED':aiStatus.enabled?'ERROR':'PLANNED', mode:aiStatus.enabled?'本地真实模型 · SHADOW影子审核':'明确标记的规则演示／人工复核', detail:aiStatus.enabled?'实际网关与固定模型摘要健康检查；新上传异步审阅，全部转独立人工复核。旧批次不改写；不代表预测精度或生产自动审批已验收。':'真实AI未配置；演示输出不是模型推理' },
      { id:"uploads", name:"CSV / Excel / JSON 上传", category:"数据接入", status:"CONNECTED", mode:storageMode, detail:"七类模板、校验、独立终审和入库统计；数据库模式设备数据中心使用领域表与SQL分页查询" },
      { id:"enterprise", name:"ERP / MES / QMS", category:"企业系统", status:"PLANNED", mode:"REST / Webhook / 文件", detail:"保留版本化接口与幂等控制" }
    ], deploymentModes:["SaaS 多租户","企业私有化"], apiVersion:"v1" };}
else if (url.pathname === "/api/v1/predictive/overview") result = predictiveOverview(store, ctx.tenantId,ctx,importData);
else if (url.pathname === "/api/v1/predictive/health") {
      const items = store.healthSnapshots.filter(item => item.tenantId === ctx.tenantId&&view.device(item.deviceCode)); result = { items, total: items.length };
    }
else if (url.pathname === "/api/v1/predictive/alerts") {
      const items = store.predictiveAlerts.filter(item => item.tenantId === ctx.tenantId&&view.device(item.deviceCode)); result = { items, total: items.length };
    }
else if (url.pathname === "/api/v1/predictive/models") {
      const items = store.predictiveModels.filter(item => item.tenantId === ctx.tenantId); result = { items, total: items.length };
    }
else if (url.pathname === "/api/v1/workflow/status") result = await workflow.status(ctx.tenantId);
else if (url.pathname === "/api/v1/work-orders") result = page(store.workOrders.filter(o => view.order(o)));
else if (/^\/api\/v1\/work-orders\/[^/]+$/.test(url.pathname)) result = orderFor(store, url.pathname.split("/")[4], ctx,importData);
else if (/^\/api\/v1\/work-orders\/[^/]+\/workflow$/.test(url.pathname)) result = await workflow.details(store, url.pathname.split("/")[4], ctx,importData);
else if (url.pathname === "/api/v1/audit") {const partialView=hasRestrictedScope(ctx)||ownTaskScope(ctx);if(services.auditPage){const slice=await workspace.readAuditPage(services.auditPage,view.audit);result=auditPageResponse(slice,services.auditPage,services.auditCursors,partialView);}else{const events=await workspace.readAudits();result={items:events.filter(view.audit).slice().reverse(),chainValid:true,verificationScope:'SERVER_FULL_TENANT_CHAIN',partialView};}}
else throw new DomainError(404, "接口不存在");
return result;
}
