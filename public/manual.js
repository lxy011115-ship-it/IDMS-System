import {workbenchSummary,businessFreshness,scenarioNotice} from './roadshow-ui.js';
import {FieldChannelWorkspace,fieldChannelView} from './field-channel-ui.js';
import {workspaceNavigation,workspaceTabs,canonicalView} from './workspace-navigation.js';
import {sparesView,installSparesUi,workOrderStockUsage,sparesTasksView} from './spares-paged-ui.js';
import {installFieldChannelUi} from './field-channel-controller.js';
import {SourceGovernanceWorkspace,sourceGovernanceView} from './source-governance-ui.js';
import {installSourceGovernanceUi} from './source-governance-controller.js';
import {OperationalWorkspace,operationalView} from './operational-metrics-ui.js';
import {installOperationalUi} from './operational-controller.js';
import {ReplayWorkspace,coverageReplayView,receiptVersionPicker} from './coverage-replay-ui.js';
import {scheduleFromCalendar} from './calendar-schedule-ui.js';
import {defaultWeeklyCalendar,calendarAuthoringManifest} from './weekly-calendar-ui.js';
import {defaultOperationCalendar} from './plan-coverage-ui.js';
import {QualityPanel} from './telemetry-quality-ui.js';
import {BatchPager,batchPageView} from './batch-pages-ui.js';
import {uploadTypeGuide,batchNextStep,batchNextStepView,ImportErrorReview,importErrorView} from './import-assistance-ui.js';
import {equipmentProfileView,newProfile,readProfileEditor,isProfile,profileRef,profileConfig,typedValues,profileEvidence,profilePicker} from './equipment-profile-ui.js';
import {auditView as renderAuditView} from './audit-ui.js';
import {dataQualityView} from './data-quality-ui.js';
import {historyButton,revisionHistoryView,correctionEvidence,correctionPicker} from './revision-ui.js';
import { maintenanceView } from './maintenance-ui.js';
import { loginView, identityBadge } from './identity-ui.js';
import { telemetryView } from './telemetry-ui.js';
import { enhanceAiReviewUi } from './ai-ui.js';
import {catalogView,defaultTemplate,customFieldsPayload} from './catalog-ui.js';
import {dataCenterView} from './data-center-ui.js';
import {defaultMappingTemplate,mappingPicker,batchMappingEvidence} from './import-mapping-ui.js';
const root = document.querySelector('#app');
const types = { DEVICE: '设备台账', POINT_DEFINITION:'测点定义', PRODUCTION: '班次生产', STATE_INTERVAL: '状态区间', MAINTENANCE: '维修记录', QUALITY: '质量检验', MEASUREMENT:'设备测点' };
const labels = { source_record_id:'来源记录ID', device_code:'设备编码', device_name:'设备名称', site_code:'工厂编码', line_code:'产线编码', shift_code:'班次', period_start:'班次开始', period_end:'班次结束', planned_minutes:'计划分钟', total_count:'总产量', good_count:'良品数', ideal_cycle_seconds:'理想节拍(秒)', start_time:'开始时间', end_time:'结束时间', state:'状态', reason_code:'停机原因', failure_time:'故障时间', repair_start:'维修开始', repair_end:'维修结束', failure_code:'故障编码', cause:'故障原因', action:'维修措施', batch_code:'产品批次', characteristic_code:'检验特性', measured_at:'检验时间', sample_no:'样本编号', measured_value:'实测值', unit:'单位', lsl:'规格下限', usl:'规格上限' };
const statusNames = { AWAITING_APPROVAL:'待人工终审', HUMAN_REVIEW:'待人工复核', VALIDATION_FAILED:'校验失败', COMMITTED:'已入库', RETURNED:'已退回', REJECTED:'已驳回' };
statusNames.AI_PENDING='真实AI处理中';
Object.assign(labels,{tag_code:'测点编码',value:'测点数值',quality:'数据质量',measured_at:'采样/检验时间'});
Object.assign(labels,{equipment_type:'设备类型',brand:'品牌',model:'型号',serial_number:'序列号',criticality:'关键度',tag_name:'测点名称',min_value:'物理范围下限',max_value:'物理范围上限',expected_interval_seconds:'建议记录间隔(秒)'});
const roles = { 'demo.uploader':'数据上传专员', 'demo.approver':'业务终审员', 'demo.technician':'维修工程师', 'demo.auditor':'审计员' };
const navigation = [['uploads','⇧','数据上传中心'],['overview','▦','企业运维工作台'],['predictive','⌁','预测维护'],['telemetry','⇌','设备采集'],['work-orders','⚒','维修工单'],['devices','◉','设备台账'],['approvals','✓','人工终审'],['analysis','▥','生产与质量分析'],['audit','↻','批次追溯'],['roles','♙','角色权限'],['integrations','⇄','集成接口'],['guide','?','系统使用说明']];
const state = { view:'uploads', actor:'demo.uploader', type:'DEVICE', aiMode:'demo', source:'manual-excel', batches:[], report:null, predictive:null, selected:null, audits:[], roles:null, integrations:null, busy:false, error:'', toast:'', filter:'ALL' };
state.workflowDetails={};
const batchPager=new BatchPager();
const importErrors=new ImportErrorReview();
function applyImportErrorFilter(form){
 if(!form?.reportValidity())return;
 const fields=new FormData(form);importErrors.field=String(fields.get('field')||'');importErrors.query=String(fields.get('query')||'');
 render();root.querySelector('#import-error-review')?.scrollIntoView({block:'start'});root.querySelector('#import-error-filter input')?.focus();
}
let batchDraft={key:'',comment:'',resolution:''};
function captureBatchDraft(){const form=root.querySelector('.approve-form[data-batch-key]');if(form?.dataset.batchKey===batchDraft.key){const comment=form.querySelector('#approval-comment'),resolution=form.querySelector('#review-resolution');if(comment)batchDraft.comment=comment.value;if(resolution)batchDraft.resolution=resolution.value;}}
async function loadBatchPage(kind=batchPager.kind,page=batchPager.page){
 captureBatchDraft();const pending=batchPager.load(api,kind,page);render();
 try{await pending;}catch(error){if([401,403,404].includes(error.status)){state.selected=null;batchPager.clear();}else if(error.code==='BATCH_INPUT_CHANGED')state.error=error.message;}
 render();
}

