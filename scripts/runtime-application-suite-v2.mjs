import {launchApplicationSuiteV2} from './runtime-application-manager-v2.mjs';
async function main(){
 if(process.argv.length!==3)throw Error('APPLICATION_SUITE_ARGUMENTS');const controller=new AbortController();let suite,stopping=false,stopRequest;
 const stop=requestId=>{if(stopping)return;stopping=true;stopRequest=requestId;controller.abort();suite?.close({requestId}).catch(()=>{});};
 const send=value=>{if(process.connected)try{process.send(value,()=>{});}catch{}};
 for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>stop());process.once('disconnect',()=>stop());process.on('message',m=>{if(m?.type==='APPLICATION_SUITE_STOP'&&/^[a-f0-9-]{36}$/.test(m.requestId))stop(m.requestId);});if(typeof process.send==='function'&&!process.connected)stop();
 try{suite=await launchApplicationSuiteV2(process.argv[2],{startupSignal:controller.signal});}
 catch(error){if(error.message==='APPLICATION_SUITE_START_CANCELLED'&&error.shutdown?.allOwnedChildrenTerminal){const event={event:'APPLICATION_SUITE_START_CANCELLED',requestId:stopRequest,allOwnedChildrenTerminal:true,components:error.shutdown.components,fullGroupReady:false};console.log(JSON.stringify(event));send(event);if(process.connected)process.disconnect();return;}throw error;}
 const ready={event:'APPLICATION_SUITE_READY',pid:process.pid,ownerId:suite.registry.ownerId,components:suite.status().components.length,manifestSha256:suite.manifestSha256};console.log(JSON.stringify(ready));send(ready);
 const result=await suite.closed;console.log(JSON.stringify({event:'APPLICATION_SUITE_CLOSED',...result}));send({event:'APPLICATION_SUITE_CLOSED',requestId:stopRequest,...result});if(!result.normal)process.exitCode=1;if(process.connected)process.disconnect();
}
main().catch(()=>{console.error('APPLICATION_SUITE_FAILED');if(process.connected)process.disconnect();process.exitCode=1;});
