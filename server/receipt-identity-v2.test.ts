import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonical,digest} from './imports.ts';
import {freezeCoveragePayload,verifyCoveragePayload} from './frozen-coverage-v1.ts';
import {freezeCoveragePayloadV2,verifyCoveragePayloadV2,coverageV2MathInput,type FrozenCoverageInputV2} from './frozen-coverage-v2.ts';
import {qualityEvaluationPackage,verifyQualityEvaluationPackage} from './quality-policy-evaluation.ts';
import {qualityEvaluationPackageV2,verifyQualityEvaluationPackageV2} from './quality-policy-evaluation-v2.ts';
import {receiptVerificationVersion} from './receipt-identity-v2.ts';
import {reportGenerated,reportChanged,appendReportState,verifyReportPayload,reportEventHash,reportFamily} from './report-events.ts';
import {verifyFrozenReportExport} from './report-export.ts';
const golden=()=>JSON.parse(readFileSync(new URL('../scripts/fixtures/frozen-coverage-v1-golden.json',import.meta.url),'utf8'));
const telemetryInput=()=>JSON.parse(readFileSync(new URL('../scripts/fixtures/governed-quality-v1-golden.json',import.meta.url),'utf8')).find((p:any)=>p.input.source==='TELEMETRY').input;
const v2=(input:any):FrozenCoverageInputV2=>({...structuredClone(input),format:'idms-coverage-input-v2',receiptVerificationVersion});
test('receipt v2 uses explicit frozen input and result domains while preserving coverage math',()=>{
 const old=golden(),next=freezeCoveragePayloadV2(v2(old.input));assert.deepEqual(verifyCoveragePayload(old),old);assert.deepEqual(verifyCoveragePayloadV2(next),next);assert.notEqual(next.inputDigest,old.inputDigest);assert.notEqual(next.resultDigest,old.resultDigest);assert.deepEqual(next.result.items,old.result.items);assert.equal(next.result.receiptVerificationVersion,receiptVerificationVersion);assert.equal(next.result.fieldCommissioned,false);assert.ok(Object.isFrozen(next.input));assert.equal(canonical(freezeCoveragePayload(coverageV2MathInput(next.input))),canonical(old));
});
test('receipt versions cannot be relabeled or guessed by either frozen verifier',()=>{
 const old=golden(),next=freezeCoveragePayloadV2(v2(old.input));assert.throws(()=>verifyCoveragePayload(next));assert.throws(()=>verifyCoveragePayloadV2(old));
 for(const change of [(p:any)=>delete p.input.receiptVerificationVersion,(p:any)=>p.input.receiptVerificationVersion='v1',(p:any)=>p.input.format='idms-coverage-input-v1',(p:any)=>p.input.receiptRule='unknown',(p:any)=>p.input.signingKey='private',(p:any)=>p.result.ruleVersion=old.result.ruleVersion]){const p=structuredClone(next);change(p);p.inputDigest=digest(canonical(p.input));p.resultDigest=digest(canonical(p.result));assert.throws(()=>verifyCoveragePayloadV2(p));}
});
test('UUID receipt rules do not weaken unknown, cutoff or immutable coverage input rules',()=>{
 const input=v2(golden().input);input.imports=[];const next=freezeCoveragePayloadV2(input);assert.ok(next.result.items.every(i=>i.status==='UNKNOWN'));assert.ok(next.result.items.every(i=>i.goodValidCoveragePercent===null));
 const late=v2(telemetryInput());late.telemetry[0].receivedAt='2999-01-01T00:00:00.000Z';assert.throws(()=>freezeCoveragePayloadV2(late));const duplicate=v2(telemetryInput());duplicate.telemetry.push(duplicate.telemetry[0]);assert.throws(()=>freezeCoveragePayloadV2(duplicate));
});
test('both old policy golden packages and v2 packages recompute under their own strict domains',()=>{
 const packs=JSON.parse(readFileSync(new URL('../scripts/fixtures/governed-quality-v1-golden.json',import.meta.url),'utf8'));
 for(const old of packs){assert.equal(verifyQualityEvaluationPackage(old).consistent,true);assert.equal(canonical(qualityEvaluationPackage(old.input,old.policy)),canonical(old));const next=qualityEvaluationPackageV2(v2(old.input),old.policy);assert.equal(verifyQualityEvaluationPackageV2(next).consistent,true);assert.equal(next.result.status,old.result.status);assert.deepEqual(next.result.items,old.result.items);assert.notEqual(next.inputDigest,old.inputDigest);assert.throws(()=>verifyQualityEvaluationPackage(next));assert.throws(()=>verifyQualityEvaluationPackageV2(old));const forged=structuredClone(next);forged.result.summary.ruleEvaluations++;forged.resultDigest=digest(canonical(forged.result));assert.throws(()=>verifyQualityEvaluationPackageV2(forged));}
});
test('v2 report retains independent approval and strict format-family binding through offline export',()=>{
 const payload=freezeCoveragePayloadV2(v2(golden().input)),at=new Date(Date.parse(payload.input.query.knownAt)+1000).toISOString(),author={tenantId:'acme',actorType:'USER',actorId:'author',authMode:'oidc' as const,roles:['tenant-admin','final-approver'],correlationId:'uuid-v2'},reviewer={...author,actorId:'independent'},event=reportGenerated(payload,'新版回执覆盖',author,'request-key',digest('request'),at),first=appendReportState(null,event),submit=reportChanged(first,'SUBMITTED',{expectedRevision:1,expectedPayloadDigest:first.payloadDigest},author,'submit-key',digest('submit'),at),pending=appendReportState(first,submit),approval={expectedRevision:2,expectedPayloadDigest:first.payloadDigest,decision:'APPROVED',comment:'独立核对新版本'};
 assert.equal(first.summary.kind,'COVERAGE_V2');assert.throws(()=>reportChanged(pending,'APPROVED',approval,author,'approval-key',digest('approve'),at),(e:any)=>e.status===403);const approved=reportChanged(pending,'APPROVED',approval,reviewer,'approval-key',digest('approve'),at),state=appendReportState(pending,approved);assert.deepEqual(verifyReportPayload(state,payload),payload);
 const pack={format:'idms-frozen-coverage-export-v2',report:state,events:[event,submit,approved],payload,verification:'SHA_AND_RECOMPUTATION_NOT_AN_EXTERNAL_SIGNATURE',notice:'可重算但非外部签名'};assert.equal(verifyFrozenReportExport(pack).consistent,true);assert.throws(()=>verifyFrozenReportExport({...pack,format:'idms-frozen-coverage-export-v1'}));assert.throws(()=>verifyReportPayload(state,golden()));
});
test('unknown and null report families remain invalid after adding the explicit v2 family',()=>{
 const p=freezeCoveragePayloadV2(v2(golden().input)),ctx={tenantId:'acme',actorType:'USER',actorId:'author',authMode:'oidc' as const,roles:['tenant-admin'],correlationId:'uuid-v2'},at=new Date(Date.parse(p.input.query.knownAt)+1000).toISOString(),event=reportGenerated(p,'新版',ctx,'request-key',digest('request'),at);
 for(const kind of [null,'COVERAGE','COVERAGE_v2','UNKNOWN',42]){const e=structuredClone(event);(e.metadata as any).kind=kind;e.hash=reportEventHash(e);assert.throws(()=>appendReportState(null,e));}assert.equal(reportFamily('COVERAGE_V2'),'COVERAGE_V2');assert.throws(()=>reportFamily('UNKNOWN'));
});
test('fixed native approved v2 report keeps original inputs, approval events and independent recomputation',()=>{
 const pack=JSON.parse(readFileSync(new URL('../scripts/fixtures/frozen-coverage-v2-export-golden.json',import.meta.url),'utf8'));assert.equal(verifyFrozenReportExport(pack).consistent,true);assert.equal(pack.report.status,'APPROVED');assert.equal(pack.payload.input.telemetry.length,3);assert.equal(pack.payload.result.items[0].goodValidSlots,3);assert.equal(pack.events.length,3);assert.equal(pack.report.summary.kind,'COVERAGE_V2');
});
test('fixed native v2 policy package retains its own exact version, hashes and passing declared rule',()=>{
 const pack=JSON.parse(readFileSync(new URL('../scripts/fixtures/governed-quality-v2-golden.json',import.meta.url),'utf8'));assert.equal(verifyQualityEvaluationPackageV2(pack).consistent,true);assert.equal(pack.input.telemetry.length,3);assert.equal(pack.result.status,'PASS');assert.equal(canonical(qualityEvaluationPackageV2(pack.input,pack.policy)),canonical(pack));
});
