import {components,InspectionError} from './runtime-inspection-input.mjs';

export const labels={core:'主站存活',business:'企业数据库最小绑定',sessions:'会话库最小绑定',identity:'身份发现端点',workflow:'工作流状态',predictor:'工程规则服务',ai:'AI影子网关',model:'本地模型版本与摘要',telemetry:'采集状态（模拟资料）',mqtt:'MQTT监听及已有边缘连接',disk:'运行目录所在卷空间',resources:'主站实时资源预算',backups:'业务备份档案'};
const advice={
 CHECK_PASSED:'该项仅在所列证据范围内通过，生产和岗位验收另行完成。',
 REPORT_TARGET_EXISTS:'报告目录已存在；选择新目录，不覆盖已有报告。',
 CONFIG_INVALID:'按公开示例核对配置字段和格式；不要将密码填入巡检配置。',
 INPUT_MISSING:'核对该组件的现有私密配置或运行文件，不自动初始化或创建账号。',
 INPUT_UNREADABLE:'核对现有配置读取权限；不要为检查放宽权限。',
 INPUT_SIZE_OR_TYPE:'输入类型或大小超出预算，检查明确的配置及档案文件。',
 INPUT_CHANGED:'输入在读取期间变化；确认原任务结束后再手动检查。',
 LINKED_INPUT_REFUSED:'输入或报告路径含链接，改用经核对的实际路径。',
 LOCAL_ENDPOINT_REQUIRED:'仅允许明确的本机端点，不将凭据发往其他主机或重定向。',
 OBSERVATION_TIMEOUT:'观察预算已到，原任务收尾后才结束本次检查；核对依赖和网络。',
 PROBE_NOT_STARTED:'总预算或用户取消后未启动该项，结果不能视为通过。',
 HTTP_STATUS_FAILED:'健康或状态接口未成功；核对服务状态及现有授权，不重复提交业务。',
 HTTP_UNAVAILABLE:'端点不可达或发生重定向；核对地址和当前服务。',
 HTTP_RESPONSE_INVALID:'接口响应不符合JSON状态契约；核对服务版本。',
 HTTP_BODY_LIMIT:'响应超过64KiB预算；确认使用正确状态接口。',
 DATABASE_UNAVAILABLE:'现有受限数据库连接或只读查询未完成；核对服务和绑定配置。',
 DATABASE_CONFIG_INVALID:'需要已有BUSINESS_RUNTIME配置和独立受限身份，不使用部署管理员。',
 DATABASE_BINDING_MISMATCH:'所查数据库或企业绑定不符，停止继续操作并核对配置。',
 DATABASE_ROLE_UNSAFE:'检测到超出巡检需要的数据库身份权限；使用现有受限身份。',
 SESSION_CONFIG_INVALID:'核对既有AUTH_SESSION_RUNTIME配置，检查不会重建会话库。',
 SESSION_BINDING_MISMATCH:'会话库结构或部署绑定不符，按专用维护流程处理。',
 CORE_CONTRACT_MISMATCH:'核对主站版本、OIDC及企业数据库模式；UP本身不是依赖就绪证明。',
 IDENTITY_CONFIG_INVALID:'核对现有身份origin、realm和显式issuer。',
 ISSUER_MISMATCH:'OIDC发行者与配置不符；不要尝试账号密码或修改回调来绕过。',
 SERVICE_BINDING_MISMATCH:'私密客户端配置与巡检中明确的本机服务地址不符。',
 SERVICE_CREDENTIAL_INVALID:'核对既有服务凭据文件，不在报告中复制凭据。',
 TENANT_LIMIT:'配置企业或来源数量超出有界检查范围，不能静默跳过。',
 MODEL_BINDING_INVALID:'核对已安装模型与现有摘要绑定，检查不会下载或替换模型。',
 MODEL_BINDING_MISMATCH:'模型名称或摘要与既有配置不符，需要按模型变更流程核对。',
 MODEL_VERSION_MISMATCH:'模型服务版本与配置不符，核对受控运行版本。',
 WORKFLOW_CONTRACT_MISMATCH:'工作流状态未满足已有Flowable版本及流程定义契约。',
 PREDICTOR_CONTRACT_MISMATCH:'预测端点不是预期工程规则服务；检查不会执行分析。',
 AI_CONTRACT_MISMATCH:'影子网关、模型就绪或摘要契约未通过；检查不会触发生成。',
 TELEMETRY_CONFIG_INVALID:'核对现有采集配置，不调用采集初始化或写设备。',
 TELEMETRY_PROFILE_UNSUPPORTED:'当前状态适配器仅覆盖明确的模拟采集；不能当作现场验收。',
 TELEMETRY_CONTRACT_MISMATCH:'采集状态身份或模式不符，核对当前来源绑定。',
 TELEMETRY_CONNECTION_FAILED:'采集报告的MQTT或OPC只读连接不可用；核对现有服务。',
 TELEMETRY_BUFFER_FULL:'采集缓存已满或已阻塞；核对主站接收及确认链路，保留未确认资料，不以删除缓存或重复采集绕过。',
 TELEMETRY_SAMPLE_UNCONFIRMED:'样本或采集错误状态尚不能确认，不能显示为设备在线。',
 TCP_UNAVAILABLE:'MQTT监听不可达；仅连通端口也不能证明消息或设备状态。',
 MQTT_EDGE_CONNECTION_FAILED:'端口可达但已有边缘未报告MQTT会话连接。',
 DISK_UNAVAILABLE:'无法读取目标卷空间；未知不是容量正常。',
 DISK_BELOW_THRESHOLD:'可用空间低于明确阈值，先按保留策略处理，不自动删除资料。',
 DISK_THRESHOLD_UNSET:'空间已测量，但尚未设置阈值；不能据此承诺生产容量。',
 LIVE_BUDGET_UNAVAILABLE:'未提供受限主站计量的维护令牌引用，不用巡检进程内存冒充主站用量。',
 RESOURCE_CONTRACT_INVALID:'主站运行计量契约未通过，核对接口版本和既有维护配置。',
 RESOURCE_CLOSING:'主站正在排空，等待当前任务实际收尾；不要另启重复进程。',
 RESOURCE_SATURATED:'当前准入或等待数量已饱和；保留原业务请求语义，核对负载，不自动重启。',
 BACKUP_DIRECTORY_MISSING:'核对明确的既有备份目录；检查不会创建备份。',
 BACKUP_DIRECTORY_INVALID:'备份目标不是可检查的目录。',
 ARCHIVE_SCAN_LIMIT:'目录扫描超出预算，范围不完整，不能宣布备份通过。',
 ARCHIVE_SCAN_INCOMPLETE:'候选数量或深度超出预算，缩小明确目录后再检查。',
 ARCHIVE_TENANT_UNBOUND:'目录内存在未绑定企业的档案，不猜测企业或忽略异常档案。',
 BACKUP_FILES_MISSING:'未找到当前范围内的备份档案，使用已有备份流程处理。',
 BACKUP_COVERAGE_MISSING:'存在企业缺少档案，不能以其他企业备份代替。',
 ARCHIVES_NOT_AUTHENTICATED:'目前只有文件证据；可显式选择--verify-backups认证，仍不执行恢复。',
 BACKUP_KEY_INVALID:'核对已有备份密钥文件的格式和绑定，检查不会生成或替换密钥。',
 ARCHIVE_FORMAT2_REQUIRED:'当前核对要求格式2业务档案，旧格式须按恢复兼容流程另行核对。',
 ARCHIVE_SOURCE_MISMATCH:'档案来源数据库与当前企业绑定不符。',
 ARCHIVE_TIMESTAMP_INVALID:'档案时间无效或明显在未来，核对生成记录及系统时钟。',
 ARCHIVE_AUTHENTICATION_FAILED:'至少一份档案认证或清单核对失败，不回退到旧档案冒充最新通过。',
 BACKUP_AGE_POLICY_UNSET:'档案已认证，但时效阈值尚未设置；实际恢复另行验收。',
 BACKUP_STALE:'至少一企业最新的可认证档案超过已配置时效，按已有流程处理。',
 ARCHIVES_AUTHENTICATED:'完整候选已认证并满足所配时效；这不证明已实际恢复或跨服务灾备。',
 PROBE_FAILED:'检查出现未分类问题，底层错误已省略；核对受限维护记录。'
};
export function safeFailure(error){const code=error instanceof InspectionError&&Object.hasOwn(advice,error.code)?error.code:'PROBE_FAILED';return {status:error instanceof InspectionError&&['FAIL','UNKNOWN','NOT_CONFIGURED'].includes(error.status)?error.status:'UNKNOWN',code,evidence:'NOT_ESTABLISHED'};}
export function decorate(id,result,required,elapsedMs){
 if(!result||!['PASS','FAIL','UNKNOWN','NOT_CONFIGURED'].includes(result.status)||!Object.hasOwn(advice,result.code))result=safeFailure(null);
 return {component:id,label:labels[id],required,status:result.status,code:result.code,evidence:result.evidence,elapsedMs:Math.round(elapsedMs),advice:advice[result.code],...(result.data?{data:result.data}:{})};
}
export async function runInspection(tasks,profile,{signal,source={},configurationSha256=null}={}){
 const start=performance.now(),startedAt=new Date().toISOString(),deadline=start+profile.budgetMs,controller=new AbortController();let observedTimeoutAt=null,cancelled=false;
 const timeout=()=>{observedTimeoutAt??=new Date().toISOString();controller.abort();};const timer=setTimeout(timeout,profile.budgetMs);
 const abort=()=>{cancelled=true;controller.abort();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();let next=0;const rows=new Array(components.length);
 try{await Promise.all(Array.from({length:profile.concurrency},async()=>{for(;;){const index=next++;if(index>=components.length)return;const id=components[index],at=performance.now();let result;if(controller.signal.aborted||performance.now()>=deadline){if(!cancelled)timeout();result={status:'UNKNOWN',code:'PROBE_NOT_STARTED',evidence:'NOT_ESTABLISHED'};}else{try{result=await tasks[id]({signal:controller.signal,deadline});}catch(e){result=safeFailure(e);}if(controller.signal.aborted||performance.now()>=deadline){if(!cancelled)timeout();result={status:'UNKNOWN',code:'OBSERVATION_TIMEOUT',evidence:'PROBE_SETTLED_AFTER_CANCELLATION'};}}rows[index]=decorate(id,result,profile.required.includes(id),performance.now()-at);}}));}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 const required=rows.filter(r=>r.required),overall=required.some(r=>r.status==='FAIL')?'FAIL':required.some(r=>r.status!=='PASS')?'UNKNOWN':'PASS';
 return {format:1,purpose:'MANUAL_READ_ONLY_PLATFORM_INSPECTION',startedAt,finishedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-start),budgetMs:profile.budgetMs,observationTimeoutAt:observedTimeoutAt,cancelled,allStartedTasksSettled:true,source,configurationSha256,overall,requiredItems:required.length,attentionItems:rows.filter(r=>r.status!=='PASS').length,productionAcceptance:false,enterpriseUserAcceptance:false,customerBusinessWrites:0,rows};
}
export function reportText(r){return ['IDMS 手动只读运行检查',`必需项结果：${r.overall}；需关注：${r.attentionItems}项`,`耗时：${r.elapsedMs}毫秒；观察预算：${r.budgetMs}毫秒`,`开始（UTC）：${r.startedAt}`,r.observationTimeoutAt?'观察预算已到；报告在原任务收尾后生成。':'所有已启动检查均已收尾。','',...r.rows.flatMap(x=>[`${x.status}  ${x.label}${x.required?'（必需）':'（可选）'}  [${x.code}]`,`证据：${x.evidence}`,x.data?JSON.stringify(x.data):'',`处理：${x.advice}`,'']),'限制：主站UP仅表示存活；最小绑定检查不替代全量审计；档案认证不代表已恢复。','本报告不代表真实账号签收、现场接入或生产验收；来源Git信息不证明主站正在运行同一提交。','没有自动重启、初始化、授权、业务写入、恢复或对外告警。'].join('\n')+'\n';}
