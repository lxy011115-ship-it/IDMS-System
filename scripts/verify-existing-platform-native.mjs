// Small, fresh owned PG + real fixed-version Java services. No enterprise service use.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,realpath,rm,open} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,delimiter} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import pg from 'pg';
import {existingIdentityCommand,assertExistingIdentityStore} from './keycloak-runtime.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {sha} from './existing-platform-binding.mjs';
import {existingIdentityContract} from './existing-identity-contract.mjs';
import {spawnExistingPostgres} from './existing-postgres-launch.mjs';

const exec=promisify(execFile),run=randomBytes(6).toString('hex'),parent=resolve('work/existing-platform-20261031'),out=join(parent,run),owned=join(out,'owned'),data=join(owned,'pgdata');
const runtime=join(process.env.LOCALAPPDATA,'IDMS/runtime'),java=join(runtime,'jdk-21/bin/java.exe'),bin=join(runtime,'pgsql/bin');
const result={run,passed:false,checks:[],enterpriseServicesStarted:0,enterpriseBusinessWrites:0,cleanup:{}},password=randomBytes(32).toString('base64url'),nonce=randomBytes(16).toString('hex'),processes=[];
let admin,pgStarted=false,pgPid;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await privateDirectory(owned);await privateNewFile(join(owned,'owner.json'),JSON.stringify({run,nonce}));
async function port(){const s=createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok);});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function snapshot(database){const c=new pg.Client({host:'127.0.0.1',port:result.pgPort,user:'idms_startup_qa',password,database});await c.connect();try{return sha(JSON.stringify((await c.query("SELECT n.nspname,c.relname,c.relkind,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS def FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' ORDER BY c.relname,a.attnum")).rows));}finally{await c.end();}}
async function connect(database){const c=new pg.Client({host:'127.0.0.1',port:result.pgPort,user:'idms_startup_qa',password,database});await c.connect();return c;}
async function terminalWithin(state,ms){let timer;try{return await Promise.race([state.terminal,new Promise(r=>{timer=setTimeout(()=>r(null),ms);})]);}finally{clearTimeout(timer);}}
async function launch(name,command,target,classpath,extraEnv={}){
 const stopFile=join(owned,name+'.stop'),args=[...command.args],index=args.indexOf('-cp');
 if(index>=0){args[index+1]=join(owned,'classes')+delimiter+classpath;args.splice(index+2,1,'OwnedStartupJvm',target);}else{const at=args.indexOf('-jar');assert(at>=0);args.splice(at,2,'-cp',join(owned,'classes')+delimiter+classpath,'OwnedStartupJvm',target);}
 args.unshift('-Didms.qa.stopFile='+stopFile,'-Didms.qa.nonce='+nonce);
 const logFile=join(owned,name+'.log'),chunks=[];let bytes=0;const child=spawn(java,args,{cwd:command.cwd,env:{...command.env,...extraEnv},windowsHide:true,stdio:['ignore','pipe','pipe']});
 const state={name,child,stopFile,exit:null,terminal:null,logFile};state.terminal=new Promise(ok=>{child.once('error',e=>{state.exit={error:e.code};ok(state.exit);});child.once('close',(code,signal)=>{state.exit={code,signal};ok(state.exit);});});
 for(const stream of[child.stdout,child.stderr])stream.on('data',b=>{bytes+=b.length;if(bytes<=2*1024**2)chunks.push(b);});
 state.flush=()=>writeFile(logFile,Buffer.concat(chunks),{mode:0o600});processes.push(state);return state;
}
async function stop(state){if(!state||state.exit)return;if(!state.stopRequested){state.stopRequested=true;await privateNewFile(state.stopFile,nonce+':'+state.child.pid);}const end=await terminalWithin(state,30000);assert(end&&end.code===0&&end.signal===null,'OWNED_JVM_NORMAL_STOP_UNCONFIRMED');await state.flush();}
async function ready(state,url,headers={}){for(let i=0;i<450;i++){if(state.exit)return false;try{const r=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(1000)});if(r.ok){await r.body?.cancel();return true;}await r.body?.cancel();}catch{}await sleep(200);}return false;}
async function rejected(state){const end=await terminalWithin(state,90000);await state.flush();assert(end&&end.code!==0&&end.signal===null,'OWNED_JVM_EXPECTED_REJECTION_UNCONFIRMED');}
try{
 result.phase='OWNED_PG';await privateNewFile(join(owned,'password'),password);
 await exec(join(bin,'initdb.exe'),['-D',data,'-U','idms_startup_qa','-A','scram-sha-256','--pwfile',join(owned,'password'),'--encoding=UTF8','--locale=C'],{windowsHide:true,timeout:30000,maxBuffer:1048576});
 result.pgPort=await port();const launcherLog=await open(join(owned,'postgres-launcher.log'),'wx');
 const ctl=spawnExistingPostgres({executable:join(bin,'pg_ctl.exe'),args:['start','-D',data,'-l',join(owned,'postgres.log'),'-w','-t','20','-o',`-h 127.0.0.1 -p ${result.pgPort} -c shared_buffers=16MB -c max_connections=30 -c max_wal_size=64MB -c min_wal_size=32MB`],cwd:owned,env:process.env},launcherLog.fd);pgStarted=true;await launcherLog.close();
 await new Promise((ok,no)=>{ctl.once('error',no);ctl.once('close',(c,s)=>c===0&&s===null?ok():no(Error('OWNED_PG_START_FAILED')));});pgPid=Number((await readFile(join(data,'postmaster.pid'),'utf8')).split(/\r?\n/)[0]);result.checks.push('ordinary pg_ctl file-descriptor handoff closes its original child and streams while the owned PostgreSQL remains independently available');
 admin=await connect('postgres');result.postgresVersion=(await admin.query('SHOW server_version')).rows[0].server_version;
 for(const db of ['idms_qa_workflow','idms_qa_identity_empty','idms_qa_identity'])await admin.query('CREATE DATABASE '+db);
 await mkdir(join(owned,'classes'));await exec(join(runtime,'jdk-21/bin/javac.exe'),['--release','21','-d',join(owned,'classes'),resolve('scripts/fixtures/OwnedStartupJvm.java')],{windowsHide:true,timeout:30000,maxBuffer:65536});
 result.phase='WORKFLOW_EMPTY';const workflowFile=join(owned,'workflow.json'),workflowPort=await port(),token=randomBytes(32).toString('base64url');
 await privateNewFile(workflowFile,JSON.stringify({tenants:{qa:{jdbcUrl:`jdbc:postgresql://127.0.0.1:${result.pgPort}/idms_qa_workflow`,user:'idms_startup_qa',password,serviceToken:token}}}));
 const jar=resolve('services/workflow/target/idms-workflow-0.1.0.jar'),workflowCommand={args:['-Xms32m','-Xmx256m','-jar',jar,'--server.address=127.0.0.1','--server.port='+workflowPort,'--server.shutdown=graceful'],env:{...process.env,IDMS_WORKFLOW_CONFIG:workflowFile,IDMS_WORKFLOW_STARTUP_MODE:'runtime',JAVA_TOOL_OPTIONS:'',JDK_JAVA_OPTIONS:'',_JAVA_OPTIONS:''},cwd:resolve('.')};
 const launchWorkflow=(name,mode)=>launch(name,workflowCommand,'org.springframework.boot.loader.launch.JarLauncher',jar,{IDMS_WORKFLOW_STARTUP_MODE:mode});
 const emptyBefore=await snapshot('idms_qa_workflow');await rejected(await launchWorkflow('workflow-empty','runtime'));assert.equal(await snapshot('idms_qa_workflow'),emptyBefore);result.checks.push('Flowable ordinary mode rejects empty schema without creating objects');
 result.phase='WORKFLOW_EXPLICIT_INITIALIZE';const initialized=await launchWorkflow('workflow-initialize','initialize'),workflowUrl=`http://127.0.0.1:${workflowPort}/v1/status`,headers={Authorization:'Bearer '+token,'X-IDMS-Tenant':'qa'};
 assert(await ready(initialized,workflowUrl,headers),'WORKFLOW_INITIALIZATION_FIXTURE_FAILED');await stop(initialized);
 const w=await connect('idms_qa_workflow');let definition;
 try{definition=(await w.query('SELECT id_,version_,deployment_id_,resource_name_ FROM act_re_procdef')).rows;assert.equal(definition.length,1);assert.equal(definition[0].version_,1);}finally{await w.end();}
 result.phase='WORKFLOW_EXISTING';const schemaBefore=await snapshot('idms_qa_workflow'),wf=await launchWorkflow('workflow-existing','runtime');assert(await ready(wf,workflowUrl,headers));const response=await(await fetch(workflowUrl,{headers})).json();assert.equal(response.startupContract,'IDMS_EXISTING_WORKFLOW_V1');assert.equal(response.startupMode,'runtime');await stop(wf);assert.equal(await snapshot('idms_qa_workflow'),schemaBefore);
 const w2=await connect('idms_qa_workflow');try{assert.deepEqual((await w2.query('SELECT id_,version_,deployment_id_,resource_name_ FROM act_re_procdef')).rows,definition);await w2.query("UPDATE act_ge_bytearray SET bytes_=$1 WHERE name_='maintenance-v1.bpmn20.xml'",[Buffer.from('<wrong/>')]);}finally{await w2.end();}
 await rejected(await launchWorkflow('workflow-resource-mismatch','runtime'));assert.equal(await snapshot('idms_qa_workflow'),schemaBefore);result.checks.push('Flowable explicit initialize is separate; ordinary mode validates existing schema and exact V1 resource, preserves definitions, rejects modified BPMN');
 result.phase='IDENTITY_EMPTY';const identityPort=await port(),managementPort=await port(),id={version:'26.8.1',origin:`http://127.0.0.1:${identityPort}`,realm:'master',database:{user:'idms_startup_qa',password,database:'idms_qa_identity_empty'}};
 const commandFor=config=>existingIdentityCommand(config,{host:'127.0.0.1',port:result.pgPort},{runtimeRoot:runtime,port:identityPort,managementPort});
 const identityClasspath=join(runtime,'keycloak-26.8.1/lib/quarkus-run.jar');
 const launchIdentity=(name,config,initialize=false)=>{const cmd=commandFor(config);if(initialize)cmd.args=cmd.args.filter(a=>!a.startsWith('--spi-connections-jpa--'));return launch(name,cmd,'io.quarkus.bootstrap.runner.QuarkusEntryPoint',identityClasspath);};
 const identityBefore=await snapshot(id.database.database),beforeProcesses=processes.length;
 await assert.rejects(assertExistingIdentityStore(id,{host:'127.0.0.1',port:result.pgPort}));assert.equal(processes.length,beforeProcesses);assert.equal(await snapshot(id.database.database),identityBefore);
 result.checks.push('ordinary identity read-only guard refuses empty store before launching Java; schema remains empty (vendor flags alone were shown insufficient in earlier owned fixture)');
 result.phase='IDENTITY_EXPLICIT_INITIALIZE';id.database.database='idms_qa_identity';const kc=await launchIdentity('identity-initialize',id,true),issuer=id.origin+'/realms/master/.well-known/openid-configuration';assert(await ready(kc,issuer),'KEYCLOAK_INITIALIZATION_FIXTURE_FAILED');await stop(kc);
 result.phase='IDENTITY_EXISTING';const contractReader=await connect(id.database.database);try{result.identityContract=await existingIdentityContract(contractReader);}finally{await contractReader.end();}
 await assertExistingIdentityStore(id,{host:'127.0.0.1',port:result.pgPort});const kcBefore=await snapshot(id.database.database),normal=await launchIdentity('identity-existing',id);assert(await ready(normal,issuer),'KEYCLOAK_EXISTING_RUNTIME_FAILED');await stop(normal);assert.equal(await snapshot(id.database.database),kcBefore);
 const c=await connect(id.database.database);try{await c.query('DELETE FROM databasechangelog WHERE orderexecuted=(SELECT max(orderexecuted) FROM databasechangelog)');
  await assert.rejects(assertExistingIdentityStore(id,{host:'127.0.0.1',port:result.pgPort}));
  await c.query("UPDATE migration_model SET version='26.7.0'");}finally{await c.end();}
 const changedBefore=await snapshot(id.database.database),priorCount=processes.length;
 await assert.rejects(assertExistingIdentityStore(id,{host:'127.0.0.1',port:result.pgPort}));assert.equal(processes.length,priorCount);
 await rejected(await launchIdentity('identity-schema-mismatch',id));assert.equal(await snapshot(id.database.database),changedBefore);result.checks.push('Keycloak 26.8.1 existing schema runs with validation; ordinary guard rejects old version before Java, vendor validate rejects pending upgrade without applying it');
 result.phase='VERIFIED';result.passed=true;
}catch(e){result.error='OWNED_STARTUP_NATIVE_QA_FAILED';result.diagnostic=String(e.message).replaceAll(password,'[redacted]').slice(0,500);process.exitCode=1;}
finally{
 try{
  for(const state of processes){await stop(state);await state.flush();}
  result.cleanup.originalJvmHandlesTerminal=processes.every(s=>s.exit&&s.exit.signal===null);assert(result.cleanup.originalJvmHandlesTerminal);
  await admin?.end();admin=null;
  if(pgStarted){const lines=(await readFile(join(data,'postmaster.pid'),'utf8')).split(/\r?\n/);assert.equal(Number(lines[0]),pgPid);assert.equal(resolve(lines[1]),resolve(data));assert.equal(Number(lines[3]),result.pgPort);assert.equal(JSON.parse(await readFile(join(owned,'owner.json'),'utf8')).nonce,nonce);await exec(join(bin,'pg_ctl.exe'),['-D',data,'-m','fast','-w','-t','20','stop'],{windowsHide:true,timeout:25000,maxBuffer:65536});for(let i=0;i<100;i++){try{process.kill(pgPid,0);await sleep(30);}catch(e){assert.equal(e.code,'ESRCH');result.cleanup.ownedPgTerminal=true;break;}}assert(result.cleanup.ownedPgTerminal);}
  const rel=relative(parent,owned);assert(!isAbsolute(rel)&&!rel.startsWith('..')&&rel===join(run,'owned'));assert.equal(await realpath(owned),owned);
  // Keep bounded private diagnostic logs, remove only the per-run fixture DB and secrets.
  for(const state of processes)await writeFile(join(out,state.name+'.private.log'),await readFile(state.logFile),{mode:0o600});
  await rm(owned,{recursive:true});result.cleanup.ownedDataAndSecretsRemoved=true;
 }catch(e){result.cleanup.error='OWNED_FIXTURE_RETAINED';result.cleanup.diagnostic=String(e.message).slice(0,300);process.exitCode=1;}
 await writeFile(join(out,'verification.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({run,passed:result.passed&&!!result.cleanup.ownedDataAndSecretsRemoved,checks:result.checks.length,phase:result.phase,cleanup:result.cleanup,evidence:out}));
