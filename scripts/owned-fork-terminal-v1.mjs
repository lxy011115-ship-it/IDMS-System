import assert from 'node:assert/strict';
import {ChildProcess} from 'node:child_process';

/** Attach immediately to an owned fork. Never infer exit from a timeout or PID lookup. */
export function observeOwnedForkTerminalV1(child){
 assert(child instanceof ChildProcess&&child.stdout&&child.stderr&&typeof child.send==='function','OWNED_FORK_HANDLE_REQUIRED');
 assert(child.exitCode===null&&child.signalCode===null,'OWNED_FORK_OBSERVER_ATTACHED_LATE');
 return new Promise((resolve,reject)=>{
  let exit=null,stdoutClosed=child.stdout.closed===true,stderrClosed=child.stderr.closed===true,ipcDisconnected=!child.connected;
  const finish=()=>{if(exit&&stdoutClosed&&stderrClosed&&ipcDisconnected)resolve(exit);};
  child.once('error',reject);
  child.once('exit',(code,signal)=>{exit={code,signal};finish();});
  child.stdout.once('close',()=>{stdoutClosed=true;finish();});
  child.stderr.once('close',()=>{stderrClosed=true;finish();});
  child.once('disconnect',()=>{ipcDisconnected=true;finish();});
 });
}
