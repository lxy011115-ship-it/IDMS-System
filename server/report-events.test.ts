import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeCoveragePayload,type FrozenCoverageInput} from './frozen-coverage-v1.ts';
import {reportGenerated,reportChanged,appendReportState,reportEventHash,reportRequestKey,reportReceipt,verifyReportPayload} from './report-events.ts';
const from='2026-10-15T00:00:00.000Z',to='2026-10-15T00:10:00.000Z',knownAt='2026-10-16T00:00:00.000Z',at='2026-10-16T00:00:01.000Z',sha='a'.repeat(64),ctx=(actorId:string,roles=['tenant-admin','final-approver'])=>({tenantId:'acme',actorType:'USER',actorId,authMode:'oidc' as const,roles,correlationId:'report-events'}),creator=ctx('creator'),submitter=ctx('submitter'),reviewer=ctx('reviewer',['final-approver']);
function fixture(){const input:FrozenCoverageInput={format:'idms-coverage-input-v1',tenantId:'acme',deviceCode:'DEVICE-A',source:'UPLOADS',query:{from,to,knownAt,tagCode:null,edgeId:null},imports:[],telemetry:[],registry:null,calendarContext:{schedule:null,calendars:[],segments:[{index:0,from,to,entryId:null,reason:'未声明',missing:'SCHEDULE_UNDECLARED',calendarId:null}]}},payload=freezeCoveragePayload(input),key=reportRequestKey(creator,'/api/v1/coverage-reports','idempotent-key'),event=reportGenerated(payload,'冻结报告',creator,key,sha,at),state=appendReportState(null,event),expected=(s:any)=>({expectedRevision:s.revision,expectedPayloadDigest:s.payloadDigest});return {payload,event,state,key,expected};}
test('generated report summarizes server frozen payload without embedding it in approval metadata',()=>{
 const f=fixture();assert.equal(f.state.status,'DRAFT');assert.equal(f.state.summary.inputRecordCount,0);assert.equal(f.state.summary.inputDigest,f.payload.inputDigest);assert.deepEqual(verifyReportPayload(f.state,f.payload),f.payload);assert.equal(reportReceipt(f.state).reportId,f.event.report_id);
 assert.throws(()=>reportGenerated(f.payload,'报告',{...creator,actorType:'AI'},f.key,sha,at));assert.throws(()=>reportGenerated(f.payload,'报告',{...creator,tenantId:'sandbox'},f.key,sha,at));assert.throws(()=>reportGenerated(f.payload,'报告',ctx('reader',['auditor']),f.key,sha,at));
});
test('report submission and independent human final approval append exact ordered immutable provenance',()=>{
 const f=fixture(),s=reportChanged(f.state,'SUBMITTED',f.expected(f.state),submitter,reportRequestKey(submitter,'/submit','idempotent-key'),sha,at),awaiting=appendReportState(f.state,s),a=reportChanged(awaiting,'APPROVED',{...f.expected(awaiting),decision:'APPROVED',comment:'独立核对来源与结果'},reviewer,reportRequestKey(reviewer,'/approval','idempotent-key'),sha,at),approved=appendReportState(awaiting,a);assert.equal(approved.status,'APPROVED');assert.equal(approved.createdBy,'creator');assert.equal(approved.submittedBy,'submitter');assert.equal(approved.approvedBy,'reviewer');assert.equal(approved.revision,3);assert.equal(approved.payloadDigest,f.state.payloadDigest);assert.equal(a.previous_hash,s.hash);assert.deepEqual(verifyReportPayload(approved,f.payload),f.payload);
 for(const u of [creator,submitter])assert.throws(()=>reportChanged(awaiting,'APPROVED',{...f.expected(awaiting),decision:'APPROVED',comment:'本人终审被禁止'},u,f.key,sha,at),(e:any)=>e.status===403);
 assert.throws(()=>reportChanged(approved,'SUBMITTED',f.expected(approved),submitter,f.key,sha,at),(e:any)=>e.status===409);
});
test('stale revisions, changed digest, foreign tenant, scripts, injected decisions and reversed clock fail',()=>{
 const f=fixture();for(const v of [{...f.expected(f.state),expectedRevision:2},{...f.expected(f.state),expectedPayloadDigest:'0'.repeat(64)},{...f.expected(f.state),payload:f.payload},{...f.expected(f.state),decision:'APPROVED'}])assert.throws(()=>reportChanged(f.state,'SUBMITTED',v,creator,f.key,sha,at));
 assert.throws(()=>reportChanged(f.state,'SUBMITTED',f.expected(f.state),{...creator,tenantId:'sandbox'},f.key,sha,at));assert.throws(()=>reportChanged(f.state,'SUBMITTED',f.expected(f.state),creator,f.key,sha,knownAt));
});
test('header hash chain detects missing duplicate forged approval and metadata changes even with public rehash',()=>{
 const f=fixture(),submitted=reportChanged(f.state,'SUBMITTED',f.expected(f.state),creator,f.key,sha,at),state=appendReportState(f.state,submitted);assert.throws(()=>appendReportState(null,submitted));assert.throws(()=>appendReportState(state,submitted));
 for(const mutate of [(e:any)=>e.actor_type='AI',(e:any)=>e.tenant_id='sandbox',(e:any)=>e.revision=4,(e:any)=>e.payload_digest='b'.repeat(64),(e:any)=>e.previous_hash='GENESIS',(e:any)=>e.metadata.comment='changed']){const e=structuredClone(submitted);mutate(e);assert.throws(()=>appendReportState(f.state,e));}
 const forged=reportChanged(state,'APPROVED',{...f.expected(state),decision:'APPROVED',comment:'独立审批'},reviewer,f.key,sha,at);forged.actor_id=creator.actorId;forged.hash=reportEventHash(forged);assert.throws(()=>appendReportState(state,forged));
 const payload=JSON.parse(JSON.stringify(f.payload));payload.input.deviceCode='OTHER';assert.throws(()=>verifyReportPayload(f.state,payload));
});
test('return and reject retain frozen report and require creating a new report for changed content',()=>{
 for(const action of ['RETURNED','REJECTED'] as const){const f=fixture(),event=reportChanged(f.state,'SUBMITTED',f.expected(f.state),creator,f.key,sha,at),state=appendReportState(f.state,event),decision=reportChanged(state,action,{...f.expected(state),decision:action,comment:'复核依据不足'},reviewer,f.key,sha,at),final=appendReportState(state,decision);assert.equal(final.status,action);assert.deepEqual(verifyReportPayload(final,f.payload),f.payload);assert.throws(()=>reportChanged(final,'SUBMITTED',f.expected(final),creator,f.key,sha,at));}
});
test('idempotent request identity includes actor and path without accepting oversized or control keys',()=>{
 const a=reportRequestKey(creator,'/create','duplicate-key'),b=reportRequestKey(reviewer,'/create','duplicate-key'),c=reportRequestKey(creator,'/approve','duplicate-key');assert.notEqual(a,b);assert.notEqual(a,c);for(const key of ['', 'short','x'.repeat(129),'x\ncontrol-key'])assert.throws(()=>reportRequestKey(creator,'/create',key));
});
