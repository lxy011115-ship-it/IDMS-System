const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const guidance={
 DEVICE:['建立设备台账','先整理企业真实设备编码和工厂、产线；提交后由另一名终审员批准。','必填：来源记录ID、设备编码、设备名称、工厂编码、产线编码。','device_code：PUMP-01；site_code：FACTORY-01。'],
 POINT_DEFINITION:['定义设备测点','先批准对应设备台账，再声明该设备的测点、单位和物理录入范围。','测点编码用小写字母、数字和下划线；下限小于上限；间隔可选，单位为整数秒。','outlet_pressure；MPa；范围0至2；间隔60秒。'],
 MEASUREMENT:['上传设备测点记录','先批准设备及自定义测点定义；单位与定义一致。','每条采样有独立来源ID；时间带时区；质量使用GOOD、BAD或UNCERTAIN。','2026-10-27T09:00:00+08:00；数值0.50；单位MPa。'],
 PRODUCTION:['上传班次生产','先批准对应设备台账；统计窗口和生产计数须有原始依据。','结束晚于开始；良品数不超过总数；计划分钟不超过期间跨度。','计划240分钟；总数1000；良品980；理想节拍10秒。'],
 STATE_INTERVAL:['上传设备状态区间','先批准对应设备台账，按实际状态变化整理连续区间。','同设备区间不能重叠；状态为RUNNING、IDLE或DOWN，DOWN必须填写原因。','08:00至11:00为RUNNING；起止时间均须写完整日期和时区。'],
 MAINTENANCE:['登记历史维修','先批准对应设备台账。本模板记录历史事实，不替代维修工单流程。','故障时间不晚于维修开始；维修结束晚于开始；填写真实原因和措施。','故障11:00，维修11:10至11:50；时间须写完整日期和时区。'],
 QUALITY:['上传质量检验','先批准对应设备台账；核对检验批次、特性、量具单位和规格。','样本编号从1开始；规格下限小于上限；缺测不填0代替。','DIAMETER；实测10.01 mm；规格9.95至10.05。']
};
export function uploadTypeGuide(type){
 const item=Object.hasOwn(guidance,type)?guidance[type]:null;if(!item)return '';
 return `<section class="upload-type-guide" aria-label="当前模板填写提示"><h3>${esc(item[0])}</h3><p>${esc(item[1])}</p><p>${esc(item[2])}</p><details><summary>查看填写示例与通用要求</summary><p>${esc(item[3])}</p><p>示例仅用于理解填法，须替换为本企业真实资料。CSV使用UTF-8，XLSX仅有data工作表且不含公式；最大10 MiB、10,000条记录。时间不能超前当前时钟。</p></details></section>`;
}
export function batchNextStep(batch,{actor,canApprove=false}={}){
 const own=batch.uploader===actor;
 switch(batch.status){
  case 'AI_PENDING':return {title:'等待AI影子审阅',detail:'文件已受理，AI仍在处理中，尚未入库。稍后刷新同一批次，不要重复上传。',action:'refresh',label:'刷新批次状态',stage:1};
  case 'VALIDATION_FAILED':return {title:'修正校验错误',detail:'整批尚未入库。按原文件行号核对错误，修正文件后重新提交；不要直接修改页面记录。',action:'import-errors',label:'定位校验错误',stage:1,issue:true};
  case 'HUMAN_REVIEW':return {title:canApprove&&!own?'填写人工复核依据':'交独立人员复核',detail:own?'你是本批上传人，不能自审。由另一名有权终审员核对材料并填写复核依据。':canApprove?'核对完整输入和原文件，填写人工复核依据及审批意见；批准前尚未入库。':'需要另一名有权终审员核对材料并填写复核依据，当前账号不能代为批准。',action:'import-review',label:'查看输入与审批要求',stage:2};
  case 'AWAITING_APPROVAL':return {title:canApprove&&!own?'核对材料并终审':'交独立终审员审批',detail:own?'你是本批上传人，不能自审。请另一名有权终审员核对来源和完整输入。':canApprove?'核对原文件、来源和冻结版本后作出决定；批准前尚未入库。':'校验已完成，尚未入库。请另一名有权终审员核对材料。',action:'import-review',label:'查看输入与审批要求',stage:2};
  case 'COMMITTED':return {title:'查询已入库数据',detail:'核对入库数量与来源。需要修正已入库事实时，使用显式更正并再次独立审批。',action:['DEVICE','POINT_DEFINITION','MEASUREMENT'].includes(batch.dataType)?'data-center':'overview',label:'查看业务数据',stage:3};
  case 'RETURNED':return {title:'按退回意见修正',detail:'阅读本批审批意见，再按原材料或更正要求整理新的提交；退回不改变已生效的旧记录。',action:'import-decision',label:'查看审批意见',stage:2,issue:true};
  case 'REJECTED':return {title:'查看驳回原因',detail:'该批次未获接收。先核对审批意见，需要重报时重新整理材料。',action:'import-decision',label:'查看审批意见',stage:2,issue:true};
  default:return {title:'核对当前批次状态',detail:'请刷新同一批次并核对详情，不根据未知状态认定已入库。',action:'refresh',label:'刷新批次状态',stage:null};
 }
}
export function batchNextStepView(batch,options={}){
 const next=batchNextStep(batch,options),stages=['文件已受理','校验与中间审阅','独立人工终审','批准入库'];
 const progress=next.stage===null?'':`<ol class="import-progress" aria-label="批次处理步骤">${stages.map((name,i)=>`<li class="${i<next.stage?'complete':i===next.stage?'current':''}" ${i===next.stage?'aria-current="step"':''}><span>${i+1}</span>${name}${i===next.stage?`<small>${next.issue?'需处理':'当前步骤'}</small>`:''}</li>`).join('')}</ol>`;
 return `<section class="import-next-step ${next.issue?'needs-action':''}" aria-label="批次下一步">${progress}<h3>${esc(next.title)}</h3><p>${esc(next.detail)}</p><button class="secondary" data-action="${next.action}" ${options.busy?'disabled':''}>${esc(next.label)}</button></section>`;
}
export function errorAdvice(code){
 const advice={REQUIRED:'补齐此字段，检查空白或被Excel改变的值。',INVALID_CODE:'使用允许的编码字符，不用设备名称代替编码。',UNKNOWN_DEVICE:'先批准该设备台账，再提交关联数据。',UNKNOWN_TAG:'先批准本设备的测点定义。',UNIT_MISMATCH:'核对测点定义单位；系统不会自动换算。',OUT_OF_RANGE:'核对原始值、单位及物理范围，不为通过校验改写事实。',INVALID_TIME:'填写有效完整日期和时区，例如2026-10-27T09:00:00+08:00。',FUTURE_TIME:'核对设备时钟和日期，不提交超前当前时钟的采样。',DUPLICATE_POINT:'检查同设备、测点、时间是否已有记录，不换ID重复计入。',RECORD_CONFLICT:'内容不同的已批准记录须走显式更正流程。',INTERVAL_OVERLAP:'回查同设备状态区间，去除重叠。',PERIOD_OVERLAP:'回查同设备生产统计窗口，去除重叠。',UNKNOWN_FIELD:'按模板表头填写；中文表头使用已发布映射。'};
 return Object.hasOwn(advice,code)?advice[code]:'对照模板与原始材料核对，保留原文件行号；不确定时交数据负责人。';
}
export class ImportErrorReview {
 constructor(){this.key='';this.field='';this.query='';}
 bind(batch,identity){const key=batch?JSON.stringify([identity,batch.batchId,batch.snapshotDigest,batch.version]):'';if(key===this.key)return;this.key=key;this.field='';this.query='';}
 filter(errors){const q=this.query.trim().toLocaleLowerCase();return errors.filter(e=>(!this.field||e.field===this.field)&&(!q||[e.row,e.field,e.sourceField,e.code,e.message].some(v=>String(v??'').toLocaleLowerCase().includes(q))));}
}
export function importErrorView(review,batch,labels,busy=false){
 const errors=batch.errors||[];if(!errors.length)return '';
 const fields=[...new Set(errors.map(e=>e.field))],items=review.filter(errors),label=key=>Object.hasOwn(labels,key)?labels[key]:key;
 return `<section class="panel import-error-review" id="import-error-review"><div class="panel-head"><div><h2>定位校验错误</h2><p>${esc(batch.counts.invalid)}行校验未通过。下列筛选仅覆盖已加载的前${errors.length}条错误；同一行可能有多个错误。完整清单请下载CSV。</p></div></div><form id="import-error-filter"><label>字段<select name="field"><option value="">全部已加载字段</option>${fields.map(f=>`<option value="${esc(f)}" ${review.field===f?'selected':''}>${esc(label(f))} · ${esc(f)}</option>`).join('')}</select></label><label>行号、错误码或关键词<input name="query" value="${esc(review.query)}" maxlength="120" placeholder="例如：58、单位、UNKNOWN_TAG"></label><div class="form-actions"><button class="secondary" data-action="import-error-filter" type="submit" ${busy?'disabled':''}>筛选错误</button><button class="secondary" data-action="import-error-clear" type="button" ${busy?'disabled':''}>清除筛选</button><button class="secondary" data-action="errors" type="button" ${busy?'disabled':''}>下载完整错误CSV</button></div></form><p class="import-error-count" role="status">当前匹配${items.length}条错误 · 已加载${errors.length}条</p>${items.length?`<div class="table-wrap"><table><thead><tr><th>原文件行号</th><th>字段与错误码</th><th>原因与处理建议</th></tr></thead><tbody>${items.map(e=>`<tr><td><b>第${esc(e.row)}行</b></td><td><b>${esc(label(e.field))}</b><code>${esc(e.field)}</code>${e.sourceField?`<span>原表头：${esc(e.sourceField)}</span>`:''}<code>${esc(e.code)}</code></td><td class="wrap-cell"><p>${esc(e.message)}</p><small>${esc(errorAdvice(e.code))}</small></td></tr>`).join('')}</tbody></table></div>`:'<p class="empty">已加载的错误中没有匹配项。清除筛选或下载完整CSV核对其余错误。</p>'}<p class="boundary-note">行号指原文件位置，不是预览页码。修正原文件后重新提交；错误清单不能直接作为上传模板。</p></section>`;
}
