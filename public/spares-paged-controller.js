import {emptyHistory} from './spares-history-ui.js';
import {readForm,getField,setField,qty,price} from './spares-ui-base.js';
import {optionSpecs} from './spares-options-ui.js';
import {installSparesInsights} from './spares-insights-controller.js';
export const tabKinds={inventory:['stock','warehouse'],parts:['part'],suppliers:['supplier'],purchases:['purchase'],movements:['movement'],links:['link','replacement'],adjustments:['adjustment'],documents:['document']};
const emptyPage=()=>({data:null,cursor:'',stack:[],loading:false,error:'',sequence:0});
const same=(a,b)=>a?.revision===b?.revision&&a?.publicRevision===b?.publicRevision;
const changed=()=>Object.assign(Error('资料已变化，请重新读取首页。'),{status:409});
export function installSparesUi({state,api,post,render,notify}){
 const s=state.spares;let identity=0,generation=0,historyGeneration=0,insightUi;const pending=new Map();s.pages??={};s.usage??={};
 const clear=()=>{identity++;generation++;historyGeneration++;Object.assign(s,{data:null,pages:{},usage:{},detail:null,error:'',editor:null,selectedId:'',query:'',supplierId:'',purchaseId:'',deviceCode:'',workOrderId:'',busy:false,loading:false,receipt:null,history:emptyHistory(),pendingCommand:null,refreshFailed:false});insightUi?.clear();pending.clear();};
 const parameters=(kind,cursor='',extra={})=>{const p=new URLSearchParams({kind,limit:'30',...extra});if(s.query)p.set('q',s.query);if(kind==='purchase'&&s.supplierId)p.set('supplierId',s.supplierId);if(['receipt','movement','document'].includes(kind)&&s.purchaseId)p.set('purchaseId',s.purchaseId);if(['movement','link','replacement'].includes(kind)&&s.deviceCode)p.set('deviceCode',s.deviceCode);if(['movement','replacement'].includes(kind)&&s.workOrderId)p.set('workOrderId',s.workOrderId);if(cursor)p.set('cursor',cursor);return p;};
 const failed=(error)=>{if([401,403].includes(error.status)){clear();s.error=error.message;return;}s.error=error.message;};
 const load=async()=>{
  if(state.view==='spares'&&s.tab==='history')return historyLoad();
  const g=++generation,i=identity,view=state.view,tab=s.tab,id=s.selectedId;historyGeneration++;s.loading=true;s.error='';s.pages={};s.detail=null;s.usage={};insightUi?.clear();render();
  try{
   const summary=await api('/spares/summary');if(g!==generation||i!==identity)return;
   if(!summary.available){s.data=summary;return;}
   const next={};if(view==='spares')for(const kind of tabKinds[tab]||tabKinds.inventory){const data=await api('/spares/list?'+parameters(kind));if(g!==generation||i!==identity)return;if(!same(summary,data))throw changed();next[kind]={...emptyPage(),data};}
   let detail=null;if(view==='spares'&&tab==='purchases'&&id){const data=await api('/spares/detail?'+new URLSearchParams({id}));if(g!==generation||i!==identity)return;if(!same(summary,data))throw changed();detail=data;const receipts=await api('/spares/list?'+new URLSearchParams({kind:'receipt',limit:'30',purchaseId:id}));if(g!==generation||i!==identity)return;if(!same(summary,receipts))throw changed();next.purchaseReceipts={...emptyPage(),data:receipts};}
   s.data=summary;s.pages=next;s.detail=detail;s.refreshFailed=false;
  }catch(error){if(g===generation&&i===identity){s.data=null;s.pages={};s.detail=null;failed(error);if(s.receipt)s.refreshFailed=true;}throw error;}
  finally{if(g===generation&&i===identity)s.loading=false;render();}
 };
 const loadPage=async(key,direction)=>{
  const p=s.pages[key];if(!p||p.loading)return;const i=identity,g=generation,n=++p.sequence;
  if(direction==='next'){if(!p.data?.nextCursor)return;p.stack.push(p.cursor);p.cursor=p.data.nextCursor;}else if(direction==='prev'){if(!p.stack.length)return;p.cursor=p.stack.pop();}else{p.cursor='';p.stack=[];}
  p.loading=true;p.error='';p.data=null;render();
  try{const params=key==='purchaseReceipts'?new URLSearchParams({kind:'receipt',limit:'30',purchaseId:s.selectedId,...(p.cursor?{cursor:p.cursor}:{})}):parameters(key,p.cursor);const value=await api('/spares/list?'+params);if(i!==identity||g!==generation||n!==p.sequence)return;if(!same(s.data,value))throw changed();p.data=value;}
  catch(error){if(i!==identity||g!==generation||n!==p.sequence)return;p.cursor='';p.stack=[];p.error=error.message;failed(error);}
  finally{if(i===identity&&g===generation&&n===p.sequence)p.loading=false;render();}
 };
 const historyLoad=async()=>{
  const h=s.history||=emptyHistory(),g=++historyGeneration,i=identity,signature=JSON.stringify(['q','action','from','to','entityId'].map(k=>h.filters[k]||''));if(h.appliedFilters&&h.appliedFilters!==signature){h.before='';h.stack=[];}h.appliedFilters=signature;h.loading=true;h.error='';h.data=null;render();
  const p=new URLSearchParams({limit:'30'});for(const k of ['q','action','from','to','entityId'])if(h.filters[k])p.set(k,h.filters[k]);if(h.before)p.set('before',h.before);
  try{const data=await api('/spares/history?'+p);if(i===identity&&g===historyGeneration){h.data=data;h.actionLabels=data.actionLabels;}}
  catch(error){if(i!==identity||g!==historyGeneration)return;if([401,403].includes(error.status)){clear();s.history.error=error.message;}else{h.error=error.message;h.before='';h.stack=[];}}
  finally{if(i===identity&&g===historyGeneration)h.loading=false;render();}
 };
 const lookup=id=>s.detail?.item?.id===id?s.detail.item:Object.values(s.pages).flatMap(p=>p.data?.items||[]).map(r=>r.entity).find(x=>x?.id===id)||insightUi?.lookup(id);
 const resetFilters=()=>{s.query='';s.supplierId='';s.purchaseId='';s.deviceCode='';s.workOrderId='';};
 const openEditor=async(action,id='',title='',values={},context={})=>{
  if(s.pendingCommand){s.error='请先按原请求核对尚未确认的提交。';render();return;}
  if(action.startsWith('material-plan.')&&!s.data?.features?.materialPlans){s.error='用料计划能力尚未准备完成，请重新读取。';render();return;}
  let item=id?lookup(id):null;
  if(id&&!item){s.error='记录已离开当前页，请重新查询后操作。';render();return;}
  let v=action.endsWith('.update')||action==='purchase.edit'?structuredClone(item):structuredClone(values);
  if(action==='material-plan.edit')v={quantity:String(qty(item.quantityMilli)),needDate:item.needDate,reason:item.reason};
  if(action==='purchase.edit')v.lines=v.lines.map(l=>({...l,quantity:String(qty(l.quantityMilli)),unitPrice:price(l.unitPriceCents)}));if(action==='purchase.create'&&!v.lines?.length)v.lines=[{}];
  const selected={};if(action==='purchase.edit'){selected.supplierId={id:v.supplierId,name:v.supplierName};selected.warehouseId=s.detail?.warehouse;v.lines.forEach((l,i)=>selected['line.'+i+'.partId']={id:l.partId,code:l.code,name:l.name,unit:l.unit});}
  s.editor={action,id,item,version:item?.version,title,values:v,fields:{},selected:{...selected,...context.selected},prefillNote:context.note||'',contextOrderId:action.startsWith('material-plan.')?context.orderId||item?.workOrderId||values.workOrderId||'':''};s.receipt=null;s.refreshFailed=false;s.error='';render();
 };
 const optionLoad=async(name,direction='reset')=>{
  const ed=s.editor,spec=ed&&optionSpecs(ed).find(x=>x.name===name);if(!spec)return;const f=ed.fields[name]??={q:'',cursor:'',stack:[],data:null,selected:ed.selected[name]||null,sequence:0};if(f.loading&&direction!=='reset')return;
  if(direction==='next'){if(!f.data?.nextCursor)return;f.stack.push(f.cursor);f.cursor=f.data.nextCursor;}else if(direction==='prev'){if(!f.stack.length)return;f.cursor=f.stack.pop();}else{f.cursor='';f.stack=[];}
  const i=identity,n=++f.sequence,value=getField(ed.values,name);f.loading=true;f.open=true;f.error='';f.data=null;render();
  const params=new URLSearchParams({kind:spec.kind,limit:'30',...spec.filters});if(f.q)params.set('q',f.q);if(value)params.set('id',value);if(f.cursor)params.set('cursor',f.cursor);
  try{const data=await api('/spares/options?'+params);if(i!==identity||s.editor!==ed||n!==f.sequence)return;f.data=data;f.selected=data.selected||f.selected;}
  catch(error){if(i!==identity||s.editor!==ed||n!==f.sequence)return;if([401,403].includes(error.status))failed(error);else{f.error=error.message;f.cursor='';f.stack=[];}}
  finally{if(i===identity&&s.editor===ed&&n===f.sequence)f.loading=false;render();}
 };
 const usageLoad=async(orderId,direction='reset')=>{
  if(!s.usage[orderId]&&Object.keys(s.usage).length>=16)delete s.usage[Object.keys(s.usage)[0]];
  const p=s.usage[orderId]??=emptyPage();if(p.loading)return;
  if(direction==='next'){if(!p.data?.nextCursor)return;p.stack.push(p.cursor);p.cursor=p.data.nextCursor;}else if(direction==='prev'){if(!p.stack.length)return;p.cursor=p.stack.pop();}else{p.cursor='';p.stack=[];}
  const i=identity,g=generation,n=++p.sequence;p.loading=true;p.error='';p.data=null;render();
  try{const value=await api('/spares/workorder-usage?'+new URLSearchParams({workOrderId:orderId,limit:'30',...(p.cursor?{cursor:p.cursor}:{})}));if(i===identity&&g===generation&&n===p.sequence)p.data=value;}
  catch(error){if(i!==identity||g!==generation||n!==p.sequence)return;p.error=error.message;p.cursor='';p.stack=[];if([401,403].includes(error.status))failed(error);}
  finally{if(i===identity&&g===generation&&n===p.sequence)p.loading=false;render();}
 };
 const send=async command=>{
  const i=identity;s.busy=true;s.error='';render();
  try{const saved=await post('/spares/commands',{action:command.action,input:command.input},undefined,command.requestKey);if(i!==identity)return;pending.delete(command.signature);s.pendingCommand=null;s.receipt={id:saved.id,number:saved.number||saved.code||'',action:command.action,workOrderId:saved.kind==='material-plan'?saved.workOrderId:''};s.editor=null;if(saved.kind==='purchase'){s.tab='purchases';s.selectedId=saved.id;resetFilters();}
   try{await load();if(saved.kind==='material-plan'&&state.view==='work-orders'&&i===identity){const refreshed=await insightUi.loadPlans(saved.workOrderId);if(!refreshed&&s.receipt){s.refreshFailed=true;return;}}}catch{if(i===identity&&s.receipt){s.refreshFailed=true;s.error='记录已经保存，列表暂未更新。请重新读取列表。';}return;}if(i===identity)notify('本次操作已保存。');
  }catch(error){if(i!==identity)return;if([401,403,404].includes(error.status)){clear();s.error=error.message;}else if(!error.status||error.status>=500||error.status===429){s.pendingCommand=command;s.error='提交结果尚未确认，请使用原请求核对，避免重复业务。';}else{s.pendingCommand=null;s.error=error.message;}}
  finally{if(i===identity)s.busy=false;render();}
 };
 const capture=()=>{const form=globalThis.document?.querySelector('#spares-form'),ed=s.editor;if(!ed||!form||s.busy)return;ed.values=readForm(form);for(const input of form.querySelectorAll?.('[data-option-query]')||[]){const f=ed.fields[input.dataset.optionQuery];if(f)f.q=input.value;}};
 const captureHistory=()=>{const form=globalThis.document?.querySelector('#spares-history-filter');if(form&&s.history&&!s.history.loading)s.history.filters={...s.history.filters,...readForm(form)};};
 const handle=async target=>{
  const a=target.dataset.action;if(s.busy)return;
  if(insightUi.accepts(a)){await insightUi.handle(target);return;}
  if(a==='spares-tab'){generation++;historyGeneration++;s.tab=target.dataset.tab;s.editor=null;s.selectedId='';resetFilters();await load();return;}
  if(a==='spares-refresh'){const orderId=s.receipt?.workOrderId;await load();if(orderId&&state.view==='work-orders'&&s.receipt&&!await insightUi.loadPlans(orderId))s.refreshFailed=true;return;}
  if(a==='spares-search'){s.query=String(new FormData(target.closest('form')).get('query')||'');await load();return;}
  if(a==='spares-filter-clear'){resetFilters();await load();return;}
  if(a==='spares-page'){await loadPage(target.dataset.key,target.dataset.direction);return;}
  if(a==='spares-supplier-orders'){s.tab='purchases';resetFilters();s.supplierId=target.dataset.id;s.selectedId='';s.editor=null;await load();return;}
  if(a==='spares-purchase-open'){s.selectedId=target.dataset.id;s.editor=null;await load();return;}
  if(a==='spares-purchase-close'){s.selectedId='';s.detail=null;delete s.pages.purchaseReceipts;render();return;}
  if(a==='spares-purchase-records'){s.tab=target.dataset.kind==='document'?'documents':'movements';resetFilters();s.purchaseId=target.dataset.id;s.selectedId='';await load();return;}
  if(a==='spares-editor-close'){s.editor=null;render();return;}
  if(a==='spares-new'){await openEditor(target.dataset.command,target.dataset.id||'',target.textContent,{...(target.dataset.stockType?{type:target.dataset.stockType}:{})});return;}
  if(a==='spares-add-line'||a==='spares-remove-line'){capture();const ed=s.editor;if(!ed)return;if(a==='spares-add-line'&&ed.values.lines.length<50)ed.values.lines.push({});if(a==='spares-remove-line'&&ed.values.lines.length>1)ed.values.lines.splice(Number(target.dataset.row),1);ed.fields={};ed.selected={};render();return;}
  if(a.startsWith('spares-option-')){
   capture();const ed=s.editor,name=target.dataset.field;if(!ed)return;
   if(a==='spares-option-open'||a==='spares-option-search'||a==='spares-option-next'||a==='spares-option-prev'){await optionLoad(name,a.endsWith('-next')?'next':a.endsWith('-prev')?'prev':'reset');return;}
   const f=ed.fields[name];if(a==='spares-option-close'){if(f)f.open=false;render();return;}
   if(a==='spares-option-clear'){setField(ed.values,name,'');if(f)f.selected=null;delete ed.selected[name];render();return;}
   if(a==='spares-option-pick'){const item=f?.data?.items.find(x=>x.id===target.dataset.id);if(!item)return;setField(ed.values,name,item.id);f.selected=item;f.open=false;ed.selected[name]=item;if(name==='deviceCode'){setField(ed.values,'workOrderId','');delete ed.fields.workOrderId;delete ed.selected.workOrderId;}render();return;}
  }
  if(a==='spares-usage'){await usageLoad(target.dataset.id,target.dataset.direction);return;}
  if(a==='spares-confirm'){if(s.pendingCommand)await send(s.pendingCommand);return;}
  if(a==='spares-save'){
   if(s.pendingCommand){s.error='请先按原请求核对尚未确认的提交。';render();return;}const form=globalThis.document?.querySelector('#spares-form');if(!form?.reportValidity())return;capture();const ed=s.editor;
   const missing=optionSpecs(ed).find(x=>x.required&&!getField(ed.values,x.name));if(missing){s.error='请搜索并选择'+missing.label;render();return;}
   const input={...ed.values,...(ed.id?{id:ed.id,expectedVersion:ed.version}:{})},signature=JSON.stringify([ed.action,input]);let requestKey=pending.get(signature);if(!requestKey){requestKey=crypto.randomUUID();pending.set(signature,requestKey);}await send({action:ed.action,input,signature,requestKey,orderId:ed.contextOrderId||''});return;
  }
  if(a==='spares-history'){s.history=emptyHistory();s.history.filters.entityId=target.dataset.id||'';s.tab='history';s.editor=null;generation++;await historyLoad();return;}
  if(a.startsWith('spares-history-')){const h=s.history||=emptyHistory();if(h.loading)return;if(a==='spares-history-apply'){h.filters={...h.filters,...readForm(target.closest('form'))};h.before='';h.stack=[];}if(a==='spares-history-clear')s.history=emptyHistory();if(a==='spares-history-older'){if(!h.data?.nextBefore)return;h.stack.push(h.before);h.before=h.data.nextBefore;}if(a==='spares-history-newer'){if(!h.stack.length)return;h.before=h.stack.pop();}await historyLoad();}
 };
 const navigate=async(tab,filters={})=>{generation++;historyGeneration++;s.tab=tab;s.selectedId='';s.editor=null;resetFilters();for(const k of ['query','supplierId','purchaseId','deviceCode','workOrderId'])if(filters[k])s[k]=filters[k];await load();};
 const epoch=()=>JSON.stringify([identity,generation,state.view,s.tab]);
 const openPurchase=async id=>{state.view='spares';s.tab='purchases';s.selectedId=id;s.editor=null;resetFilters();await load();};
 const openOrder=async id=>{const token=epoch(),data=await api('/predictive/overview');if(epoch()!==token)return;state.predictive=data;if(!data.workOrders?.some(o=>o.id===id)){notify('工单已离开当前列表，请刷新后重新查询。');return;}state.view='work-orders';await load();await insightUi.loadPlans(id);render();globalThis.document?.getElementById?.('wo-'+id)?.scrollIntoView({block:'start',behavior:'smooth'});};
 const openHistory=async id=>{state.view='spares';await handle({dataset:{action:'spares-history',id}});};
 insightUi=installSparesInsights({state,api,render,notify,epoch,failed,openEditor,navigate,openPurchase,openOrder,openHistory});
 return {load,clear,handle,capture,captureHistory,loadHistory:historyLoad,openEditor,navigate};
}
