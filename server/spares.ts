import {randomUUID} from 'node:crypto';
import {DomainError} from './service.ts';
import {scopeFilter,hasAccess,type AccessContext} from './access.ts';
import {factKey,localEntities,relatedTotal,type SparesFacts} from './spares-facts.ts';
export type SpareEntity={id:string;kind:string;tenantId:string;siteCode:string;createdBy:string;createdAt:string;version:number;[key:string]:any};
export type SparesState={entities:SpareEntity[];facts?:SparesFacts};
export type SpareReferences={devices:{code:string;siteCode:string;name:string}[];orders:{id:string;deviceCode:string;assignee:string;state:string}[]};
const fail=(message:string,status=400):never=>{throw new DomainError(status,message);};
const text=(v:unknown,name:string,max=200,optional=false)=>{if(v===undefined&&optional)return '';if(typeof v!=='string'||v.trim().length>(max)||(!optional&&!v.trim()))return fail(name+'填写无效');return v.trim();};
const code=(v:unknown)=>{const s=text(v,'编码',80);if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s))fail('编码仅允许字母、数字、点、下划线和短横线');return s;};
export function quantity(v:unknown,precision=3){const s=String(v??'');if(!(precision===0?/^\d{1,9}$/:/^\d{1,9}(?:\.\d{1,3})?$/).test(s))fail('数量须为非负数，计数单位使用整数，计量单位最多三位小数');const [a,b='']=s.split('.');return Number(a)*1000+Number(b.padEnd(3,'0'));}
export function money(v:unknown){const s=String(v??'');if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(s))fail('金额须为非负人民币数值，最多两位小数');const [a,b='']=s.split('.');return Number(a)*100+Number(b.padEnd(2,'0'));}
const amount=(q:number,p:number)=>{const n=(BigInt(q)*BigInt(p)+500n)/1000n;if(n>9000000000000n)fail('金额超出范围');return Number(n);};
export const businessDay=(value=new Date())=>new Date(value.getTime()+8*3600000).toISOString().slice(0,10);
const day=(v:unknown)=>{const s=text(v,'日期',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)fail('日期无效');return s;};
const integer=(v:unknown,min:number,max:number)=>{const n=Number(v);if(!Number.isInteger(n)||n<min||n>max)fail('整数参数超出范围');return n;};
export function sparesCapabilities(ctx:AccessContext){return {manage:hasAccess(ctx,'spares:manage'),request:hasAccess(ctx,'spares:request'),move:hasAccess(ctx,'spares:move'),approve:hasAccess(ctx,'spares:approve'),finance:hasAccess(ctx,'spares:finance'),history:hasAccess(ctx,'spares:history')};}
export function spareVisible(e:SpareEntity,ctx:AccessContext,refs:SpareReferences){const s=scopeFilter(ctx);return e.tenantId===ctx.tenantId&&(s.sites===null||s.sites.includes(e.siteCode))&&(!e.deviceCode||refs.devices.some(d=>d.code===e.deviceCode))&&(!e.workOrderId||refs.orders.some(o=>o.id===e.workOrderId));}
export function authorizeSpare(state:SparesState,action:string,input:Record<string,any>,ctx:AccessContext,refs:SpareReferences){
 const c=sparesCapabilities(ctx),right=action.endsWith('.approve')?'approve':action.startsWith('purchase.')&&['purchase.create','purchase.edit','purchase.submit','purchase.cancel'].includes(action)?'request':action.startsWith('stock.')||action==='replacement.create'?'move':action==='document.create'?'finance':'manage';
 if(!c[right as keyof typeof c])fail('当前账户没有此项备件采购权限',403);
 const s=scopeFilter(ctx);if(input.siteCode&&(s.sites!==null&&!s.sites.includes(input.siteCode)))fail('工厂不在当前授权范围',403);
 if(input.id){const target=state.entities.find(e=>e.id===input.id&&spareVisible(e,ctx,refs));if(!target)fail('单据不存在或不在授权范围',404);}
 for(const id of [input.partId,input.warehouseId,input.targetWarehouseId,input.supplierId,input.linkId,...(Array.isArray(input.lines)?input.lines.map((l:any)=>l?.partId):[])].filter(Boolean))if(!state.entities.some(e=>e.id===id&&spareVisible(e,ctx,refs)))fail('关联资料不在当前范围',403);
 if(input.deviceCode&&!refs.devices.some(d=>d.code===input.deviceCode))fail('设备不在当前授权范围',403);
 if(input.workOrderId&&!refs.orders.some(o=>o.id===input.workOrderId))fail('工单不在当前授权范围',403);
}
export function stock(state:SparesState,partId:string,warehouseId:string){const moves=localEntities(state).filter(e=>e.kind==='movement'&&e.partId===partId&&e.warehouseId===warehouseId),base=state.facts?.stocks.get(factKey(partId,warehouseId));if(state.facts&&!base)fail('备件命令缺少库存事实',503);return {quantityMilli:(base?.quantityMilli||0)+moves.reduce((n,e)=>n+e.deltaMilli,0),revision:(base?.revision||0)+moves.length};}
export function spareCommand(state:SparesState,action:string,input:Record<string,any>,ctx:AccessContext,refs:SpareReferences){
 authorizeSpare(state,action,input,ctx,refs);const all=state.entities,now=new Date().toISOString(),caps=sparesCapabilities(ctx);
 const find=(id:unknown,kind:string)=>{const e=all.find(e=>e.id===id&&e.kind===kind&&spareVisible(e,ctx,refs));if(!e)fail('关联'+kind+'不存在或不在当前范围',404);return e!;};
 const active=(e:SpareEntity)=>{if(e.active===false)fail('已停用档案不能用于新业务');return e;};
 const version=(e:SpareEntity)=>{if(input.expectedVersion!==e.version)fail('单据版本已变化，请刷新后重试',409);};
 const add=(kind:string,siteCode:string,fields:Record<string,any>)=>{const e={id:randomUUID(),kind,tenantId:ctx.tenantId,siteCode,createdBy:ctx.actorId,createdAt:now,version:1,...fields} as SpareEntity;all.push(e);return e;};
 const sameSite=(...es:SpareEntity[])=>{if(new Set(es.map(e=>e.siteCode)).size!==1)fail('关联档案必须属于同一工厂');};
 const device=(v:unknown,site:string)=>{const d=refs.devices.find(d=>d.code===v&&d.siteCode===site);if(!d)fail('须选择当前授权范围内、同工厂的已批准设备');return d!;};
 const positive=(v:unknown,p:SpareEntity)=>{const n=quantity(v,p.precision);if(n<=0)fail('数量必须大于零');return n;};
 const unique=(kind:string,value:string,except?:string)=>{if(state.facts?state.facts.codeConflict:all.some(e=>e.kind===kind&&e.tenantId===ctx.tenantId&&e.id!==except&&e.code.toLowerCase()===value.toLowerCase()))fail('编码已存在',409);};
 const movement=(p:SpareEntity,w:SpareEntity,delta:number,type:string,fields:Record<string,any>={})=>{sameSite(p,w);const next=stock(state,p.id,w.id).quantityMilli+delta;if(!Number.isSafeInteger(next)||next>9000000000000)fail('库存数量超限');if(next<0)fail('库存不足，不能形成负库存',409);return add('movement',w.siteCode,{partId:p.id,warehouseId:w.id,deltaMilli:delta,type,...fields});};
 const checkedOrder=(p:SpareEntity)=>{if(!['APPROVED','ORDERED','PART_RECEIVED','RECEIVED'].includes(p.status))fail('采购单当前状态不允许此操作',409);return p;};
 const refreshOrder=(p:SpareEntity)=>{if(p.status!=='CLOSED')p.status=p.lines.every((l:any)=>l.receivedMilli===l.quantityMilli)?'RECEIVED':p.lines.some((l:any)=>l.receivedMilli>0)?'PART_RECEIVED':'ORDERED';p.version++;};
 const newSite=()=>{const site=code(input.siteCode),s=scopeFilter(ctx);if(s.sites!==null&&!s.sites.includes(site))fail('工厂不在当前范围',403);return site;};
 if(['part.create','supplier.create','warehouse.create'].includes(action)){
  const kind=action.split('.')[0],site=newSite(),value=code(input.code);unique(kind,value);
  const fields:Record<string,any>={code:value,name:text(input.name,'名称'),active:true,remark:text(input.remark,'备注',2000,true)};
  if(kind==='part'){fields.model=text(input.model,'规格型号',200,true);fields.brand=text(input.brand,'品牌',100,true);fields.category=text(input.category,'类别',100,true);fields.unit=text(input.unit,'计量单位',20);fields.precision=integer(input.precision??0,0,3);if(![0,3].includes(fields.precision))fail('精度仅支持0或3');if(['件','个','只','套','台','支','根','片','颗','枚'].includes(fields.unit)&&fields.precision!==0)fail('计数单位必须使用整数精度');fields.safetyMilli=quantity(input.safety??'0',fields.precision);fields.wearPart=input.wearPart!==false;fields.referencePriceCents=money(input.referencePrice??'0');}
  if(kind==='supplier'){fields.contact=text(input.contact,'联系人',100,true);fields.phone=text(input.phone,'联系电话',100,true);fields.leadDays=integer(input.leadDays??0,0,3650);}
  if(kind==='warehouse')fields.location=text(input.location,'库位',200,true);
  return add(kind,site,fields);
 }
 if(['part.update','supplier.update','warehouse.update'].includes(action)){
  const kind=action.split('.')[0],e=find(input.id,kind);version(e);e.name=text(input.name??e.name,'名称');e.remark=text(input.remark??e.remark,'备注',2000,true);if(input.active!==undefined){if(typeof input.active!=='boolean')fail('启停用参数无效');e.active=input.active;}
  if(kind==='part'){if(input.safety!==undefined)e.safetyMilli=quantity(input.safety,e.precision);for(const key of ['model','brand','category'])if(input[key]!==undefined)e[key]=text(input[key],'备件资料',200,true);if(input.referencePrice!==undefined)e.referencePriceCents=money(input.referencePrice);if(input.wearPart!==undefined){if(typeof input.wearPart!=='boolean')fail('易损件标记无效');e.wearPart=input.wearPart;}}
  if(kind==='supplier'){e.contact=text(input.contact??e.contact,'联系人',100,true);e.phone=text(input.phone??e.phone,'联系电话',100,true);e.leadDays=integer(input.leadDays??e.leadDays,0,3650);}
  if(kind==='warehouse')e.location=text(input.location??e.location,'库位',200,true);e.version++;return e;
 }
 const purchaseLines=(supplier:SpareEntity,w:SpareEntity)=>{sameSite(supplier,w);if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>50)fail('采购明细须为1至50项');return input.lines.map((l:any)=>{const p=active(find(l.partId,'part'));sameSite(p,w);const q=positive(l.quantity,p),price=money(l.unitPrice);return {id:randomUUID(),partId:p.id,code:p.code,name:p.name,unit:p.unit,precision:p.precision,quantityMilli:q,receivedMilli:0,rejectedMilli:0,returnedMilli:0,unitPriceCents:price,amountCents:amount(q,price)};});};
 if(action==='purchase.create'||action==='purchase.edit'){
  const s=active(find(input.supplierId,'supplier')),w=active(find(input.warehouseId,'warehouse')),lines=purchaseLines(s,w);const totalCents=lines.reduce((n:number,l:any)=>n+l.amountCents,0);if(!Number.isSafeInteger(totalCents)||totalCents>9000000000000)fail('采购金额超限');
  const fields={supplierId:s.id,supplierName:s.name,warehouseId:w.id,lines,totalCents,currency:'CNY',dueDate:day(input.dueDate),remark:text(input.remark,'采购说明',2000,true),contributors:[ctx.actorId],status:'DRAFT'};
  if(action.endsWith('create'))return add('purchase',w.siteCode,{...fields,number:'PO-'+now.replace(/\D/g,'').slice(0,14)+'-'+randomUUID().slice(0,6)});
  const p=find(input.id,'purchase');version(p);if(!['DRAFT','RETURNED'].includes(p.status))fail('只能修改草稿或退回单据',409);if(!caps.manage&&p.createdBy!==ctx.actorId)fail('只能修改本人采购草稿',403);sameSite(p,w);fields.contributors=[...new Set([...(p.contributors||[]),ctx.actorId,p.createdBy])];Object.assign(p,fields,{version:p.version+1});return p;
 }
 if(action.startsWith('purchase.')){
  const p=find(input.id,'purchase');version(p);
  if(action==='purchase.submit'){if(!['DRAFT','RETURNED'].includes(p.status))fail('仅草稿可提交',409);if(!caps.manage&&p.createdBy!==ctx.actorId)fail('只能提交本人草稿',403);active(find(p.supplierId,'supplier'));active(find(p.warehouseId,'warehouse'));for(const l of p.lines)active(find(l.partId,'part'));p.status='SUBMITTED';p.submittedBy=ctx.actorId;}
  else if(action==='purchase.approve'){if(p.status!=='SUBMITTED')fail('仅待审核采购单可审批',409);if([p.createdBy,p.submittedBy,...(p.contributors||[])].includes(ctx.actorId))fail('采购编制人员不能自审',403);const decision=text(input.decision,'决定');if(!['APPROVED','RETURNED','REJECTED'].includes(decision))fail('审批决定无效');p.status=decision;p.approval={actor:ctx.actorId,comment:text(input.comment,'审批意见',2000),at:now,decision};}
  else if(action==='purchase.order'){if(p.status!=='APPROVED')fail('仅已批准采购可登记下单',409);p.status='ORDERED';p.externalNumber=text(input.externalNumber,'外部单号',200,true);p.orderedAt=now;}
  else if(action==='purchase.close'){checkedOrder(p);p.status='CLOSED';p.closeReason=text(input.reason,'关闭依据',2000);}
  else if(action==='purchase.cancel'){if(p.status!=='DRAFT'||p.createdBy!==ctx.actorId&&!caps.manage)fail('只能取消有权处理的未提交草稿',409);p.status='CANCELLED';}
  else if(action==='purchase.receive'){
   if(!['ORDERED','PART_RECEIVED'].includes(p.status))fail('仅已下单或部分到货的采购可收货',409);const l=p.lines.find((l:any)=>l.id===input.lineId);if(!l)fail('采购行不存在');const part=find(l.partId,'part'),w=active(find(p.warehouseId,'warehouse')),accepted=quantity(input.accepted??'0',part.precision),rejected=quantity(input.rejected??'0',part.precision);if(accepted+rejected<=0||accepted+rejected>l.quantityMilli-l.receivedMilli)fail('本次到货不得超过该行剩余未收数量');
   const receipt=add('receipt',p.siteCode,{purchaseId:p.id,lineId:l.id,partId:part.id,warehouseId:w.id,acceptedMilli:accepted,rejectedMilli:rejected,reason:text(input.reason,'验收依据',2000)});if(accepted)movement(part,w,accepted,'RECEIPT',{receiptId:receipt.id,purchaseId:p.id,lineId:l.id});l.receivedMilli+=accepted;l.rejectedMilli+=rejected;refreshOrder(p);return receipt;
  }else fail('采购操作不存在',404);p.version++;return p;
 }
 if(action==='stock.supplier-return'){
  if(!caps.manage)fail('供应商退货须由备件管理人员处理',403);
  const r=find(input.id,'receipt'),p=find(r.purchaseId,'purchase'),part=find(r.partId,'part'),w=find(r.warehouseId,'warehouse'),q=positive(input.quantity,part),returned=relatedTotal(state,'supplierReturns',r.id,e=>e.kind==='movement'&&e.type==='SUPPLIER_RETURN'&&e.receiptId===r.id,e=>-e.deltaMilli);if(returned+q>r.acceptedMilli)fail('超过原收货可退数量');const l=p.lines.find((l:any)=>l.id===r.lineId);if(l.receivedMilli<q)fail('采购净收货数量不足');const m=movement(part,w,-q,'SUPPLIER_RETURN',{receiptId:r.id,purchaseId:p.id,reason:text(input.reason,'退货依据',2000)});l.receivedMilli-=q;l.returnedMilli+=q;refreshOrder(p);return m;
 }
 if(action==='stock.issue'){
  const p=active(find(input.partId,'part')),w=active(find(input.warehouseId,'warehouse'));device(input.deviceCode,w.siteCode);let order;
  if(input.workOrderId){order=refs.orders.find(o=>o.id===input.workOrderId&&o.deviceCode===input.deviceCode);if(!order)fail('工单不在当前范围或设备不一致');if(!caps.manage&&(order!.assignee!==ctx.actorId||order!.state!=='IN_PROGRESS'))fail('维修人员仅可对本人维修中的工单领料',403);}
  if(!caps.manage&&!order)fail('维修人员领料必须关联本人维修中的工单',403);
  return movement(p,w,-positive(input.quantity,p),'ISSUE',{deviceCode:input.deviceCode,workOrderId:order?.id||'',reason:text(input.reason,'领用用途',2000)});
 }
 if(action==='stock.return'){
  const m=find(input.id,'movement');if(m.type!=='ISSUE')fail('退料须引用原领用');if(!caps.manage&&m.createdBy!==ctx.actorId)fail('仅能退回本人领用',403);const p=find(m.partId,'part'),w=find(m.warehouseId,'warehouse'),q=positive(input.quantity,p),returns=relatedTotal(state,'issueReturns',m.id,e=>e.kind==='movement'&&e.type==='RETURN'&&e.issueId===m.id,e=>e.deltaMilli),installed=relatedTotal(state,'issueInstalled',m.id,e=>e.kind==='replacement'&&e.issueId===m.id,e=>e.quantityMilli);if(q+returns+installed>-m.deltaMilli)fail('退料超过尚未使用的原领用数量');return movement(p,w,q,'RETURN',{issueId:m.id,deviceCode:m.deviceCode,workOrderId:m.workOrderId,reason:text(input.reason,'退料依据',2000)});
 }
 if(action==='stock.transfer'){
  if(!caps.manage)fail('调拨须由备件管理人员处理',403);const p=active(find(input.partId,'part')),from=active(find(input.warehouseId,'warehouse')),to=active(find(input.targetWarehouseId,'warehouse'));if(from.id===to.id)fail('调拨仓库不能相同');sameSite(p,from,to);const q=positive(input.quantity,p),ref=randomUUID(),reason=text(input.reason,'调拨依据',2000);movement(p,from,-q,'TRANSFER_OUT',{transferId:ref,reason});return movement(p,to,q,'TRANSFER_IN',{transferId:ref,reason});
 }
 if(action==='adjustment.create'){
  const p=active(find(input.partId,'part')),w=active(find(input.warehouseId,'warehouse'));sameSite(p,w);const current=stock(state,p.id,w.id);if(!['OPENING','COUNT','SCRAP'].includes(input.type))fail('调整类型无效');const q=quantity(input.quantity,p.precision);if(input.type==='OPENING'&&current.revision)fail('有历史流水的库存不能再次期初建账');const delta=input.type==='SCRAP'?-q:q-current.quantityMilli;if(!delta)fail('没有库存差异');if(current.quantityMilli+delta<0)fail('报损数量超过库存');return add('adjustment',p.siteCode,{partId:p.id,warehouseId:w.id,type:input.type,baseline:current,deltaMilli:delta,status:'SUBMITTED',reason:text(input.reason,'调整依据',2000)});
 }
 if(action==='adjustment.approve'){
  const e=find(input.id,'adjustment');version(e);if(e.status!=='SUBMITTED')fail('该调整已处理',409);if(e.createdBy===ctx.actorId)fail('调整申请人不能自审',403);if(!['APPROVED','REJECTED'].includes(input.decision))fail('决定无效');const comment=text(input.comment,'审批意见',2000);if(input.decision==='APPROVED'){const p=find(e.partId,'part'),w=find(e.warehouseId,'warehouse'),current=stock(state,p.id,w.id);if(current.revision!==e.baseline.revision||current.quantityMilli!==e.baseline.quantityMilli)fail('库存已变化，请重新盘点后提交',409);movement(p,w,e.deltaMilli,e.type,{adjustmentId:e.id,reason:e.reason});}e.status=input.decision;e.approval={actor:ctx.actorId,comment,at:now};e.version++;return e;
 }
 if(action==='link.create'){
  const p=active(find(input.partId,'part'));device(input.deviceCode,p.siteCode);const position=text(input.position,'安装位置');if(state.facts?state.facts.linkConflict:all.some(e=>e.kind==='link'&&e.partId===p.id&&e.deviceCode===input.deviceCode&&e.position===position))fail('该设备位置已有此备件关联',409);const lastDate=input.lastDate?day(input.lastDate):'';if(lastDate&&lastDate>businessDay(new Date(now)))fail('最近更换日期不能为未来');return add('link',p.siteCode,{partId:p.id,deviceCode:input.deviceCode,position,quantityMilli:positive(input.quantity,p),cycleDays:integer(input.cycleDays??0,0,36500),lastDate});
 }
 if(action==='replacement.create'){
  const m=find(input.id,'movement');if(m.type!=='ISSUE')fail('更换记录须引用原领用单');if(!caps.manage&&m.createdBy!==ctx.actorId)fail('只能登记本人领用的更换',403);const p=find(m.partId,'part'),link=find(input.linkId,'link');if(link.partId!==p.id||link.deviceCode!==m.deviceCode)fail('设备、位置与领用备件不匹配');const q=positive(input.quantity,p),used=relatedTotal(state,'issueInstalled',m.id,e=>e.kind==='replacement'&&e.issueId===m.id,e=>e.quantityMilli),ret=relatedTotal(state,'issueReturns',m.id,e=>e.kind==='movement'&&e.type==='RETURN'&&e.issueId===m.id,e=>e.deltaMilli);if(q+used+ret>-m.deltaMilli)fail('更换数量超过原领用净数量');const date=day(input.date);if(date>businessDay(new Date(now))||date<businessDay(new Date(m.createdAt))||link.lastDate&&date<link.lastDate)fail('更换日期须在领用之后且不早于已登记更换、不晚于当前日期');const e=add('replacement',p.siteCode,{partId:p.id,linkId:link.id,issueId:m.id,quantityMilli:q,date,deviceCode:m.deviceCode,workOrderId:m.workOrderId,reason:text(input.reason,'更换依据',2000)});link.lastDate=date;link.version++;return e;
 }
 if(action==='document.create'){
  const p=find(input.id,'purchase');if(p.status!=='CLOSED')checkedOrder(p);if(!['INVOICE','PAYMENT'].includes(input.type))fail('凭证类型无效');const value=money(input.amount);if(value<=0)fail('登记金额须大于零');const number=text(input.number,'票号或付款凭证号',120),date=day(input.date);if(date>businessDay(new Date(now)))fail('凭证日期不能为未来');if(state.facts?state.facts.documentConflict:all.some(e=>e.kind==='document'&&e.tenantId===ctx.tenantId&&e.type===input.type&&e.number===number))fail('凭证号已登记',409);const prior=relatedTotal(state,'documents',factKey(p.id,input.type),e=>e.kind==='document'&&e.purchaseId===p.id&&e.type===input.type,e=>e.amountCents);if(prior+value>p.totalCents)fail('累计登记金额超过采购单金额');return add('document',p.siteCode,{purchaseId:p.id,type:input.type,number,date,amountCents:value,reason:text(input.reason,'登记依据',2000)});
 }
 fail('备件采购操作不存在',404);
}
export function sparesView(state:SparesState,ctx:AccessContext,refs:SpareReferences){
 const entities=state.entities.filter(e=>spareVisible(e,ctx,refs)),parts=entities.filter(e=>e.kind==='part'),warehouses=entities.filter(e=>e.kind==='warehouse');
 const balances=parts.flatMap(p=>warehouses.filter(w=>w.siteCode===p.siteCode).map(w=>({...stock(state,p.id,w.id),partId:p.id,warehouseId:w.id,low:stock(state,p.id,w.id).quantityMilli<p.safetyMilli})));
 const reminders=entities.filter(e=>e.kind==='link').map(e=>({...e,dueDate:e.cycleDays&&e.lastDate?new Date(Date.parse(e.lastDate+'T00:00:00Z')+e.cycleDays*86400000).toISOString().slice(0,10):null}));
 const purchases=entities.filter(e=>e.kind==='purchase').map(e=>{const payment=entities.filter(x=>x.kind==='document'&&x.purchaseId===e.id&&x.type==='PAYMENT').reduce((n,x)=>n+x.amountCents,0),invoice=entities.filter(x=>x.kind==='document'&&x.purchaseId===e.id&&x.type==='INVOICE').reduce((n,x)=>n+x.amountCents,0),netReceived=e.lines.reduce((n:number,l:any)=>n+amount(l.receivedMilli,l.unitPriceCents),0);return {...e,paymentCents:payment,invoiceCents:invoice,netReceivedCents:netReceived,financeReview:payment>netReceived};});
 return {available:true,capabilities:sparesCapabilities(ctx),entities:entities.filter(e=>e.kind!=='purchase'),purchases,balances,reminders,devices:refs.devices,orders:refs.orders,notice:'本地开发版 · 付款仅登记凭证，不执行支付。库存收发与实际更换分别记录。'};
}
