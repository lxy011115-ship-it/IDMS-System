import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {coldSourceMapProfileV1,assertColdSourceMapFactsV1} from './cold-source-full-facts-v2.mjs';
import {captureFieldMapFullFactsOneShotV1} from './field-map-full-facts-one-shot-v1.mjs';
import {launchFieldMapFullEvidenceWorkerV2} from './field-map-full-evidence-worker-owner-v2.mjs';
import {coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {reviewSourceNeedV1 as need} from './workflow-review-source-facts-v1.mjs';
export async function captureColdTargetMapFactsParallelEvidenceV2(c,frame,baseline,targetDirectory,workDirectory){
 const original=baseline.map;need(original,'COLD_SOURCE_MAP_COVERAGE');const profile=coldSourceMapProfileV1(frame,original.profile.fenceBinding,original.profile.binding,targetDirectory),file=join(workDirectory,'target-map-'+original.tenantId+'-'+randomUUID()+'.jsonl');
 const captured=await captureFieldMapFullFactsOneShotV1(c,profile,original.facts.head,file);assertColdSourceMapFactsV1(captured.facts,original.facts);const evidenceSha256=(await coldFileHashV1(file,2*1024**3)).sha256,independentWorkerHandle=await launchFieldMapFullEvidenceWorkerV2({file,expectedFacts:captured.facts,workDirectory});return{tenantId:original.tenantId,facts:captured.facts,evidenceFile:file,evidenceSha256,independentWorkerHandle,batchReadStatistics:captured.batchReadStatistics};
}
