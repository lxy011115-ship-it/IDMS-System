import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,open,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {need,StartupError} from './existing-platform-binding.mjs';
const exec=promisify(execFile);
export async function processFacts(pid){
 need(Number.isSafeInteger(pid)&&pid>0,'PID_INVALID');
 if(process.platform!=='win32')throw new StartupError('WINDOWS_RUNTIME_REQUIRED');
 const command=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($p){[pscustomobject]@{pid=[int]$p.ProcessId;born=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath}|ConvertTo-Json -Compress}`;
 const r=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,maxBuffer:4096});
 if(!r.stdout.trim())return null;const p=JSON.parse(r.stdout);need(p.pid===pid&&typeof p.born==='string'&&typeof p.executable==='string','PROCESS_IDENTITY_UNCONFIRMED');return p;
}
export const sameProcess=(a,b)=>!!a&&!!b&&a.pid===b.pid&&a.born===b.born&&a.executable.toLowerCase()===b.executable.toLowerCase();
export function occupied(port){return new Promise(ok=>{const s=net.connect({port,host:'127.0.0.1'});let done=false;const finish=v=>{if(done)return;done=true;s.destroy();ok(v);};s.setTimeout(1000,()=>finish(true));s.once('connect',()=>finish(true));s.once('error',e=>finish(e.code!=='ECONNREFUSED'));});}
export async function acquireCoordinator(file,{facts=processFacts}={}){
 const owner={format:1,nonce:randomUUID(),process:await facts(process.pid)};
 let handle;try{handle=await open(file,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;let prior;try{prior=JSON.parse(await readFile(file,'utf8'));}catch{throw new StartupError('COORDINATOR_LOCK_UNCONFIRMED');}const current=await facts(prior.process?.pid);throw new StartupError(current?(sameProcess(prior.process,current)?'COORDINATOR_ALREADY_RUNNING':'COORDINATOR_PID_REUSED'):'COORDINATOR_STALE_REVIEW');}
 try{await handle.writeFile(JSON.stringify(owner));await handle.sync();}finally{await handle.close();}
 return async()=>{const prior=JSON.parse(await readFile(file,'utf8'));need(prior.nonce===owner.nonce&&sameProcess(prior.process,owner.process),'COORDINATOR_LOCK_CHANGED');await unlink(file);};
}
/** No termination/retry on observation timeout; caller retains original process identity. */
export async function observeStage({probe,alive,budgetMs=30000,delayMs=250,now=()=>performance.now(),wait=ms=>new Promise(r=>setTimeout(r,ms))}){
 const start=now();
 for(;;){
  if(!await alive())return {status:'EXITED',elapsedMs:Math.round(now()-start)};
  const ready=await probe();
  const elapsedMs=Math.round(now()-start);
  if(ready)return {status:elapsedMs<=budgetMs?'READY':'LATE_READY',elapsedMs};
  if(elapsedMs>=budgetMs)return {status:'UNCONFIRMED',elapsedMs};
  await wait(Math.min(delayMs,budgetMs-elapsedMs));
 }
}
export async function launchGuardedService(bindingPath,runDirectory,name){
 const child=spawn(process.execPath,[resolve('scripts/existing-platform-child.mjs'),bindingPath,runDirectory,name],{cwd:resolve('.'),detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,NODE_OPTIONS:''}});
 let error=false;child.once('error',()=>{error=true;});child.unref();
 const receipt=join(runDirectory,name+'.json');
 for(let i=0;i<(name==='database'?800:100);i++){
  try{need(!error,'SERVICE_WRAPPER_FAILED');const r=JSON.parse(await readFile(receipt,'utf8'));if(r.status==='STARTED')return r;if(r.status==='REFUSED'||r.status==='EXITED')throw new StartupError('SERVICE_START_REJECTED');}
  catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError)){e.mayHaveStarted=true;e.wrapperPid=child.pid;throw e;}}
  await new Promise(r=>setTimeout(r,100));
 }
 const failure=new StartupError('SERVICE_WRAPPER_UNCONFIRMED');failure.mayHaveStarted=true;failure.wrapperPid=child.pid;throw failure;
}
