import {DatabaseSync} from 'node:sqlite';
import {createApplicationRegistryV1,appendApplicationRegistryV1} from '../runtime-application-registry-v1.mjs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import assert from 'node:assert/strict';
assert(process.send&&process.argv.length===3);
const base=process.argv[2],tenantIds=['acme'],binding={controlId:randomUUID(),sourceHash:'1'.repeat(64),authorityHash:'2'.repeat(64)},components=['GOVERNANCE','MAINTENANCE','PREDICTIVE','RECONCILIATION','SITE'].map(kind=>({id:kind.toLowerCase(),kind,tenantId:kind==='SITE'?null:'acme',runtimeFile:join(base,kind+'.json')}));
const manifest={format:1,purpose:'RUNTIME_APPLICATION_SUITE_V1',registryDirectory:join(base,'registry'),trustFile:join(base,'trust.json'),authorityRuntimeFile:join(base,'authority.json'),binding,tenantIds,components};
const trust=await createApplicationRegistryV1(manifest.registryDirectory,manifest,[{path:manifest.trustFile,sha256:'3'.repeat(64)}]);
process.send({event:'TRUST',trust});await new Promise(ok=>process.once('message',m=>{assert.equal(m,'START');ok();}));
let checkpoints=0;const checkpointResults=[];
async function append(event,details){await appendApplicationRegistryV1(trust,event,details);const db=new DatabaseSync(trust.storeFile,{allowExtension:false,timeout:3000});try{assert.equal(db.prepare('PRAGMA busy_timeout;').get().timeout,3000);const result={...db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get()};assert.deepEqual(result,{busy:0,log:0,checkpointed:0});checkpointResults.push(result);checkpoints++;}finally{db.close();}await new Promise(ok=>setTimeout(ok,10));}
for(const c of components){await append('LAUNCH_INTENT',{componentId:c.id,kind:c.kind,configSha256:'4'.repeat(64)});await append('READY',{componentId:c.id,pid:process.pid,configSha256:'4'.repeat(64),kind:c.kind,tenantIds,binding});}
await append('GROUP_READY',{});const requestId=randomUUID();await append('GROUP_STOPPING',{requestId});
for(const c of [...components].reverse()){
 await append('STOP_INTENT',{componentId:c.id,pid:process.pid,requestId});await append('DRAINING',{componentId:c.id,pid:process.pid,requestId});await append('CLOSED',{componentId:c.id,pid:process.pid,requestId});await append('EXIT',{componentId:c.id,pid:process.pid,code:0,signal:null});
}
await append('GROUP_CLOSED',{});process.send({event:'COMPLETE',checkpoints,busyTimeout:3000,checkpointResults});process.disconnect();