state.audit={data:null,filters:{},identity:'',error:'',revision:0};
function auditIdentity(){const u=state.auth?.user;return JSON.stringify([state.auth?.mode,state.auth?.authenticated,state.actor,u?.tenantId,u?.actorType,[...(u?.roles||[])].sort(),[...(u?.permissions||[])].sort(),u?.scope]);}
function clearQuality(){state.dataQuality?.clear(auditIdentity());state.coverageReplay?.clear(auditIdentity());state.policyEvaluation?.clear(auditIdentity());state.policyEditor=null;operationalUi.clear();sourceUi.clear();fieldUi.clear();sparesUi.clear();}
function clearAudit(resetFilters=false){const a=state.audit;state.audit={data:null,filters:resetFilters?{}:a.filters,identity:auditIdentity(),error:'',revision:a.revision+1};state.audits=[];}
state.catalog={items:[],plugins:[],editor:null};
state.mappingId='';
state.profileId='';state.profiles={editor:null,assetType:'',assetValues:{},assetDraft:{}};
state.dataCenter={overview:null,measurements:null,filters:{},assetPage:1,measurementPage:1};
state.dataQuality=new QualityPanel();state.coverageReplay=new ReplayWorkspace();state.replayAvailable=false;
state.fieldChannels=new FieldChannelWorkspace();state.fieldChannelsAvailable=false;
const fieldUi=installFieldChannelUi({root,state,api,post,can,identity:auditIdentity,refreshIdentity,loadCapability:loadReplayCapability,load,task,render,notify,download:nativeCsvDownload});
navigation.splice(2,0,['field-channels','◇','现场通道审批']);
state.operational=new OperationalWorkspace();state.operationalAvailable=false;state.operationalEditor=null;
const operationalUi=installOperationalUi({root,state,api,post,can,identity:auditIdentity,refreshIdentity,loadCapability:loadReplayCapability,load,task,render,notify,download:nativeCsvDownload});
state.sourceGovernance=new SourceGovernanceWorkspace();state.sourceGovernanceAvailable=false;
const sourceUi=installSourceGovernanceUi({root,state,api,post,can,identity:auditIdentity,refreshIdentity,loadCapability:loadReplayCapability,load,task,render,notify,download:nativeCsvDownload});
navigation.splice(2,0,['source-governance','⇄','来源与点表审批']);
navigation.splice(2,0,['operational','▥','运营指标与报告']);
state.policyEvaluation=new PolicyWorkspace();state.policyAvailable=false;state.policyEditor=null;
navigation.splice(2,0,['quality-policy','◇','质量规则评估']);
navigation.splice(2,0,['coverage-history','◷','历史复核与报告']);
navigation.splice(2,0,['data-center','▧','设备数据中心'],['data-quality','◇','数据质量工作台']);
navigation.splice(10,0,['templates','▤','企业模板']);
navigation.splice(11,0,['equipment-profiles','◇','设备类型模板']);
navigation.push(['spares','▤','备件与采购']);
state.spares={data:null,tab:'inventory',error:'',editor:null,selectedId:'',query:'',busy:false};
const sparesUi=installSparesUi({state,api,post,render,notify});
if(new URLSearchParams(location.search).get('section')==='history')state.spares.tab='history';
const initialView=canonicalView(new URLSearchParams(location.search).get('view'));if(navigation.some(n=>n[0]===initialView))state.view=initialView;
state.auth = null;
const demoPermissions = {'demo.uploader':['upload','analyze'],'demo.approver':['approve','analyze','predictive:approve','maintenance:approve'],'demo.technician':['maintenance:execute','analyze'],'demo.auditor':[]};
function can(permission){return (state.auth?.mode==='oidc'?state.auth.user?.permissions||[]:demoPermissions[state.actor]||[]).includes(permission);}
function identityName(){return state.auth?.mode==='oidc'?state.auth.user?.name||state.auth.user?.username||'未登录':roles[state.actor];}
async function refreshIdentity(){
  const response=await fetch('/api/v1/auth/session',{cache:'no-store'});
  if(!response.ok){
    if(response.status===401||response.status===403){state.auth={mode:'oidc',authenticated:false};state.report=null;state.selected=null;state.batches=[];state.predictive=null;clearAudit(true);clearQuality();}
    throw Error('登录服务暂不可用或权限已变化，请重试或重新登录。');
  }
  state.auth=await response.json();
  if(state.auth.mode==='oidc'){
    if(!state.auth.authenticated){state.workflowDetails={};state.catalog={items:[],plugins:[],editor:null};}
    state.actor=state.auth.user?.actorId||'';
    if(!state.auth.authenticated){state.report=null;state.batches=[];state.predictive=null;state.audits=[];state.selected=null;}
  }
  if(state.audit.identity!==auditIdentity()){clearAudit(true);clearQuality();state.selected=null;batchPager.clear();}
}
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp = value => value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '暂无数据';
const number = (value, suffix='') => value == null || !Number.isFinite(value) ? '—' : `${Number(value).toFixed(Number.isInteger(value)?0:2)}${suffix}`;
const badge = status => `<span class="badge ${esc(status)}">${esc(statusNames[status] || status)}</span>`;
const button = (title, action, extra='', kind='secondary') => `<button class="${kind}" data-action="${action}" ${extra} ${state.busy?'disabled':''}>${title}</button>`;
function headers(actor=state.actor){return state.auth?.mode==='oidc'?{'X-CSRF-Token':state.auth.csrfToken||''}:{'X-Tenant-Id':'acme','X-Actor-Id':actor,'X-Actor-Type':'USER'};}
async function api(path, options={}) {
  let response;
  try { response = await fetch('/api/v1'+path,{...options,headers:{...headers(),...options.headers}}); }
  catch { throw Error('无法连接本机 IDMS 服务，请运行启动脚本后刷新。'); }
  const text = await response.text(); let result;
  try { result=JSON.parse(text); } catch { throw Error(`接口返回异常（HTTP ${response.status}），请确认4010端口运行最新版IDMS。`); }
  if((response.status===401||response.status===403)&&state.auth?.mode==='oidc'){if(response.status===401){state.auth.authenticated=false;state.report=null;state.selected=null;}clearAudit(true);clearQuality();}
  if(!response.ok){const error=Error(result.error || result.message || `HTTP ${response.status}`);error.status=response.status;error.code=result.code;throw error;}
  return result;
}
async function post(path, body, actor=state.actor,requestKey=crypto.randomUUID()) {
  return api(path,{method:'POST',headers:{...headers(actor),'Content-Type':'application/json','Idempotency-Key':requestKey,'X-Correlation-Id':crypto.randomUUID()},body:JSON.stringify(body)});
}
async function load(){
  await refreshIdentity();
  if(state.auth.mode==='oidc'&&!state.auth.authenticated){render();return;}
  await loadReplayCapability();
  const [batches,report,config,integrations,predictive,templates,plugins] = await Promise.all([api('/data-imports?pageSize=100'),api('/upload-report'),api('/roles'),api('/integrations'),api('/predictive/overview'),api('/templates'),api('/plugins')]);
  state.catalog={...state.catalog,items:templates.items,plugins:plugins.items};
  state.batches=batches.items; state.report=report; state.roles=config; state.integrations=integrations; state.predictive=predictive;
  await loadTelemetry();
  await loadDataCenter();
  if(['spares','work-orders','overview','approvals'].includes(canonicalView(state.view)))await sparesUi.load().catch(()=>{});
  if(state.view==='data-quality')await loadDataQuality();if(state.view==='coverage-history')await loadCoverageHistory();
  if(state.view==='audit')await loadAudit();if(state.view==='operational')await operationalUi.load();if(state.view==='source-governance')await sourceUi.load();if(state.view==='field-channels')await fieldUi.load();
  if(state.selected){try{state.selected=state.batches.find(b=>b.batchId===state.selected.batchId)||await api('/data-imports/'+encodeURIComponent(state.selected.batchId));}catch(error){if(error.status!==404)throw error;state.selected=null;batchPager.clear();}}
  state.error=''; render();
}
async function loadAudit(cursor){
 try{await refreshIdentity();if(state.auth.mode==='oidc'&&!state.auth.authenticated)return;
 const identity=auditIdentity(),revision=state.audit.revision,params=new URLSearchParams({pageSize:'50'});
 if(cursor)params.set('cursor',cursor);else for(const [key,value]of Object.entries(state.audit.filters)){if(!value)continue;params.set(key,key==='from'||key==='to'?new Date(value).toISOString():value);}
 const data=await api('/audit?'+params);if(revision!==state.audit.revision||identity!==auditIdentity())return;state.audit.data=data;state.audit.error='';}
 catch(error){clearAudit(error.status===401||error.status===403||error.code==='AUDIT_SCOPE_CHANGED');state.audit.error=error.message;throw error;}
}
async function loadTelemetry(){state.telemetry=await api('/telemetry/overview');state.telemetryPoints=[];for(const source of state.telemetry.sources)state.telemetryPoints.push(...(await api('/telemetry/points?edgeId='+encodeURIComponent(source.edgeId))).items);state.telemetryUpdatedAt=new Date().toISOString();}
async function loadDataCenter(){
  const c=state.dataCenter,asset=new URLSearchParams({page:String(c.assetPage),pageSize:'50'}),measurement=new URLSearchParams({page:String(c.measurementPage),pageSize:'50'});
  for(const [key,value] of Object.entries(c.filters))if(value)(['q','equipmentType','siteCode'].includes(key)?asset:measurement).set(key,value);
  const [overview,measurements]=await Promise.all([api('/data-management/overview?'+asset),api('/data-management/measurements?'+measurement)]);
  state.dataCenter={...c,overview,measurements,appliedFilters:{...c.filters}};
}
async function loadReplayCapability(){const health=await api('/health');state.fieldChannelsAvailable=health.storage==='postgres-tenant-databases'&&health.fieldChannelGovernance==='scoped-field-channel-view-v1';state.replayAvailable=health.storage==='postgres-tenant-databases'&&health.frozenCoverageReports==='append-only-independent-report-v1';state.policyAvailable=health.storage==='postgres-tenant-databases'&&health.qualityPolicyGovernance==='approved-effective-quality-rules-v1';state.sourceGovernanceAvailable=health.storage==='postgres-tenant-databases'&&health.sourceGovernance==='approved-source-binding-v1';state.operationalAvailable=health.storage==='postgres-tenant-databases'&&health.operationalMetrics==='approved-frozen-operational-v1';const receiptV2=health.storage==='postgres-tenant-databases'&&health.receiptIdentity==='persisted-uuid-receipt-binding-2.0.0';state.coverageReplay.configureReceiptV2(receiptV2);state.policyEvaluation.configureReceiptV2(receiptV2);state.dataQuality.configureReceiptV2(receiptV2);}
async function loadCoverageHistory(){if(!state.replayAvailable)return;const m=state.coverageReplay;await Promise.all([m.loadList(api,auditIdentity),...(m.detailId?[m.open(api,auditIdentity,m.detailId)]:[])]);}
function captureReplayDraft(){const m=state.coverageReplay;if(!m)return;const owns=form=>form&&Number(form.dataset.ownerEpoch)===m.epoch;
 const form=root.querySelector('#replay-form');if(owns(form)&&!form.querySelector('[name=deviceCode]')?.disabled)m.setFilters(Object.fromEntries(new FormData(form)));
 const title=root.querySelector('#replay-freeze-form');if(owns(title)&&!title.querySelector('[name=title]')?.disabled)m.title=title.querySelector('[name=title]').value;
 const approval=root.querySelector('#replay-approval');if(owns(approval)&&approval.dataset.reportKey===m.approvalKey&&!approval.querySelector('[name=comment]')?.disabled)m.approvalComment=approval.querySelector('[name=comment]').value;
}
function replayTask(work){const epoch=state.coverageReplay.epoch;task(async()=>{await refreshIdentity();if(epoch!==state.coverageReplay.epoch)throw Error('身份或范围已变化，请重新复核后操作');await work();});}
function capturePolicyDraft(){const m=state.policyEvaluation,form=root.querySelector('#policy-evaluation-form');if(form&&Number(form.dataset.ownerEpoch)===m.epoch&&!form.querySelector('[name=deviceCode]')?.disabled)m.setFilters(Object.fromEntries(new FormData(form)));const editor=root.querySelector('#quality-policy-editor');if(editor&&state.policyEditor&&Number(editor.dataset.ownerEpoch)===m.epoch&&!editor.querySelector('[name=deviceCode]')?.disabled)state.policyEditor.value=readPolicyAuthor(editor,state.policyEditor);}
function renderPolicyAuthor(){const old=root.querySelector('#quality-policy-editor');if(old)old.dataset.ownerEpoch='-1';render();}
function policyTask(work){const epoch=state.policyEvaluation.epoch;task(async()=>{await refreshIdentity();if(epoch!==state.policyEvaluation.epoch)throw Error('身份或范围已变化，请重新核对规则后操作');await work();});}
async function loadDataQuality(){
  await refreshIdentity();if(state.auth.mode==='oidc'&&!state.auth.authenticated)return;
  await loadReplayCapability();await state.dataQuality.load(api,auditIdentity);
}
function notify(message){state.toast=message;render();setTimeout(()=>{state.toast='';render();},4500);}
async function task(work){if(state.busy)return;state.busy=true;state.error='';render();try{await work();}catch(e){state.error=e.message;}finally{state.busy=false;render();}}
let nativeExportFrame=null,nativeExportTimer,nativeExportGeneration=0;
function clearNativeDownload(){nativeExportGeneration++;clearTimeout(nativeExportTimer);nativeExportFrame?.remove();nativeExportFrame=null;}
function nativeCsvDownload(path){
 const generation=++nativeExportGeneration,frame=nativeExportFrame||document.createElement('iframe');nativeExportFrame=frame;frame.hidden=true;frame.title='CSV导出';clearTimeout(nativeExportTimer);
 frame.onload=async()=>{if(generation!==nativeExportGeneration)return;try{if(frame.contentWindow.location.href==='about:blank')return;const text=frame.contentDocument.body.innerText;let value;try{value=JSON.parse(text);}catch{throw Error('导出未完成，请检查连接后重试。');}if(value.error){try{await refreshIdentity();}catch{}if(generation!==nativeExportGeneration)return;state.error=value.error;clearNativeDownload();render();}}catch{if(generation!==nativeExportGeneration)return;state.error='导出未完成，请检查连接后重试。';clearNativeDownload();render();}};
 frame.src='/api/v1'+path;if(!frame.isConnected)document.body.append(frame);nativeExportTimer=setTimeout(()=>{if(generation===nativeExportGeneration)clearNativeDownload();},12*60*1000);notify('正在准备导出，准备完成后由浏览器下载。');
}
async function download(path, filename){
  if(state.auth?.mode==='oidc'&&/^\/data-management\/(assets|measurements)\/export(?:\?|$)/.test(path)){nativeCsvDownload(path);return;}
  const response=await fetch('/api/v1'+path,{headers:headers()});
  if(!response.ok){const value=await response.json();throw Error(value.error||'下载失败');}
  const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
async function upload(file){
  if(state.correctionParent&&(!state.correctionReason||state.correctionReason.trim().length<2))throw Error('请填写更正理由');
  if(!can('upload'))throw Error('当前账户没有上传权限，请由数据上传专员登录。');
  const form=new FormData();form.set('file',file);form.set('dataType',state.type);form.set('templateVersion','1.0.0');form.set('sourceSystem',state.source);form.set('aiMode',state.aiMode);
  if(state.correctionParent){form.set('supersedesBatchId',state.correctionParent);form.set('correctionReason',state.correctionReason);}
  if(state.mappingId){const t=state.catalog.items.find(t=>t.id===state.mappingId);if(!t||t.status!=='PUBLISHED'||t.manifest.importMapping?.dataType!==state.type||t.manifest.importMapping?.sourceSystem!==state.source)throw Error('映射版本或来源已变化，请重新选择。');form.set('mappingRef',JSON.stringify({templateId:t.id,version:t.version,contentDigest:t.contentDigest}));}
  if(state.profileId&&['DEVICE','POINT_DEFINITION'].includes(state.type)){const t=state.catalog.items.find(t=>t.id===state.profileId&&t.status==='PUBLISHED'&&isProfile(t));if(!t)throw Error('设备类型版本已变化，请重新选择');form.set('equipmentProfileRef',JSON.stringify(profileRef(t)));}
  const batch=await api('/data-imports',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID(),'X-Correlation-Id':crypto.randomUUID()},body:form});
  // Bind the accepted batch before refresh, so load() keeps the latest version
  // and can discard it if the authenticated identity changes.
  state.selected=batch;
  await load();
  if(state.selected?.batchId===batch.batchId)notify(uploadCompletionMessage(state.selected.status));
}
function uploadCompletionMessage(status){
  return ({
    AI_PENDING:'上传已接收，AI影子审阅仍在处理中；尚未入库，请稍后刷新查看状态。',
    HUMAN_REVIEW:'上传已接收，需另一名人员填写人工复核依据并终审；尚未入库。',
    AWAITING_APPROVAL:'校验已完成，等待另一名人员终审；尚未入库。',
    VALIDATION_FAILED:'上传已接收，校验存在错误；整批尚未入库，请查看逐行错误。',
    COMMITTED:'该批次已入库，请核对入库数量与来源。',
    RETURNED:'该批次已退回，请查看审批意见后修正材料。',
    REJECTED:'该批次已驳回，请查看审批意见。'
  })[status]||'上传已接收，请在批次详情核对当前状态和入库数量。';
}
async function useSample(invalid=false){
  state.mappingId='';
  const response=await fetch(`/api/v1/data-import-templates/${state.type}?sample=1`,{headers:headers()});
  if(!response.ok)throw Error('样例下载失败');
  let text=await response.text();
  if(invalid){if(state.type==='PRODUCTION')text=text.replace(',1000,980,20',',1000,1200,20');else text=text.replace(/D-001/g,'UNKNOWN-001').replace(/FACTORY-01/g,'FACTORY-99');}
  await upload(new File([text],`${state.type.toLowerCase()}${invalid?'-error':''}.csv`,{type:'text/csv'}));
}
function panel(title, subtitle, body, action=''){return `<section class="panel"><div class="panel-head"><div><h2>${title}</h2><p>${subtitle}</p></div>${action}</div>${body}</section>`;}
function table(head,rows,empty='暂无数据'){return `<div class="table-wrap"><table><thead><tr>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td class="empty-row" colspan="${head.length}">${empty}</td></tr>`}</tbody></table></div>`;}
function stats(items){return `<div class="upload-metrics">${items.map(([label,value,note])=>`<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('')}</div>`;}
function batchTable(items){return table(['批次与文件','数据类型 / 来源','校验结果','状态','下一步','操作'],items.map(b=>`<tr><td><b>${esc(b.filename)}</b><span>${b.batchId.slice(0,8)} · ${stamp(b.createdAt)}</span></td><td><b>${types[b.dataType]}</b><span>${esc(b.sourceSystem)}</span></td><td><b>${b.counts.valid} 有效 · ${b.counts.invalid} 错误</b><span>${b.counts.duplicates} 重复 · ${b.counts.committed} 入库</span></td><td>${badge(b.status)}</td><td class="wrap-cell">${esc(batchNextStep(b,{actor:state.actor,canApprove:can('approve')}).title)}</td><td>${button('查看详情','batch',`data-id="${b.batchId}"`,'row-action')}</td></tr>`),'上传一个文件，开始建立企业数据档案。');}
function uploadsView(){
  const r=state.report;
  return `<section class="upload-hero"><div><span class="eyebrow">MANUAL DATA · PHASE 01</span><h2>让现有报表，成为企业的数据底座</h2><p>从 Excel / CSV 开始。统一校验、AI辅助审核、独立人工终审，<br>每一项指标都能追溯到原始文件与批准人。</p><div class="hero-tags"><span>7类标准模板</span><span>多类型设备</span><span>保留API接入</span></div></div><div class="hero-flow"><span>上传原始数据</span><i>↓</i><span>规则 + AI 中间审核</span><i>↓</i><b>人工终审后入库</b></div></section>
  ${stats([['已入库批次',r.committedBatches,'仅统计已批准数据'],['等待人工审批',r.pending,'上传与终审角色分离'],['需要修正',r.invalid,'逐行定位校验错误'],['已入库记录',r.committedRows,'保留来源与审批链']])}
  <div class="upload-layout">${panel('上传业务数据','标准模板 v1.0.0 · UTF-8 CSV / 无公式XLSX · 最大10 MiB',`<div class="upload-form"><div class="form-grid"><label>数据类型<select id="data-type">${Object.entries(types).map(([key,name])=>`<option value="${key}" ${state.type===key?'selected':''}>${name}</option>`).join('')}</select></label><label>来源系统<input id="source-system" value="${esc(state.source)}" maxlength="100"></label></div>${uploadTypeGuide(state.type)}<label>中间审核模式<select id="ai-mode"><option value="demo" ${state.aiMode==='demo'?'selected':''}>模拟 AI 审核 · 演示规则输出</option><option value="unavailable" ${state.aiMode==='unavailable'?'selected':''}>真实模型未连接 · 转人工复核</option></select></label><label class="drop-zone" for="file-upload"><div class="upload-icon">⇧</div><strong>选择 Excel 或 CSV 文件</strong><span>点击选择文件 · 使用标准字段名 · Excel工作表名为 data</span><input id="file-upload" type="file" accept=".csv,.xlsx" ${!can('upload')||state.busy?'disabled':''}></label><div class="form-actions">${button('下载空白模板','template')}${button('下载填写样例','sample-download')}${button('使用样例上传','sample','data-testid="sample-upload"','primary')}</div><p class="form-note">${can('upload')?'第一步请上传并批准设备台账，再上传生产等业务数据。':'当前账户没有上传权限；请由数据上传专员登录。'}</p></div>`)}
  ${panel('先建立多类型设备数据档案','设备 → 测点定义 → 测点记录，每一步由独立人员批准',`<ol class="walkthrough"><li><b>01</b><div><strong>上传设备台账</strong><p>下载扩展样例，填写设备类型、品牌和型号等可选字段。示例编码须替换为本企业编码。</p></div></li><li><b>02</b><div><strong>批准测点定义，再上传记录</strong><p>为每台设备声明测点编码、名称、单位和物理录入范围；批准后才可使用自定义测点。</p></div></li><li><b>03</b><div><strong>进入设备数据中心</strong><p>按类型、工厂、设备与质量筛选，并查看来源批次和原行号；无需运行预测。</p></div></li></ol><div class="scenario-actions">${button('设备扩展样例','device-extended-sample')}${button('查看设备数据','data-center')}${button('查看使用指南','guide')}</div><p class="boundary-note">数据质量不等于设备健康。真实连接与AI模式以集成页为准；销售样例只能在隔离沙箱使用。</p>`)}
  </div><div class="section-toolbar"><h2>上传批次</h2><select id="batch-filter"><option value="ALL">全部批次</option>${Object.entries(statusNames).map(([key,name])=>`<option value="${key}" ${state.filter===key?'selected':''}>${name}</option>`).join('')}</select></div>
  ${state.auth.mode==='demo'?`<div class="scenario-actions">${button('上传错误样例','error-sample')}</div>`:''}
  ${panel('文件到业务结果的完整记录',`最近${state.batches.length}个批次 · 原文件不可从页面覆盖`,batchTable(state.batches.filter(b=>state.filter==='ALL'||b.status===state.filter)))}`;
}
function overviewView(){const r=state.report;return `${workbenchSummary({batches:state.batches,spares:state.spares.data,actor:state.actor,canApprove:can('approve'),name:identityName()})}${businessFreshness(r)}
  ${panel('待协作的业务批次','查看校验结果和来源；只有具备独立审核职责的人员才能批准',batchTable(state.batches.filter(b=>['AWAITING_APPROVAL','HUMAN_REVIEW'].includes(b.status))),button('查看审核队列','approvals'))}
  <details class="workbench-analysis"><summary>生产与数据完整性概况 <span>展开查看已批准记录的分析依据</span></summary>
  ${stats([['班次总产量',number(r.total),'来源：已批准生产记录'],['良品率',number(r.yield,'%'),'良品数 / 总产量'],['记录停机时长',number(r.downMinutes,' min'),'来源：已批准状态区间'],['平均维修时间',number(r.mttr,' min'),'来源：已完成维修记录']])}
  <div class="upload-layout">${panel('设备效率 · 有依据才计算','状态区间、计划时长、节拍与产量需同时完整',productionTable(r.production))}${panel('数据覆盖情况','仅统计授权范围内已批准记录',`<div class="coverage-list">${Object.entries(types).map(([type,name])=>{const b=state.batches.filter(x=>x.dataType===type&&x.status==='COMMITTED');return `<div><span>${name}</span><b>${b.length} 个批准批次</b><i class="${b.length?'covered':''}"></i></div>`;}).join('')}</div><div class="metric-warning">MTBF需完整观察窗口；Cp/Cpk需同特性足量样本及稳定性验证。当前不输出不具备依据的数值。</div>`)}</div></details>`;}
function predictiveView(){
  const p=state.predictive;if(!p)return '<div class="empty">正在加载预测维护数据…</div>';
  const band={HEALTHY:'健康',WATCH:'观察',RISK:'风险',CRITICAL:'紧急'};
  const alertState={OPEN:'开放',AWAITING_APPROVAL:'待人工批准',WORK_ORDER_CREATED:'已生成工单',RESOLVED:'已解决',DISMISSED:'已忽略'};
  const healthRows=p.health.map(h=>`<tr><td><b>${esc(h.deviceCode)}</b><span>${({APPROVED_IMPORT:'批准上传分析',SIMULATED_TELEMETRY:'模拟设备实际采集分析',LIVE_TELEMETRY:'现场采集分析'})[h.provenance]||'预置场景样例'}</span>${h.sourceEdgeId?`<span>${esc(h.sourceEdgeId)} · ${h.sourceEventIds?.length||0}条测点血缘</span>`:''}</td><td><strong class="${h.score<70?'bad-text':h.score<80?'warn-text':'good-text'}">${h.score}</strong><span>${h.confidence==null?'未标定置信度':`样例值 ${Math.round(h.confidence*100)}%`}</span></td><td><span class="health-band ${h.band}">${band[h.band]}</span></td><td><code>${esc(h.modelVersion)}</code><span>${esc(h.inputWindow)}</span>${h.inputDigest?`<span>输入摘要 ${esc(h.inputDigest.slice(0,16))}…</span>`:''}</td><td>${stamp(h.capturedAt)}</td></tr>`);
  const risk=p.health.find(h=>h.band==='RISK');
  const featureRows=(risk?.features||[]).map(f=>`<div><span>${esc(f.label)}</span><b class="${f.status==='CRITICAL'?'bad-text':f.status==='ELEVATED'?'warn-text':'good-text'}">${f.value} ${esc(f.unit)}</b><small>基线 ${f.baseline} · ${f.status==='NORMAL'?'正常':f.status==='ELEVATED'?'升高':'超限'}</small></div>`).join('');
  const alertRows=p.alerts.map(a=>`<tr><td><b>${esc(a.title)}</b><span>${esc(a.deviceCode)} · ${esc(a.modelVersion)}</span></td><td><strong class="bad-text">${a.probability==null?'未标定':`${Math.round(a.probability*100)}%（样例）`}</strong><span>异常分 ${Math.round(a.anomalyScore*100)}%</span></td><td>${esc(a.horizon)}</td><td><span class="badge ${a.state}">${alertState[a.state]}</span></td><td class="wrap-cell">${esc(a.recommendation)}</td><td>${a.state==='AWAITING_APPROVAL'&&can('predictive:approve')?button('批准生成工单','predictive-approve',`data-id="${esc(a.id)}"`,'primary'):''}</td></tr>`);
  const modelRows=p.models.map(m=>`<tr><td><b>${esc(m.name)}</b><span>${esc(m.key)} · ${esc(m.version)}</span></td><td>${esc(m.modelType)}</td><td><span class="badge ${m.status}">${m.status==='ACTIVE'?'演示启用':m.status==='SHADOW'?'未生产发布':'已退役'}</span></td><td>${m.precision?`样例 Precision ${Math.round(m.precision*100)}% / Recall ${Math.round(m.recall*100)}%（无真实评测）`:'无已验证评测指标'}</td><td class="wrap-cell">${esc(m.note)}</td></tr>`);
  const controls=panel('分析已批准的设备测点','先上传设备测点模板并由终审员批准。每个测点至少6个GOOD样本、覆盖5分钟；工程阈值非厂商生产阈值。',`<div class="prediction-controls"><label>设备<select id="prediction-device">${state.report.assets.map(a=>`<option value="${esc(a.device_code)}">${esc(a.device_code)} · ${esc(a.device_name)}</option>`).join('')}</select></label>${button('运行独立分析服务','analyze-device','','primary')}<p>RUL：未评估 · 历史上传不代表设备实时在线。模型不可用或数据不足时转人工，不产生假健康结果。</p></div>`);
  return `${scenarioNotice()}<section class="upload-hero predictive-hero"><div><span class="eyebrow">PREDICTIVE MAINTENANCE · PHASE 02</span><h2>从设备信号到可执行的维护建议</h2><p>${esc(p.disclaimer)}</p><div class="hero-tags"><span>健康评分</span><span>异常检测</span><span>维修闭环</span><span>人工责任门</span></div></div><div class="hero-flow"><span>时序窗口</span><i>↓</i><span>特征 + 模型</span><i>↓</i><b>人工确认后生成工单</b></div></section>${stats([['监控设备',p.metrics.monitoredDevices,'含预置场景样例'],['健康',p.metrics.healthy,'评分 ≥ 80'],['观察',p.metrics.watch,'需要持续关注'],['风险',p.metrics.risk,'建议进入维修队列'],['待人工批准',p.metrics.pendingApproval,'AI不能替代责任人']])}${controls}<div class="upload-layout">${panel('设备健康矩阵','区分预置样例与批准上传结果；输入窗口和模型版本可追溯',table(['设备','健康分','状态','模型','采样截止时间'],healthRows))}${panel('特征状态','用于解释为什么触发风险，而非黑盒结论',`<div class="feature-list">${featureRows}</div>`)}</div>${panel('预测告警与维修建议','生成建议不等于执行；批准后才创建维修工单',table(['告警','故障概率','预测窗口','状态','建议动作',''],alertRows))}${panel('模型治理','模型必须经历影子评测，生产输出需要模型版本和数据证据',table(['模型','类型','状态','评测','说明'],modelRows))}`;
}
function productionTable(items){return table(['设备 / 班次','产量 / 良品','A / P / Q','OEE','来源'],items.map(p=>`<tr><td><b>${esc(p.device_code)} · ${esc(p.shift_code)}</b><span>${stamp(p.period_end)}</span></td><td>${p.total_count} / ${p.good_count}</td><td>${number(p.availability,'%')} / ${number(p.performance,'%')} / ${number(p.quality,'%')}</td><td><b class="${p.issue?'bad-text':'good-text'}">${number(p.oee,'%')}</b><span>${esc(p.issue||'输入条件完整')}</span></td><td>${button('查看来源','record-source',`data-source="${esc(p.source_record_id)}"`)}</td></tr>`),'批准生产和完整状态区间后显示效率。');}
function devicesView(){return panel('设备资产台账','只展示通过独立人工终审的上传台账；不表示设备实时在线',table(['设备编码','设备名称','工厂','产线','来源记录'],state.report.assets.map(a=>`<tr><td><b>${esc(a.device_code)}</b></td><td>${esc(a.device_name)}</td><td>${esc(a.site_code)}</td><td>${esc(a.line_code)}</td><td><code>${esc(a.source_record_id)}</code></td></tr>`)),button('上传台账','uploads','','primary'));}
function approvalsView(){const pending=state.batches.filter(b=>['AWAITING_APPROVAL','HUMAN_REVIEW'].includes(b.status));return `<div class="approval-notice"><b>✓ 最终责任由授权人员确认</b><p>模拟 AI 可整理证据，不能批准入库。上传者不得批准本人的批次；转人工批次需额外填写复核依据。</p><span>当前身份：${esc(identityName())}</span>${!can('approve')?button(state.auth.mode==='oidc'?'退出并更换终审账户':'切换为业务终审员','switch-approver','','primary'):''}</div>${panel('数据入库终审队列',`${pending.length}项待处理 · 点击详情查看校验、原始数据和审核证据`,batchTable(pending))}`;}
function analysisView(){const r=state.report;return `${stats([['产量',number(r.total),'已入库生产数据'],['良品率',number(r.yield,'%'),'总数为0时不计算'],['质量样本',r.qualitySamples,'未进行产品放行'],['Cp / Cpk','—','需同特性样本与稳定性验证']])}${panel('班次效率分析','A × P × Q · 数据不完整时显示缺失条件',productionTable(r.production))}<div class="upload-layout">${panel('停机原因分析','按已批准状态区间汇总',r.reasons.length?`<div class="reason-bars">${r.reasons.map(x=>`<div><label><span>${esc(x.reason)}</span><b>${number(x.minutes,' min')}</b></label><i style="width:${Math.max(5,Math.min(100,x.minutes/Math.max(...r.reasons.map(t=>t.minutes))*100))}%"></i></div>`).join('')}</div>`:'<div class="empty-small">上传状态区间后显示停机分布。</div>')}${panel('维修记录','记录维修事实；导入结束时间不等于自动关单',table(['设备','故障原因','维修措施','完成时间'],r.repairs.map(x=>`<tr><td>${esc(x.device_code)}</td><td>${esc(x.cause)}</td><td>${esc(x.action)}</td><td>${stamp(x.repair_end)}</td></tr>`)))}</div>${panel('质量检验原始样本',esc(r.cpkIssue),table(['设备 / 批次','特性 / 样本','实测 / 单位','规格限','判断'],r.quality.map(q=>`<tr><td><b>${esc(q.device_code)}</b><span>${esc(q.batch_code)}</span></td><td>${esc(q.characteristic_code)} / ${q.sample_no}</td><td>${q.measured_value} ${esc(q.unit)}</td><td>${q.lsl}–${q.usl}</td><td>${badge(Number(q.measured_value)>=Number(q.lsl)&&Number(q.measured_value)<=Number(q.usl)?'单点规格内':'单点超规格')}</td></tr>`)))}`;}
function auditView(){return renderAuditView(state.audit,state.busy);}
function rolesView(){const r=state.roles;return `${panel('当前实际执行的权限',esc(r.scopeNotice),table(['Keycloak角色','后端操作权限'],Object.entries(r.runtimeRolePermissions).map(([role,permissions])=>`<tr><td><code>${esc(role)}</code></td><td class="wrap-cell">${permissions.map(p=>esc(r.runtimePermissionLabels?.[p]||p)).join('、')}</td></tr>`)))}${panel('当前账户',state.auth.mode==='oidc'?'身份来自已验证的OIDC令牌，不能在页面选择角色':'演示模式，不是真实认证',`<p>${esc(identityName())}</p><p>企业：${esc(state.auth.user?.tenantId||'acme')}</p><p>角色：${esc(state.auth.user?.roles?.join('、')||state.actor)}</p><p>当前生效权限：${(r.currentPermissions||[]).map(p=>esc(r.runtimePermissionLabels?.[p]||p)).join('、')}</p><p>角色叠加仍受独立审批和平台管理员业务隔离限制；页面不修改账号角色。</p>`)}${panel('产品目标权限包（不等于已实现）',`版本${esc(r.version)} · ${r.roles.length}类角色 / ${r.permissionCatalog.length}项目标权限`,table(['角色','目标范围','权限数量','职责'],r.roles.map(x=>`<tr><td><b>${esc(x.name)}</b><span>${esc(x.key)}</span></td><td>${esc(r.dataScopes[x.dataScope])}</td><td>${x.permissions.length}</td><td class="wrap-cell">${esc(x.description)}</td></tr>`)))}`;}
function integrationsView(){return `<section class="upload-hero"><div><span class="eyebrow">OPEN INTERFACES</span><h2>手动上传起步，自动接入演进</h2><p>文件与企业接口共用校验、批次审批和追溯边界。<br>真实设备采集继续保持只读。</p></div><div class="api-mark"><code>/api/v1</code><span>CSV · XLSX · JSON</span></div></section><div class="integration-grid">${state.integrations.items.map(i=>`<article><div class="integration-head"><span>${esc(i.category)}</span><em class="${i.status}">${i.status==='CONNECTED'?'开发已接通':i.status==='CONFIGURED'?'已配置真实认证':i.status==='READY'?'待联调':'尚未接入'}</em></div><h3>${esc(i.name)}</h3><b>${esc(i.mode)}</b><p>${esc(i.detail)}</p></article>`).join('')}</div>${panel('上传 API',state.auth.mode==='oidc'?'当前使用真实会话或Bearer JWT；请求头不能覆盖企业和身份':'演示模式使用请求头，不可对公网开放',`<div class="api-list"><code>POST /api/v1/data-imports</code><span>multipart/form-data · 文件上传</span><code>POST /api/v1/data-imports/records</code><span>JSON · 企业接口上传</span><code>GET /api/v1/data-imports/{batchId}</code><span>校验、审核与入库状态</span><code>POST /api/v1/data-imports/{batchId}/approval</code><span>独立人工批准 · 版本与快照校验</span></div><p class="boundary-note">写请求需Idempotency-Key和X-Correlation-Id；浏览器会话还需同源及CSRF令牌。服务账号人工终审被禁止，机器身份接入仍待专门配置。已发布字段映射用于CSV/XLSX表头；已入库记录支持显式更正并须独立批准。映射不执行单位换算，Webhook尚未接入。</p>`)}`;}
function guideView(){return `${panel('多设备数据管理使用顺序','不要重置已有企业数据；样例仅供隔离沙箱演示',`<ol class="guide-list"><li><b>1. 建立设备台账</b><p>上传专员登录后下载设备扩展样例，填写企业真实设备编码和工厂/产线。类型、品牌、型号、序列号和关键度可选；由另一终审员批准。</p></li><li><b>2. 建立设备测点字典</b><p>选择“测点定义”，填写每设备测点编码、名称、单位、最小/最大物理值和可选记录间隔。批准前不能上传自定义测点。录入范围不是告警阈值。</p></li><li><b>3. 上传测点记录</b><p>选择“设备测点”，填入已批准的设备与测点、带时区采样时间、数值、单位和GOOD/BAD/UNCERTAIN质量。支持七类CSV/XLSX；JSON保留给接口接入。上传者即使兼有终审角色也不能自审。</p></li><li><b>4. 查询与追溯</b><p>进入设备数据中心，筛选类型、工厂、设备、测点、时间和质量，点击来源打开原批次及行号。只有批准记录可见；GOOD不代表设备健康，手动上传不代表设备实时在线。</p></li><li><b>5. 后续按需分析与维修</b><p>生产/状态/维修/质量可独立上传。预测页仅提供兼容工程测点的规则分析，不是所有设备通用预测；维护建议和工单关单仍须独立人工批准。</p></li></ol><div class="guide-actions">${button('设备数据中心','data-center','','primary')}${button('数据上传中心','uploads')}${state.auth.mode==='demo'?button('重置本机演示数据','reset','','danger'):''}</div>`)}${panel('当前能力边界','开发验证版，不等于商业生产验收',`<p>真实连接以集成页面为准。完整本机平台已接通OIDC、PostgreSQL、Flowable与本地模型SHADOW抽样审阅，上传仍须人工复核和独立终审；文件Demo使用规则模拟。企业范围权限、已发布字段映射和已入库数据更正已提供；具体操作仍受当前账号和业务状态限制。现场接入、RUL、自动中审和生产运维仍需配置或验收。</p>`)}`;}
function body(){
  if(state.view==='spares')return sparesView(state.spares,state.actor);
  if(!state.report)return '<div class="empty">正在加载设备数据工作台…</div>';
  if(state.view==='field-channels')return fieldChannelView(state.fieldChannels,state.busy,state.fieldChannelsAvailable,can);
  if(state.view==='source-governance')return sourceGovernanceView(state.sourceGovernance,state.busy,state.sourceGovernanceAvailable,can);
  if(state.view==='operational')return operationalView(state.operational,can,state.auth?.user?.actorId||state.actor,state.busy,state.operationalAvailable);
  if(state.view==='quality-policy')return qualityPolicyView(state.policyEvaluation,state.busy,state.policyAvailable);
  if(state.view==='coverage-history')return coverageReplayView(state.coverageReplay,can,state.actor,state.busy,state.replayAvailable);
  if(state.view==='data-quality')return (state.dataQuality.mode==='TELEMETRY'?receiptVersionPicker(state.dataQuality,state.busy,'quality-receipt-version'):'')+dataQualityView(state.dataQuality.result,state.dataQuality.filters,state.busy,state.dataQuality.mode,state.dataQuality.error,state.dataQuality.metric);
  if(state.view==='data-center')return dataCenterView(state.dataCenter,can('upload'),state.busy);
  if(state.view==='equipment-profiles')return equipmentProfileView(state.catalog,state.profiles,can,state.actor,state.busy);
  if(state.view==='templates')return fieldUi.authorView()+sourceUi.authorView()+operationalUi.authorView()+policyAuthorView(state.policyEditor,state.busy)+catalogView({...state.catalog,items:state.catalog.items.filter(t=>!isProfile(t))},can,state.actor,state.busy);
  return ({uploads:uploadsView,overview:overviewView,predictive:predictiveView,telemetry:()=>telemetryView(state.telemetry,state.telemetryPoints,state.telemetryUpdatedAt,can('analyze')),'work-orders':()=>maintenanceView(state.predictive?.workOrders||[],state.actor,state.busy,{oidc:state.auth.mode==='oidc',canExecute:can('maintenance:execute'),canApprove:can('maintenance:approve')},state.workflowDetails),devices:devicesView,approvals:approvalsView,analysis:analysisView,audit:auditView,roles:rolesView,integrations:integrationsView,guide:guideView}[state.view]||uploadsView)();
}
function drawer(){
  if(state.history)return revisionHistoryView(state.history,can('upload'),state.busy,labels,state.catalog.items);
  const b=state.selected;if(!b)return '';
  const columns=Object.keys(b.preview[0]||{}).filter(k=>!['source_profile_ref','profile_values'].includes(k)), pending=['AWAITING_APPROVAL','HUMAN_REVIEW'].includes(b.status);
  return `<div class="drawer-scrim" data-action="close"></div><aside class="import-drawer"><div class="drawer-head"><div><span class="eyebrow">${types[b.dataType]} · ${b.batchId.slice(0,8)}</span><h2>${esc(b.filename)}</h2></div>${button('×','close','','icon-btn')}</div><div class="import-drawer-body"><div class="batch-status-row">${badge(b.status)}<span>v${b.version} · ${esc(b.sourceKind)}</span></div>${batchNextStepView(b,{actor:state.actor,canApprove:can('approve'),busy:state.busy})}${stats([['有效',b.counts.valid,'待写入或已入库'],['错误',b.counts.invalid,'整批错误阻止入库'],['重复',b.counts.duplicates,'不重复写入'],['入库',b.counts.committed,'已批准记录']])}<dl class="batch-facts"><dt>上传人</dt><dd>${esc(b.uploader)}</dd><dt>来源系统</dt><dd>${esc(b.sourceSystem)}</dd><dt>上传时间</dt><dd>${stamp(b.createdAt)}</dd><dt>模板版本</dt><dd>${esc(b.templateVersion)}</dd><dt>原文件SHA-256</dt><dd><code>${b.fileSha256}</code></dd><dt>冻结快照</dt><dd><code>${b.snapshotDigest}</code></dd></dl>
  <div class="batch-downloads">${button('下载原始文件','original')}${b.errors.length?button('导出错误清单','errors'):''}</div>
  ${importErrorView(importErrors,b,labels,state.busy)}
  ${batchPageView(batchPager,b,labels,historyButton)}
  <section class="ai-card"><div class="ai-title"><b>${b.aiReview.modelVersion==='unavailable'?'人工复核要求':'模拟 AI 中间审核'}</b><span>${b.aiReview.confidence==null?'无模型置信度':`${Math.round(b.aiReview.confidence*100)}% 演示值`}</span></div><p>${esc(b.aiReview.conclusion)}</p><ul>${b.aiReview.evidence.map(e=>`<li>${esc(e)}</li>`).join('')}</ul><small>模型/规则 ${esc(b.aiReview.modelVersion)} · 不具备最终批准权限</small></section>
  ${b.approval?`<section class="approval-result"><b>人工${b.approval.decision==='APPROVED'?'批准':b.approval.decision==='RETURNED'?'退回':'驳回'} · ${esc(b.approval.approver)}</b><p>${esc(b.approval.comment)}</p>${b.approval.reviewResolution?`<p>复核依据：${esc(b.approval.reviewResolution)}</p>`:''}<small>${stamp(b.approval.decidedAt)}</small></section>`:''}
  ${pending?`<section class="approve-form" data-batch-key="${esc(batchDraft.key)}"><h3>最终人工批准</h3><p>批准当前冻结输入后正式入库。上传者不能批准自己的数据。</p>${can('approve')&&b.uploader!==state.actor?`<label>审批意见<textarea id="approval-comment" placeholder="核对了数据来源和统计口径，同意本批次入库。" maxlength="2000">${esc(batchDraft.comment)}</textarea></label>${b.status==='HUMAN_REVIEW'?`<label>人工复核依据<textarea id="review-resolution" placeholder="说明人工核查结果与证据来源。" maxlength="4000">${esc(batchDraft.resolution)}</textarea></label>`:''}<div class="approval-buttons">${button('退回修正','decide','data-decision="RETURNED"','danger')}${button('驳回','decide','data-decision="REJECTED"','secondary')}${button('批准并入库','decide','data-decision="APPROVED" data-testid="approve-batch"','primary')}</div>`:button(state.auth.mode==='oidc'?'退出并由独立终审员登录':'切换终审员继续','switch-approver','','primary')}</section>`:''}
  </div><div class="drawer-foot"><small>${state.auth.mode==='oidc'?'企业数据 · 审批与入库记录可追溯':'本机演示存储 · 审批与入库记录可追溯'}</small>${button('关闭','close')}</div></aside>`;
}
function render(){
  state.view=canonicalView(state.view);
  captureBatchDraft();captureReplayDraft();capturePolicyDraft();operationalUi.capture();sourceUi.capture();fieldUi.capture();
  const activeBatch=state.auth&&(state.auth.mode!=='oidc'||state.auth.authenticated)&&!state.history?state.selected:null;
  importErrors.bind(activeBatch,auditIdentity());
  const draftKey=activeBatch?JSON.stringify([auditIdentity(),activeBatch.batchId]):'';
  if(draftKey!==batchDraft.key)batchDraft={key:draftKey,comment:'',resolution:''};
  if(batchPager.bind(activeBatch,auditIdentity()))queueMicrotask(()=>{if(batchPager.batch&&!batchPager.loading&&!batchPager.data&&!batchPager.error)void loadBatchPage('rows',1);});
  if(!state.auth||(state.auth.mode==='oidc'&&!state.auth.authenticated)){root.innerHTML=loginView(state.error,!state.auth&&!state.error);return;}
  const oidc=state.auth.mode==='oidc';
  root.innerHTML=`<div class="shell manual-shell"><aside class="sidebar"><div class="brand"><div class="brand-mark">⌁</div><div><strong>IDMS</strong><span>企业设备与生产数据平台</span></div></div><div class="tenant"><span class="tenant-logo">企</span><div><b>${oidc?esc(state.auth.user.tenantId):'华东精工 · 演示企业'}</b><small>初期方案 · 手动数据接入</small></div></div><nav aria-label="主导航">${workspaceNavigation(availableNavigation(),state.view,state.report?.pending)}</nav><div class="sidebar-foot"><b>●</b><span>数据可追溯 · 设备只读边界</span></div></aside><main><header><div><h1>${navigation.find(n=>n[0]===state.view)?.[2]}</h1><p>本地开发版 · 企业设备与运维管理</p></div><div class="head-actions">${button('↻','refresh','','icon-btn')}${oidc?identityBadge(state.auth.user):`<label class="actor-picker">演示身份<select id="actor-select" data-testid="actor-select">${Object.entries(roles).map(([key,name])=>`<option value="${key}" ${state.actor===key?'selected':''}>${name}</option>`).join('')}</select></label>`}</div></header><nav class="mobile-nav" aria-label="手机主导航">${workspaceNavigation(availableNavigation(),state.view,state.report?.pending)}</nav><section class="content"><div class="manual-demo-bar"><span><b>${oidc?'DEV':'DEMO'}</b> ${oidc?'真实身份与企业数据库 · 开发验证版':'可操作销售演示 · 本机数据持久化'} · AI规则模拟</span><div>上传 → 校验 → 中审 → 人工终审 → 入库 → 追溯</div>${button('使用说明','guide')}</div>${state.error?`<div role="alert" class="error-banner">${esc(state.error)}${button('重试加载','refresh')}</div>`:''}${state.busy?'<div class="busy-line">正在处理，请稍候…</div>':''}${workspaceTabs(availableNavigation(),state.view)}${state.view==='approvals'?sparesTasksView(state.spares.data):''}${body()}</section></main>${drawer()}${state.toast?`<div class="toast" role="status">${esc(state.toast)}</div>`:''}</div>`;
  enhanceAiReviewUi(state,root);
  if(state.view==='work-orders')for(const node of root.querySelectorAll('.work-order'))node.querySelector('.work-order-body')?.insertAdjacentHTML('beforeend',workOrderStockUsage(state.spares,node.id.slice(3)));
  const sourceField=root.querySelector('#source-system')?.closest('label');
  if(sourceField)sourceField.insertAdjacentHTML('afterend',correctionPicker(state.batches,state.type,state.source,state.correctionParent,state.correctionReason,state.busy));
  const batchBody=root.querySelector('.import-drawer-body');
  if(batchBody&&state.selected&&!state.history)batchBody.insertAdjacentHTML('afterbegin',correctionEvidence(state.selected,labels));
  if(batchBody&&state.selected&&!state.history)batchBody.insertAdjacentHTML('afterbegin',profileEvidence(state.selected.equipmentProfileBinding,state.selected.preview));
  const aiLabel=root.querySelector('#ai-mode')?.closest('label');
  if(aiLabel)aiLabel.insertAdjacentHTML('beforebegin',mappingPicker(state.catalog.items,state.type,state.source,state.mappingId,state.busy));
  if(aiLabel)aiLabel.insertAdjacentHTML('beforebegin',profilePicker(state.catalog.items,state.type,state.profileId,state.busy));
  if(state.mappingId){const description=root.querySelector('.drop-zone span');if(description)description.textContent='企业原表头 · Excel工作表名 data';}
  const downloads=root.querySelector('.batch-downloads');
  if(downloads&&state.selected)downloads.insertAdjacentHTML('afterend',batchMappingEvidence(state.selected));
  if(state.view==='templates'){
    if(state.catalog.editor?.value?.manifest?.purpose==='import-mapping'){const note=root.querySelector('#catalog-form .form-note');if(note)note.textContent='来源、类型和字段对应随版本冻结；提交后需独立批准。映射不执行脚本或值转换。';}
    const notice=root.querySelector('.approval-notice');
    if(notice){notice.querySelector('b').textContent='企业模板 · 维修、映射、日历与质量规则';notice.querySelector('p').textContent='维修字段绑定新工单，上传映射绑定新批次，日历配置与生效安排分别独立发布。生效安排可安排未来切换、明确历史修订；日历复核不重放历史定义或数据。旧版本与审批保留。质量规则单独按生效时间和资料截止复核。';notice.insertAdjacentHTML('beforeend',`${can('template:edit')?button('新建上传映射','catalog-mapping-new')+(state.policyAvailable?button('新建质量策略','catalog-quality-new'):''):''}<label class="catalog-purpose-filter">模板用途<select id="catalog-purpose"><option value="">全部用途</option><option value="import-mapping">上传映射</option><option value="maintenance-form">维修字段</option><option value="operation-calendar">运行日历（含循环）</option><option value="calendar-schedule">日历生效安排</option><option value="data-quality-policy">质量规则策略</option></select></label>`);root.querySelector('#catalog-purpose').value=state.catalog.filter||'';}
    for(const item of state.catalog.items){const node=document.getElementById('template-'+item.id);if(!node)continue;const mapped=item.manifest.purpose==='import-mapping',calendar=item.manifest.purpose==='operation-calendar',scheduled=item.manifest.purpose==='calendar-schedule',purpose=item.manifest.purpose||'maintenance-form';node.hidden=!!state.catalog.filter&&purpose!==state.catalog.filter;node.querySelector('.panel-head p').textContent=`${item.industry} · 修订 ${item.revision??'历史'} · ${item.runtimeApplicable?(scheduled?(item.status==='PUBLISHED'?'当前发布生效安排':item.status==='RETIRED'?'历史生效安排':'待发布生效安排'):calendar?(item.status==='PUBLISHED'?'当前发布日历配置':item.status==='RETIRED'?'历史日历配置':'待发布日历配置'):mapped?'可用于上传映射':'可用于维修字段'):'历史 / 未验证配置'}`;if(item.manifest.purpose==='data-quality-policy')node.querySelector('.panel-head p').textContent=item.industry+' · 修订 '+item.revision+' · '+(item.status==='PUBLISHED'?'当前发布质量策略':item.status==='RETIRED'?'历史质量策略':'待发布质量策略');const policy=node.querySelector('.catalog-details p:last-child');if(policy&&item.manifest.purpose==='data-quality-policy')policy.textContent='独立终审 / 数据质量规则复核。无规则或缺条件保持未知，不代表健康或质量放行。';if(policy&&scheduled)policy.textContent='独立终审 / 日历部分重放。当前权限始终生效，定义与数据使用当前授权结果。';if(policy&&calendar)policy.textContent='安全策略：独立人工终审 / 设备只读。区间随版本冻结；生效时刻由独立安排声明。';if(policy&&mapped)policy.textContent='安全策略：独立人工终审 / 设备只读。新批次冻结映射；旧批次不重算。';}
  }
  operationalUi.decorateCatalog();sourceUi.decorateCatalog();fieldUi.decorateCatalog();
}
document.addEventListener('submit',event=>{
 if(['spares-form','spares-search','spares-history-filter'].includes(event.target.id)){event.preventDefault();const button=event.target.querySelector('[type=submit]');if(button)void sparesUi.handle(button).catch(error=>{state.spares.error=error.message;render();});return;}
 if(event.target.id!=='import-error-filter')return;
 event.preventDefault();if(!state.busy)applyImportErrorFilter(event.target);
});
document.addEventListener('change',event=>{
 if(event.target.id==='replay-receipt-version'){captureReplayDraft();state.coverageReplay.setReceiptVersion(event.target.value);replayTask(loadCoverageHistory);return;}
 if(event.target.id==='policy-receipt-version'){capturePolicyDraft();state.policyEvaluation.setReceiptVersion(event.target.value);render();return;}
 if(event.target.id==='quality-receipt-version'){state.dataQuality.setReceiptVersion(event.target.value);task(loadDataQuality);return;}
  const target=event.target;
  if(target.closest('#policy-evaluation-form')){const form=target.closest('form');if(Number(form.dataset.ownerEpoch)!==state.policyEvaluation.epoch)return;const changed=state.policyEvaluation.setFilters(Object.fromEntries(new FormData(form)));if(target.name==='source')render();else if(changed)root.querySelector('.policy-evaluation-result')?.remove();return;}
  if(target.closest('#quality-policy-editor')){capturePolicyDraft();if(target.name==='suspended'){const entry=state.policyEditor.value.manifest.dataQualityPolicy.entries[Number(target.closest('[data-entry-index]').dataset.entryIndex)];if(!target.checked&&!entry.rules?.length){entry.rules=[];addPolicyRule(entry);}renderPolicyAuthor();}return;}
  if(target.closest('#profile-editor')&&target.name==='type'){const e=state.profiles.editor;e.value=readProfileEditor(root.querySelector('#profile-editor'),e);for(const f of e.value.manifest.equipmentProfile.assetFields){if(f.type!=='NUMBER'){delete f.min;delete f.max;}if(f.type!=='TEXT')delete f.maxLength;if(f.type!=='SELECT')delete f.options;}render();return;}
  if(target.closest('#replay-form')){const form=target.closest('form');if(Number(form.dataset.ownerEpoch)!==state.coverageReplay.epoch)return;const changed=state.coverageReplay.setFilters(Object.fromEntries(new FormData(form)));if(target.name==='source')render();else if(changed)root.querySelector('.replay-result')?.remove();return;}
  if(target.closest('#quality-filter')&&state.dataQuality.metric==='COVERAGE'){state.dataQuality.filters=Object.fromEntries(new FormData(target.closest('form')));if(state.dataQuality.filters.planMode!=='EFFECTIVE')delete state.dataQuality.filters.knownAt;state.dataQuality.revision++;state.dataQuality.result=null;state.dataQuality.error='';state.dataQuality.page=1;if(target.name==='planMode')render();else root.querySelector('.coverage-result')?.remove();return;}
  if(target.id==='equipment-profile'){state.profileId=target.value;return;}
  if(target.id==='profile-asset-type'){state.profiles.assetType=target.value;state.profiles.assetValues={};state.profiles.assetDraft={};render();return;}
  if(target.closest('#profile-asset-form')){const form=target.closest('form'),t=state.catalog.items.find(t=>t.id===state.profiles.assetType);state.profiles.assetDraft=Object.fromEntries(new FormData(form));state.profiles.assetValues=t?typedValues(form,profileConfig(t).assetFields):{};}
  if(target.id==='revision-profile'){const form=target.closest('form'),latest=state.history.items.at(-1),t=state.catalog.items.find(t=>t.id===state.history.upgradeProfileId),fields=profileConfig(t||latest.equipmentProfileBinding)?.assetFields||[];state.history.draftRow={...latest.record.value,...Object.fromEntries(new FormData(form))};state.history.draftValues=typedValues(form,fields);state.history.upgradeProfileId=target.value;render();return;}
  if(target.id==='profile-import'&&target.files[0]){const file=target.files[0];task(async()=>{const value=await readCatalogPackage(file,state.policyAvailable,state.operationalAvailable,state.sourceGovernanceAvailable,state.fieldChannelsAvailable);if(value.content?.manifest?.purpose!=='equipment-profile')throw Error('请选择设备类型包');await post('/templates/import',value);await load();notify('类型包已导入为待审草稿');});return;}
  if(target.id==='actor-select'){state.selected=null;batchPager.clear();state.history=null;state.actor=target.value;clearAudit(true);clearQuality();state.workflowDetails={};state.catalog.editor=null;task(load);}
  if(target.id==='catalog-import'&&target.files[0]){const file=target.files[0];task(async()=>{const value=await readCatalogPackage(file,state.policyAvailable,state.operationalAvailable,state.sourceGovernanceAvailable,state.fieldChannelsAvailable);await post('/templates/import',value);await load();notify('模板包已导入为本企业草稿，仍需独立批准。');});}
  if(target.id==='correction-parent'){state.correctionParent=target.value;state.correctionReason='';render();}
  if(target.id==='correction-reason')state.correctionReason=target.value;
  if(target.id==='data-type'){state.correctionParent='';state.type=target.value;state.mappingId='';state.profileId='';render();}
  if(target.id==='source-system'){const next=target.value.trim();if(next===state.source)return;state.correctionParent='';state.source=next;state.mappingId='';render();}
  if(target.id==='import-mapping'){state.mappingId=target.value;render();}
  if(target.id==='catalog-purpose'){state.catalog.filter=target.value;render();}
  if(target.id==='ai-mode')state.aiMode=target.value;
  if(target.id==='batch-filter'){state.filter=target.value;render();}
  if(target.id==='file-upload'&&target.files[0]){const file=target.files[0];task(()=>upload(file));}
});
document.addEventListener('click',event=>{
  const target=event.target.closest('[data-action]');if(!target||target.disabled||state.busy)return;
  captureBatchDraft();
  const action=target.dataset.action;
  if(action==='workbench-spares'){state.view='spares';task(()=>sparesUi.navigate(target.dataset.tab==='purchases'?'purchases':'inventory'));return;}
  if(action.startsWith('spares-')){event.preventDefault();void sparesUi.handle(target).catch(error=>{state.spares.error=error.message;render();});return;}
  if(action==='device-spares'||action==='wo-spares'){state.view='spares';state.selected=null;task(async()=>{await sparesUi.navigate(action==='device-spares'?'links':'movements',{deviceCode:target.dataset.device||'',...(action==='wo-spares'?{workOrderId:target.dataset.id}:{})});if(action==='wo-spares')await sparesUi.openEditor('stock.issue','','工单领用备件',{deviceCode:target.dataset.device,workOrderId:target.dataset.id});});return;}
  if(action==='import-error-filter'){event.preventDefault();applyImportErrorFilter(target.closest('form'));return;}
  if(action==='import-error-clear'){importErrors.field='';importErrors.query='';render();root.querySelector('#import-error-review')?.scrollIntoView({block:'start'});return;}
  if(['import-errors','import-review','import-decision'].includes(action)){
    const selector={'import-errors':'#import-error-review','import-review':'.batch-pages','import-decision':'.approval-result'}[action];
    const section=root.querySelector(selector);if(section)section.scrollIntoView({block:'start',behavior:'smooth'});else notify('当前批次暂无对应内容，请刷新核对。');return;
  }
  if(action.startsWith('policy-author-')){capturePolicyDraft();const editor=state.policyEditor;if(!editor)return;
    if(action==='policy-author-cancel'){state.policyEditor=null;render();return;}const p=editor.value.manifest.dataQualityPolicy,index=Number(target.dataset.entry),entry=p.entries[index];
    if(action==='policy-author-add-entry')addPolicyEntry(p);
    if(action==='policy-author-remove-entry'&&p.entries.length>1)p.entries.splice(index,1);
    if(action==='policy-author-add-rule'&&entry?.rules)addPolicyRule(entry);
    if(action==='policy-author-remove-rule'&&entry?.rules?.length>1)entry.rules.splice(Number(target.dataset.rule),1);
    if(action==='policy-author-save'){if(!root.querySelector('#quality-policy-editor')?.reportValidity())return;const payload=editor.id?{manifest:editor.value.manifest,expectedDigest:editor.value.contentDigest,expectedRevision:editor.value.revision}:editor.value;policyTask(async()=>{await post(editor.id?'/templates/'+editor.id+'/edit':'/templates',payload);state.policyEditor=null;await load();notify('质量策略草稿已保存，提交后须独立终审。');});return;}renderPolicyAuthor();return;
  }
  if(action.startsWith('policy-')){capturePolicyDraft();const m=state.policyEvaluation;
    if(action==='policy-now'){m.setFilters({...m.filters,knownAt:new Date().toISOString()});root.querySelector('#policy-evaluation-form').dataset.ownerEpoch='-1';render();return;}
    if(action==='policy-evaluate'){if(!root.querySelector('#policy-evaluation-form')?.reportValidity())return;policyTask(()=>m.preview(api,auditIdentity));return;}
    if(action==='policy-page'){m.page=Number(target.dataset.page);policyTask(()=>m.preview(api,auditIdentity));return;}
    if(action==='policy-export'){let path;try{path=m.exportPath();}catch(error){notify(error.message);return;}policyTask(()=>nativeCsvDownload(path));return;}
    return;
  }
  if(action.startsWith('replay-')){captureReplayDraft();const m=state.coverageReplay;
    if(action==='replay-now'){m.setFilters({...m.filters,knownAt:new Date().toISOString()});render();return;}
    if(action==='replay-run'){if(!root.querySelector('#replay-form')?.reportValidity())return;replayTask(()=>m.preview(api,auditIdentity));return;}
    if(action==='replay-page'){m.page=Number(target.dataset.page);replayTask(()=>m.preview(api,auditIdentity));return;}
    if(action==='replay-list-refresh'){replayTask(loadCoverageHistory);return;}
    if(action==='replay-list-filter'){m.listDevice=m.listDevice?'':m.filters.deviceCode;m.listPage=1;replayTask(()=>m.loadList(api,auditIdentity));return;}
    if(action==='replay-list-page'){m.listPage=Number(target.dataset.page);replayTask(()=>m.loadList(api,auditIdentity));return;}
    if(action==='replay-report-open'){replayTask(()=>m.open(api,auditIdentity,target.dataset.id));return;}
    if(action==='replay-report-close'){m.close();render();return;}
    if(action==='replay-detail-page'){m.detailPage=Number(target.dataset.page);render();return;}
    if(action==='replay-report-export'){replayTask(()=>nativeCsvDownload(m.reportBase+'/'+encodeURIComponent(target.dataset.id)+'/export'));return;}
    if(action==='replay-freeze'){if(!root.querySelector('#replay-freeze-form')?.reportValidity())return;let input;try{input=m.freezeRequest();}catch(error){notify(error.message);return;}const path=m.reportBase,key=m.commandKey(path,input);replayTask(async()=>{const receipt=await post(path,input,state.actor,key);await m.loadList(api,auditIdentity);await m.open(api,auditIdentity,receipt.reportId);notify('冻结草稿已保存，须提交并由独立人员终审。');});return;}
    if(action==='replay-report-submit'&&m.detail){const path=m.reportBase+'/'+m.detail.reportId+'/submit',input={expectedRevision:m.detail.revision,expectedPayloadDigest:m.detail.payloadDigest},id=m.detail.reportId,key=m.commandKey(path,input);replayTask(async()=>{await post(path,input,state.actor,key);await m.open(api,auditIdentity,id);await m.loadList(api,auditIdentity);notify('冻结报告已提交，等待独立终审。');});return;}
    if(action==='replay-report-approve'&&m.detail){if(!root.querySelector('#replay-approval')?.reportValidity())return;const path=m.reportBase+'/'+m.detail.reportId+'/approval',input={expectedRevision:m.detail.revision,expectedPayloadDigest:m.detail.payloadDigest,decision:target.dataset.decision,comment:m.approvalComment},id=m.detail.reportId,key=m.commandKey(path,input);replayTask(async()=>{await post(path,input,state.actor,key);await m.open(api,auditIdentity,id);await m.loadList(api,auditIdentity);notify('独立终审决定已保存，原冻结内容保持。');});return;}
    return;
  }

  if(action==='batch-page-kind'){void loadBatchPage(target.dataset.kind,1);return;}
  if(action==='batch-page-retry'){void loadBatchPage();return;}
  if(action==='batch-page-next'||action==='batch-page-previous'){if(!batchPager.loading&&batchPager.data?.[action==='batch-page-next'?'hasNext':'hasPrevious'])void loadBatchPage(batchPager.kind,batchPager.page+(action==='batch-page-next'?1:-1));return;}
  if(action==='audit-batch'){task(async()=>{state.selected=await api('/data-imports/'+encodeURIComponent(target.dataset.id));});return;}
  if(action==='audit-next'||action==='audit-previous'){const cursor=state.audit.data?.[action==='audit-next'?'nextCursor':'previousCursor'];if(cursor)task(()=>loadAudit(cursor));return;}
  if(action==='audit-filter'){const form=target.closest('form');if(!form?.reportValidity())return;const filters=Object.fromEntries(new FormData(form));clearAudit();state.audit.filters=filters;task(()=>loadAudit());return;}
  if(action==='audit-refresh'||action==='audit-reset'){clearAudit(action==='audit-reset');task(()=>loadAudit());return;}
  if(action.startsWith('profile-')){
    const item=state.catalog.items.find(t=>t.id===target.dataset.id),ui=state.profiles,e=ui.editor;
    if(action==='profile-new'){ui.editor={value:newProfile()};render();return;}
    if(action==='profile-cancel'){ui.editor=null;render();return;}
    if(action==='profile-edit'&&item){ui.editor={id:item.id,value:structuredClone(item)};render();return;}
    if((action==='profile-clone'||action==='profile-derive')&&item){const value=newProfile(),same=state.catalog.items.filter(t=>t.templateKey===item.templateKey&&/^\d+\.\d+\.\d+$/.test(t.version)).map(t=>t.version.split('.').map(Number)).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]),last=same.at(-1)||[1,0,0];value.templateKey=action==='profile-clone'?item.templateKey:'';value.version=action==='profile-clone'?`${last[0]}.${last[1]}.${last[2]+1}`:'1.0.0';value.industry=item.industry;value.manifest.equipmentProfile=structuredClone(profileConfig(item));if(item.equipmentResolution)value.parent=item.templateKey+'@'+item.version;ui.editor={value};render();return;}
    if(e&&['profile-field-add','profile-field-remove','profile-point-add','profile-point-remove'].includes(action)){e.value=readProfileEditor(root.querySelector('#profile-editor'),e);const p=e.value.manifest.equipmentProfile;if(action==='profile-field-add'){if(p.assetFields.length>=12)return notify('扩展字段最多12项');p.assetFields.push({key:'',label:'',type:'TEXT',required:false});}if(action==='profile-point-add'){if(p.points.length>=64)return notify('测点最多64项');p.points.push({tag_code:'',tag_name:'',unit:'',min_value:0,max_value:1});}if(action==='profile-field-remove')p.assetFields.splice(Number(target.dataset.index),1);if(action==='profile-point-remove')p.points.splice(Number(target.dataset.index),1);render();return;}
    if(action==='profile-save'&&e){const form=root.querySelector('#profile-editor');if(!form?.reportValidity())return;e.value=readProfileEditor(form,e);const value=e.value,payload=e.id?{manifest:value.manifest,expectedDigest:value.contentDigest,expectedRevision:value.revision}:{templateKey:value.templateKey,version:value.version,industry:value.industry,...(value.parent?{parent:value.parent}:{}),manifest:value.manifest};task(async()=>{await post(e.id?`/templates/${e.id}/edit`:'/templates',payload);ui.editor=null;await load();notify('类型草稿已保存');});return;}
    if(action==='profile-submit'&&item){task(async()=>{await post(`/templates/${item.id}/submit`,{expectedDigest:item.contentDigest,expectedRevision:item.revision});await load();notify('继承结果已冻结，等待另一人终审');});return;}
    if(['profile-approve','profile-return','profile-reject'].includes(action)&&item){const form=target.closest('form');if(!form?.reportValidity())return;const comment=form.querySelector('[name=comment]').value;task(async()=>{await post(`/templates/${item.id}/approval`,{decision:action==='profile-approve'?'APPROVED':action==='profile-return'?'RETURNED':'REJECTED',comment,expectedDigest:item.contentDigest,expectedRevision:item.revision});await load();notify('类型审批已记录，已有批次配置保留');});return;}
    if(action==='profile-export'&&item){task(()=>download(`/templates/${item.id}/export`,`${item.templateKey}-${item.version}.json`));return;}
    if(action==='profile-asset-create'){const form=root.querySelector('#profile-asset-form'),t=state.catalog.items.find(t=>t.id===ui.assetType&&t.status==='PUBLISHED');if(!t||!form?.reportValidity())return;const fields=Object.fromEntries(new FormData(form)),{sourceSystem,...row}=fields;row.profile_values=JSON.stringify(typedValues(form,profileConfig(t).assetFields));task(async()=>{const batch=await post('/data-imports/records',{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem,records:[row],equipmentProfileRef:profileRef(t)});state.selected=batch;ui.assetDraft={};ui.assetValues={};await load();notify('设备台账批次已提交，等待独立终审');});return;}
    if(action==='profile-points-create'){const form=root.querySelector('#profile-points-form');if(!form?.reportValidity())return;const deviceCode=form.querySelector('[name=deviceCode]').value.trim();task(async()=>{state.selected=await post('/equipment-profiles/points',{deviceCode});await load();notify('测点批次已生成，需独立终审后生效');});return;}
    return;
  }
  if(action==='quality-metric'){state.dataQuality.switchMetric(target.dataset.metric);task(loadDataQuality);return;}
  if(action==='quality-source'){state.dataQuality.switchMode(target.dataset.source);task(loadDataQuality);return;}
  if(action==='quality-retry'){task(loadDataQuality);return;}
  if(action==='quality-filter'){const form=root.querySelector('#quality-filter');if(!form?.reportValidity())return;state.dataQuality.filters=Object.fromEntries(new FormData(form));state.dataQuality.page=1;task(loadDataQuality);return;}
  if(action==='quality-page'){state.dataQuality.page=Number(target.dataset.page);task(loadDataQuality);return;}
  if(action==='correction-review-download'&&state.selected){task(()=>download('/data-imports/'+encodeURIComponent(state.selected.batchId)+'/correction-review','correction-review.csv'));return;}
  if(action==='record-history'){
    task(async()=>{state.history=await api('/data-management/history?'+new URLSearchParams({dataType:target.dataset.type,sourceSystem:target.dataset.source,sourceRecordId:target.dataset.record}));state.selected=null;});return;
  }
  if(action==='record-correction-submit'){
    const form=root.querySelector('#record-correction-form');if(!form?.reportValidity())return;
    const latest=state.history.items.at(-1),row={},fields=Object.fromEntries(new FormData(form));
    for(const key of state.history.fields){if(['profile_values','source_profile_ref'].includes(key))continue;if(Object.hasOwn(fields,key)&&(fields[key]!==''||Object.hasOwn(latest.record.value,key)))row[key]=fields[key];}
    const profile=state.catalog.items.find(t=>t.id===state.history.upgradeProfileId),binding=profile||latest.equipmentProfileBinding;
    if(binding){if(latest.record.dataType==='DEVICE'){row.profile_values=JSON.stringify(typedValues(form,profileConfig(binding).assetFields));row.equipment_type=profileConfig(binding).typeName;}if(latest.record.value.source_profile_ref)row.source_profile_ref=latest.record.value.source_profile_ref;}
    const payload={dataType:latest.record.dataType,sourceSystem:latest.record.sourceSystem,templateVersion:'1.0.0',records:[row],supersedesBatchId:latest.record.batchId,correctionReason:fields.correctionReason};
    if(profile)payload.equipmentProfileRef=profileRef(profile);
    task(async()=>{const batch=await post('/data-imports/records',payload);state.history=null;state.selected=batch;await load();notify('更正已提交，原版本在独立批准前继续生效。');});return;
  }
  if(action.startsWith('catalog-')){
    const item=state.catalog.items.find(t=>t.id===target.dataset.id);
    if(action==='catalog-quality-new'){state.catalog.editor=null;state.policyEditor={value:defaultQualityPolicy(),epoch:state.policyEvaluation.epoch};renderPolicyAuthor();return;}
    if((action==='catalog-edit'||action==='catalog-clone')&&item?.manifest.purpose==='data-quality-policy'){const value=structuredClone(item);if(action==='catalog-clone'){const versions=state.catalog.items.filter(t=>t.templateKey===item.templateKey).map(t=>t.version.split('.').map(Number)).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);const last=versions.at(-1);value.version=last[0]+'.'+last[1]+'.'+(last[2]+1);if(state.catalog.items.some(t=>t.templateKey===item.templateKey&&t.status==='PUBLISHED'))value.manifest.dataQualityPolicy.changeIntent='PROSPECTIVE';for(const key of Object.keys(value))if(!['templateKey','version','industry','manifest'].includes(key))delete value[key];}state.catalog.editor=null;state.policyEditor={id:action==='catalog-edit'?item.id:null,value,epoch:state.policyEvaluation.epoch};renderPolicyAuthor();return;}
    const nextVersion=(key='maintenance-form')=>{const versions=state.catalog.items.filter(t=>t.templateKey===key).map(t=>t.version).filter(v=>/^\d+\.\d+\.\d+$/.test(v)).sort((a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];});if(!versions.length)return '1.0.0';const v=versions.at(-1).split('.').map(Number);return `${v[0]}.${v[1]}.${v[2]+1}`;};
    if(action==='catalog-schedule-new'&&item){try{state.catalog.editor={value:scheduleFromCalendar(item,state.catalog.items,nextVersion)};render();}catch(error){notify(error.message);}return;}
    if(action==='catalog-weekly-new'){state.catalog.editor={value:defaultWeeklyCalendar()};render();return;}
    if(action==='catalog-calendar-new'){state.catalog.editor={value:defaultOperationCalendar()};render();return;}
    if(action==='catalog-new'){state.catalog.editor={value:defaultTemplate(nextVersion())};render();return;}
    if(action==='catalog-mapping-new'){state.catalog.editor={value:defaultMappingTemplate(nextVersion('import-map-assets'))};render();return;}
    if(action==='catalog-cancel'){state.catalog.editor=null;render();return;}
    if(action==='catalog-edit'&&item){const value=structuredClone(item);value.manifest=calendarAuthoringManifest(value.manifest);state.catalog.editor={id:item.id,value};render();return;}
    if(action==='catalog-clone'&&item){const value={templateKey:item.templateKey,version:nextVersion(item.templateKey),industry:item.industry,manifest:calendarAuthoringManifest(structuredClone(item.manifest))};if(!['operation-calendar','calendar-schedule'].includes(item.manifest.purpose)&&['PUBLISHED','RETIRED'].includes(item.status))value.parent=`${item.templateKey}@${item.version}`;state.catalog.editor={value};render();return;}
    if(action==='catalog-export'&&item){task(()=>download(`/templates/${item.id}/export`,`${item.templateKey}-${item.version}.json`));return;}
    if(action==='catalog-save'){
      const form=document.querySelector('#catalog-form');if(!form?.reportValidity())return;let value;try{value=JSON.parse(document.querySelector('#catalog-json').value);}catch{notify('JSON格式错误，请检查引号与逗号。');return;}
      const editor=state.catalog.editor,fields=Object.fromEntries(new FormData(form));
      const payload=editor.id?{manifest:calendarAuthoringManifest(value),expectedDigest:editor.value.contentDigest,expectedRevision:editor.value.revision}:{...value,manifest:calendarAuthoringManifest(value.manifest),templateKey:fields.templateKey,version:fields.version,industry:fields.industry};
      task(async()=>{await post(editor.id?`/templates/${editor.id}/edit`:'/templates',payload);state.catalog.editor=null;await load();notify('草稿已保存，尚未发布。');});return;
    }
    if(action==='catalog-submit'&&item){task(async()=>{await post(`/templates/${item.id}/submit`,{expectedDigest:item.contentDigest,expectedRevision:item.revision});await load();notify('版本已冻结，请由独立终审员审核。');});return;}
    if(['catalog-approve','catalog-return','catalog-reject'].includes(action)&&item){const form=target.closest('form');if(!form?.reportValidity())return;const comment=form.querySelector('[name=comment]').value.trim();task(async()=>{await post(`/templates/${item.id}/approval`,{decision:action==='catalog-approve'?'APPROVED':action==='catalog-return'?'RETURNED':'REJECTED',comment,expectedDigest:item.contentDigest,expectedRevision:item.revision});await load();notify('审批结果已记录；历史绑定不变。');});return;}
    return;
  }
  if(action==='data-point-upload'){state.view='uploads';state.type='POINT_DEFINITION';state.selected=null;render();return;}
  if(action==='data-asset-export'||action==='data-measurement-export'){
    const assets=action==='data-asset-export',params=new URLSearchParams();
    for(const [key,value] of Object.entries(state.dataCenter.appliedFilters||{}))if(value&&(['q','equipmentType','siteCode'].includes(key)===assets))params.set(key,value);
    task(()=>download('/data-management/'+(assets?'assets':'measurements')+'/export?'+params,'idms-'+(assets?'assets':'measurements')+'.csv'));return;
  }
  if(action==='data-source'){task(async()=>{state.selected=await api('/data-imports/'+encodeURIComponent(target.dataset.id));});return;}
  if(action==='data-asset-filter'||action==='data-measurement-filter'){
    const form=target.closest('form');if(!form?.reportValidity())return;
    Object.assign(state.dataCenter.filters,Object.fromEntries(new FormData(form)));state.dataCenter.assetPage=1;state.dataCenter.measurementPage=1;
    task(loadDataCenter);return;
  }
  if(action==='data-asset-page'||action==='data-measurement-page'){state.dataCenter[action==='data-asset-page'?'assetPage':'measurementPage']=Number(target.dataset.page);task(loadDataCenter);return;}
  if(action==='nav'){state.view=canonicalView(target.dataset.view);if(['spares','work-orders','overview','approvals'].includes(state.view)){state.selected=null;task(()=>sparesUi.load());return;}state.selected=null;state.error='';if(state.view==='quality-policy'){task(async()=>{await refreshIdentity();await loadReplayCapability();});return;}if(state.view==='coverage-history'){task(async()=>{await refreshIdentity();await loadReplayCapability();await loadCoverageHistory();});return;}if(state.view==='audit'){task(()=>loadAudit());return;}if(state.view==='data-quality'){task(loadDataQuality);return;}if(['uploads','templates','equipment-profiles'].includes(state.view))task(async()=>{state.catalog.items=(await api('/templates')).items;});else render();return;}
  if(navigation.some(n=>n[0]===action)){state.view=canonicalView(action);if(['spares','work-orders','overview','approvals'].includes(state.view)){task(()=>sparesUi.load());return;}state.selected=null;if(action==='audit')task(()=>loadAudit());else render();return;}
  if(action==='close'){state.history=null;state.selected=null;render();return;}
  if(action==='batch'){state.selected=state.batches.find(b=>b.batchId===target.dataset.id)||null;if(!state.selected)notify('该事件不属于当前上传批次。');else render();return;}
  if(action==='record-source'){state.selected=state.batches.find(b=>b.status==='COMMITTED'&&b.dataType==='PRODUCTION'&&b.preview.some(p=>p.source_record_id===target.dataset.source));render();return;}
  if(action==='logout'||(action==='switch-approver'&&state.auth?.mode==='oidc')){
    clearNativeDownload();
    task(async()=>{state.history=null;await post('/auth/logout',{});state.auth={mode:'oidc',authenticated:false};clearAudit(true);clearQuality();state.report=null;state.selected=null;state.batches=[];state.predictive=null;state.workflowDetails={};state.catalog={items:[],plugins:[],editor:null};state.dataCenter={overview:null,measurements:null,filters:{},assetPage:1,measurementPage:1};});return;
  }
  if(action==='switch-approver'){state.actor='demo.approver';clearAudit(true);clearQuality();task(load);return;}
  if(action==='analyze-device'){
    const deviceCode=document.querySelector('#prediction-device')?.value;if(!deviceCode)return notify('请先上传并批准设备台账。');
    task(async()=>{const result=await post('/predictive/analyze',{deviceCode});await load();notify(result.status==='ANALYZED'?'批准测点已完成工程规则分析，输入来源与版本已记录。':`需人工处理：${result.reason}`);});return;
  }
  if(action==='telemetry-analyze'){
    task(async()=>{const result=await post('/telemetry/analyze',{edgeId:target.dataset.edgeId});await load();if(result.status==='ANALYZED'){state.view='predictive';notify('采集窗口已分析；模拟来源、测点血缘与规则版本已保留。');}else notify('需人工处理：'+result.reason);});return;
  }
  if(action==='predictive-approve'){
    if(!can('predictive:approve')){notify('请由业务终审员登录。');return;}
    const comment=window.prompt('填写预测告警人工复核意见：','已核对振动趋势、设备现场状态与备件可用性，同意生成维修工单。');
    if(!comment?.trim())return;
    const alert=state.predictive.alerts.find(a=>a.id===target.dataset.id);
    task(async()=>{await post(`/predictive/alerts/${target.dataset.id}/approval`,{decision:'APPROVED',comment,expectedVersion:alert.version},'demo.approver');await load();state.view='work-orders';notify('预测告警已批准，维修工单已进入执行队列。');});return;
  }
  if(action==='workflow-history'){
    task(async()=>{state.workflowDetails[target.dataset.id]=await api(`/work-orders/${target.dataset.id}/workflow`);});return;
  }
  if(action==='workflow-retry'){
    task(async()=>{await post(`/work-orders/${target.dataset.id}/workflow/retry`,{});await load();notify('已请求重试原命令，不会跳过人工审批或创建新流程。');});return;
  }
  if(action.startsWith('wo-')){
    const order=state.predictive.workOrders.find(o=>o.id===target.dataset.id), form=target.closest('.work-order').querySelector('form');
    if(!order)return;
    const values=form?Object.fromEntries(new FormData(form)):{};
    const endpoint=action==='wo-claim'?'claim':action==='wo-start'?'start':action==='wo-submit'?'submit':'approval';
    if(form&&!form.reportValidity())return;
    const payload=['start','claim'].includes(endpoint)?{expectedVersion:order.version}:endpoint==='submit'?{...values,...customFieldsPayload(form,order.templateBinding),minutes:Number(values.minutes),partsUsed:String(values.partsUsed||'').split(/[,，]/).map(p=>p.trim()).filter(Boolean),expectedVersion:order.version}:{decision:action==='wo-return'?'RETURNED':'APPROVED',comment:values.comment,expectedVersion:order.version,snapshotDigest:order.resolution?.digest};
    task(async()=>{const result=await post(`/work-orders/${order.id}/${endpoint}`,payload);await load();notify(result.workflow?.status==='PENDING'?'命令已提交，等待Flowable确认；当前业务状态尚未推进。':endpoint==='approval'?'终审结果已记录。':'工单状态和证据已保存。');});return;
  }
  if(action==='decide'){
    const comment=document.querySelector('#approval-comment')?.value.trim()||'', reviewResolution=document.querySelector('#review-resolution')?.value.trim()||'', b=state.selected;
    if(comment.length<2){notify('请填写至少两字的审批意见。');return;}
    if(b.status==='HUMAN_REVIEW'&&target.dataset.decision==='APPROVED'&&reviewResolution.length<2){notify('请补充人工复核依据。');return;}
    task(async()=>{await post(`/data-imports/${b.batchId}/approval`,{decision:target.dataset.decision,comment,reviewResolution,expectedVersion:b.version,snapshotDigest:b.snapshotDigest});await load();notify(target.dataset.decision==='APPROVED'?'人工批准完成，数据已入库。':'审批结果已记录。');});return;
  }
  const tasks={refresh:load,sample:()=>useSample(), 'error-sample':()=>useSample(true),template:()=>download(`/data-import-templates/${state.type}${state.type==='DEVICE'?'?profile=extended':''}`,`${state.type}-template.csv`),'sample-download':()=>download(`/data-import-templates/${state.type}?sample=1${state.type==='DEVICE'?'&profile=extended':''}`,`${state.type}-sample.csv`),'device-extended-sample':()=>download('/data-import-templates/DEVICE?sample=1&profile=extended','devices-extended.csv'),original:()=>download(`/data-imports/${state.selected.batchId}/original`,state.selected.filename),errors:()=>download(`/data-imports/${state.selected.batchId}/errors?format=csv`,'errors.csv'),reset:async()=>{if(!confirm('重置将移除本机演示上传、批准数据与审计，恢复空白上传场景。确定继续？'))return;await post('/demo/reset',{},'demo.admin');state.selected=null;state.view='uploads';state.type='DEVICE';state.actor='demo.uploader';await load();notify('本机演示数据已重置。');}};
  if(tasks[action])task(tasks[action]);
});
render();task(load);
setInterval(()=>{if(state.view==='telemetry'&&state.auth?.authenticated!==false&&!state.busy&&state.report)void task(loadTelemetry);},5000);
setInterval(()=>{if(state.view==='work-orders'&&!state.busy&&state.report&&state.predictive?.workOrders.some(o=>o.workflow?.status==='PENDING'))void task(load);},2000);
setInterval(()=>{if(state.report&&!state.busy&&state.auth?.authenticated!==false&&state.batches.some(b=>b.status==='AI_PENDING'))void task(load);},3000);


import {PolicyWorkspace,qualityPolicyView,defaultQualityPolicy,policyAuthorView,readPolicyAuthor,addPolicyRule,addPolicyEntry,readCatalogPackage} from './quality-policy-ui.js';





function availableNavigation(){return navigation.filter(n=>n[0]!=='devices'&&(n[0]!=='coverage-history'||state.replayAvailable)&&(n[0]!=='quality-policy'||state.policyAvailable)&&(n[0]!=='operational'||state.operationalAvailable)&&(n[0]!=='source-governance'||state.sourceGovernanceAvailable)&&(n[0]!=='field-channels'||state.fieldChannelsAvailable));}

for(const type of ['input','change'])root.addEventListener(type,event=>{if(event.target.closest('#spares-form'))sparesUi.capture();if(event.target.closest('#spares-history-filter'))sparesUi.captureHistory();});

root.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.matches('[data-option-query]')){event.preventDefault();void sparesUi.handle({dataset:{action:'spares-option-search',field:event.target.dataset.optionQuery}}).catch(error=>{state.spares.error=error.message;render();});}});
