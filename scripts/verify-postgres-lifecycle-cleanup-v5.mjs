import {inspectCiSourcePolicyV2} from './ci-source-policy-v2.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {coldStoppedV1,coldToolingV1} from './pg-cold-image-portable-tools-v1.mjs';
const nonce=process.argv[2];assert(process.argv.length===3&&/^[a-f0-9]{12}$/.test(nonce));
const root=resolve('.'),work=join(root,'work/postgres-lifecycle-v5-20261024',nonce),json=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const r=await json(join(work,'verification.json'));assert.equal(r.nonce,nonce);assert(/^[a-f0-9]{12}$/.test(r.qaClusterNonce));
const admission=await inspectCiSourcePolicyV2('36d63806dd1f7f374631545fba9431e1342d48aeb307ff40c88fb727ae6eeb94');assert.deepEqual(r.sourcePolicy,{parentCommit:admission.parentCommit,policySha256:admission.policySha256,profiles:admission.profiles});const admittedPins=new Map(r.sourcePins.map(p=>[p.path,p.sha256]));for(const p of admission.executionBaseline.blobs)assert.equal(admittedPins.get(p.path),p.sha256);
const settings=await json(join(root,'work/pg-physical-platform-v1-20261022',r.qaClusterNonce,'cluster.private.json')),tooling=await coldToolingV1(settings.bin),control=await coldStoppedV1(settings.source,tooling,r.finalControl.systemIdentifier);assert.equal(control.state,'shut down');
for(const p of r.sourcePins)assert.equal(createHash('sha256').update(await readFile(p.path)).digest('hex'),p.sha256);
const outcomes=[];
for(const p of r.processes){const path=resolve(p.directory),rel=relative(join(work,'records'),path);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));const st=await lstat(path);assert(st.isDirectory()&&!st.isSymbolicLink());const e=await json(join(path,'exit-observation.json'));assert.equal(e.pid,p.pid);assert.equal(e.owner,p.owner);assert(e.code!==null&&e.signal===null);
 if(r.passed){const bound=await json(join(path,'bound.json')),proof=await json(join(path,'normal-stop-proof.json'));assert.equal(bound.binding.pid,p.pid);assert.equal(proof.binding.owner,p.owner);assert.equal(proof.terminal.code,0);assert.equal(proof.terminal.signal,null);assert(proof.terminal.proofSaved&&proof.helperReplyConfirmed&&!proof.genericKillUsed);assert.equal(proof.mode,'smart');assert.equal(proof.control.systemIdentifier,control.systemIdentifier);assert.equal(proof.control.state,'shut down');}
 if(process.platform==='linux'){try{const cmd=await readFile('/proc/'+p.pid+'/cmdline','utf8');assert(!cmd.split('\0').includes(settings.source),'OWNED_PG_IDENTITY_STILL_PRESENT');}catch(error){if(error.code!=='ENOENT')throw error;}}
 outcomes.push({pid:p.pid,code:e.code,normalStopProven:r.passed,originalHandleExitSaved:true});
}
if(r.passed){assert.equal(r.checks.length,13);assert.equal(outcomes.length,2);assert(outcomes.every(x=>x.code===0));}
const result={format:'IDMS_POSTGRES_LIFECYCLE_INDEPENDENT_CLEANUP_V5',nonce,at:new Date().toISOString(),nativePassed:r.passed,checks:r.checks.length,resourcesRetired:true,cleanControlState:control.state,systemIdentifier:control.systemIdentifier,postmasters:outcomes,sourcePinsVerified:r.sourcePins.length,signalsSent:false,fullGoalComplete:false};
await writeFile(join(work,'independent-cleanup.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
