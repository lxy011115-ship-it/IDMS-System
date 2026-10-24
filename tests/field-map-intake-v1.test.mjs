import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fieldMapIntakeModelV1} from '../scripts/fixtures/field-map-intake-model-v1.mjs';
import {fieldIntakeDecision,fieldIntakeFingerprint} from '../server/field-intake-decision.ts';
import {fieldIntakeDecisionMapV1,fieldIntakeFingerprintMapV1} from '../server/field-map-intake-decision-v1.ts';
import {planFieldReceiveMapV1,fieldMapPointBodyV1,fieldMapPointKeyV1,fieldMapReceiptKeyV1,inspectFieldMapReceiptV1} from '../server/field-map-receive-v1.ts';
import {fieldPointBody} from '../server/field-receive.ts';
import {readFieldMapPointPageV1} from '../server/field-map-point-query-v1.ts';
import {signFieldEvent} from '../integrations/field-event.ts';
import {verifyAuditChain} from '../server/audit.ts';

const receive=(f,e,s=f.snapshot())=>planFieldReceiveMapV1(s,e,f.profile,f.registry,f.keys.publicKey,f.storage);
const clone=(f,e,patch)=>{const {signature,...body}=e;return signFieldEvent({...body,...patch},f.eventKey,f.profile,f.keys.publicKey);};
const keys=f=>new Map([[f.registry.leaseKeyId,f.keys.publicKey]]);

