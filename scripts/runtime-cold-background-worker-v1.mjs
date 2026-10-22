import {loadRuntimeColdBackgroundV1} from './runtime-cold-background-v1.mjs';

async function main(){
 if(process.argv.length!==3)throw Error('COLD_BACKGROUND_ARGUMENTS');
 const runtime=await loadRuntimeColdBackgroundV1(process.argv[2]);let stopped=false,wake,draining;
 const stop=()=>{if(stopped)return;stopped=true;draining=runtime.close();draining.catch(()=>{});console.log(JSON.stringify({event:'COLD_BACKGROUND_DRAINING',kind:runtime.kind,tenant:runtime.tenantId,pid:process.pid}));wake?.();};for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);process.once('disconnect',stop);process.on('message',m=>{if(m?.type==='COLD_BACKGROUND_STOP')stop();});
 try{const ready={event:'COLD_BACKGROUND_READY',kind:runtime.kind,tenant:runtime.tenantId,pid:process.pid};console.log(JSON.stringify(ready));process.send?.(ready);
  while(!stopped){try{const value=await runtime.runOne();if(value)console.log(JSON.stringify({event:'COLD_BACKGROUND_JOB_STATE',kind:runtime.kind,status:value.status??null}));}catch{console.error('COLD_BACKGROUND_WAITING_FOR_VALID_RUNTIME');}if(!stopped)await new Promise(ok=>{const timer=setTimeout(()=>{wake=undefined;ok();},500);wake=()=>{clearTimeout(timer);wake=undefined;ok();};});}
 }finally{await runtime.close();console.log(JSON.stringify({event:'COLD_BACKGROUND_CLOSED',kind:runtime.kind,tenant:runtime.tenantId,pid:process.pid}));if(process.connected)process.disconnect();}
}
main().catch(()=>{console.error('COLD_BACKGROUND_RUNTIME_FAILED');if(process.connected)process.disconnect();process.exitCode=1;});
