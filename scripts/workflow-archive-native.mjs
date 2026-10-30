import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {realpath,lstat,open} from 'node:fs/promises';
import {recoveryHostId} from './field-recovery-lock.mjs';
import {canonical} from '../server/imports.ts';
import {workflowRequire as need,workflowSha} from './workflow-archive-facts.mjs';
import {hashWorkflowArchiveFile} from './workflow-archive-container.mjs';
import {workflowArchiveLimits as limits} from './workflow-archive-format.mjs';
const exec=promisify(execFile),helper=fileURLToPath(new URL('./workflow-archive-process.ps1',import.meta.url));
export async function workflowArchiveOwner(){const r=await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Mode','Identity','-OwnerPid',String(process.pid)],{windowsHide:true});const ticks=r.stdout.trim();need(/^\d{17,20}$/.test(ticks),'WF_ARCHIVE_OWNER');return {pid:process.pid,startTicks:ticks,hostId:recoveryHostId()};}
export async function workflowArchiveOwnerState(owner){need(owner.hostId===recoveryHostId(),'WF_ARCHIVE_HOST');const r=await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Mode','Owner','-OwnerPid',String(owner.pid),'-OwnerStartTicks',owner.startTicks],{windowsHide:true});need(['LIVE','TERMINAL'].includes(r.stdout.trim()),'WF_ARCHIVE_OWNER');return r.stdout.trim();}
export async function workflowDumpProgram(){const file=await realpath(resolve(process.env.LOCALAPPDATA,'IDMS/runtime/pgsql/bin/pg_dump.exe'));const version=(await exec(file,['--version'],{windowsHide:true})).stdout.trim();need(/^pg_dump \(PostgreSQL\) 16\./.test(version),'WF_ARCHIVE_PG_VERSION');return {file,version,sha256:(await hashWorkflowArchiveFile(file)).sha256};}
function validateTool(t){need(t.format==='idms-workflow-archive-tool-v2'&&Array.isArray(t.args)&&t.args.length===9&&t.applicationName==='wfarc-d-'+t.runId.replaceAll('-','')&&canonical(t.args)===canonical(['--format=custom','--no-owner','--no-acl','--no-password','--strict-names','--schema=public','--snapshot='+t.snapshot,'--file='+t.dumpFile,'--lock-wait-timeout=30s']),'WF_ARCHIVE_TOOL');}
async function inspect(t,file,owner,mode,target){validateTool(t);const raw=await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Mode',mode,'-OwnerPid',String(owner.pid),'-OwnerStartTicks',owner.startTicks,'-ToolIntentFile',file,'-ExpectedSha256',workflowSha(t),...(target?['-TargetPid',String(target.pid),'-TargetStartTicks',target.startTicks]:[])],{windowsHide:true,maxBuffer:65536});return raw.stdout.trim();}
export async function retireWorkflowNative(tool,file,owner){const program=await workflowDumpProgram(),observed=[];need(tool.program===program.file&&tool.programSha256===program.sha256,'WF_ARCHIVE_TOOL_PROGRAM');for(;;){const rows=JSON.parse(await inspect(tool,file,owner,'Inspect'));need(Array.isArray(rows),'WF_ARCHIVE_TOOL');if(!rows.length)return {observed,allOwnedNativeProcessesTerminal:true};for(const row of rows.sort((a,b)=>(a.kind==='dump'?0:1)-(b.kind==='dump'?0:1))){need(['dump','helper'].includes(row.kind)&&Number.isSafeInteger(row.pid)&&/^\d{17,20}$/.test(row.startTicks),'WF_ARCHIVE_TOOL');observed.push({...row,action:row.kind==='dump'?'Stop':'Wait'});need(await inspect(tool,file,owner,row.kind==='dump'?'Stop':'Wait',row)==='TERMINAL','WF_ARCHIVE_TOOL_NOT_TERMINAL');}}}
export async function runWorkflowDump(tool,{config,check,signal,onPhase=async()=>{}}){
 validateTool(tool);const p=await workflowDumpProgram();need(tool.program===p.file&&tool.programSha256===p.sha256,'WF_ARCHIVE_TOOL_PROGRAM');
 const f=await open(tool.dumpFile,'wx',0o600),before=await f.stat({bigint:true});await f.close();
 const env={...process.env};for(const k of Object.keys(env))if(/^PG/i.test(k))delete env[k];const a=config.authority;
 Object.assign(env,{PGHOST:a.host,PGPORT:String(a.port),PGUSER:'idms_bootstrap',PGPASSWORD:a.bootstrapPassword,PGDATABASE:config.source.database,PGCONNECT_TIMEOUT:'5',PGAPPNAME:tool.applicationName,
  PGOPTIONS:'-c default_transaction_read_only=on -c timezone=UTC -c datestyle=ISO,YMD -c intervalstyle=postgres -c extra_float_digits=3 -c bytea_output=hex -c standard_conforming_strings=on -c max_parallel_workers_per_gather=0'});
 let child,problem,checking=false,closed;const stop=()=>child?.kill(),abort=()=>{problem=Object.assign(Error('WF_ARCHIVE_CANCELLED'),{code:'WF_ARCHIVE_CANCELLED'});stop();};
 try{
  await check();need(!signal?.aborted,'WF_ARCHIVE_CANCELLED');await onPhase('DUMP_FILE_CREATED',{dev:String(before.dev),ino:String(before.ino)});
  closed=new Promise(ok=>{child=spawn(tool.program,tool.args,{env,windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.resume();child.once('error',()=>{problem=Object.assign(Error('WF_ARCHIVE_NATIVE_FAILED'),{code:'WF_ARCHIVE_NATIVE_FAILED'});});child.once('close',(code,sig)=>{if(code!==0||sig)problem??=Object.assign(Error('WF_ARCHIVE_NATIVE_FAILED'),{code:'WF_ARCHIVE_NATIVE_FAILED'});ok();});});
  signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,300000),monitor=setInterval(async()=>{if(checking)return;checking=true;try{await check();need((await lstat(tool.dumpFile)).size<=limits.dumpBytes,'WF_ARCHIVE_DUMP_LIMIT');}catch(e){problem=e;stop();}finally{checking=false;}},250);
  try{await onPhase('DUMP_SPAWNED',{pid:child.pid});await closed;}catch(e){problem=e;stop();await closed;}finally{clearTimeout(timer);clearInterval(monitor);while(checking)await new Promise(ok=>setTimeout(ok,10));}
  if(problem)throw problem;await check();const after=await lstat(tool.dumpFile,{bigint:true});need(after.isFile()&&after.nlink===1n&&after.dev===before.dev&&after.ino===before.ino,'WF_ARCHIVE_DUMP_CHANGED');return hashWorkflowArchiveFile(tool.dumpFile,limits.dumpBytes);
 }finally{signal?.removeEventListener('abort',abort);if(closed){if(problem)stop();await closed;}}
}
