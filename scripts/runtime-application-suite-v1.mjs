import {launchApplicationSuiteV1} from './runtime-application-manager-v1.mjs';
async function main(){
 if(process.argv.length!==3)throw Error('APPLICATION_SUITE_ARGUMENTS');let suite,stopping=false,stopRequest;
 const stop=requestId=>{if(stopping)return;stopping=true;stopRequest=requestId;suite?.close({requestId}).catch(()=>{});};
 for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>stop());process.once('disconnect',()=>stop());process.on('message',m=>{if(m?.type==='APPLICATION_SUITE_STOP'&&/^[a-f0-9-]{36}$/.test(m.requestId))stop(m.requestId);});
 suite=await launchApplicationSuiteV1(process.argv[2]);if(stopping)suite.close({requestId:stopRequest}).catch(()=>{});
 const ready={event:'APPLICATION_SUITE_READY',pid:process.pid,ownerId:suite.registry.ownerId,components:suite.status().components.length,manifestSha256:suite.manifestSha256};console.log(JSON.stringify(ready));process.send?.(ready);
 const result=await suite.closed;console.log(JSON.stringify({event:'APPLICATION_SUITE_CLOSED',...result}));process.send?.({event:'APPLICATION_SUITE_CLOSED',requestId:stopRequest,...result});if(!result.normal)process.exitCode=1;if(process.connected)process.disconnect();
}
main().catch(()=>{console.error('APPLICATION_SUITE_FAILED');if(process.connected)process.disconnect();process.exitCode=1;});
