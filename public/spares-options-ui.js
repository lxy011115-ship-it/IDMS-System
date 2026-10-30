import {e,button,getField} from './spares-ui-base.js';
export function optionSpecs(ed){
 const specs=[],add=(name,label,kind,required=true,filters={})=>specs.push({name,label,kind,required,filters}),a=ed.action;
 if(['purchase.create','purchase.edit'].includes(a)){add('supplierId','供应商','supplier');add('warehouseId','收货仓库','warehouse');for(let i=0;i<(ed.values.lines||[{}]).length;i++)add('line.'+i+'.partId','第'+(i+1)+'行备件','part');}
 if(['stock.issue','stock.transfer','adjustment.create','link.create'].includes(a))add('partId','备件','part');
 if(['stock.issue','stock.transfer','adjustment.create'].includes(a))add('warehouseId','仓库','warehouse');
 if(['stock.issue','link.create'].includes(a))add('deviceCode','已批准设备','device');
 if(a==='stock.issue')add('workOrderId','关联工单','order',false,ed.values.deviceCode?{deviceCode:ed.values.deviceCode}:{});
 if(a==='stock.transfer')add('targetWarehouseId','调入仓库','warehouse');
 if(a==='replacement.create')add('linkId','设备适用位置','link',true,{partId:ed.item.partId,deviceCode:ed.item.deviceCode});
 return specs;
}
export const optionName=x=>x?[x.code||x.deviceCode,x.name||x.position||(!x.code?x.id:'')].filter(Boolean).join(' · ')+(x.unit?' ['+x.unit+']':'')+(x.active===false?'（已停用）':''):'';
export function remoteOption(ed,name,label,kind,value='',required=true){
 const f=ed.fields?.[name],selected=f?.selected||ed.selected?.[name],title=selected&&selected.id===value?optionName(selected):value?'已选 '+value:'尚未选择';
 const attrs=`data-field="${e(name)}"`;
 return `<div class="spares-option" data-option="${e(name)}"><label>${e(label)}${required?' *':''}<input type="hidden" name="${e(name)}" value="${e(value)}"></label><div class="option-choice"><span>${e(title)}</span>${button(value?'搜索 / 更换':'搜索选择','spares-option-open',attrs)}${value&&!required?button('清空','spares-option-clear',attrs):''}</div>${f?.open?`<div class="option-results"><div class="option-search"><input data-option-query="${e(name)}" value="${e(f.q||'')}" aria-label="搜索${e(label)}" placeholder="输入编码、名称或位置">${button('查询','spares-option-search',attrs)}</div>${f.error?`<p role="alert">${e(f.error)}</p>`:''}${f.loading?'<p role="status">正在查找…</p>':`<ul>${(f.data?.items||[]).map(x=>`<li>${button(optionName(x),'spares-option-pick',attrs+` data-id="${e(x.id)}"`)} </li>`).join('')||'<li>暂无匹配资料，请调整关键词。</li>'}</ul>`}<div class="option-pagination"><span>本页 ${f.data?.items?.length||0} 项${f.data?.hasMore?' · 还有更多，请翻页或搜索':''}</span>${button('上一页','spares-option-prev',attrs+(!f.stack?.length||f.loading?' disabled':''))}${button('下一页','spares-option-next',attrs+(!f.data?.nextCursor||f.loading?' disabled':''))}${button('收起','spares-option-close',attrs)}</div></div>`:''}</div>`;
}
