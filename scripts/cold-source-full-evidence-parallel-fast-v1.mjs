import {lstat,realpath} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {canonical} from '../server/imports.ts';
import {validateColdSourceFullFactsV1} from './cold-source-full-facts-v2.mjs';
import {privateDirectory} from './backup-support.mjs';
import {coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {launchFieldMapFullEvidenceWorkerV3,awaitFieldMapFullEvidenceWorkerV3} from './field-map-full-evidence-worker-owner-v3.mjs';
import {reviewSourceNeedV1 as need} from './workflow-review-source-facts-v1.mjs';
const identity=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),nlink:String(s.nlink)}),same=(a,b)=>canonical(a)===canonical(b);
/** Complete original SOURCE data verification only; no SQL, current-user or runtime capability is created. */
export async function verifyColdSourceFullEvidenceParallelFastV1(frame,set,controlDirectory,workDirectory){
 validateColdSourceFullFactsV1(frame,set,controlDirectory);need(typeof workDirectory==='string'&&isAbsolute(workDirectory)&&resolve(workDirectory)===workDirectory,'COLD_SOURCE_PARALLEL_WORK_DIRECTORY');
 const originalFrame=canonical(frame),originalSet=canonical(set),directory=join(resolve(controlDirectory),'source-full-maps'),dir=await lstat(directory,{bigint:true});need(dir.isDirectory()&&!dir.isSymbolicLink()&&await realpath(directory)===directory,'COLD_SOURCE_MAP_EVIDENCE_DIRECTORY');
 const workerDirectory=join(workDirectory,'original-source-evidence-workers');await privateDirectory(workerDirectory);const pending=[],results=[],maps=[];let problem;
 try{
  for(const d of set.databases){const m=d.map;if(!m)continue;const stat=await lstat(m.evidenceFile,{bigint:true});need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&stat.size<=BigInt(2*1024**3),'COLD_SOURCE_MAP_EVIDENCE_FILE');need((await coldFileHashV1(m.evidenceFile,2*1024**3)).sha256===m.evidenceSha256,'COLD_SOURCE_MAP_EVIDENCE_CHANGED');const handle=await launchFieldMapFullEvidenceWorkerV3({file:m.evidenceFile,expectedFacts:m.facts,workDirectory:workerDirectory});pending.push({handle,map:m,identity:identity(stat)});}
 }catch(error){problem=error;}
 finally{
  const outcomes=await Promise.allSettled(pending.map(p=>awaitFieldMapFullEvidenceWorkerV3(p.handle)));
  for(let i=0;i<outcomes.length;i++){const outcome=outcomes[i],p=pending[i];if(outcome.status==='rejected'){problem??=outcome.reason;continue;}try{need(same(identity(await lstat(p.map.evidenceFile,{bigint:true})),p.identity),'COLD_SOURCE_MAP_EVIDENCE_CHANGED');need((await coldFileHashV1(p.map.evidenceFile,2*1024**3)).sha256===p.map.evidenceSha256,'COLD_SOURCE_MAP_EVIDENCE_CHANGED');results.push(outcome.value.result);maps.push({tenantId:p.map.tenantId,facts:p.map.facts,evidenceFile:p.map.evidenceFile,evidenceSha256:p.map.evidenceSha256,batchReadStatistics:null,independent:outcome.value.result,independentWorker:outcome.value.terminal});}catch(error){problem??=error;}}
  try{need(same(identity(await lstat(directory,{bigint:true})),identity(dir))&&await realpath(directory)===directory&&canonical(frame)===originalFrame&&canonical(set)===originalSet,'COLD_SOURCE_PARALLEL_ORIGINAL_INPUT_CHANGED');}catch(error){problem??=error;}
 }
 if(problem)throw problem;need(results.length===set.databases.filter(d=>d.map).length&&maps.length===results.length,'COLD_SOURCE_PARALLEL_COMPLETE_RESULTS_REQUIRED');
 return{format:'COLD_SOURCE_FULL_EVIDENCE_PARALLEL_V1',results,sourceEvidenceWorkers:maps,allOriginalWorkerHandlesNormallyClosed:true,originalSourceBytesAndIdentitiesUnchanged:true,sourceOrUserOrRuntimeAuthorityGranted:false};
}
