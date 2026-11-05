import {spawn} from 'node:child_process';
import {readFile,open,lstat,realpath,rename} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {processFacts,sameProcess} from './existing-platform-process.mjs';
const need=(value,code)=>{if(!value)throw Error(code);},hash=b=>createHash('sha256').update(b).digest('hex'),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const serviceName=v=>typeof v==='string'&&/^(main|edge|simulator)$/.test(v);
async function replaceStatus(temporary,path){
 // A short Windows sharing violation is an observation of the same write, not
 // permission to spawn another service or recreate a stop request.
 const start=performance.now();for(;;){try{await rename(temporary,path);return;}catch(error){if(!['EACCES','EPERM','EBUSY'].includes(error.code)||performance.now()-start>=5000)throw error;await new Promise(resolve=>setTimeout(resolve,25));}}
}
async function boundedJson(path){const s=await lstat(path);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size>0&&s.size<=8192&&await realpath(path)===path,'NODE_CONTROL_FILE_INVALID');return JSON.parse(await readFile(path,'utf8'));}
export function spawnControlledNode(command){
 need(command.executable===process.execPath&&command.args.length===1&&resolve(command.args[0])===command.args[0],'NODE_CONTROL_COMMAND_INVALID');
 const nonce=randomBytes(32).toString('hex'),child=spawn(command.executable,command.args,{cwd:command.cwd,env:{...command.env,IDMS_PARENT_CONTROL_NONCE:nonce},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});return {child,nonce};
}
export async function attachNodeControl(child,nonce,directory,service,identity){
 need(child.pid===identity.pid&&/^[a-f0-9]{64}$/.test(nonce)&&serviceName(service)&&directory===resolve(directory)&&await realpath(directory)===directory,'NODE_CONTROL_CHILD_INVALID');
 const wrapper=await processFacts(process.pid),requestFile=join(directory,service+'.stop.request.json'),statusFile=join(directory,service+'.stop.status.json'),control={format:'IDMS_CONTROLLED_NODE_V1',service,nonce,process:identity,wrapper,requestFile,statusFile};
 let closing=false,ticking,accepted,complete=false,lastDigest,state={phase:'AVAILABLE',requestId:null};
 let writes=Promise.resolve(),writeError;
 const save=()=>{
  const bytes=JSON.stringify({format:'IDMS_CONTROLLED_NODE_STATUS_V1',service,process:identity,wrapper,nonceDigest:hash(nonce),...state})+'\n';
  writes=writes.then(async()=>{const temporary=statusFile+'.'+randomUUID()+'.tmp',fd=await open(temporary,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}await replaceStatus(temporary,statusFile);}).catch(error=>{writeError??=error;});return writes;
 };await save();if(writeError)throw writeError;
 const onMessage=m=>{if(!accepted||m?.requestId!==accepted)return;if(m.type==='IDMS_SERVICE_STOP_ACCEPTED_V1')state={phase:'ACCEPTED',requestId:accepted};else if(m.type==='IDMS_SERVICE_STOP_COMPLETED_V1'){complete=true;state={phase:'DRAINED',requestId:accepted};}else if(m.type==='IDMS_SERVICE_STOP_FAILED_V1')state={phase:'FAILED',requestId:accepted};else return;void save();};child.on('message',onMessage);
 const tick=async()=>{if(closing||ticking)return;ticking=(async()=>{
  try{
   let request;try{request=await boundedJson(requestFile);}catch(e){if(e.code==='ENOENT')return;throw e;}
   const digest=hash(JSON.stringify(request));if(digest===lastDigest)return;lastDigest=digest;
   need(request.format==='IDMS_CONTROLLED_NODE_STOP_V1'&&request.service===service&&request.nonce===nonce&&uuid(request.requestId)&&sameProcess(request.process,identity)&&sameProcess(request.wrapper,wrapper),'NODE_CONTROL_REQUEST_MISMATCH');
   if(accepted){need(accepted===request.requestId,'NODE_CONTROL_REQUEST_CHANGED');return;}
   need(child.exitCode===null&&child.signalCode===null&&child.connected,'NODE_CONTROL_CHILD_UNAVAILABLE');accepted=request.requestId;state={phase:'REQUESTED',requestId:accepted};await save();if(writeError)throw writeError;child.send({type:'IDMS_SERVICE_STOP_V1',service,nonce,requestId:accepted},error=>{if(error){state={phase:'FAILED',requestId:accepted,code:'NODE_CONTROL_IPC_UNCONFIRMED'};void save();}});
  }catch(e){if(!accepted){state={phase:'REFUSED',requestId:null,code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'NODE_CONTROL_INVALID'};await save();}}
 })().finally(()=>{ticking=undefined;});await ticking;};
 const timer=setInterval(()=>void tick(),100);return {control,close:async end=>{closing=true;clearInterval(timer);await ticking;child.off('message',onMessage);state={phase:'TERMINAL',requestId:accepted||null,drainCompleted:complete,exitCode:end.exitCode??end.code,signal:end.signal??null};await save();if(writeError)throw writeError;return state;}};
}
/** Observation timeout does not send another stop or kill any process. */
export async function stopControlledNode(control,{requestId,budgetMs=60000,facts=processFacts}={}){
 need(control?.format==='IDMS_CONTROLLED_NODE_V1'&&/^[a-f0-9]{64}$/.test(control.nonce)&&serviceName(control.service)&&typeof control.requestFile==='string'&&typeof control.statusFile==='string'&&control.requestFile===resolve(control.requestFile)&&control.requestFile===join(dirname(control.statusFile),control.service+'.stop.request.json')&&control.statusFile===join(dirname(control.requestFile),control.service+'.stop.status.json')&&control.process&&control.wrapper&&Number.isFinite(budgetMs)&&budgetMs>=0&&budgetMs<=300000,'NODE_CONTROL_CAPABILITY_INVALID');
 const status=async()=>{const s=await boundedJson(control.statusFile);need(s.format==='IDMS_CONTROLLED_NODE_STATUS_V1'&&s.service===control.service&&sameProcess(s.process,control.process)&&sameProcess(s.wrapper,control.wrapper)&&s.nonceDigest===hash(control.nonce),'NODE_CONTROL_STATUS_CHANGED');return s;};
 await status();
 let current;try{current=await boundedJson(control.requestFile);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(current){need(current.format==='IDMS_CONTROLLED_NODE_STOP_V1'&&current.nonce===control.nonce&&current.service===control.service&&sameProcess(current.process,control.process)&&sameProcess(current.wrapper,control.wrapper)&&uuid(current.requestId),'NODE_CONTROL_REQUEST_MISMATCH');need(!requestId||requestId===current.requestId,'NODE_CONTROL_REQUEST_CHANGED');requestId=current.requestId;}
 requestId??=randomUUID();need(uuid(requestId),'NODE_CONTROL_REQUEST_INVALID');
 if(!current){need(sameProcess(control.wrapper,await facts(control.wrapper.pid))&&sameProcess(control.process,await facts(control.process.pid)),'NODE_CONTROL_PROCESS_CHANGED');const fd=await open(control.requestFile,'wx',0o600);try{await fd.writeFile(JSON.stringify({format:'IDMS_CONTROLLED_NODE_STOP_V1',service:control.service,nonce:control.nonce,requestId,process:control.process,wrapper:control.wrapper}));await fd.sync();}finally{await fd.close();}}
 const started=performance.now();for(;;){const s=await status();if(s.phase==='TERMINAL'){need(s.requestId===requestId&&s.drainCompleted&&s.exitCode===0&&s.signal===null&&!await facts(control.process.pid),'NODE_CONTROL_NORMAL_EXIT_UNPROVEN');return {status:'NORMAL_EXIT',requestId,process:control.process};}if(performance.now()-started>=budgetMs)return {status:'UNCONFIRMED',requestId,process:control.process};await new Promise(ok=>setTimeout(ok,100));}
}
