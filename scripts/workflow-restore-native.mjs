import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {canonical} from '../server/imports.ts';
import {workflowRequire as need,workflowSha} from './workflow-archive-facts.mjs';
import {hashWorkflowArchiveFile} from './workflow-archive-container.mjs';
const exec=promisify(execFile),helper=fileURLToPath(new URL('./workflow-restore-process.ps1',import.meta.url));
export async function workflowRestoreProgram(){const file=await realpath(resolve(process.env.LOCALAPPDATA,'IDMS/runtime/pgsql/bin/pg_restore.exe')),version=(await exec(file,['--version'],{windowsHide:true})).stdout.trim();need(/^pg_restore \(PostgreSQL\) 16\./.test(version),'WF_RESTORE_PROGRAM');return {file,version,sha256:(await hashWorkflowArchiveFile(file)).sha256};}
export function workflowRestoreArgs(database,dump){return ['--no-owner','--no-acl','--no-password','--single-transaction','--exit-on-error','--role='+database,'--dbname='+database,dump];}
function validate(t){need(t?.format==='idms-workflow-restore-tool-v1'&&/^idms_workflowrestore_(acme|sandbox)_[a-f0-9]{12}$/.test(t.targetDatabase)&&t.applicationName==='wfres-r-'+t.runId.replaceAll('-','')&&canonical(t.args)===canonical(workflowRestoreArgs(t.targetDatabase,t.dumpFile)),'WF_RESTORE_TOOL');}
async function inspect(t,file,owner,mode,row){validate(t);const r=await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Mode',mode,'-OwnerPid',String(owner.pid),'-OwnerStartTicks',owner.startTicks,'-ToolIntentFile',file,'-ExpectedSha256',workflowSha(t),...(row?['-TargetPid',String(row.pid),'-TargetStartTicks',row.startTicks]:[])],{windowsHide:true,maxBuffer:65536});return r.stdout.trim();}
export async function retireWorkflowRestoreNative(tool,file,owner){
 validate(tool);const p=await workflowRestoreProgram(),observed=[];need(p.file===tool.program&&p.sha256===tool.programSha256,'WF_RESTORE_PROGRAM_CHANGED');
 for(;;){const rows=JSON.parse(await inspect(tool,file,owner,'Inspect'));need(Array.isArray(rows),'WF_RESTORE_TOOL');if(!rows.length)return {observed,allOwnedNativeProcessesTerminal:true};for(const row of rows.sort((a,b)=>(a.kind==='restore'?0:1)-(b.kind==='restore'?0:1))){need(['restore','helper'].includes(row.kind)&&Number.isSafeInteger(row.pid)&&/^\d{17,20}$/.test(row.startTicks),'WF_RESTORE_TOOL');observed.push(row);need(await inspect(tool,file,owner,row.kind==='restore'?'Stop':'Wait',row)==='TERMINAL','WF_RESTORE_NATIVE_NOT_TERMINAL');}}
}
export async function runWorkflowRestoreNative(tool,{authority,check,signal,onPhase}){
 validate(tool);const p=await workflowRestoreProgram();need(tool.program===p.file&&tool.programSha256===p.sha256,'WF_RESTORE_PROGRAM_CHANGED');need((await hashWorkflowArchiveFile(tool.dumpFile)).sha256===tool.dumpSha256,'WF_RESTORE_DUMP_CHANGED');
 await check();need(!signal?.aborted,'WF_RESTORE_CANCELLED');const env={...process.env};for(const k of Object.keys(env))if(/^PG/i.test(k))delete env[k];Object.assign(env,{PGHOST:authority.host,PGPORT:String(authority.port),PGUSER:'idms_bootstrap',PGPASSWORD:authority.bootstrapPassword,PGDATABASE:tool.targetDatabase,PGAPPNAME:tool.applicationName,PGCONNECT_TIMEOUT:'5',PGOPTIONS:'-c timezone=UTC -c max_parallel_workers_per_gather=0'});
 let child,problem,checking=false;const stop=()=>child?.kill(),abort=()=>{problem=Object.assign(Error('WF_RESTORE_CANCELLED'),{code:'WF_RESTORE_CANCELLED'});stop();};
 const closed=new Promise(ok=>{child=spawn(tool.program,tool.args,{env,windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.resume();child.once('error',()=>{problem=Object.assign(Error('WF_RESTORE_NATIVE_FAILED'),{code:'WF_RESTORE_NATIVE_FAILED'});});child.once('close',(code,sig)=>{if(code!==0||sig)problem??=Object.assign(Error('WF_RESTORE_NATIVE_FAILED'),{code:'WF_RESTORE_NATIVE_FAILED'});ok();});});
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(abort,300000),monitor=setInterval(async()=>{if(checking)return;checking=true;try{await check();}catch(e){problem=e;stop();}finally{checking=false;}},250);
 try{await onPhase('RESTORE_NATIVE_SPAWNED',{pid:child.pid,applicationName:tool.applicationName});await closed;}catch(e){problem=e;stop();await closed;}
 finally{clearTimeout(timer);clearInterval(monitor);signal?.removeEventListener('abort',abort);while(checking)await new Promise(ok=>setTimeout(ok,10));await closed;}
 if(problem)throw problem;await check();await onPhase('RESTORE_NATIVE_CLOSED',{});
}
