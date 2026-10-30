import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {readSparesQuery} from '../../server/spares-query-db.ts';
import {readSparesHistoryCurrent} from '../../server/spares-history-db.ts';
import {commandSparesCurrent} from '../../server/spares-db.ts';
// Called only while verify-spares-growth owns its disposable QA DB and pool.
// There is no route that selects a customer database or accepts a user identity.
export async function previewSparePages({pool,ctx,reviewer,refs,run,supplier,warehouse}){
 const part=(await pool.query("SELECT body FROM idms_spares.entities WHERE tenant_id='qa' AND kind='part' AND body->>'code'='CAP-10001'")).rows[0].body;
 let purchase=await run('purchase.create',{supplierId:supplier.id,warehouseId:warehouse.id,dueDate:'2026-12-01',lines:[{partId:part.id,quantity:'40',unitPrice:'10'}],remark:'隔离分页演示：31次分批收货'});purchase=await run('purchase.submit',{id:purchase.id,expectedVersion:purchase.version});purchase=await run('purchase.approve',{id:purchase.id,expectedVersion:purchase.version,decision:'APPROVED',comment:'隔离演示独立审批'},reviewer);purchase=await run('purchase.order',{id:purchase.id,expectedVersion:purchase.version});
 for(let i=0;i<31;i++){await run('purchase.receive',{id:purchase.id,expectedVersion:purchase.version,lineId:purchase.lines[0].id,accepted:'1',reason:'合成分批收货 '+(i+1)});purchase=(await pool.query("SELECT body FROM idms_spares.entities WHERE tenant_id='qa' AND kind='purchase' AND id=$1",[purchase.id])).rows[0].body;}
 const parent=resolve('work/spares-ui-paging-20261030'),requests=[];let writes=0;
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1'),json=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(url.pathname.startsWith('/api/v1/spares/')){
   requests.push({path:url.pathname,query:url.search,method:req.method});if(requests.length>2000)requests.shift();const endpoint=url.pathname.slice('/api/v1/spares/'.length);
   const verify=async c=>{if((await c.query("SELECT tenant_id FROM public.business_state WHERE tenant_id='qa'")).rows.length!==1)throw Error('Synthetic proof missing');};
   if(endpoint==='commands'&&req.method==='POST'){let body='';for await(const chunk of req){body+=chunk;if(body.length>32768)throw Error('Oversized synthetic command');}const input=JSON.parse(body);const result=await commandSparesCurrent(pool,ctx,input.action,input.input,String(req.headers['idempotency-key']||''),verify);writes++;return json(result);}
   if(req.method!=='GET')throw Error('Method unsupported');if(endpoint==='history')return json(await readSparesHistoryCurrent(pool,ctx,url.searchParams,verify));if(!['summary','list','detail','options','workorder-usage'].includes(endpoint))throw Error('Unknown synthetic endpoint');
   return json(await readSparesQuery(pool,ctx,endpoint,url.searchParams,async c=>{if((await c.query("SELECT tenant_id FROM public.business_state WHERE tenant_id='qa'")).rows.length!==1)throw Error('Synthetic proof missing');}));
  }
  if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);return;}
  if(!/^\/[A-Za-z0-9_.-]+\.(js|css)$/.test(url.pathname))throw Error('Unknown asset');const name=url.pathname.slice(1),file=join(resolve('public'),name),bytes=await readFile(file);res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});res.end(bytes);
 }catch(error){res.writeHead(error.status||500,{'content-type':'application/json'});res.end(JSON.stringify({message:error.status?error.message:'合成预览暂不可用'}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,finish=join(parent,'preview-finish.json');await writeFile(join(parent,'preview-runtime.json'),JSON.stringify({base:'http://127.0.0.1:'+port,purchaseId:purchase.id,purchaseNumber:purchase.number,pid:process.pid,finish},null,2));console.log('Owned paged UI preview ready on http://127.0.0.1:'+port);
 try{const deadline=Date.now()+30*60*1000;while(Date.now()<deadline){try{const value=JSON.parse(await readFile(finish,'utf8'));if(value.port===port)break;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(r=>setTimeout(r,500));}}
 finally{await new Promise(r=>server.close(r));await writeFile(join(parent,'preview-http-verification.json'),JSON.stringify({requests,writes,customerBusinessWrites:0,syntheticProjectionOnly:true,port},null,2));}
}
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IDMS 分页隔离验证</title><link rel="stylesheet" href="/manual.css"><link rel="stylesheet" href="/workspace.css"><body><div class="manual-shell"><main style="margin:0"><header><h1>IDMS 备件与采购</h1><p>合成隔离资料 · 随机QA数据库 · 不连接企业业务库</p></header><section class="content"><div id="mode"><button data-mode="spares">备件页面</button><button data-mode="overview">工作台汇总</button><button data-mode="work-orders">工单用量</button></div><div id="app"></div></section></main></div><script type="module">
import {sparesView,installSparesUi,workOrderStockUsage} from '/spares-paged-ui.js';import {workbenchSummary} from '/roadshow-ui.js';
const state={view:'spares',actor:'clerk',spares:{tab:'parts',data:null,query:''}},root=document.querySelector('#app');
const api=async(path,options={})=>{const r=await fetch('/api/v1'+path,options),v=await r.json();if(!r.ok)throw Object.assign(Error(v.message),{status:r.status});return v;},post=(p,b,_x,key)=>api(p,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(b)});
function render(){root.innerHTML=state.view==='spares'?sparesView(state.spares,'clerk'):state.view==='overview'?workbenchSummary({spares:state.spares.data,name:'隔离演示管理员'}):workOrderStockUsage(state.spares,'QA-ORDER');}
const ui=installSparesUi({state,api,post,render,notify:()=>{}});document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.mode){state.view=b.dataset.mode;await ui.load();render();return;}if(b.dataset.action?.startsWith('spares-')){e.preventDefault();try{await ui.handle(b);}catch(error){state.spares.error=error.message;render();}}});document.addEventListener('submit',e=>{e.preventDefault();const b=e.target.querySelector('[type=submit]');if(b)ui.handle(b).catch(error=>{state.spares.error=error.message;render();});});for(const t of ['input','change'])document.addEventListener(t,e=>{if(e.target.closest('#spares-form'))ui.capture();if(e.target.closest('#spares-history-filter'))ui.captureHistory();});document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('[data-option-query]')){e.preventDefault();ui.handle({dataset:{action:'spares-option-search',field:e.target.dataset.optionQuery}});}});await ui.load();render();
</script></body></html>`;