test('current-map intake decision and fingerprint match the original protocol rule',async()=>{
 const f=fieldMapIntakeModelV1(),e=f.events()[0],at=Date.now(),actual=await fieldIntakeDecisionMapV1(f.snapshot(),f.profile,f.registry,e,f.keys.publicKey,at),expected=fieldIntakeDecision({...f.payload.business,audits:f.payload.audits},f.payload.imports,f.profile,f.registry,e,f.keys.publicKey,at);assert.deepEqual(actual,expected);assert.equal(fieldIntakeFingerprintMapV1(actual),fieldIntakeFingerprint(expected));
});
test('one planner atomically adds the point, receipt, audit and query indexes; exact replay adds nothing',async()=>{
 const f=fieldMapIntakeModelV1(),e=f.events()[0],p=await receive(f,e);assert.equal(p.candidate.status,'STORED');assert(p.operations.length<=64);f.apply(p.operations);const audit=f.auditImage().at(-1),point=f.map.get('blob\0'+fieldMapPointKeyV1(e.eventId));assert.deepEqual(point,fieldPointBody(e,audit));assert.deepEqual(point,fieldMapPointBodyV1(e,audit));assert(verifyAuditChain(f.auditImage(),'acme'));
 const before=f.head(),replay=await receive(f,e);assert(replay.replayed);assert.deepEqual(replay.candidate,p.candidate);assert.equal(replay.operations.length,0);assert.deepEqual(f.head(),before);
});
test('event id, stream sequence and read id conflicts retain the original priority and never add a point',async()=>{
 const f=fieldMapIntakeModelV1(),e=f.events()[0];f.apply((await receive(f,e)).operations);const cases=[clone(f,e,{sequenceNo:e.sequenceNo+1,witness:{...e.witness,readId:randomUUID()}}),clone(f,e,{eventId:randomUUID(),witness:{...e.witness,readId:randomUUID()}}),clone(f,e,{eventId:randomUUID(),sequenceNo:e.sequenceNo+2})];
 for(const [i,event]of cases.entries()){const p=await receive(f,event);assert.equal(p.candidate.reason,['FIELD_EVENT_ID_CONFLICT','FIELD_SEQUENCE_CONFLICT','FIELD_READ_ID_CONFLICT'][i]);f.apply(p.operations);assert.equal([...f.map.keys()].filter(k=>k.startsWith('blob\0field_point:')).length,1);assert.equal((await receive(f,event)).operations.length,0);}
});
test('policy pause precedes old receipt lookup and appends a denial without deleting prior data',async()=>{
 const f=fieldMapIntakeModelV1(),e=f.events()[0];const stored=await receive(f,e);f.apply(stored.operations);f.pause();const p=await receive(f,e);assert.equal(p.candidate.status,'REJECTED');assert.equal(p.candidate.reason,'FIELD_APPROVAL_PAUSED');assert.notEqual(p.candidate.receiptAuditId,stored.candidate.receiptAuditId);assert(p.operations.every(o=>!['receipt','field_event','field_sequence','field_read'].includes(o.namespace)));f.apply(p.operations);assert(f.map.has('receipt\0'+fieldMapReceiptKeyV1(e)));assert.equal(f.auditImage().at(-1).action,'FIELD_EVENT_REPLAY_DENIED');
});
test('reverse point pages share one root, expose actual stored values and keep historical points visible after pause',async()=>{
 const f=fieldMapIntakeModelV1(),events=f.events();for(const e of events)f.apply((await receive(f,e)).operations);const s=f.snapshot(),first=await readFieldMapPointPageV1(s,f.profile.source.deviceCode,f.storage,keys(f),{limit:1});assert.equal(first.items.length,1);assert.equal(first.total,String(events.length));assert.equal(first.items[0].point.id,events.at(-1).eventId);const second=await readFieldMapPointPageV1(s,f.profile.source.deviceCode,f.storage,keys(f),{limit:1,beforePosition:first.nextBeforePosition});assert.equal(second.items[0].point.id,events[0].eventId);assert.equal(second.nextBeforePosition,null);f.pause();const after=await readFieldMapPointPageV1(f.snapshot(),f.profile.source.deviceCode,f.storage,keys(f));assert.equal(after.items.length,events.length);assert(after.items.every(i=>i.receipt.status==='STORED'));
});
test('receipt, point and cross-database storage changes cannot produce a replay acknowledgement',async()=>{
 for(const kind of ['receipt','point','storage']){const f=fieldMapIntakeModelV1(),e=f.events()[0];f.apply((await receive(f,e)).operations);if(kind==='receipt')f.map.get('receipt\0'+fieldMapReceiptKeyV1(e)).receivedAt='2020-01-01T00:00:00.000Z';if(kind==='point')f.map.get('blob\0'+fieldMapPointKeyV1(e.eventId)).sample.value+=1;if(kind==='storage')f.storage={...f.storage,databaseOid:'7'};await assert.rejects(receive(f,e),/FIELD_MAP_(RECEIPT|POINT)_INTEGRITY/);}
});
test('current admission is withdrawn during staging and missing intake preparation is not an empty dataset',async()=>{
 const f=fieldMapIntakeModelV1(),e=f.events()[0];f.map.get('domain_head\0control').status='UPDATING';await assert.rejects(receive(f,e),/FIELD_ADMISSION_MAP_NOT_ACTIVE/);f.map.get('domain_head\0control').status='ACTIVE';f.map.delete('domain_head\0field_intake');await assert.rejects(receive(f,e),/UNIT_REQUIRED_MEMBER_MISSING/);
});
test('competing plans preserve both points only after a fresh CAS plan and query arguments are bounded',async()=>{
 const f=fieldMapIntakeModelV1(),events=f.events(),a=await receive(f,events[0]),b=await receive(f,events[1]);f.apply(a.operations);assert.throws(()=>f.apply(b.operations),/UNIT_CAS_CONFLICT/);f.apply((await receive(f,events[1])).operations);assert(verifyAuditChain(f.auditImage(),'acme'));for(const options of [{limit:17},{limit:0},{beforePosition:'0'},{beforePosition:'999999'}])await assert.rejects(readFieldMapPointPageV1(f.snapshot(),f.profile.source.deviceCode,f.storage,keys(f),options));
});
test('historical read verifies committed receipt and lease proof without reauthenticating an event HMAC',async()=>{
 const f=fieldMapIntakeModelV1(),e=f.events()[0];f.apply((await receive(f,e)).operations);const raw=f.map.get('receipt\0'+fieldMapReceiptKeyV1(e)),result=await inspectFieldMapReceiptV1(f.snapshot(),raw,f.keys.publicKey,f.storage);assert.equal(result.event.eventId,e.eventId);assert.equal(result.receipt.status,'STORED');const missing=new Map();await assert.rejects(readFieldMapPointPageV1(f.snapshot(),f.profile.source.deviceCode,f.storage,missing),/FIELD_MAP_HISTORICAL_KEY_REQUIRED/);
});
