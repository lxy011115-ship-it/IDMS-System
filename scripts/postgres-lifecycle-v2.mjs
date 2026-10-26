import {spawn} from 'node:child_process';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {mkdir,lstat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {backupDirectory,backupRegular,backupUnchanged,readExactly} from './field-backup-io.mjs';
import {coldToolingV1,coldStoppedV1,coldToolEnvV1} from './pg-cold-image-portable-tools-v1.mjs';
import {coldConfigNamesV1,coldReviewImageConfigV2 as coldConfigV1,coldReviewImageManifestV2 as coldManifestV1,coldReviewImageEvidenceV2} from './pg-cold-review-config-v2.mjs';
import {coldTreeV1,coldRecheckIdentityV1} from './pg-cold-image-portable-tree-v1.mjs';

const owned=new WeakMap(),hash=b=>createHash('sha256').update(b).digest('hex');
const need=(v,c)=>{if(!v)throw Error(c);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const pathKey=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&pathKey(a)===pathKey(b);
const outside=(a,b)=>{const r=relative(a,b);return r!==''&&(r==='..'||r.startsWith('..\\')||r.startsWith('../')||isAbsolute(r));};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const identity=s=>({dev:String(s.dev),ino:String(s.ino)});
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};

async function bytes(file,max=1024**2){const f=await backupRegular(file,max);try{const b=await readExactly(f.file,Number(f.stat.size),0);await backupUnchanged(f);return b;}finally{await f.file.close();}}
async function pinsFor(directory,evidence){const pins=[];for(const name of coldConfigNamesV1){const file=join(directory,name),b=await bytes(file);coldConfigV1(name,b,evidence);pins.push({name,path:file,bytes:b.length,sha256:hash(b)});}return pins;}
async function checkFiles(s){
 need(canonical(identity(await lstat(await backupDirectory(s.dataDirectory),{bigint:true})))===canonical(s.dataIdentity),'PG_LIFECYCLE_DIRECTORY_CHANGED');
 need(canonical(identity(await lstat(await backupDirectory(s.directory),{bigint:true})))===canonical(s.directoryIdentity),'PG_LIFECYCLE_RECORD_DIRECTORY_CHANGED');
 need(canonical(await pinsFor(s.dataDirectory,s.reviewEvidence))===canonical(s.files),'PG_LIFECYCLE_CONFIG_CHANGED');
 need(canonical((await coldToolingV1(s.binDirectory)).binding)===canonical(s.tooling.binding),'PG_LIFECYCLE_PROGRAM_CHANGED');
}
function alive(s){need(s.child.pid>0&&s.child.exitCode===null&&s.child.signalCode===null&&!s.exitObservation,'PG_LIFECYCLE_NOT_RUNNING');}
async function pidFile(s){
 alive(s);const lines=(await bytes(join(s.dataDirectory,'postmaster.pid'),8192)).toString('utf8').split(/\r?\n/);
 need(Number(lines[0])===s.child.pid&&samePath(lines[1],s.dataDirectory)&&Number(lines[3])===s.port&&/^\d+$/.test(lines[2]),'PG_LIFECYCLE_POSTMASTER_BINDING');
 if(s.binding.startSeconds)need(lines[2]===s.binding.startSeconds,'PG_LIFECYCLE_START_CHANGED');
 return{pid:s.child.pid,startSeconds:lines[2]};
}
async function sqlIdentity(s){
 const c=new pg.Client({host:'127.0.0.1',port:s.port,...s.account,application_name:'idms-owned-postgres-lifecycle',connectionTimeoutMillis:2000,query_timeout:3000});
 try{await c.connect();await c.query('BEGIN READ ONLY');const row=(await c.query("SELECT current_setting('data_directory') AS directory,current_setting('config_file') AS config_file,current_setting('hba_file') AS hba_file,current_setting('ident_file') AS ident_file,inet_server_port() AS port,(pg_control_system()).system_identifier::text AS system_id,extract(epoch FROM pg_postmaster_start_time())::text AS started,(SELECT count(*)::int FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()) AS other_clients,(SELECT count(*)::int FROM pg_prepared_xacts) AS prepared_transactions")).rows[0];await c.query('COMMIT');
  need(samePath(row.directory,s.dataDirectory)&&row.system_id===s.systemIdentifier&&Number(row.port)===s.port,'PG_LIFECYCLE_SQL_BINDING');
  for(const[k,name]of Object.entries({config_file:'postgresql.conf',hba_file:'pg_hba.conf',ident_file:'pg_ident.conf'}))need(samePath(row[k],join(s.dataDirectory,name)),'PG_LIFECYCLE_SQL_CONFIGURATION');
  if(s.binding.sqlStarted)need(row.started===s.binding.sqlStarted,'PG_LIFECYCLE_SQL_START_CHANGED');return row;
 }finally{await c.end().catch(()=>{});}
}

/** Explicitly stopped PG16 only. Creates a real postmaster; never adopts a PID. */
export async function launchPostgresLifecycleV2(options){
 need(exact(options,['binDirectory','dataDirectory','workDirectory','expectedSystemIdentifier','port','account','reviewEvidence']),'PG_LIFECYCLE_INPUT_FIELDS');
 const{binDirectory,dataDirectory,workDirectory,expectedSystemIdentifier,port,account,reviewEvidence}=options;
 const evidence=freeze(structuredClone(reviewEvidence));coldReviewImageEvidenceV2(evidence);
 need(['win32','linux'].includes(process.platform)&&!(process.platform==='linux'&&process.getuid()===0),'PG_LIFECYCLE_PLATFORM_OR_ROOT');
 need([binDirectory,dataDirectory,workDirectory].every(p=>typeof p==='string'&&p.length>0&&!/[\u0000-\u001f]/.test(p))&&/^\d{16,20}$/.test(expectedSystemIdentifier)&&Number.isInteger(port)&&port>1024&&port<=65535,'PG_LIFECYCLE_INPUT');
 need(exact(account,['user','password','database'])&&/^[a-z][a-z0-9_]{1,62}$/.test(account.user)&&typeof account.password==='string'&&account.password.length>=32&&account.password.length<=4096&&!/[\r\n\0]/.test(account.password)&&account.database==='postgres','PG_LIFECYCLE_ACCOUNT');
 const data=await backupDirectory(dataDirectory),parent=await backupDirectory(workDirectory),bin=await backupDirectory(binDirectory);
 need(outside(data,parent)&&outside(parent,data)&&outside(data,bin),'PG_LIFECYCLE_PATH_OVERLAP');
 const tooling=await coldToolingV1(bin),control=await coldStoppedV1(data,tooling,expectedSystemIdentifier),files=await pinsFor(data,evidence),dataIdentity=identity(await lstat(data,{bigint:true})),inventory=await coldTreeV1(data);
 // Reuse the complete offline profile: no external tablespaces/WAL links,
 // standby/recovery signals, duplicate aliases or unclean control state.
 const offline=coldManifestV1({format:'IDMS_PG_REVIEW_COLD_IMAGE_V2',backupId:randomUUID(),createdAt:new Date().toISOString(),scope:'ENTIRE_SHUT_DOWN_PG16_CLUSTER',restoreMode:'NEW_ISOLATED_DIRECTORY_ONLY',sourceDirectory:data,platform:process.platform,arch:process.arch,tooling:tooling.binding,control,evidence,tree:inventory.tree,totalBytes:inventory.totalBytes,automaticActivationApproved:false,privilegedAdministratorTrustRequired:true});
 const owner=randomUUID(),directory=join(parent,'postgres-process-'+owner);await mkdir(directory,{mode:0o700});await privateDirectory(directory);
 const directoryIdentity=identity(await lstat(directory,{bigint:true})),deployment=hash(canonical({directory:data,dataIdentity,systemIdentifier:expectedSystemIdentifier,port,tooling:tooling.binding,files,offlineTreeHash:hash(canonical(inventory.tree))})),binding={owner,deployment,systemIdentifier:expectedSystemIdentifier,dataDirectory:data,port};
 await privateNewFile(join(directory,'offline-input-manifest.json'),canonical(offline));
 await privateNewFile(join(directory,'launch-intent.json'),canonical({format:'IDMS_POSTGRES_LIFECYCLE_LAUNCH_V1',binding,control,files,programs:tooling.binding,normalStopMode:'smart',host:'127.0.0.1',offlineInputOnly:true,archiveAuthenticatedByLifecycle:false}));
 await coldRecheckIdentityV1(inventory);need(canonical((await coldTreeV1(data)).tree)===canonical(inventory.tree)&&canonical(await coldStoppedV1(data,tooling,expectedSystemIdentifier))===canonical(control),'PG_LIFECYCLE_OFFLINE_INPUT_CHANGED');
 // All GUC paths are argv values, never shell text or pg_ctl's -o command string.
 const args=['-D',data,'-h','127.0.0.1','-p',String(port),...Object.entries({config_file:'postgresql.conf',hba_file:'pg_hba.conf',ident_file:'pg_ident.conf'}).flatMap(([k,n])=>['-c',k+'='+join(data,n)]),...(process.platform==='linux'?['-c','unix_socket_directories=']:[])];
 const logFile=join(directory,'process.private.log');await privateNewFile(logFile,'');const fd=openSync(logFile,'a');
 const child=spawn(tooling.paths.postgres,args,{cwd:data,env:coldToolEnvV1(),windowsHide:true,stdio:['ignore','pipe','pipe']}),s={child,directory,directoryIdentity,dataDirectory:data,dataIdentity,binDirectory:bin,tooling,systemIdentifier:expectedSystemIdentifier,port,account:{...account},files,reviewEvidence:evidence,binding,bound:false,stopPromise:null,stopAccepted:false,stopRequestId:null,helperAttempts:0,stopProof:null,logFailed:false,exitObservation:null};
 let resolveTerminal,settled=false;const terminal=new Promise(ok=>resolveTerminal=ok);s.terminal=terminal;
 const exited=(code,signal,spawnFailed=false)=>{if(settled)return;settled=true;try{fsyncSync(fd);closeSync(fd);}catch{s.logFailed=true;}s.exitObservation={format:'IDMS_POSTGRES_OWNED_EXIT_V1',owner,deployment,pid:child.pid??null,code,signal,spawnFailed,observedAt:new Date().toISOString()};void privateNewFile(join(directory,'exit-observation.json'),canonical(s.exitObservation)).then(()=>resolveTerminal({...s.exitObservation,proofSaved:true}),()=>resolveTerminal({...s.exitObservation,proofSaved:false}));};
 child.once('error',()=>exited(null,null,true));child.once('close',(code,signal)=>exited(code,signal));
 for(const stream of [child.stdout,child.stderr])stream?.on('data',b=>{try{writeSync(fd,b);}catch{s.logFailed=true;}});
 const handle=Object.freeze({process:child,terminal,directory,get binding(){return structuredClone(s.binding);},get bound(){return s.bound;},get helperAttempts(){return s.helperAttempts;},get stopProof(){return s.stopProof;}});owned.set(handle,s);return handle;
}

export async function bindPostgresLifecycleV2(handle){
 const s=owned.get(handle);need(s&&!s.stopAccepted,'PG_LIFECYCLE_HANDLE');await checkFiles(s);const deadline=Date.now()+30000;
 for(;;){alive(s);try{const row=await sqlIdentity(s),pid=await pidFile(s);need(Math.abs(Number(row.started)-Number(pid.startSeconds))<3,'PG_LIFECYCLE_START_BINDING');await checkFiles(s);alive(s);
   const binding={...s.binding,startSeconds:pid.startSeconds,sqlStarted:row.started,pid:s.child.pid};
   if(s.bound)need(canonical(binding)===canonical(s.binding),'PG_LIFECYCLE_BINDING_CHANGED');else{await privateNewFile(join(s.directory,'bound.json'),canonical({format:'IDMS_POSTGRES_BOUND_V1',binding}));s.binding=binding;s.bound=true;}return structuredClone(binding);
  }catch(error){if(!['ECONNREFUSED','57P03'].includes(error.code))throw Error(/^PG_LIFECYCLE_[A-Z_]+$/.test(error.message)?error.message:'PG_LIFECYCLE_DATABASE_BIND_FAILED');need(Date.now()<deadline,'PG_LIFECYCLE_READY_TIMEOUT');await new Promise(ok=>setTimeout(ok,100));}}
}
export async function inspectPostgresLifecycleV2(handle){const s=owned.get(handle);need(s&&s.bound&&!s.stopAccepted,'PG_LIFECYCLE_HANDLE');await checkFiles(s);await pidFile(s);const row=await sqlIdentity(s);await pidFile(s);return{binding:structuredClone(s.binding),otherClients:row.other_clients,preparedTransactions:row.prepared_transactions};}

/** A rejected preflight sends nothing; an accepted stop is never retransmitted. */
export function stopPostgresLifecycleV2(handle,{requestId}={}){
 const s=owned.get(handle);need(s,'PG_LIFECYCLE_HANDLE');need(requestId===undefined||uuid(requestId),'PG_LIFECYCLE_REQUEST_ID');
 if(s.stopPromise){need(!requestId||requestId===s.stopRequestId,'PG_LIFECYCLE_STOP_REQUEST_CHANGED');return s.stopPromise;}
 const id=requestId??randomUUID();s.stopRequestId=id;
 const attempt=(async()=>{need(s.bound,'PG_LIFECYCLE_NOT_BOUND');const status=await inspectPostgresLifecycleV2(handle);need(status.otherClients===0&&status.preparedTransactions===0,'PG_LIFECYCLE_CLIENTS_REMAIN');await pidFile(s);await checkFiles(s);
  await privateNewFile(join(s.directory,'stop-intent.json'),canonical({format:'IDMS_POSTGRES_SMART_STOP_INTENT_V1',requestId:id,binding:s.binding,otherClients:0,preparedTransactions:0}));s.stopAccepted=true;s.helperAttempts++;
  const helper=await new Promise(ok=>{const p=spawn(s.tooling.paths.pgCtl,['stop','-D',s.dataDirectory,'-m','smart','-w','-t','30'],{env:coldToolEnvV1(),windowsHide:true,stdio:'ignore'});let done=false;const finish=v=>{if(!done){done=true;ok(v);}};p.once('error',()=>finish({code:null,signal:null,spawnFailed:true}));p.once('close',(code,signal)=>finish({code,signal,spawnFailed:false}));});
  await privateNewFile(join(s.directory,'stop-helper-result.json'),canonical({requestId:id,...helper}));need(!helper.spawnFailed,'PG_LIFECYCLE_STOP_HELPER_START_FAILED');
  const terminal=await s.terminal;need(terminal.code===0&&terminal.signal===null&&!terminal.spawnFailed&&terminal.proofSaved&&!s.logFailed,'PG_LIFECYCLE_TARGET_EXIT');await checkFiles(s);const control=await coldStoppedV1(s.dataDirectory,s.tooling,s.systemIdentifier);
  const proof={format:'IDMS_POSTGRES_NORMAL_STOP_PROOF_V1',requestId:id,binding:s.binding,terminal,helper,helperReplyConfirmed:helper.code===0&&helper.signal===null,control,otherClientsBefore:0,preparedTransactionsBefore:0,mode:'smart',genericKillUsed:false,observedAt:new Date().toISOString()};
  await privateNewFile(join(s.directory,'normal-stop-proof.json'),canonical(proof));s.stopProof=freeze(proof);s.account.password='';return s.stopProof;
 })();s.stopPromise=attempt;attempt.catch(()=>{if(!s.stopAccepted&&s.stopPromise===attempt){s.stopPromise=null;s.stopRequestId=null;}});return attempt;
}
