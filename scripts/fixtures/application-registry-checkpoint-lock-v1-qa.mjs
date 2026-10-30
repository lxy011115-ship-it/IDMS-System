import {DatabaseSync} from 'node:sqlite';
import {createApplicationRegistryV1,appendApplicationRegistryV1} from '../runtime-application-registry-v1.mjs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import assert from 'node:assert/strict';
assert(process.send&&process.argv.length===3);
const base=process.argv[2],tenantIds=['acme'],binding={controlId:randomUUID(),sourceHash:'1'.repeat(64),authorityHash:'2'.repeat(64)},components=['GOVERNANCE','MAINTENANCE','PREDICTIVE','RECONCILIATION','SITE'].map(kind=>({id:kind.toLowerCase(),kind,tenantId:kind==='SITE'?null:'acme',runtimeFile:join(base,kind+'.json')}));
const manifest={format:1,purpose:'RUNTIME_APPLICATION_SUITE_V1',registryDirectory:join(base,'registry'),trustFile:join(base,'trust.json'),authorityRuntimeFile:join(base,'authority.json'),binding,tenantIds,components};
const trust=await createApplicationRegistryV1(manifest.registryDirectory,manifest,[{path:manifest.trustFile,sha256:'3'.repeat(64)}]);
process.send({event:'TRUST',trust});await new Promise((ok,no)=>{process.once('message',m=>{assert.equal(m,'READ_LOCKED');ok();});process.once('disconnect',()=>no(Error('CHECKPOINT_PARENT_DISCONNECTED')));});
await appendApplicationRegistryV1(trust,'LAUNCH_INTENT',{componentId:'governance',kind:'GOVERNANCE',configSha256:'4'.repeat(64)});
const immediate=new DatabaseSync(trust.storeFile,{allowExtension:false,timeout:0});let blocked;
try{blocked={...immediate.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get()};assert.equal(blocked.busy,1);assert(blocked.log>0);}finally{immediate.close();}
const waiting=new DatabaseSync(trust.storeFile,{allowExtension:false,timeout:3000});
try{
 const configuredTimeout=waiting.prepare('PRAGMA busy_timeout;').get().timeout;assert.equal(configuredTimeout,3000);process.send({event:'BUSY_OBSERVED',blocked,configuredTimeout});const started=performance.now();
 const completed={...waiting.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get()};assert.deepEqual(completed,{busy:0,log:0,checkpointed:0});const row=waiting.prepare('SELECT sequence FROM application_meta WHERE id=1').get();assert.equal(row.sequence,1);
 process.send({event:'COMPLETE',completed,configuredTimeout,elapsedMs:performance.now()-started,sequence:row.sequence});
}finally{waiting.close();}
process.disconnect();
