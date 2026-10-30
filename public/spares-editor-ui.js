import {e,qty,price,today,select,field,button,statuses} from './spares-ui-base.js';
import {remoteOption} from './spares-options-ui.js';
export function editorView(s){
 const ed=s.editor;if(!ed)return '';const v=ed.values||{},kind=ed.action.split('.')[0],remote=(name,label,kind,value,required=true)=>remoteOption(ed,name,label,kind,value,required);let fields='';
 if(['part','supplier','warehouse'].includes(kind)){
  fields=(ed.action.endsWith('.create')?field('siteCode','工厂编码',v.siteCode||'')+field('code','档案编码',v.code||''):'')+field('name','名称',v.name||'');
  if(kind==='part'){fields+=field('model','规格型号',v.model||'','text',false)+field('brand','品牌',v.brand||'','text',false)+field('category','分类',v.category||'','text',false);if(ed.action.endsWith('.create'))fields+=field('unit','计量单位',v.unit||'只')+select('precision','数量精度',[{id:'0',name:'整数（件/只/套）'},{id:'3',name:'最多三位小数（kg/m/L等）'}],String(v.precision??0));fields+=field('referencePrice','参考单价（元）',v.referencePrice??price(v.referencePriceCents))+select('wearPart','是否易损件',[{id:'true',name:'易损件'},{id:'false',name:'普通备件'}],String(v.wearPart??true))+field('safety','每库安全库存',v.safety??qty(v.safetyMilli));}
  if(kind==='supplier')fields+=field('contact','联系人',v.contact||'','text',false)+field('phone','联系电话',v.phone||'','text',false)+field('leadDays','交货期（天）',v.leadDays??0,'number');
  if(kind==='warehouse')fields+=field('location','库位说明',v.location||'','text',false);
  fields+=field('remark','备注',v.remark||'','text',false);if(ed.action.endsWith('.update'))fields+=select('active','状态',[{id:'true',name:'启用'},{id:'false',name:'停用'}],String(v.active));
 }else if(kind==='material-plan'){
  fields=`<p class="insight-note">关联工单 ${e(ed.contextOrderId)}。计划不预留库存；填写总量，系统另扣实际净领用。</p>`;
  if(ed.action==='material-plan.create')fields+=`<input type="hidden" name="workOrderId" value="${e(v.workOrderId)}">`+remote('partId','备件','part',v.partId)+remote('warehouseId','同工厂仓库','warehouse',v.warehouseId);
  if(['material-plan.create','material-plan.edit'].includes(ed.action))fields+=field('quantity','计划总量（含已净领用）',v.quantity||'')+field('needDate','需用日期',v.needDate||'','date');
  fields+=field('reason',ed.action==='material-plan.reopen'?'人工恢复依据':'计划或处理依据',v.reason||'');
 }else if(['purchase.create','purchase.edit'].includes(ed.action)){
  fields=remote('supplierId','供应商','supplier',v.supplierId)+remote('warehouseId','收货仓库','warehouse',v.warehouseId)+field('dueDate','需求日期',v.dueDate||'','date')+field('remark','采购说明',v.remark||'','text',false);
  fields+=`<div class="spares-lines"><h3>采购明细（人民币）</h3>${(v.lines||[{}]).map((l,i)=>`<div class="spares-line">${remote('line.'+i+'.partId','备件','part',l.partId)}${field('line.'+i+'.quantity','数量',l.quantity??qty(l.quantityMilli))}${field('line.'+i+'.unitPrice','单价（元）',l.unitPrice??price(l.unitPriceCents))}${(v.lines||[]).length>1?button('删除此行','spares-remove-line',`data-row="${i}"`):''}</div>`).join('')}${button('增加一行','spares-add-line')}</div>`;
 }else if(ed.action==='purchase.receive'){
  const p=ed.item;fields=select('lineId','采购明细',p.lines.filter(l=>l.receivedMilli<l.quantityMilli).map(l=>({id:l.id,name:l.code+' · 未收'+qty(l.quantityMilli-l.receivedMilli)+l.unit})),v.lineId)+field('accepted','本次合格数量',v.accepted??'0')+field('rejected','本次拒收数量',v.rejected??'0')+field('reason','验收依据',v.reason||'');
 }else if(ed.action.endsWith('.approve'))fields=select('decision','审批决定',(kind==='purchase'?['APPROVED','RETURNED','REJECTED']:['APPROVED','REJECTED']).map(id=>({id,name:statuses[id]})),v.decision||'APPROVED')+field('comment','审批意见',v.comment||'');
 else if(ed.action==='purchase.order')fields=field('externalNumber','外部订单号（登记，不自动下单）',v.externalNumber||'','text',false);
 else if(ed.action==='purchase.close')fields=field('reason','关闭依据（未收齐须说明）',v.reason||'');
 else if(ed.action==='stock.issue'||ed.action==='stock.transfer'||ed.action==='adjustment.create'){
  fields=remote('partId','备件','part',v.partId)+remote('warehouseId','仓库','warehouse',v.warehouseId)+field('quantity',ed.action==='adjustment.create'?'实盘/期初数量，报损时填报损数量':'数量',v.quantity||'');
  if(ed.action==='stock.issue')fields+=remote('deviceCode','已批准设备','device',v.deviceCode)+remote('workOrderId','关联工单（维修员必须填写）','order',v.workOrderId,false);
  if(ed.action==='stock.transfer')fields+=remote('targetWarehouseId','调入仓库','warehouse',v.targetWarehouseId);
  if(ed.action==='adjustment.create')fields+=select('type','类型',[{id:'COUNT',name:'盘点差异'},{id:'OPENING',name:'期初建账'},{id:'SCRAP',name:'报损'}],v.type||'COUNT');fields+=field('reason','业务依据',v.reason||'');
 }else if(ed.action==='stock.return'||ed.action==='stock.supplier-return')fields=field('quantity','退回数量',v.quantity||'')+field('reason','退回依据',v.reason||'');
 else if(ed.action==='link.create')fields=remote('partId','备件','part',v.partId)+remote('deviceCode','设备','device',v.deviceCode)+field('position','安装位置',v.position||'')+field('quantity','每台所需数量',v.quantity||'1')+field('cycleDays','更换周期（自然日，0表示未配置）',v.cycleDays||'0','number')+field('lastDate','最近实际更换日期（可留空）',v.lastDate||'','date',false);
 else if(ed.action==='replacement.create'){
  fields=remote('linkId','设备适用位置','link',v.linkId)+field('quantity','实际更换数量',v.quantity||'')+field('date','实际更换日期',v.date||today(),'date')+field('reason','更换与复测依据',v.reason||'');
 }else if(ed.action==='document.create')fields=select('type','凭证类型',[{id:'INVOICE',name:'发票登记'},{id:'PAYMENT',name:'付款凭证登记'}],v.type||'INVOICE')+field('number','票号或付款凭证号',v.number||'')+field('amount','金额（元）',v.amount||'')+field('date','凭证日期',v.date||today(),'date')+field('reason','登记依据',v.reason||'');
 return `<section class="panel spares-editor"><div class="panel-head"><h2>${e(ed.title||'填写业务资料')}</h2>${button('取消','spares-editor-close')}</div>${ed.prefillNote?`<p class="insight-note">${e(ed.prefillNote)}</p>`:''}<form id="spares-form"><div class="form-grid">${fields}</div><p>保存后保留业务记录；采购及库存调整须独立审批。领料不等于更换完成，付款凭证登记不执行支付。</p><button class="primary" data-action="spares-save" type="submit" ${s.busy?'disabled':''}>${s.busy?'正在保存…':'保存本次操作'}</button></form></section>`;
}
