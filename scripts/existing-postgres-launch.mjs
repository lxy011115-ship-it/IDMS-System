import {spawn} from 'node:child_process';
/** Vendor pg_ctl handoff must not inherit Node pipes on Windows. Verified in owned native QA. */
export function spawnExistingPostgres(command,logFd){
 if(!Number.isInteger(logFd)||logFd<0)throw Error('PRIVATE_DATABASE_LOG_REQUIRED');
 return spawn(command.executable,command.args,{cwd:command.cwd,env:command.env,windowsHide:true,stdio:['ignore',logFd,logFd]});
}
