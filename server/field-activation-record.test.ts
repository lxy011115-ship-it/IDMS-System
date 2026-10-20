import assert from 'node:assert/strict';
import test from 'node:test';
import {activationBaseline,activationPhase,activationPrepared,activationPhasePrefix,readActivationPhase} from '../scripts/field-activation-record.mjs';
import {sourceFreezeSha as sha} from '../scripts/field-source-freeze-policy.mjs';
const id=(n:string)=>n.repeat(8)+'-'+n.repeat(4)+'-4'+n.repeat(3)+'-8'+n.repeat(3)+'-'+n.repeat(12),hash='a'.repeat(64);
const phase=()=>({format:'idms-field-activation-phase-v1',operationId:id('1'),attemptId:id('2'),backupId:id('3'),planId:id('4'),databaseName:'idms_qa_activation',databaseOid:'12345',stage:'ACTIVATED',approvalPhaseSha256:hash,attemptSha256:hash,baselineSha256:hash,publicationSha256:hash,runtimePolicySha256:hash,registryEventId:id('5'),registryEventHash:hash,registryRevision:'2',registrySha256:hash,activationAuditEventId:id('6'),activationAuditHead:hash,auditEvents:10,revision:5,initialFactsSha256:hash,activeControlSha256:hash});
function baseline(){const rootRecord='{"revision":4,"payload_digest":"'+hash+'","updated_at":"2026-10-18T09:00:00.123456+00:00"}',body={revision:4,root:JSON.parse(rootRecord),relations:[{schema:'public',table:'business_state',sha256:sha(rootRecord+'\n')}]};return {format:'idms-field-activation-baseline-v1',operationId:id('1'),attemptId:id('2'),facts:{...body,factsSha256:sha(body),sequenceValuesAreNotMvcc:true,maximumSupportedRowBytes:64*1024**2},rootRecord};}
test('activation baseline seals the physical microsecond root independently of the normalized facts',()=>{
 const b=baseline();assert.deepEqual(activationBaseline(b),b);assert.throws(()=>activationBaseline({...b,rootRecord:b.rootRecord.replace('123456','123999')}));assert.throws(()=>activationBaseline({...b,facts:{...b.facts,revision:5}}));
});
test('committed activation database marker requires exact canonical body, database and OID',async()=>{
 const p=activationPhase(phase()),comment=activationPhasePrefix+JSON.stringify(Object.fromEntries(Object.entries(p).sort(([a],[b])=>a.localeCompare(b))));
 const canonical=(v:any):string=>v&&typeof v==='object'&&!Array.isArray(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
 const client=(body:string,oid='12345')=>({query:async()=>({rows:[{oid,comment:body}]})});assert.deepEqual(await readActivationPhase(client(activationPhasePrefix+canonical(p)),'idms_qa_activation'),p);
 for(const [body,oid]of [[comment+'\n','12345'],[activationPhasePrefix+canonical(p),'12346'],[activationPhasePrefix+canonical({...p,databaseName:'other'}),'12345']])await assert.rejects(readActivationPhase(client(body,oid),'idms_qa_activation'));
 assert.throws(()=>activationPhase({...p,stage:'APPROVED'}));assert.throws(()=>activationPhase({...p,registryRevision:'0'}));assert.throws(()=>activationPhase({...p,extra:true}));
});
test('prepared commit witness cannot change its initial facts or database phase independently',()=>{
 const b=baseline(),body={...b.facts,revision:5,root:{...b.facts.root,revision:5},auditEvents:10,auditHead:hash},rootRecord=JSON.stringify(body.root);body.relations=[{schema:'public',table:'business_state',sha256:sha(rootRecord+'\n')}];const {factsSha256:old,...factsBody}=body;delete (factsBody as any).sequenceValuesAreNotMvcc;delete (factsBody as any).maximumSupportedRowBytes;const facts={...body,factsSha256:sha(factsBody)},p={...phase(),initialFactsSha256:facts.factsSha256},v={format:'idms-field-activation-prepared-v1',operationId:b.operationId,attemptId:b.attemptId,phase:p,facts,rootRecord};assert.deepEqual(activationPrepared(v),v);assert.throws(()=>activationPrepared({...v,phase:{...p,activationAuditHead:'b'.repeat(64)}}));assert.throws(()=>activationPrepared({...v,phase:{...p,initialFactsSha256:'b'.repeat(64)}}));
});
