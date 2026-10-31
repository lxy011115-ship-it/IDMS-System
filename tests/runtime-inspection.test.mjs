import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,unlink,truncate} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {httpJson} from '../scripts/runtime-inspection-probes.mjs';
import {components,InspectionError,privateJson,validateProfile,boundedFile} from '../scripts/runtime-inspection-input.mjs';
import {runInspection,reportText} from '../scripts/runtime-inspection-report.mjs';
import {inspectBackups} from '../scripts/runtime-inspection-backups.mjs';
import {inspectionTasks} from '../scripts/runtime-inspection-tasks.mjs';
import {sealBackup} from '../scripts/backup-support.mjs';

const defaultProfile=()=>readFile(new URL('../infra/runtime-inspection.example.json',import.meta.url),'utf8').then(JSON.parse);
async function fixture(fn){const parent=resolve('work/runtime-inspection-tests');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'owned-'));try{return await fn(root);}finally{const r=relative(parent,root);if(!r.startsWith('owned-')||r.startsWith('..')||isAbsolute(r))throw Error('Unsafe owned test cleanup');await rm(root,{recursive:true,force:true});}}
async function server(fn,run){const s=createServer(fn);await new Promise(r=>s.listen(0,'127.0.0.1',r));try{return await run('http://127.0.0.1:'+s.address().port,s);}finally{s.closeAllConnections();await new Promise(r=>s.close(r));}}
const response=(res,data)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));};

test('HTTP probes refuse wrong responses, cross-origin redirects and over-limit streams without forwarding credentials',async()=>{
 const secret=randomBytes(32).toString('base64url');let forwarded=0;
 await server((req,res)=>{forwarded++;response(res,{secret});},async target=>server((req,res)=>{
  if(req.url==='/redirect'){res.writeHead(302,{location:target});res.end();}else if(req.url==='/large'){res.writeHead(200,{'content-length':'1000000'});res.end('x');}else if(req.url==='/stream'){res.writeHead(200);res.end('x'.repeat(70000));}else if(req.url==='/bad'){res.writeHead(500);res.end(secret);}else response(res,{status:'UP'});
 },async base=>{assert.deepEqual(await httpJson(base+'/good'),{status:'UP'});for(const [path,code]of [['redirect','HTTP_UNAVAILABLE'],['large','HTTP_BODY_LIMIT'],['stream','HTTP_BODY_LIMIT'],['bad','HTTP_STATUS_FAILED']])await assert.rejects(httpJson(base+'/'+path,{headers:{Authorization:'Bearer '+secret}}),e=>e.code===code&&!e.message.includes(secret));assert.equal(forwarded,0);}));
});
test('streaming HTTP deadlines settle the original request and never return late success',async()=>{
 let closed;const ended=new Promise(r=>closed=r);
 await server((req,res)=>{req.on('close',closed);res.writeHead(200);res.write('{');},async base=>{await assert.rejects(httpJson(base,{timeoutMs:70}),e=>e.code==='OBSERVATION_TIMEOUT'&&e.status==='UNKNOWN');await ended;});
});
test('configuration rejects unknown components and non-loopback credential destinations; linked files are not read',async()=>fixture(async root=>{
 const p=await defaultProfile();assert.throws(()=>validateProfile({...p,required:['core','made-up']}));assert.throws(()=>validateProfile({...p,core:{...p.core,url:'http://example.com'}}));assert.throws(()=>validateProfile({...p,core:{...p.core,url:'http://name:secret@127.0.0.1'}}));
 const target=join(root,'private.json'),link=join(root,'alias.json');await writeFile(target,JSON.stringify({password:randomBytes(30).toString('base64url')}));await symlink(target,link,'file');try{await assert.rejects(privateJson(link),e=>e.code==='LINKED_INPUT_REFUSED');}finally{await unlink(link);}await assert.rejects(boundedFile(target,2),e=>e.code==='INPUT_SIZE_OR_TYPE');await writeFile(target,'\uFEFF'+JSON.stringify({format:1}));assert.equal((await privateJson(target)).value.format,1);
}));
test('scheduler caps concurrency, keeps optional unknown visible and sanitizes raw errors',async()=>{
 const p=validateProfile(await defaultProfile());p.required=['core'];let active=0,peak=0;const secret=randomBytes(30).toString('base64url');
 const tasks=Object.fromEntries(components.map(id=>[id,async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;if(id==='disk')throw Error('postgres://'+secret);return {status:'PASS',code:'CHECK_PASSED',evidence:'TEST_EVIDENCE'};}]));
 const r=await runInspection(tasks,p);assert.equal(peak,2);assert.equal(r.overall,'PASS');assert.equal(r.attentionItems,1);assert.equal(r.rows.find(x=>x.component==='disk').status,'UNKNOWN');assert(!JSON.stringify(r).includes(secret));assert(!reportText(r).includes('postgres://'));assert.equal(r.productionAcceptance,false);p.required=['core','disk'];assert.equal((await runInspection(tasks,p)).overall,'UNKNOWN');
});
test('observation expiry awaits real task cleanup and does not launch remaining work or substitute a restart',async()=>{
 const p=validateProfile(await defaultProfile());p.budgetMs=100;p.required=['core'];let started=0,settled=0;
 const tasks=Object.fromEntries(components.map(id=>[id,async({signal})=>{started++;await new Promise(r=>{signal.addEventListener('abort',()=>setTimeout(r,100),{once:true});});settled++;return {status:'PASS',code:'CHECK_PASSED',evidence:'LATE'};}]));
 const at=performance.now(),r=await runInspection(tasks,p);assert.equal(started,2);assert.equal(settled,2);assert(performance.now()-at>=180);assert.equal(r.allStartedTasksSettled,true);assert(r.observationTimeoutAt);assert.equal(r.overall,'UNKNOWN');assert.equal(r.rows[0].status,'UNKNOWN');assert.equal(r.rows[2].code,'PROBE_NOT_STARTED');
});

