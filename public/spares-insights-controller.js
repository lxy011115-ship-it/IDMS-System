import {qty,price} from './spares-ui-base.js';
const same=(a,b)=>a?.revision===b?.revision&&a?.publicRevision===b?.publicRevision;
const empty=()=>({stock:Object.create(null),replacement:Object.create(null),plans:Object.create(null)});
export const stockInsightKey=(partId,warehouseId)=>partId+':'+warehouseId;
export function installSparesInsights({state,api,render,notify,epoch,failed,openEditor,navigate,openPurchase,openOrder,openHistory}){
 const s=state.spares;s.insights??=empty();
 const clear=()=>{s.insights=empty();};
 const group=kind=>s.insights[kind];
 const valid=(kind,key,p,token,n)=>epoch()===token&&group(kind)[key]===p&&p.sequence===n;
 async function read(kind,key,params,direction='reset'){
  if(!['stock','replacement','plans'].includes(kind))return null;
  if(!s.data?.features?.insights)return null;
  const entries=group(kind);if(!entries[key]&&Object.keys(entries).length>=16)delete entries[Object.keys(entries)[0]];
  const p=entries[key]??={data:null,cursor:'',stack:[],sequence:0,params:{...params},error:'',loading:false};
  if(p.loading&&direction!=='reset')return null;
  if(direction==='next'){if(!p.data?.nextCursor&&!p.data?.basis?.nextCursor)return null;p.stack.push(p.cursor);p.cursor=p.data.nextCursor||p.data.basis.nextCursor;}
  else if(direction==='prev'){if(!p.stack.length)return null;p.cursor=p.stack.pop();}else{p.cursor='';p.stack=[];}
  p.params={...params};p.loading=true;p.error='';p.data=null;const token=epoch(),n=++p.sequence;render();
  const endpoint={stock:'stock-insight',replacement:'replacement-insight',plans:'material-plans'}[kind];
  try{
   const data=await api('/spares/'+endpoint+'?'+new URLSearchParams({...params,limit:'30',...(p.cursor?{cursor:p.cursor}:{})}));
   if(!valid(kind,key,p,token,n))return null;if(!data.ready)throw Object.assign(Error(data.notice||'此能力尚未准备完成'),{status:409});if(!same(s.data,data))throw Object.assign(Error('库存、工单或计划已变化，请刷新后从首页查看依据。'),{status:409});
   p.data=data;return data;
  }catch(error){if(!valid(kind,key,p,token,n))return null;p.error=error.message;p.cursor='';p.stack=[];if([401,403].includes(error.status))failed(error);if(error.status===404&&kind==='plans'&&(s.editor?.contextOrderId===key||s.receipt?.workOrderId===key||s.pendingCommand?.orderId===key))failed(Object.assign(Error('此工单已不在当前授权范围，请重新读取。'),{status:403}));return null;}
  finally{if(valid(kind,key,p,token,n))p.loading=false;render();}
 }
 const loadPlans=(orderId,direction='reset')=>read('plans',orderId,{workOrderId:orderId},direction);
 const lookup=id=>Object.values(s.insights.plans).flatMap(p=>p.data?.items||[]).find(r=>r.entity.id===id)?.entity;
 async function purchaseFrom(p){
  if(!p?.data?.canRequest||!(p.data.calculation?.suggestedMilli>0))return;
  const params={partId:p.params.partId,warehouseId:p.params.warehouseId};state.view='spares';await navigate('purchases');
  const token=epoch();
  try{
   const fresh=await api('/spares/stock-insight?'+new URLSearchParams(params));if(epoch()!==token)return;
   if(!fresh.ready||!same(s.data,fresh))throw Object.assign(Error('库存或计划已变化，请刷新并重新查看依据后编制采购。'),{status:409});
   if(!fresh.canRequest)throw Object.assign(Error('当前档案或职责不允许编制此采购申请，请重新核对。'),{status:fresh.capabilities?.request===false?403:409});
   const q=fresh.calculation.suggestedMilli;if(!(q>0)){notify('最新依据已无拟补充量，请核对库存与未收采购。');return;}
   const max=fresh.part.precision===0?999999999000:999999999999,tooLarge=q>max;
   await openEditor('purchase.create','','根据库存依据编制采购申请',{warehouseId:fresh.warehouse.id,dueDate:'',remark:'按'+fresh.businessDay+'库存与当前可见工单计划核对，拟补充'+qty(q)+fresh.part.unit+'；请确认供应商和需用日期。',lines:[{partId:fresh.part.id,quantity:tooLarge?'':String(qty(q)),unitPrice:price(fresh.part.referencePriceCents)}]},
    {selected:{warehouseId:fresh.warehouse,'line.0.partId':fresh.part},note:tooLarge?'拟补充总量超出单行范围，请核对并分批填写；系统不会自动拆单。':'仅带入最新参考数量和档案价格。请核对供应商、数量、单价与需求日期后保存，未自动创建采购单。'});
  }catch(error){if(epoch()===token)failed(error);render();}
 }
 async function handle(target){
  const a=target.dataset.action;
  if(a==='spares-stock-basis'){const {partId,warehouseId}=target.dataset,key=stockInsightKey(partId,warehouseId);if(s.insights.stock[key])delete s.insights.stock[key];else await read('stock',key,{partId,warehouseId,basis:'plans'});render();return true;}
  if(a==='spares-replacement-basis'){const key=target.dataset.id;if(s.insights.replacement[key])delete s.insights.replacement[key];else await read('replacement',key,{linkId:key});render();return true;}
  if(a==='spares-insight-page'||a==='spares-insight-basis'){
   const {kind,key}=target.dataset,p=group(kind)?.[key];if(p){const params={...p.params,...(a==='spares-insight-basis'?{basis:target.dataset.basis}:{})};await read(kind,key,params,a==='spares-insight-basis'?'reset':target.dataset.direction);}return true;
  }
  if(a==='spares-plans'){await loadPlans(target.dataset.id,target.dataset.direction||'reset');return true;}
  if(a==='spares-plan-new'){
   const id=target.dataset.id,p=s.insights.plans[id];if(p?.data?.canCreate)await openEditor('material-plan.create','','登记工单用料计划',{workOrderId:id},{orderId:id});return true;
  }
  if(a==='spares-plan-action'){
   const {id,command}=target.dataset,row=Object.values(s.insights.plans).flatMap(p=>p.data?.items||[]).find(r=>r.entity.id===id),op=command?.split('.')[1];
   const right={edit:'edit',close:'close',cancel:'close',reopen:'reopen'}[op];if(row&&right&&row.operations[right])await openEditor(command,id,{edit:'修订计划总量',close:'关闭用料计划',cancel:'取消用料计划',reopen:'人工恢复用料计划'}[op],{}, {orderId:row.entity.workOrderId});return true;
  }
  if(a==='spares-insight-request'){await purchaseFrom(s.insights.stock[target.dataset.key]);return true;}
  if(a==='spares-insight-purchase'){await openPurchase(target.dataset.id);return true;}
  if(a==='spares-insight-order'){await openOrder(target.dataset.id);return true;}
  if(a==='spares-insight-history'){await openHistory(target.dataset.id);return true;}
  return false;
 }
 const accepts=action=>['spares-stock-basis','spares-replacement-basis','spares-insight-page','spares-insight-basis','spares-plans','spares-plan-new','spares-plan-action','spares-insight-request','spares-insight-purchase','spares-insight-order','spares-insight-history'].includes(action);
 return {clear,handle,accepts,loadPlans,lookup};
}
