import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

assert.equal(process.argv.length,4,'FIELD_DATA_PATH_EXPLICIT_TOOLING_REQUIRED');
const root=resolve('.'),nonce=randomBytes(6).toString('hex'),work=resolve('work/field-owned-data-path-v1-20261024',nonce);
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const report={format:'IDMS_FIELD_OWNED_DATA_PATH_NATIVE_V1',nonce,checks:[],passed:false,cleanupComplete:false,originalDatabaseContacted:false,allProductionDependenciesRegistered:false};
let cluster,admin,worker,workerTerminal,workerProof,logBytes=0,logFailed=false;
const {privateDirectory,privateNewFile}=await import('./backup-support.mjs');
const {createOwnedPlatformPgQaV1}=await import('./fixtures/owned-platform-pg-v1-qa.mjs');
const {observeOwnedForkTerminalV1}=await import('./owned-fork-terminal-v1.mjs');
await privateDirectory(work);
const note=async name=>{report.checks.push(name);await writeFile(join(work,'current.private.json'),JSON.stringify(report));console.log(JSON.stringify({nonce,check:report.checks.length,name}));};
try{
  const baseline='docs/validation/field-owned-data-parent-v1.json';assert.equal(hash(await readFile(baseline)),'8b6a3a6ca68fce858dbaba3e630109bbe5d753dbe4917dfc1525537690a9cecd');
  const publication=await read(baseline);assert.equal(publication.commit,'4105015e6624b760368e6cb774ea2ff098a68672');assert.equal(publication.blobs.length,864);
  const pins=new Map(),visited=new Set();
  for(const row of publication.blobs){assert.equal(hash(await readFile(row.path)),row.sha256);pins.set(row.path,row.sha256);}
  async function visit(path){
    path=resolve(path);const name=relative(root,path).replaceAll('\\','/');assert(name&&!name.startsWith('..')&&!isAbsolute(name));
    if(visited.has(name))return;visited.add(name);assert(visited.size<=2048);
    const bytes=await readFile(path),digest=hash(bytes);if(pins.has(name))assert.equal(pins.get(name),digest);else pins.set(name,digest);
    if(/\.(mjs|ts)$/.test(name))for(const m of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*\(?\s*|new URL\s*\(\s*)['"](\.[^'"\r\n]+)['"]/g))if(/\.(mjs|ts|sql)$/.test(m[1]))await visit(resolve(dirname(path),m[1]));
  }
  // Discover the new executable roots even if other frozen files are already pinned.
  for(const name of ['scripts/verify-field-owned-data-path-v1.mjs','scripts/fixtures/field-owned-data-worker-v1-qa.mjs','scripts/field-edge-lifecycle-v2.mjs','scripts/field-edge-managed-entry-v2.mjs','services/field/edge-runner-v3.ts','package.json','package-lock.json',baseline])await visit(name);
  report.sourcePins=[...pins].map(([path,sha256])=>({path,sha256}));report.node={version:process.versions.node,sha256:hash(await readFile(process.execPath))};
  await privateNewFile(join(work,'native-input-pins.json'),JSON.stringify({nonce,node:report.node,sourcePins:report.sourcePins}));
  console.log(JSON.stringify({nativeStarted:true,nonce,pid:process.pid,sourcePins:pins.size,expectedChecks:7}));
  const brokerToolingDirectory=await realpath(process.argv[3]);
  cluster=await createOwnedPlatformPgQaV1(process.argv[2]);report.postgres={work:cluster.work,source:cluster.source,port:cluster.authority.port,systemIdentifier:cluster.systemIdentifier};await writeFile(join(work,'current.private.json'),JSON.stringify(report));
  const {telemetryQualityFixture}=await import('./fixtures/telemetry-quality-model.mjs');
  const {migrateQaDatabases}=await import('./qa-database.mjs');
  const {migrationRuntime}=await import('./database-migrations.mjs');
  const {migrateFieldTenant}=await import('./field-migration.mjs');
  const fixture=telemetryQualityFixture({count:0}),config={host:cluster.authority.host,port:cluster.authority.port,tenants:{}};
  admin=await cluster.client();
  for(const tenant of ['acme','sandbox']){
    const name='idms_fieldownedqa_'+tenant+'_'+nonce,account={user:name,database:name,password:randomBytes(32).toString('base64url')};config.tenants[tenant]=account;
    await admin.query('CREATE ROLE "'+name+'" LOGIN PASSWORD \''+account.password+'\' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT');
    await admin.query('CREATE DATABASE "'+name+'" OWNER "'+name+'"');
  }
  const runtime=await migrateQaDatabases(config,cluster.authority,{snapshot:fixture.snapshot,telemetryTenants:['acme','sandbox']});
  await migrateFieldTenant(runtime,migrationRuntime(config),'acme');await admin.end();admin=null;
  const runtimeFile=join(work,'business.private.json'),inputFile=join(work,'worker.private.json');
  await privateNewFile(runtimeFile,JSON.stringify(runtime));await privateNewFile(inputFile,JSON.stringify({format:'IDMS_FIELD_DATA_PATH_QA_INPUT_V1',nonce,work,runtimeFile,runtime,source:fixture.sources[0],brokerToolingDirectory}));
  worker=fork(fileURLToPath(new URL('./fixtures/field-owned-data-worker-v1-qa.mjs',import.meta.url)),[inputFile],{execArgv:[],windowsHide:true,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:'',NODE_ENV:'test',IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:runtimeFile,IDMS_DEMO_NAMESPACE:'fieldownedqa-'+nonce,IDMS_FIELD_PLATFORM_CONFIG:'',IDMS_FIELD_INTAKE_CONFIG:'',IDMS_TELEMETRY_CONFIG:'',IDMS_WORKFLOW_CLIENT_CONFIG:'',IDMS_AI_CLIENT_CONFIG:'',IDMS_PREDICTOR_URL:''},stdio:['ignore','pipe','pipe','ipc']});
  workerTerminal=observeOwnedForkTerminalV1(worker);
  const log=[];for(const stream of [worker.stdout,worker.stderr])stream.on('data',b=>{logBytes+=b.length;if(logBytes<=4*1024**2)log.push(Buffer.from(b));else logFailed=true;});
  worker.on('message',m=>{
    if(m?.nonce!==nonce)return;
    if(m.type==='FIELD_NOTE')void note(m.name);
    else if(m.type==='FIELD_WORKER_PROOF')workerProof=m.proof;
    else if(m.type==='FIELD_PG_STOP_GUARD')void(async()=>{
      let refused=false;try{await assert.rejects(cluster.stop(),/OWNED_PG_OTHER_CLIENTS_REMAIN/);refused=true;}catch{}
      report.postgresStopRefusedWhileIntakeHeld=refused;
      worker.send({type:'FIELD_PG_STOP_GUARD_RESULT',nonce,requestId:m.requestId,refused},()=>{});
    })();
  });
  const exit=await workerTerminal;await privateNewFile(join(work,'worker.private.log'),Buffer.concat(log));report.workerExit={...exit,pid:worker.pid,stdoutClosed:worker.stdout.closed,stderrClosed:worker.stderr.closed,ipcDisconnected:!worker.connected};report.workerProof=workerProof??null;
  assert.equal(exit.code,0,'FIELD_DATA_PATH_WORKER_FAILED');assert.equal(exit.signal,null);assert(workerProof?.passed&&!logFailed);
  assert.equal(report.postgresStopRefusedWhileIntakeHeld,true);assert.equal(report.checks.length,6);
}catch(error){
  await privateNewFile(join(work,'failure.private.json'),JSON.stringify({message:error.message,stack:error.stack,code:error.code??null}));report.failure={code:/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'FIELD_DATA_PATH_FAILED',messageSha256:hash(error.message)};process.exitCode=1;
}finally{
  const failures=[];
  if(admin)try{await admin.end();}catch{failures.push('ADMIN_CLOSE');}
  if(worker&&worker.exitCode===null&&worker.signalCode===null){if(worker.connected)worker.send({type:'FIELD_WORKER_STOP',nonce},()=>{});try{await workerTerminal;}catch{failures.push('WORKER_EXIT');}}
  if(cluster)try{await cluster.stop();report.postgresCleanOffline=!!cluster.sourceControl;report.postgresProcesses=cluster.processes;assert(!cluster.active&&cluster.processes.every(p=>p.stopped));}catch{failures.push('POSTGRES_SMART_STOP');}
  for(const p of report.sourcePins??[])try{assert.equal(hash(await readFile(p.path)),p.sha256);}catch{failures.push('SOURCE_CHANGED');}
  report.cleanupErrors=failures;report.cleanupComplete=failures.length===0&&!!cluster?.sourceControl;
  if(report.cleanupComplete&&report.workerProof?.passed&&!report.failure){await note('owned edge, intake, broker, worker and PostgreSQL all retired normally');report.passed=report.checks.length===7;}
  if(!report.passed)process.exitCode=1;
  await writeFile(join(work,'verification.private.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({nonce,passed:report.passed,checks:report.checks.length,cleanupComplete:report.cleanupComplete,cleanupErrorCount:failures.length,failure:report.failure??null,originalDatabaseContacted:false,allProductionDependenciesRegistered:false}));
}