async function backupFixture(root){const key={keyId:randomUUID(),bytes:randomBytes(32)},directory=join(root,'archives'),keyFile=join(root,'key.json');await mkdir(directory);await writeFile(keyFile,JSON.stringify({format:1,keyId:key.keyId,key:key.bytes.toString('base64')}));const business={tenants:{acme:{database:'qa_acme'}}},profile={directories:['archives'],keyFile:'key.json',maxAgeHours:24};
 async function archive({tenantId='acme',sourceDatabase='qa_acme',createdAt=new Date().toISOString()}={},file){const dump=Buffer.from('PGDMP-SYNTHETIC-ARCHIVE-AUTHENTICATION-TEST-ONLY'),manifest={format:2,backupId:randomUUID(),tenantId,createdAt,sourceDatabase,pgVersion:'160009',schemaVersion:2,scope:'TENANT_BUSINESS_DATABASE',recoveryMode:'ISOLATED_BUSINESS_ONLY',excluded:['identity-database'],facts:[],checks:{auditEvents:0,batches:0,businessDigest:'0'.repeat(64),importsDigest:'0'.repeat(64),records:0,workOrders:0},spares:{available:false},dumpSha256:createHash('sha256').update(dump).digest('hex')};const bytes=sealBackup(manifest,dump,key),path=file||join(directory,'acme-'+randomUUID()+'.idmsbackup');await writeFile(path,bytes);return path;}
 return {directory,keyFile,business,profile,archive};
}
test('backup existence, authentication, age policy and restore are separate evidence',async()=>fixture(async root=>{
 const f=await backupFixture(root);await f.archive();const existence=await inspectBackups(root,{...f.profile,keyFile:'missing-key'},f.business);assert.equal(existence.status,'UNKNOWN');assert.equal(existence.code,'ARCHIVES_NOT_AUTHENTICATED');
 const verified=await inspectBackups(root,f.profile,f.business,{verify:true});assert.equal(verified.status,'PASS');assert.equal(verified.data.authenticatedCount,1);assert.equal(verified.data.restorePerformed,false);
 const noAge=await inspectBackups(root,{...f.profile,maxAgeHours:null},f.business,{verify:true});assert.equal(noAge.status,'UNKNOWN');assert.equal(noAge.code,'BACKUP_AGE_POLICY_UNSET');
 await rm(f.directory,{recursive:true});await mkdir(f.directory);await f.archive({createdAt:new Date(Date.now()-48*3600000).toISOString()});assert.equal((await inspectBackups(root,f.profile,f.business,{verify:true})).code,'BACKUP_STALE');
}));
test('a corrupt newer candidate, wrong source or cross-tenant archive cannot fall back to an older valid backup',async()=>fixture(async root=>{
 const f=await backupFixture(root);await f.archive({createdAt:new Date(Date.now()-60000).toISOString()});const bad=await f.archive(),bytes=await readFile(bad);bytes[bytes.length-1]^=1;await writeFile(bad,bytes);
 await assert.rejects(inspectBackups(root,f.profile,f.business,{verify:true}),e=>e.code==='ARCHIVE_AUTHENTICATION_FAILED');await rm(bad);
 const crossed=await f.archive({tenantId:'sandbox'});await assert.rejects(inspectBackups(root,f.profile,f.business,{verify:true}),e=>e.code==='ARCHIVE_AUTHENTICATION_FAILED');await rm(crossed);
 await f.archive({sourceDatabase:'other_source'});await assert.rejects(inspectBackups(root,f.profile,f.business,{verify:true}),e=>e.code==='ARCHIVE_SOURCE_MISMATCH');
}));
test('scan exhaustion is incomplete before key access, and oversized archives are rejected before decryption',async()=>fixture(async root=>{
 const f=await backupFixture(root);for(let i=0;i<33;i++)await writeFile(join(f.directory,'acme-'+randomUUID()+'.idmsbackup'),'not-an-archive');await rm(f.keyFile);
 await assert.rejects(inspectBackups(root,f.profile,f.business,{verify:true}),e=>e.code==='ARCHIVE_SCAN_INCOMPLETE'&&e.status==='UNKNOWN');await rm(f.directory,{recursive:true});await mkdir(f.directory);const huge=join(f.directory,'acme-'+randomUUID()+'.idmsbackup');await writeFile(huge,'');await truncate(huge,129*1024*1024);await writeFile(f.keyFile,JSON.stringify({format:1,keyId:randomUUID(),key:randomBytes(32).toString('base64')}));
 await assert.rejects(inspectBackups(root,f.profile,f.business,{verify:true}),e=>e.code==='INPUT_SIZE_OR_TYPE');
}));
test('actual CLI writes private reports, keeps missing optional inputs visible and refuses existing outputs',async()=>fixture(async root=>{
 const p=await defaultProfile();p.required=['core'];p.budgetMs=2000;p.httpMs=200;p.business.config=join(root,'not-provisioned');p.sessions.config=null;p.identity.config=null;p.workflow.config=join(root,'not-provisioned');p.ai.config=join(root,'not-provisioned');p.telemetry.config=join(root,'not-provisioned');p.backups.directories=[join(root,'not-provisioned')];
 let requests=0;await server((req,res)=>{requests++;return req.url==='/api/v1/health'?response(res,{status:'UP',version:'0.1.0',authentication:'oidc',storage:'postgres-tenant-databases',sessionStorage:'POSTGRES_ENCRYPTED'}):response(res,{issuer:'wrong-issuer'});},async base=>{
  p.core.url=base;p.identity.issuer=base+'/realms/test';p.predictor.url=base;p.model.url=base;p.workflow.url=base;p.ai.url=base;const input=join(root,'profile.json'),output=join(root,'report');await writeFile(input,JSON.stringify(p));
  async function run(){return new Promise((done,reject)=>{const c=spawn(process.execPath,['scripts/inspect-platform.mjs','--profile',input,'--output',output,'--json'],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('exit',code=>done({code,out,err}));});}
  const first=await run();assert.equal(first.code,0,first.err);const r=JSON.parse(first.out);assert.equal(r.rows.find(x=>x.component==='identity').code,'ISSUER_MISMATCH');assert.equal(r.rows.find(x=>x.component==='business').status,'NOT_CONFIGURED');assert.equal(r.rows.length,13);assert.equal(r.productionAcceptance,false);const bytes=await readFile(join(output,'report.json'));assert(!first.out.includes(root));const requestsBeforeRepeat=requests;const repeated=await run();assert.equal(repeated.code,3);assert.equal(requests,requestsBeforeRepeat);assert(!repeated.err.includes(root));assert.deepEqual(await readFile(join(output,'report.json')),bytes);
 });
}));


test('connected MQTT does not hide a full collection spool, while safe queue counts remain visible',async()=>fixture(async root=>{
 const secret=randomBytes(32).toString('base64url');
 let state={edgeId:'qa-edge',tenantId:'qa',origin:'SIMULATOR',mode:'READ_ONLY_POLL',mqttConnected:true,opcConnected:true,lastSample:null,lastError:'SPOOL_CAPACITY_REACHED',pending:10,rejected:0,acknowledged:0};
 await server((req,res)=>{assert.equal(req.headers.authorization,'Bearer '+secret);response(res,state);},async base=>{
  const p=validateProfile(await defaultProfile());p.telemetry={config:'telemetry.json',statusOrigins:[base]};
  await writeFile(join(root,'telemetry.json'),JSON.stringify({sources:[{edgeId:'qa-edge',tenantId:'qa',origin:'SIMULATOR',statusKey:secret,statusUrl:base+'/status'}],edge:{capacity:10}}));
  const task=inspectionTasks(root,p).telemetry,ctx={signal:new AbortController().signal,deadline:performance.now()+5000};
  const full=await task(ctx);assert.equal(full.status,'FAIL');assert.equal(full.code,'TELEMETRY_BUFFER_FULL');assert.equal(full.data.queues[0].pending,10);assert(!JSON.stringify(full).includes(secret));
  state={...state,lastError:null,pending:7,rejected:3,lastSample:new Date().toISOString()};assert.equal((await task(ctx)).code,'TELEMETRY_BUFFER_FULL');
  state={...state,pending:0,rejected:0,acknowledged:10};assert.equal((await task(ctx)).status,'PASS');
  state={...state,mqttConnected:false};await assert.rejects(task(ctx),e=>e.code==='TELEMETRY_CONNECTION_FAILED');
  state={...state,mqttConnected:true,pending:-1};await assert.rejects(task(ctx),e=>e.code==='TELEMETRY_CONTRACT_MISMATCH');
 });
}));
