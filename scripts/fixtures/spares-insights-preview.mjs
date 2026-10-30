import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {readSparesQuery} from '../../server/spares-query-db.ts';
import {readSparesHistoryCurrent} from '../../server/spares-history-db.ts';
import {commandSparesCurrent} from '../../server/spares-db.ts';
export async function previewInsights(f,{preview=false,interruptPlanReply=false}={}){
 const requests=[],writes=[],screenshots=[];let port,interrupted=false;
 const roles={manager:{...f.ctx,actorId:'manager'},repairer:{...f.ctx,actorId:'clerk',roles:['maintenance-engineer'],scope:{sites:['F1'],lines:['L1'],devices:['*'],provided:true}},auditor:{...f.ctx,actorId:'auditor',roles:['auditor']}};
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1'),json=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
  if(req.headers.host!=='127.0.0.1:'+port)throw Object.assign(Error('Owned preview host required'),{status:403});
  if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:'+port)throw Object.assign(Error('Owned preview origin required'),{status:403});
  if(url.pathname==='/qa/screenshot'&&req.method==='POST'){
   if(req.headers['content-type']?.split(';')[0]!=='application/json')throw Object.assign(Error('JSON required'),{status:415});let body='';for await(const chunk of req){body+=chunk;if(body.length>4*1024*1024)throw Object.assign(Error('Screenshot exceeds QA budget'),{status:413});}
   const input=JSON.parse(body);if(!/^[a-z0-9-]{1,60}$/.test(input.name||'')||typeof input.jpegBase64!=='string'||! /^[A-Za-z0-9+/]+={0,2}$/.test(input.jpegBase64))throw Object.assign(Error('Invalid screenshot payload'),{status:400});
   const bytes=Buffer.from(input.jpegBase64,'base64');if(bytes.length>3*1024*1024||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)throw Object.assign(Error('Original JPEG capture required'),{status:400});
   const outputRoot=resolve('outputs'),parent=join(outputRoot,'企业交付优化_20261030'),directory=join(parent,'用料洞察_'+f.run);for(const path of [outputRoot,parent,directory]){await mkdir(path,{recursive:true});if((await lstat(path)).isSymbolicLink())throw Object.assign(Error('Linked artifact directory refused'),{status:400});}
   const file=join(directory,input.name+'.jpg'),sha256=createHash('sha256').update(bytes).digest('hex');try{await writeFile(file,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||createHash('sha256').update(await readFile(file)).digest('hex')!==sha256)throw Object.assign(Error('Screenshot name is already in use'),{status:409});}
   screenshots.push({file,bytes:bytes.length,sha256});return json(200,{file,bytes:bytes.length,sha256});
  }
  const role=req.headers['x-idms-qa-role']||'manager',ctx=roles[role];if(!ctx)throw Object.assign(Error('Unknown QA role'),{status:400});
  if(url.pathname==='/api/v1/predictive/overview'&&req.method==='GET')return json(200,{workOrders:(await f.pool.query("SELECT body FROM public.business_work_orders WHERE tenant_id='qa' ORDER BY id")).rows.map(r=>r.body)});
  if(url.pathname.startsWith('/api/v1/spares/')){
   requests.push({path:url.pathname,query:url.search,method:req.method,role});if(requests.length>2000)requests.shift();const endpoint=url.pathname.slice('/api/v1/spares/'.length);
   if(endpoint==='commands'&&req.method==='POST'){
    if(req.headers['content-type']?.split(';')[0]!=='application/json')throw Object.assign(Error('JSON required'),{status:415});let body='';for await(const chunk of req){body+=chunk;if(body.length>32768)throw Object.assign(Error('QA request too large'),{status:413});}
    const input=JSON.parse(body),key=String(req.headers['idempotency-key']||'');f.metrics.requests++;const result=await commandSparesCurrent(f.tracked,ctx,input.action,input.input,key,f.proof);
    writes.push({action:input.action,keySha256:createHash('sha256').update(key).digest('hex'),resultId:result.id,role});
    if(interruptPlanReply&&!interrupted&&input.action.startsWith('material-plan.')){interrupted=true;return json(503,{code:'SPARES_COMMIT_UNKNOWN',message:'隔离验证：回执传递中断，请按原请求核对'});}
    return json(200,result);
   }
   if(req.method!=='GET')throw Object.assign(Error('GET required'),{status:405});
   if(endpoint==='history'){f.metrics.requests++;return json(200,await readSparesHistoryCurrent(f.tracked,ctx,url.searchParams,f.proof));}
   if(!['summary','list','detail','options','workorder-usage','material-plans','stock-insight','replacement-insight'].includes(endpoint))throw Object.assign(Error('Unknown QA endpoint'),{status:404});
   f.metrics.requests++;return json(200,await readSparesQuery(f.tracked,ctx,endpoint,url.searchParams,f.proof));
  }
  if(url.pathname==='/'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(await readFile(new URL('./spares-insights-preview.html',import.meta.url),'utf8'));return;}
  if(!['GET','HEAD'].includes(req.method)||!/^\/[A-Za-z0-9_.-]+\.(js|css)$/.test(url.pathname))throw Object.assign(Error('Unknown QA asset'),{status:404});
  const name=url.pathname.slice(1),bytes=await readFile(join(resolve(name==='styles.css'?'src':'public'),name));res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);
 }catch(error){res.writeHead(error.status||500,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({message:error.status?error.message:'隔离预览暂不可用'}));}});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));port=server.address().port;const base='http://127.0.0.1:'+port,finish=join(f.out,'preview-finish.json');
 await writeFile(join(f.out,'preview-runtime.json'),JSON.stringify({run:f.run,base,port,pid:process.pid,finish,syntheticPublicProjection:true,customerDatabasesAllowed:false,interruptPlanReply},null,2)+'\n');
 try{
  const response=await fetch(base+'/api/v1/spares/summary');if(!response.ok||(await response.json()).features?.insights!==true)throw Error('Owned HTTP preview capability missing');
  const denied=await fetch(base+'/api/v1/spares/commands',{method:'POST',headers:{'content-type':'application/json','x-idms-qa-role':'auditor','idempotency-key':'qa-readonly-denied-'+f.run},body:JSON.stringify({action:'material-plan.create',input:{}})});if(denied.status!==403)throw Error('Readonly QA role unexpectedly accepted a write');await denied.body?.cancel();
  console.log(JSON.stringify({run:f.run,previewReady:base,pid:process.pid,finish}));
  if(preview){const until=Date.now()+20*60*1000;while(Date.now()<until){try{const done=JSON.parse(await readFile(finish,'utf8'));if(done.run===f.run&&done.port===port)break;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(ok=>setTimeout(ok,500));}}
 }finally{
  server.closeIdleConnections();await new Promise(ok=>server.close(ok));const unique=new Set(writes.map(w=>w.role+':'+w.keySha256));
  await writeFile(join(f.out,'preview-http-verification.json'),JSON.stringify({run:f.run,port,requests,writes,screenshots,writeAttempts:writes.length,uniquePostedKeys:unique.size,interrupted,syntheticPublicProjection:true,customerBusinessWrites:0},null,2)+'\n');
 }
 return {port,interrupted,writeAttempts:writes.length};
}
