import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {spawn} from 'node:child_process';
import {runtimeDependencyTasks} from '../server/runtime-adapters.ts';
import {MemoryAuthStore} from '../server/auth-state.ts';
import {runtimeResources} from '../server/runtime-resources.ts';
import {RuntimeReadiness,readinessComponents} from '../server/runtime-readiness.ts';
import {runtimeStatusRoutes} from '../server/runtime-status-route.ts';
import {inspectionTasks} from '../scripts/runtime-inspection-tasks.mjs';
import {validateProfile} from '../scripts/runtime-inspection-input.mjs';
const send=(res,data)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));};
const ctx=()=>({signal:new AbortController().signal,deadline:performance.now()+3000,timeoutMs:500});
async function server(handler,run){const s=createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));try{return await run('http://127.0.0.1:'+s.address().port);}finally{s.closeAllConnections();await new Promise(r=>s.close(r));}}

test('running client adapters reject wrong issuers, workflow contracts and model binding without writes',async()=>{
 const token=randomBytes(32).toString('base64url'),workflowToken=randomBytes(32).toString('base64url');let state='healthy',writes=0,base;
 await server((req,res)=>{
  if(req.method!=='GET')writes++;
  if(req.url.includes('openid-configuration'))return send(res,{issuer:state==='issuer'?'wrong':base+'/realms/qa'});
  assert(['Bearer '+token,'Bearer '+workflowToken].includes(req.headers.authorization));assert.equal(req.headers['x-idms-tenant'],'qa');
  send(res,req.headers.authorization==='Bearer '+workflowToken?{engine:'Flowable',version:state==='workflow'?'wrong':'7.2.0',definitionId:'qa-definition'}
   :{service:'IDMS_AI_GATEWAY',mode:'SHADOW',modelReady:state!=='model',model:{name:'qa-model',digest:'sha256:'+'a'.repeat(64)}});
 },async url=>{base=url;const d={databases:[{tenantId:'qa',pool:{}}],authConfig:{mode:'oidc',issuer:base+'/realms/qa'},authState:new MemoryAuthStore(),workflow:{config:{baseUrl:base,tenants:{qa:{serviceToken:workflowToken}}}},ai:{config:{baseUrl:base+'/',model:{name:'qa-model',digest:'sha256:'+'a'.repeat(64)},tenants:{qa:{serviceToken:token}}}},telemetry:{connected:false,subscribed:false,closing:false}};
  const tasks=runtimeDependencyTasks(d);assert.equal((await tasks.identity(ctx())).status,'PASS');state='issuer';await assert.rejects(tasks.identity(ctx()),e=>e.code==='ISSUER_MISMATCH');state='healthy';assert.equal((await tasks.workflow(ctx())).status,'PASS');state='workflow';await assert.rejects(tasks.workflow(ctx()),e=>e.code==='WORKFLOW_CONTRACT_MISMATCH');state='healthy';assert.equal((await tasks.ai(ctx())).status,'PASS');state='model';await assert.rejects(tasks.ai(ctx()),e=>e.code==='AI_CONTRACT_MISMATCH');
  d.ai.config.model.digest='sha256:'+'b'.repeat(64);state='healthy';const changed=runtimeDependencyTasks(d);await assert.rejects(changed.ai(ctx()),e=>e.code==='AI_CONTRACT_MISMATCH');assert.equal(writes,0);
 });
});

