import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {filePin,verifyPin,selectRuntime} from '../scripts/existing-platform-binding.mjs';
import {acquireCoordinator,sameProcess,observeStage} from '../scripts/existing-platform-process.mjs';
import {existingIdentityCommand} from '../scripts/keycloak-runtime.mjs';
import {serviceCommand} from '../scripts/existing-platform-services.mjs';
import {openExistingSqlite,existingSqliteDefinitions} from '../services/existing-sqlite.ts';
import {EdgeSpool} from '../services/edge/spool.ts';
import {sha} from '../integrations/telemetry.ts';
import {recoveryArguments} from '../scripts/recover-edge-spool.mjs';
import {assertRecoveryWritersStopped} from '../scripts/edge-recovery-platform.mjs';
const exec=promisify(execFile),project=resolve('.');
async function fixture(t){const parent=await realpath(tmpdir()),path=await mkdtemp(join(parent,'idms-existing-'));t.after(async()=>{const rel=relative(parent,resolve(path));assert(!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('idms-existing-'));await rm(path,{recursive:true});});return path;}
test('all ordinary entries refuse absent binding before child execution or configuration creation',async t=>{
 const dir=await fixture(t),hook=join(dir,'hook.mjs'),events=join(dir,'events.jsonl');
 await writeFile(hook,`import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';import{appendFileSync}from'node:fs';for(const k of ['spawn','execFile','exec','fork','spawnSync','execFileSync'])cp[k]=()=>{appendFileSync(${JSON.stringify(events)},JSON.stringify({call:k})+'\\n');throw Error('FORBIDDEN_CHILD');};syncBuiltinESMExports();`);
 for(const name of ['start-platform.mjs','start-platform-v4.mjs','existing-platform-startup.mjs']){
  let output;try{await exec(process.execPath,['--import',pathToFileURL(hook).href,join(project,'scripts',name)],{cwd:dir,windowsHide:true});assert.fail('expected refusal');}catch(e){output=e.stdout;assert.equal(e.code,1);assert.match(e.stderr,/INPUT_MISSING_OR_INVALID/);}
  assert.match(output+''||'',/^$/); // fixed refusal is written to stderr, never a raw configuration exception.
 }
 await assert.rejects(access(events),{code:'ENOENT'});await assert.rejects(access(join(dir,'.local')),{code:'ENOENT'});
});
test('ordinary entry rejects provisioning arguments rather than forwarding them',async t=>{
 const dir=await fixture(t);try{await exec(process.execPath,[join(project,'scripts/start-platform.mjs'),'--initialize'],{cwd:dir,windowsHide:true});assert.fail();}catch(e){assert.equal(e.code,1);assert.match(e.stderr,/ORDINARY_STARTUP_ARGUMENTS_REFUSED/);}
});
test('each of 24 missing bound inputs and a wrong-purpose descriptor refuses before any native child invocation',async t=>{
 const dir=await fixture(t),local=join(dir,'.local');await mkdir(local);
 const hook=join(dir,'hook.mjs'),events=join(dir,'children'),seen=join(dir,'missing-input-observations'),descriptor=join(local,'existing-platform.json');
 await writeFile(hook,`import cp from 'node:child_process';import fsp from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';import{appendFileSync}from'node:fs';import{basename}from'node:path';const rp=fsp.realpath;fsp.realpath=async(...a)=>{if(basename(String(a[0])).startsWith('absent-'))appendFileSync(${JSON.stringify(seen)},basename(String(a[0]))+'\\n');return rp(...a);};for(const k of ['spawn','execFile','exec','fork'])cp[k]=()=>{appendFileSync(${JSON.stringify(events)},k);throw Error('UNEXPECTED_PROCESS');};syncBuiltinESMExports();`);
 const files={};for(let i=0;i<24;i++){const p=join(dir,'input-'+i);await writeFile(p,'owned-fixture-'+i);files['input'+i]=await filePin(p);}
 const binding={format:1,purpose:'EXISTING_PLATFORM_RUNTIME',project:dir,files};
 for(let i=0;i<25;i++){
  const b=structuredClone(binding);if(i<24)b.files['input'+i].path=join(dir,'absent-'+i);else b.purpose='BOOTSTRAP_CONFIG';await writeFile(descriptor,JSON.stringify(b));
  try{await exec(process.execPath,['--import',pathToFileURL(hook).href,join(project,'scripts/start-platform.mjs')],{cwd:dir,windowsHide:true});assert.fail('missing input must refuse');}catch(e){assert.equal(e.code,1);assert.match(e.stderr,/"servicesStarted":0/);}
 }
 assert.deepEqual((await readFile(seen,'utf8')).trim().split('\n'),Array.from({length:24},(_,i)=>'absent-'+i));
 await assert.rejects(access(events),{code:'ENOENT'});await assert.rejects(access(join(local,'platform-startup')),{code:'ENOENT'});
});
test('bound input modification is refused, unchanged exact bytes pass',async t=>{
 const dir=await fixture(t),file=join(dir,'input');await writeFile(file,'known-deployment');const pin=await filePin(file);await verifyPin(pin);await writeFile(file,'different-bytes');await assert.rejects(verifyPin(pin));
});
test('physical aliases deduplicate but different data clusters require explicit selection',async()=>{
 const identities={a:{data:'physical-a',device:1,inode:10,systemIdentifier:'42'},alias:{data:'physical-a',device:1,inode:10,systemIdentifier:'42'},b:{data:'physical-b',device:1,inode:11,systemIdentifier:'43'}};
 const options={canonical:async p=>p,readIdentity:async p=>identities[p]};
 assert.equal((await selectRuntime(['a','alias'],options)).runtime,'a');await assert.rejects(selectRuntime(['a','b'],options),{code:'MULTIPLE_DATABASE_DEPLOYMENTS'});
 assert.equal((await selectRuntime(['b'],options)).identity.systemIdentifier,'43');
});
test('coordinator lock distinguishes live owner, reused PID, and stale owner; only own nonce releases',async t=>{
 const dir=await fixture(t),file=join(dir,'lock'),owner={pid:process.pid,born:'first',executable:'node.exe'};
 const release=await acquireCoordinator(file,{facts:async()=>owner});await assert.rejects(acquireCoordinator(file,{facts:async()=>owner}),{code:'COORDINATOR_ALREADY_RUNNING'});
 await assert.rejects(acquireCoordinator(file,{facts:async()=>({...owner,born:'second'})}),{code:'COORDINATOR_PID_REUSED'});
 await assert.rejects(acquireCoordinator(file,{facts:async()=>null}),{code:'COORDINATOR_STALE_REVIEW'});await release();await assert.rejects(access(file),{code:'ENOENT'});
 assert.equal(sameProcess(owner,{...owner,born:'second'}),false);
});
test('stage observation preserves late readiness, live timeout and original exit without launching or stopping another process',async()=>{
 let time=0,probes=0;
 const late=await observeStage({probe:async()=>{probes++;time=120;return true;},alive:async()=>true,budgetMs:100,now:()=>time,wait:async ms=>{time+=ms;}});assert.equal(late.status,'LATE_READY');assert.equal(probes,1);
 time=0;probes=0;const unknown=await observeStage({probe:async()=>{probes++;return false;},alive:async()=>true,budgetMs:100,delayMs:30,now:()=>time,wait:async ms=>{time+=ms;}});assert.equal(unknown.status,'UNCONFIRMED');assert.equal(time,100);
 const exit=await observeStage({probe:async()=>assert.fail(),alive:async()=>false});assert.equal(exit.status,'EXITED');
});
test('identity runtime command pins validation, disables empty initialization, index creation and bootstrap inheritance',()=>{
 const c=existingIdentityCommand({version:'26.8.1',origin:'http://127.0.0.1:8081',database:{database:'qa',user:'qa',password:'x'}},{host:'127.0.0.1',port:1234},{runtimeRoot:resolve('runtime')});
 assert(c.args.includes('--optimized'));assert(c.args.includes('--spi-connections-jpa--quarkus--migration-strategy=validate'));assert(c.args.includes('--spi-connections-jpa--quarkus--initialize-empty=false'));assert(c.args.includes('--spi-connections-jpa--quarkus--auto-create-missing-indexes=false'));assert(!Object.keys(c.env).some(k=>k.startsWith('KC_BOOTSTRAP_')));assert(!c.args.includes('--import-realm'));
});
test('existing spool preserves schema and source; missing, wrong and changed mappings refuse without repair',async t=>{
 const dir=await fixture(t),file=join(dir,'edge.sqlite'),source={tenantId:'qa',edgeId:'qa-edge',deviceCode:'qa-device',mapVersion:'qa-v1',signingKey:randomBytes(32).toString('base64url')};
 const db=new DatabaseSync(file);for(const sql of Object.values(existingSqliteDefinitions.edge))db.exec(sql);db.prepare('INSERT INTO metadata VALUES(?,?)').run('sequence','0');db.prepare('INSERT INTO metadata VALUES(?,?)').run('source',sha({tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion}));db.close();
 const opened=openExistingSqlite(file,'edge',source,{readOnly:true}),before=opened.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();opened.close();
 const spool=new EdgeSpool(file,source,10,{existingOnly:true});assert.equal(spool.stats().pending,0);spool.close();
 const after=new DatabaseSync(file,{readOnly:true});assert.deepEqual(after.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(),before);after.close();
 assert.throws(()=>openExistingSqlite(file,'edge',{...source,mapVersion:'changed'}));assert.throws(()=>openExistingSqlite(join(dir,'absent.sqlite'),'edge',source));await assert.rejects(access(join(dir,'absent.sqlite')),{code:'ENOENT'});
});
test('actual AI existing-only entry rejects absent store without creating directory or database',async t=>{
 const dir=await fixture(t),config=join(dir,'ai.json'),data=join(dir,'data');await writeFile(config,JSON.stringify({modelUrl:'http://127.0.0.1:11435',model:{name:'qwen3:4b',digest:'sha256:'+'a'.repeat(64)},dataDirectory:data,tenants:{qa:{serviceToken:'x'.repeat(40)}}}));
 try{await exec(process.execPath,[join(project,'services/ai-gateway/index.ts')],{cwd:dir,env:{...process.env,IDMS_AI_GATEWAY_CONFIG:config,IDMS_EXISTING_ONLY:'1'},windowsHide:true});assert.fail();}catch(e){assert.equal(e.code,1);}
 await assert.rejects(access(data),{code:'ENOENT'});
});
test('recovery CLI rejects arbitrary paths, extra actions and missing/invalid operation identity',()=>{
 for(const args of [[],['--apply'],['--plan','--apply'],['--status','../outside'],['--export','C:/private'],['--plan','--password','secret']])assert.throws(()=>recoveryArguments(args));
 assert.deepEqual(recoveryArguments(['--inspect']),{action:'--inspect'});assert.deepEqual(recoveryArguments(['--prepare-database']),{action:'--prepare-database'});const id=randomUUID();assert.deepEqual(recoveryArguments(['--status',id]),{action:'--status',operationId:id});
});
test('recovery writer gate requires all identities terminal and all actual endpoints absent',async()=>{
 const platform={latest:{services:Object.fromEntries(['main','edge','simulator'].map((name,i)=>[name,{process:{pid:100+i,born:'2026-11-01T00:00:00Z',executable:'node.exe'}}]))}},seen=[];
 const result=await assertRecoveryWritersStopped(platform,{facts:async id=>{seen.push(id);return null;},portOccupied:async()=>false});assert.equal(result.length,3);assert.deepEqual(seen,[100,101,102]);assert(result.every(r=>r.terminalObserved));
 await assert.rejects(assertRecoveryWritersStopped(platform,{facts:async id=>({pid:id,born:'2026-11-01T00:00:00Z',executable:'node.exe'}),portOccupied:async()=>false}),{code:'RECOVERY_WRITER_STILL_LIVE'});
 await assert.rejects(assertRecoveryWritersStopped(platform,{facts:async id=>({pid:id,born:'different',executable:'node.exe'}),portOccupied:async()=>false}),{code:'RECOVERY_WRITER_PID_REUSED'});
 await assert.rejects(assertRecoveryWritersStopped(platform,{facts:async()=>null,portOccupied:async port=>port===4014}),{code:'RECOVERY_WRITER_ENDPOINT_OCCUPIED'});
 await assert.rejects(assertRecoveryWritersStopped({latest:{}},{facts:async()=>null,portOccupied:async()=>false}),{code:'RECOVERY_WRITER_PROVENANCE_REQUIRED'});
});
