import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';

assert.equal(process.argv.length,2,'This verifier always runs fresh isolated lease, Flowable and AI checks');
const startedAt=new Date().toISOString();
for(const script of ['verify-worker-leases.mjs','verify-workflow.mjs','verify-ai.mjs']){
 console.log('Running '+script);
 const child=spawn(process.execPath,['scripts/'+script],{env:{...process.env,IDMS_VERIFY_WORKER_HA:'1'},stdio:'inherit',windowsHide:true});
 const code=await new Promise((ok,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>signal?reject(Error('Verifier terminated: '+signal)):ok(code));});
 assert.equal(code,0,script+' failed');
}
const proofs={};
for(const [name,file]of Object.entries({leases:'worker-lease-verification.json',workflow:'workflow-worker-ha-verification.json',ai:'ai-worker-ha-verification.json'})){
 const proof=JSON.parse(await readFile('outputs/'+file,'utf8'));assert.ok(proof.verifiedAt>=startedAt,'Stale evidence: '+file);proofs[name]=proof;
}
assert.equal(proofs.workflow.realFlowable,true);assert.equal(proofs.ai.realLocalModel,true);
const evidence={startedAt,verifiedAt:new Date().toISOString(),scope:'TWO_CORE_PROCESSES_SINGLE_AUTHORITATIVE_POSTGRES',leaseMs:30000,heartbeatMs:10000,proofs,productionHaAcceptance:false,databaseFailoverAcceptance:false,crossServiceDisasterRecoveryAcceptance:false};
await writeFile('outputs/worker-ha-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
