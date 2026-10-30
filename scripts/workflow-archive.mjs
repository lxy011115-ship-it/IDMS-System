import pg from 'pg';
import {readFile,readdir,lstat,mkdir,unlink,rmdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {withWorkflowFreeze} from './workflow-freeze-control.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {backupDirectory} from './field-backup-io.mjs';
import {WorkflowArchiveObserver} from './workflow-archive-observer.mjs';
import {workflowRequire as need,workflowSha,workflowArchiveFacts,workflowFactSession,workflowArchiveContext} from './workflow-archive-facts.mjs';
import {workflowArchiveOwner,workflowArchiveOwnerState,workflowDumpProgram,retireWorkflowNative,runWorkflowDump} from './workflow-archive-native.mjs';
import {workflowArchiveKeyBinding,sealWorkflowArchive,authenticateWorkflowArchiveV2,publishWorkflowArchive,finishWorkflowArchiveLink,hashWorkflowArchiveFile} from './workflow-archive-container.mjs';
import {authenticateManagedWorkflowArchive,retireWorkflowAuthenticationWorkspaces} from './workflow-archive-workspace.mjs';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
async function optional(p){try{return await read(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const pgConnection=(config,database,name)=>({host:config.authority.host,port:config.authority.port,user:'idms_bootstrap',password:config.authority.bootstrapPassword,database,application_name:name,connectionTimeoutMillis:3000,query_timeout:15000,options:'-c default_transaction_read_only=on -c max_parallel_workers_per_gather=0'});
async function terminalBackend(c,row,sourceOid,operatorOid){
 need(row.datid===sourceOid&&row.usesysid===operatorOid,'WF_ARCHIVE_OLD_READER_BINDING');
 await c.query('SELECT pg_stat_clear_snapshot()');await c.query('SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND datid=$3::oid AND usesysid=$4::oid AND application_name=$5',[row.pid,row.backend_start,row.datid,row.usesysid,row.application_name]);
 const end=performance.now()+15000;for(;;){await c.query('SELECT pg_stat_clear_snapshot()');if(!(await c.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz',[row.pid,row.backend_start])).rowCount)return;need(performance.now()<end,'WF_ARCHIVE_OLD_READER_NOT_TERMINAL');await new Promise(ok=>setTimeout(ok,25));}
}
async function cleanRun(root,plan){
 need(plan.runDirectory===join(root,'run-'+plan.runId),'WF_ARCHIVE_RUN_PATH');await backupDirectory(plan.runDirectory);
 const names=await readdir(plan.runDirectory),allowed=['dump.pgdump','archive.partial','dump.identity.json','stage-proof.json','closed.json'];need(names.every(n=>allowed.includes(n)),'WF_ARCHIVE_RUN_UNKNOWN_FILE');
 for(const name of names){const p=join(plan.runDirectory,name),s=await lstat(p);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'WF_ARCHIVE_RUN_PATH');}
 const identity=await optional(join(plan.runDirectory,'dump.identity.json'));const dump=join(plan.runDirectory,'dump.pgdump');
 try{const s=await lstat(dump,{bigint:true});need(identity?String(s.dev)===identity.dev&&String(s.ino)===identity.ino:s.size===0n,'WF_ARCHIVE_DUMP_CHANGED');}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const name of names)await unlink(join(plan.runDirectory,name));await rmdir(plan.runDirectory);
}
// API only: callers explicitly provide the existing DRAINED operation. It never releases the source.
export async function createWorkflowArchive({config,operationId,keyFile,workDirectory,outputDirectory,signal,onPhase=async()=>{}}){
 await privateDirectory(workDirectory);await privateDirectory(outputDirectory);const root=await backupDirectory(workDirectory),output=await backupDirectory(outputDirectory),intentFile=join(root,'workflow-archive-intent.json'),owner=await workflowArchiveOwner(),keyBinding=await workflowArchiveKeyBinding(keyFile);
 let controllerIdentity;
 return withWorkflowFreeze(config,operationId,async api=>{
  let intent=await optional(intentFile);const a=config.authority,s=config.source,request={operationId,authority:{host:a.host,port:a.port,systemIdentifier:a.systemIdentifier,controlDatabase:a.controlDatabase},source:s,keyBinding,outputDirectory:output};
  const retirement=new pg.Client(pgConnection(config,a.controlDatabase,'idms-wf-archive-retirement'));retirement.on('error',()=>{});await retirement.connect();
  try{
   const op=(await retirement.query('SELECT phase,source_binding,baseline_sha256,baseline,database_oid::text FROM workflow_freeze_operations WHERE operation_id=$1',[operationId])).rows[0];
   need(op&&op.phase==='DRAINED'&&canonical(op.source_binding)===canonical(s)&&workflowSha(op.baseline)===op.baseline_sha256,'WF_ARCHIVE_REQUIRES_DRAINED');
   if(intent){need(intent.format==='idms-workflow-archive-intent-v2'&&canonical(intent.request)===canonical(request)&&intent.fence.baselineSha256===op.baseline_sha256&&intent.fence.databaseOid===op.database_oid,'WF_ARCHIVE_INTENT_CHANGED');
    const operatorOid=(await retirement.query('SELECT usesysid::text FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0].usesysid;
    const plans=(await readdir(root)).filter(n=>/^workflow-run-[a-f0-9-]{36}\.json$/.test(n));
    for(const file of plans){const plan=await read(join(root,file));need(plan.format==='idms-workflow-archive-run-v2'&&plan.intentSha256===workflowSha(intent)&&plan.runDirectory===join(root,'run-'+plan.runId),'WF_ARCHIVE_RUN_PATH');
     const closed=await optional(join(root,'workflow-run-'+plan.runId+'.closed.json'));const same=plan.owner.pid===owner.pid&&plan.owner.startTicks===owner.startTicks;
     need((same&&closed)||await workflowArchiveOwnerState(plan.owner)==='TERMINAL','WF_ARCHIVE_OWNER_STILL_LIVE');
     const toolFile=join(root,'workflow-'+intent.backupId+'-tool-'+plan.runId+'.json'),tool=await optional(toolFile);if(tool){const retirementProof=await retireWorkflowNative(tool,toolFile,owner);await onPhase('PREVIOUS_NATIVE_RETIRED',{runId:plan.runId,...retirementProof});}
     await retirement.query('SELECT pg_stat_clear_snapshot()');const old=(await retirement.query(`SELECT pid,to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,usesysid::text,datid::text,application_name FROM pg_stat_activity WHERE datid=$1::oid AND application_name=ANY($2::text[])`,[op.database_oid,[plan.snapshotName,plan.dumpName]])).rows;
     for(const row of old)await terminalBackend(retirement,row,op.database_oid,operatorOid);
    }
   }
  }finally{await retirement.end();}
  await retireWorkflowAuthenticationWorkspaces(root,owner);
  const fence=await api.status();need(fence.phase==='DRAINED','WF_ARCHIVE_REQUIRES_DRAINED');
  if(!intent){intent={format:'idms-workflow-archive-intent-v2',backupId:randomUUID(),createdAt:new Date().toISOString(),request,fence};await privateNewFile(intentFile,canonical(intent));}
  need(canonical(intent.fence)===canonical(fence),'WF_ARCHIVE_FENCE_DRIFT');await api.prepare();need(controllerIdentity,'WF_ARCHIVE_LEASE_BINDING');
  const destination=join(output,s.tenantId+'-'+intent.backupId+'.idmsworkflowbackup');
  const plans=(await readdir(root)).filter(n=>/^workflow-run-[a-f0-9-]{36}\.json$/.test(n));
  let destinationSeen=false;try{const state=await lstat(destination);destinationSeen=true;if(state.nlink===2){let found=false;for(const name of plans){const p=await read(join(root,name)),proof=await optional(join(p.runDirectory,'stage-proof.json'));if(proof){await finishWorkflowArchiveLink({stageProof:proof,backupFile:destination});found=true;break;}}need(found,'WF_ARCHIVE_PUBLICATION');}
   const opened=await authenticateManagedWorkflowArchive({backupFile:destination,keyFile,tenantId:s.tenantId,workDirectory:root,signal},owner,onPhase);try{need(opened.manifest.backupId===intent.backupId&&opened.manifest.operationId===operationId&&canonical(opened.manifest.fence)===canonical(fence),'WF_ARCHIVE_PUBLICATION');}finally{await opened.dispose();}
   for(const name of plans){const plan=await read(join(root,name));try{await cleanRun(root,plan);}catch(e){if(e.code!=='ENOENT')throw e;}}
   return {format:'idms-workflow-archive-created-v2',backupId:intent.backupId,file:destination,...(await hashWorkflowArchiveFile(destination)),reused:true,sourceRemainsDRAINED:true,automaticActivationApproved:false};
  }catch(e){if(e.code!=='ENOENT'||destinationSeen)throw e;}
  for(const name of plans){const plan=await read(join(root,name));try{await cleanRun(root,plan);}catch(e){if(e.code!=='ENOENT')throw e;}}
  const runId=randomUUID(),runDirectory=join(root,'run-'+runId),plan={format:'idms-workflow-archive-run-v2',runId,intentSha256:workflowSha(intent),owner,runDirectory,snapshotName:'wfarc-s-'+runId.replaceAll('-',''),dumpName:'wfarc-d-'+runId.replaceAll('-','')};
  await privateNewFile(join(root,'workflow-run-'+runId+'.json'),canonical(plan));await mkdir(runDirectory,{recursive:false,mode:0o700});await privateDirectory(runDirectory);await onPhase('RUN_PREPARED',{runId});
  const observer=new WorkflowArchiveObserver(config,operationId,fence,controllerIdentity),source=new pg.Client(pgConnection(config,s.database,plan.snapshotName));source.on('error',()=>{});let sourceConnected=false,sourceIdentity,tool,manifest,stageProof;
  try{
   await observer.connect();await source.connect();sourceConnected=true;await workflowFactSession(source);await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   sourceIdentity=(await source.query(`SELECT pid,to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,usesysid::text,datid::text,application_name FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];observer.addReader(sourceIdentity);await observer.check();
   const snapshot=(await source.query('SELECT pg_export_snapshot() AS id')).rows[0].id,context=await workflowArchiveContext(source,s.database),before=await workflowArchiveFacts(source),program=await workflowDumpProgram();
   await observer.check();await onPhase('SNAPSHOT_READY',{runId,snapshot});
   const dumpFile=join(runDirectory,'dump.pgdump');tool={format:'idms-workflow-archive-tool-v2',runId,owner,program:program.file,programSha256:program.sha256,dumpFile,snapshot,applicationName:plan.dumpName,
    args:['--format=custom','--no-owner','--no-acl','--no-password','--strict-names','--schema=public','--snapshot='+snapshot,'--file='+dumpFile,'--lock-wait-timeout=30s']};
   await privateNewFile(join(root,'workflow-'+intent.backupId+'-tool-'+runId+'.json'),canonical(tool));observer.expectDump(plan.dumpName);
   const dump=await runWorkflowDump(tool,{config,signal,check:()=>observer.check(),onPhase:async(phase,value)=>{if(phase==='DUMP_FILE_CREATED')await privateNewFile(join(runDirectory,'dump.identity.json'),canonical(value));await onPhase(phase,value);}});
   await observer.waitAbsent(plan.dumpName);const after=await workflowArchiveFacts(source);need(canonical(before)===canonical(after),'WF_ARCHIVE_SOURCE_FACT_DRIFT');await observer.check();
   manifest={format:'idms-workflow-formal-archive-v2',backupId:intent.backupId,operationId,createdAt:new Date().toISOString(),tenantId:s.tenantId,scope:'FROZEN_WORKFLOW_DATABASE',restoreMode:'ISOLATED_ONLY',
    authority:{systemIdentifier:a.systemIdentifier,controlDatabase:a.controlDatabase,sourceDatabaseOid:fence.databaseOid,sourceRoleOid:fence.sourceRoleOid},source:s,fence,context,facts:before,
    dump:{...dump,programVersion:program.version,programSha256:program.sha256},privilegedAdministratorTrustRequired:true,automaticActivationApproved:false};
   await source.query('ROLLBACK');await source.end();sourceConnected=false;observer.readers.delete(sourceIdentity.pid);await observer.waitAbsent(plan.snapshotName);await observer.check();need(canonical(await api.status())===canonical(fence),'WF_ARCHIVE_FENCE_DRIFT');
   await privateNewFile(join(runDirectory,'closed.json'),canonical({nativeAndSourceConnectionsTerminal:true}));await privateNewFile(join(root,'workflow-run-'+runId+'.closed.json'),canonical({nativeAndSourceConnectionsTerminal:true}));await onPhase('READERS_CLOSED',{runId});
   stageProof=await sealWorkflowArchive({manifest,dumpFile,keyFile,stageFile:join(runDirectory,'archive.partial'),signal});await privateNewFile(join(runDirectory,'stage-proof.json'),canonical(stageProof));
   const opened=await authenticateManagedWorkflowArchive({backupFile:stageProof.file,keyFile,tenantId:s.tenantId,workDirectory:root,signal},owner,onPhase);try{need(canonical(opened.manifest)===canonical(manifest),'WF_ARCHIVE_AUTHENTICATED_MANIFEST');}finally{await opened.dispose();}
   need(canonical(await api.status())===canonical(fence),'WF_ARCHIVE_FENCE_DRIFT');await onPhase('BEFORE_PUBLICATION',{backupId:intent.backupId});const published=await publishWorkflowArchive({manifest,stageProof,outputDirectory:output,signal});await onPhase('AFTER_PUBLICATION',{backupId:intent.backupId});
   await cleanRun(root,plan);return {format:'idms-workflow-archive-created-v2',...published,reused:false,sourceRemainsDRAINED:true,automaticActivationApproved:false};
  }finally{
   if(sourceConnected){await source.query('ROLLBACK').catch(()=>{});await source.end().catch(()=>{});if(sourceIdentity)observer.readers.delete(sourceIdentity.pid);await observer.waitAbsent(plan.snapshotName).catch(()=>{});}
   await observer.close();
  }
 },{onPhase:async(phase,identity)=>{if(phase==='PREPARED')controllerIdentity={...identity};}});
}