test('local MQTT subscription, edge buffer and sample states are independent evidence',async()=>{
 const key=randomBytes(32).toString('base64url');let requests=0,state={edgeId:'qa-edge',tenantId:'qa',origin:'SIMULATOR',mode:'READ_ONLY_POLL',pending:0,rejected:0,acknowledged:4,mqttConnected:true,opcConnected:true,lastSample:new Date().toISOString(),lastError:null};
 await server((req,res)=>{requests++;assert.equal(req.headers.authorization,'Bearer '+key);send(res,state);},async base=>{
  const telemetry={connected:true,subscribed:false,closing:false,config:{edge:{capacity:10},sources:[{edgeId:'qa-edge',tenantId:'qa',origin:'SIMULATOR',statusUrl:base+'/status',statusKey:key}]}};
  const tasks=runtimeDependencyTasks({databases:[{tenantId:'qa',pool:{}}],authConfig:{mode:'demo'},authState:new MemoryAuthStore(),workflow:{},ai:{},telemetry});
  await assert.rejects(tasks.telemetry(ctx()),e=>e.code==='TELEMETRY_CONNECTION_FAILED');assert.equal(requests,0);telemetry.subscribed=true;assert.equal((await tasks.telemetry(ctx())).status,'PASS');
  state={...state,pending:10};await assert.rejects(tasks.telemetry(ctx()),e=>e.code==='TELEMETRY_BUFFER_FULL');state={...state,pending:0,lastSample:null};await assert.rejects(tasks.telemetry(ctx()),e=>e.code==='TELEMETRY_SAMPLE_UNCONFIRMED');
  state={...state,lastSample:new Date().toISOString()};telemetry.connected=false;await assert.rejects(tasks.telemetry(ctx()),e=>e.code==='TELEMETRY_CONNECTION_FAILED');
 });
});

test('duplicate maintenance Authorization is refused on an actual HTTP connection',async()=>{
 const token=randomBytes(32).toString('base64url');const tasks=Object.fromEntries(readinessComponents.map(k=>[k,async()=>({status:'PASS',code:'CHECK_PASSED',evidence:'QA'})]));
 const m=new RuntimeReadiness(null,tasks),route=runtimeStatusRoutes(m,()=>runtimeResources([]),token);
 await server((req,res)=>route(req,res,new URL(req.url,'http://127.0.0.1')),async base=>{
  const status=await new Promise((ok,no)=>{const r=request(base+'/api/v1/runtime/status',{headers:{Authorization:['Bearer '+token,'Bearer '+token]}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});r.on('error',no);r.end();});assert.equal(status,401);
 });await m.close();
});

test('actual CLI reads the other process resource contract and keeps old tokenless profiles explicit',async()=>{
 const parent=resolve('work/runtime-resource-tests');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'owned-')),token=randomBytes(32).toString('base64url');let measured;
 try {
  await writeFile(join(root,'token'),token);const p=JSON.parse(await readFile('infra/runtime-inspection.example.json','utf8'));p.required=['core'];p.resources.tokenFile=join(root,'token');for(const c of ['business','workflow','ai','telemetry'])p[c].config=join(root,'missing');p.sessions.config=null;p.identity.config=null;
  await server((req,res)=>{
   if(req.url==='/api/v1/health')return send(res,{status:'UP',version:'0.1.0',authentication:'oidc',storage:'postgres-tenant-databases',sessionStorage:'POSTGRES_ENCRYPTED'});
   if(req.url==='/api/v1/runtime/status'){assert.equal(req.headers.authorization,'Bearer '+token);measured=runtimeResources([]);return send(res,{format:1,productionApproved:false,resourceCode:'CHECK_PASSED',resources:{...measured,arbitrarySecret:token}});}
   send(res,{});
  },async base=>{
   for(const c of ['core','workflow','ai','predictor','model'])p[c].url=base;p.identity.issuer=base+'/realms/qa';const profile=join(root,'profile.json'),output=join(root,'report');await writeFile(profile,JSON.stringify(p));
   const child=await new Promise((ok,no)=>{const c=spawn(process.execPath,['scripts/inspect-platform.mjs','--profile',profile,'--output',output,'--json'],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',no);c.on('close',code=>ok({code,out,err}));});
   assert.equal(child.code,0,child.err);const row=JSON.parse(child.out).rows.find(x=>x.component==='resources');assert.equal(row.status,'PASS');assert.equal(row.data.memory.rss,measured.memory.rss);assert.equal(row.data.operatingSystemCapacityVerified,false);assert.equal(row.data.arbitrarySecret,undefined);assert(!child.out.includes(token));
   const old=structuredClone(p);delete old.resources;const legacy=await inspectionTasks(root,validateProfile(old)).resources(ctx());assert.equal(legacy.status,'NOT_CONFIGURED');assert.equal(legacy.code,'LIVE_BUDGET_UNAVAILABLE');
  });
 }finally{const r=relative(parent,root);assert(r.startsWith('owned-')&&!r.startsWith('..')&&!isAbsolute(r));await rm(root,{recursive:true,force:true});}
});
