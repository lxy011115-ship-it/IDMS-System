const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text = value => typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
// One page and one request belong to an exact batch version and authenticated scope.
export class BatchPager {
 constructor(){this.generation=0;this.clear();}
 clear(){this.controller?.abort();this.generation++;this.key='';this.batch=null;this.kind='rows';this.page=1;this.pageSize=50;this.data=null;this.error='';this.loading=false;}
 bind(batch,identity){const key=batch?JSON.stringify([identity,batch.batchId,batch.snapshotDigest,batch.version]):'';if(key===this.key)return false;this.clear();this.key=key;this.batch=batch?{batchId:batch.batchId,snapshotDigest:batch.snapshotDigest,version:batch.version}:null;return !!batch;}
 async load(api,kind=this.kind,page=this.page){
  if(!this.batch)return false;
  this.controller?.abort();const controller=new AbortController(),generation=++this.generation,batch=this.batch;this.controller=controller;this.kind=kind;this.page=page;this.data=null;this.error='';this.loading=true;
  try{
   const params=new URLSearchParams({page:String(page),pageSize:String(this.pageSize),snapshotDigest:batch.snapshotDigest});
   const data=await api('/data-imports/'+encodeURIComponent(batch.batchId)+'/'+kind+'?'+params,{signal:controller.signal});
   if(generation!==this.generation)return false;
   if(data.batchId!==batch.batchId||data.snapshotDigest!==batch.snapshotDigest||data.kind!==kind||data.page!==page||data.pageSize!==this.pageSize||!Array.isArray(data.items)||data.items.length>this.pageSize||!Number.isSafeInteger(data.total)||data.total<0)throw Error('分页来源不匹配，请重新打开批次。');
   this.data=data;return true;
  }catch(error){if(generation!==this.generation)return false;this.error=error.message;throw error;}
  finally{if(generation===this.generation){this.loading=false;this.controller=null;}}
 }
}
export function batchPageView(pager,batch,labels,historyButton){
 const label=key=>Object.hasOwn(labels,key)?labels[key]:key;
 const e=escape,data=pager.data,disabled=pager.loading?'disabled':'',action=(label,name,extra='',off=false)=>`<button class="secondary" data-action="${name}" ${extra} ${off?'disabled':''}>${label}</button>`;
 const tabs=`<div class="batch-page-tabs" role="group" aria-label="批次记录类型">${['rows','records'].map(kind=>`<button class="${pager.kind===kind?'primary':'secondary'}" data-action="batch-page-kind" data-kind="${kind}" aria-pressed="${pager.kind===kind}" ${disabled}>${kind==='rows'?'冻结输入':'批准时记录'}</button>`).join('')}</div>`;
 let content=pager.loading?'<p role="status">正在核对来源并读取本页…</p>':pager.error?`<p role="alert">${e(pager.error)}</p>${action('重试本页','batch-page-retry')}`:'';
 if(data){
  const rows=data.kind==='rows',values=data.items.map(item=>rows?item.value:item.record.value),columns=[...new Set(values.flatMap(value=>Object.keys(value)))];
  const head=['来源行 / 输入位置',...columns.map(label),rows?'校验证据':'历史版本 / 来源'];
  const body=data.items.map((item,i)=>{
   const sourceRow=rows?item.sourceRow:item.record.row,details=rows?{inputOrdinal:item.inputOrdinal,sourceRow:item.sourceRow,validOrdinal:item.validOrdinal,validation:item.validation,errors:item.errors,value:item.value}:item;
   const evidence=rows?`<b>${e({VALIDATED:'有效输入',ERRORS:'存在错误',NOT_SELECTED:'未选入有效行'}[item.validation]||item.validation)}</b>${item.errors.map(error=>`<p>${e(label(error.field))}：${e(error.message)}${error.sourceField?`（原表头：${e(error.sourceField)}）`:''}</p>`).join('')}`:`<b>v${e(item.source.recordVersion)}</b>${item.source.supersedesBatchId?`<p>替代批次 ${e(item.source.supersedesBatchId)} · 来源行 ${e(item.source.previousSourceRow)}</p>`:'<p>首次批准记录</p>'}${historyButton({sourceSystem:item.record.sourceSystem,sourceRecordId:item.record.value.source_record_id,recordVersion:item.source.recordVersion},batch.dataType)}`;
   return `<tr data-source-row="${e(sourceRow)}"><td>${e(sourceRow)}${rows?`<small>输入第 ${e(item.inputOrdinal)} 条</small>`:''}<details><summary>完整 JSON</summary><pre>${e(JSON.stringify(details,null,2))}</pre></details></td>${columns.map(k=>`<td title="${e(text(values[i][k]))}">${e(text(values[i][k]))}</td>`).join('')}<td class="wrap-cell">${evidence}</td></tr>`;
  }).join('');
  content=`<p class="batch-page-notice">${e(data.notice)}</p>${data.batchVersion!==batch.version?'<p role="alert">批次状态已变化，请刷新批次后再审批。</p>':''}${data.items.length?`<div class="preview-table batch-page-table"><table><thead><tr>${head.map(h=>`<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`:'<p class="empty">本页没有记录。</p>'}<div class="batch-page-controls">${action('上一页','batch-page-previous','',!data.hasPrevious)}<span>第 ${e(data.page)} 页 · 共 ${e(data.total)} 条 · 每页 ${e(data.pageSize)} 条</span>${action('下一页','batch-page-next','',!data.hasNext)}</div>`;
 }
 return `<section class="panel batch-pages" data-testid="batch-pages"><div class="panel-head"><div><h2>原始数据预览</h2><p>逐页审阅冻结输入与批准时记录，保留来源行号和逐行证据。</p></div></div>${tabs}${content}</section>`;
}
