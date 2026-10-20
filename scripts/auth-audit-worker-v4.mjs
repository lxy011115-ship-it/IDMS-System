import {loadAuthAuditRuntimeV4} from '../server/auth-audit-runtime-v4.ts';
async function main(){
 if(process.argv.length!==3)throw Error('AUTH_AUDIT_RUNTIME_ARGUMENTS');const runtime=await loadAuthAuditRuntimeV4(process.argv[2]);let stopping=false,wake;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;wake?.();});process.on('message',message=>{if(message?.type==='AUTH_AUDIT_STOP'){stopping=true;wake?.();}});console.log(JSON.stringify({event:'AUTH_AUDIT_WORKER_READY',tenants:runtime.config.targets.map(t=>t.binding.tenantId)}));
 while(!stopping){let worked=false;for(const target of runtime.config.targets){if(stopping)break;try{const result=await runtime.worker.runOne(target.binding.tenantId);if(result){worked=true;console.log(JSON.stringify({event:'AUTH_AUDIT_STATE',eventId:result.eventId,status:result.status}));}}catch{console.error('AUTH_AUDIT_DELIVERY_RETRY');}}if(!stopping&&!worked)await new Promise(ok=>{const timer=setTimeout(()=>{wake=undefined;ok();},500);wake=()=>{clearTimeout(timer);wake=undefined;ok();};});}
 if(process.connected)process.disconnect();
}
main().catch(()=>{console.error('AUTH_AUDIT_RUNTIME_FAILED');if(process.connected)process.disconnect();process.exitCode=1;});
