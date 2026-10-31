// Detached, bounded private logger. It owns exactly one native service, never kills/restarts it.
import {spawn} from 'node:child_process';
import {open,writeFile,readFile,lstat,truncate} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {loadExistingBinding,need} from './existing-platform-binding.mjs';
import {serviceCommand} from './existing-platform-services.mjs';
import {processFacts,sameProcess} from './existing-platform-process.mjs';
import {assertExistingIdentityStore} from './keycloak-runtime.mjs';
import {spawnExistingPostgres} from './existing-postgres-launch.mjs';

const [bindingPath,directory,name]=process.argv.slice(2),parent=resolve('.local/platform-startup/runs'),rel=relative(parent,resolve(directory));
need(!isAbsolute(rel)&&!rel.startsWith('..')&&/^[a-f0-9-]{36}$/.test(rel)&&/^(database|identity|broker|workflow|model|ai|predictor|main|simulator|edge)$/.test(name),'CHILD_REQUEST_INVALID');
const receipt=join(directory,name+'.json');let log,child,total=0,retained=0,chain=Promise.resolve(),state;
const save=()=>writeFile(receipt,JSON.stringify(state)+'\n',{mode:0o600});
try {
 const binding=await loadExistingBinding(bindingPath);
 if(name==='identity'){
  await assertExistingIdentityStore(JSON.parse(await readFile(binding.files.identity.path,'utf8')),JSON.parse(await readFile(binding.files.database.path,'utf8')));
 }
 const command=await serviceCommand(binding,name);
 const databaseLog=join(directory,'database-server.private.log');
 if(name==='database')command.args.push('-l',databaseLog);
 log=await open(join(directory,name+'.private.log'),'wx',0o600);
 child=name==='database'?spawnExistingPostgres(command,log.fd):spawn(command.executable,command.args,{cwd:command.cwd,env:command.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const terminal=new Promise(ok=>{child.once('error',()=>ok({status:'REFUSED',code:'SPAWN_FAILED'}));child.once('close',(exitCode,signal)=>ok({status:'EXITED',exitCode,signal}));});
 // Discard excess logs after a fixed limit; draining continues so services never block on a full pipe.
 const append=bytes=>{total+=bytes.length;const part=Buffer.from(bytes.subarray(0,Math.max(0,2*1024**2-retained)));retained+=part.length;if(part.length)chain=chain.then(()=>log.write(part)).catch(()=>{});};
 child.stdout?.on('data',append);child.stderr?.on('data',append);
 let finished;terminal.then(value=>{finished=value;});
 if(name==='database'){
  // pg_ctl applies the vendor's restricted-token handling on Windows and hands off to postgres.
  const launcherEnd=await terminal;await chain;
  if(launcherEnd.exitCode!==0)throw Error('DATABASE_VENDOR_LAUNCH_REJECTED');
  const lines=(await readFile(join(binding.identity.data,'postmaster.pid'),'utf8')).split(/\r?\n/);
  need(resolve(lines[1])===binding.identity.data,'DATABASE_HANDOFF_UNCONFIRMED');
  const identity=await processFacts(Number(lines[0]));need(identity?.executable.toLowerCase()===binding.files.postgres.path.toLowerCase(),'DATABASE_HANDOFF_UNCONFIRMED');
  state={format:1,name,status:'STARTED',process:identity,launcher:{pid:child.pid,...launcherEnd},vendorHandoff:true,observedAt:new Date().toISOString(),autoRestart:false,forceTermination:false};await save();
  let dropped=0;
  while(sameProcess(identity,await processFacts(identity.pid))){
   const s=await lstat(databaseLog);if(s.size>2*1024**2){dropped+=s.size;await truncate(databaseLog,0);}
   await new Promise(r=>setTimeout(r,5000));
  }
  await log.close();log=null;state={...state,status:'PROCESS_TERMINAL',endedAt:new Date().toISOString(),exitCode:null,discardedServerLogBytes:dropped};await save();
 }else{
 const identity=await processFacts(child.pid);
 state={format:1,name,status:identity&&!finished?'STARTED':(finished?.status||'REFUSED'),process:identity,observedAt:new Date().toISOString(),autoRestart:false,forceTermination:false};await save();
 const end=await terminal;await chain;await log.close();log=null;
 state={...state,...end,endedAt:new Date().toISOString(),logBytes:retained,discardedLogBytes:total-retained};await save();
 }
}catch{
 // A failed ownership observation must not terminate a process that may still be running.
 state={...state,format:1,name,status:'REFUSED',code:'SERVICE_LAUNCH_UNCONFIRMED',autoRestart:false,forceTermination:false};await save().catch(()=>{});await log?.close().catch(()=>{});process.exitCode=1;
}
