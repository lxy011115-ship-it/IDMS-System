import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,isAbsolute} from 'node:path';
import {readRuntimeColdReviewWithFieldSourceV2} from '../../scripts/runtime-cold-readonly-control-v7.mjs';
import {loadColdSymbolicProgramReferencesQaV1} from '../../scripts/fixtures/cold-symbolic-program-consumer-v1-qa.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const inputFile=process.env.IDMS_SYMBOLIC_CONSUMER_FIXTURE;
assert(typeof inputFile==='string'&&isAbsolute(inputFile));
const input=JSON.parse(await readFile(inputFile,'utf8'));
assert.equal(input.format,'COLD_SYMBOLIC_CONSUMER_RECORDED_INPUT_V1');
assert.equal(input.offlineOnly,true);assert.equal(input.currentLinuxRuntimeProof,false);
assert(isAbsolute(input.caseDirectory));
const bytes=await readFile(join(input.caseDirectory,'verification.json'));
assert.equal(sha(bytes),input.reportSha256);
export const report=JSON.parse(bytes),work=resolve(input.caseDirectory);
assert(report.passed&&report.implementationVersion===15&&report.checks.length===60);
assert(report.cleanup.allNodeChildrenTerminal);assert.deepEqual(report.cleanup.errors,[]);
assert.equal(report.fieldCurrentMaterialsNative.cases.length,2);
export const references=await loadColdSymbolicProgramReferencesQaV1();
export const cases=[];
for(const item of report.fieldCurrentMaterialsNative.cases){
 const state=await readRuntimeColdReviewWithFieldSourceV2(item.trust);
 assert.equal(state.phase,'REVIEW_READY_V3');
 const v=item.coreFieldReview,m=v.coreMaterialEvidence;
 cases.push({item,state,source:state.source,files:m.files,binding:m.binding,
  roleResponsibilities:m.roleResponsibilities,cohort:v.coreSqlPeerCohort,v});
}
export function familyArguments(kind,index=0){
 const c=cases[index],proof=kind==='auth'?c.v.coreAuthenticationSql.authenticationSql.programPrivileges:
  kind==='workflow'?c.v.programMatrix.workflows[0]:kind==='fence'?c.v.programMatrix.fences[0]:c.v.programMatrix.retired[0];
 return{reference:references.families[kind],kind,source:c.source,roleResponsibilities:c.roleResponsibilities,
  proof,binding:c.binding,files:c.files,cohort:c.cohort};
}
export function mapArguments(index=0){const c=cases[index];return{reference:references.families.map,
 source:c.source,roleResponsibilities:c.roleResponsibilities,binding:c.binding,files:c.files,queue:c.v.coreQueueSql[0]};}
