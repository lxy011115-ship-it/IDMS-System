import {timingSafeEqual} from 'node:crypto';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
/** Private creator IPC only. No HTTP stop endpoint or PID signal emulation. */
export function installRuntimeStop(stop:()=>Promise<void>,service:string){
 const nonce=process.env.IDMS_PARENT_CONTROL_NONCE;let stopping:Promise<void>|undefined;
 const send=(message:unknown)=>new Promise<void>(resolve=>{if(!process.connected||!process.send)return resolve();process.send(message as object,()=>resolve());});
 const begin=(requestId?:string)=>{
  if(stopping)return stopping;
  stopping=(async()=>{if(requestId)await send({type:'IDMS_SERVICE_STOP_ACCEPTED_V1',requestId});await stop();if(requestId)await send({type:'IDMS_SERVICE_STOP_COMPLETED_V1',requestId});process.exitCode=0;if(process.connected)process.disconnect?.();})();
  void stopping.catch(async()=>{process.exitCode=1;if(requestId)await send({type:'IDMS_SERVICE_STOP_FAILED_V1',requestId});if(process.connected)process.disconnect?.();});return stopping;
 };
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void begin();});
 if(process.send&&process.connected&&typeof nonce==='string'&&/^[a-f0-9]{64}$/.test(nonce))process.on('message',message=>{
  const m=message as Record<string,unknown>;
  if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).sort().join(',')!==['type','service','nonce','requestId'].sort().join(',')||m.type!=='IDMS_SERVICE_STOP_V1'||m.service!==service||!uuid(m.requestId)||typeof m.nonce!=='string'||!(/^[a-f0-9]{64}$/).test(m.nonce)||!timingSafeEqual(Buffer.from(m.nonce),Buffer.from(nonce))){void send({type:'IDMS_SERVICE_STOP_REJECTED_V1',requestId:uuid(m?.requestId)?m.requestId:null});return;}
  void begin(m.requestId);
 });
 return {get stopping(){return !!stopping;},stop:begin};
}
