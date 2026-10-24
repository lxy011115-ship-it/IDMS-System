import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fieldIssuanceFixture} from '../scripts/fixtures/field-issuance-model.mjs';
import {tenantSeed} from '../scripts/database-migrations.mjs';
import {publicGovernedSource} from '../server/source-governance.ts';
import {canonicalDigest} from '../server/canonical-state.ts';
import {telemetryDomainFormat} from '../server/telemetry-map-v4.ts';
import {encodeGovernanceCandidateV6} from '../server/governance-plan-v6.ts';
import {compileFieldRuntimeMapV1} from '../server/field-runtime-map-v1.ts';
import {planFieldRegistryObservationMapV1,planFieldLeaseIssuanceMapV1,fieldCurrentLeaseCheckMapV1} from '../server/field-map-lease-v1.ts';
import {prepareFieldLeaseIssuance} from '../server/field-lease-issue.ts';
import {fieldCurrentLeaseCheck} from '../server/field-current-check.ts';
import {appendFieldRegistryObservation} from '../server/field-registry.ts';
import {verifyAuditChain} from '../server/audit.ts';
import {stateValueText,stateValueHash} from '../server/state-map-v1.ts';
import {signFieldLease} from '../integrations/field-lease.ts';
import {signFieldCheckRequest} from '../integrations/field-check.ts';

function fixture(){
 const f=fieldIssuanceFixture(),{audits,idempotency,...business}=f.store,payload=tenantSeed({version:2,business,audits,imports:f.imports,idempotency:[...idempotency]},'acme'),control={format:telemetryDomainFormat,tenantId:'acme',status:'ACTIVE',epoch:'1',legacySealKey:'0'.repeat(64),governanceAnchorDigest:canonicalDigest(payload)},map=new Map([...encodeGovernanceCandidateV6(payload,0,control,[publicGovernedSource(f.sources[0])])].map(e=>[e.namespace+'\0'+e.key,JSON.parse(e.valueText)]));
 let reads=0;const snapshot=()=>({tenantId:'acme',head:{},state:async(ns,key)=>{reads++;const k=ns+'\0'+key,v=map.get(k);return map.has(k)?{present:true,value:structuredClone(v),valueHash:stateValueHash(stateValueText(v))}:{present:false,value:null,valueHash:null};},get:async function(ns,key){const r=await this.state(ns,key);assert(r.present,'TEST_REQUIRED_MEMBER_MISSING');return r.value;},operation:async function(ns,key,value){return {namespace:ns,key,expected:(await this.state(ns,key)).valueHash,valueText:stateValueText(value)};}});
 const apply=ops=>{for(const op of ops){const value=map.get(op.namespace+'\0'+op.key);assert.equal(value===undefined?null:stateValueHash(stateValueText(value)),op.expected,'TEST_CAS_CONFLICT');}for(const op of ops)map.set(op.namespace+'\0'+op.key,JSON.parse(op.valueText));};
 const auditImage=()=>[...map].filter(([k])=>k.startsWith('audit_order\0')).sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>map.get('audit\0'+v.eventId));
 return {...f,registry:f.snapshot,payload,map,snapshot,apply,auditImage,get reads(){return reads;}};
}
async function issued(){const f=fixture();f.apply((await planFieldRegistryObservationMapV1(f.snapshot(),f.registry,'map-qa-a')).operations);const request=f.request(),plan=await planFieldLeaseIssuanceMapV1(f.snapshot(),request,f.registry);f.apply(plan.operations);return {...f,requestValue:request,lease:signFieldLease(plan.value,f.keys.privateKey)};}
const checkRequest=(f,at=Date.now(),lease=f.lease)=>signFieldCheckRequest({format:'idms-field-lease-check-request-v1',requestId:randomUUID(),requestedAtMs:at,lease},f.requestKey);

test('maintenance proves empty history before registration; missing marker never means no history',async()=>{
 const f=fixture();assert.equal(compileFieldRuntimeMapV1(f.payload,'acme').length,1);f.map.delete('domain_head\0field_runtime');await assert.rejects(planFieldRegistryObservationMapV1(f.snapshot(),f.registry,'map-qa'),/TEST_REQUIRED_MEMBER_MISSING/);
});
test('registration is idempotent and preserves the original audit format and chain',async()=>{
 const f=fixture(),p=await planFieldRegistryObservationMapV1(f.snapshot(),f.registry,'map-qa');assert(p.value.changed);assert.equal(p.operations.length,4);f.apply(p.operations);const again=await planFieldRegistryObservationMapV1(f.snapshot(),f.registry,'map-qa');assert.equal(again.value.changed,false);assert.equal(again.operations.length,0);assert.equal(again.value.registryEventId,p.value.registryEventId);
 const audits=f.auditImage();assert(verifyAuditChain(audits,'acme'));const store={...f.payload.business,audits};assert.deepEqual(appendFieldRegistryObservation(store,f.registry,'map-qa'),again.value);
});
test('committed issuance is accepted by the original planner and replays never renew it',async()=>{
 const f=await issued(),audits=f.auditImage(),before=audits.length,store={...f.payload.business,audits};assert(verifyAuditChain(audits,'acme'));assert.deepEqual(prepareFieldLeaseIssuance(store,f.imports,f.requestValue,f.registry),f.lease.body);assert.equal(audits.length,before);
 const replay=await planFieldLeaseIssuanceMapV1(f.snapshot(),f.requestValue,f.registry);assert.equal(replay.operations.length,0);assert.deepEqual(replay.value,f.lease.body);
 await assert.rejects(planFieldLeaseIssuanceMapV1(f.snapshot(),f.request(Date.now(),f.requestValue.requestId),f.registry),/FIELD_LEASE_REQUEST_CONFLICT/);
});
test('current check matches the original rule, is read only, and preserves original expiry',async()=>{
 const f=await issued(),at=Date.now(),request=checkRequest(f,at),before=canonicalDigest([...f.map]),audits=f.auditImage(),store={...f.payload.business,audits};const result=await fieldCurrentLeaseCheckMapV1(f.snapshot(),request,f.registry,f.keys.publicKey,at);assert(result.allowed);assert.deepEqual(result,fieldCurrentLeaseCheck(store,f.imports,request,f.registry,f.keys.publicKey,at));assert.equal(canonicalDigest([...f.map]),before);
 const expired=f.lease.body.expiresAtMs,r=checkRequest(f,expired),denied=await fieldCurrentLeaseCheckMapV1(f.snapshot(),r,f.registry,f.keys.publicKey,expired);assert.equal(denied.reason,'FIELD_LEASE_EXPIRED');assert.deepEqual(denied,fieldCurrentLeaseCheck(store,f.imports,r,f.registry,f.keys.publicKey,expired));
});
test('a valid platform signature without its exact committed issuance cannot pass current check',async()=>{
 const f=await issued(),fake=signFieldLease({...f.lease.body,leaseId:randomUUID()},f.keys.privateKey),at=Date.now();await assert.rejects(fieldCurrentLeaseCheckMapV1(f.snapshot(),checkRequest(f,at,fake),f.registry,f.keys.publicKey,at),/FIELD_MAP_ISSUANCE_INTEGRITY/);
 f.map.delete('field_issuance\0'+f.lease.body.requestId);await assert.rejects(fieldCurrentLeaseCheckMapV1(f.snapshot(),checkRequest(f,at),f.registry,f.keys.publicKey,at),/TEST_REQUIRED_MEMBER_MISSING/);
});
test('registration changes invalidate the old lease and match the original current check',async()=>{
 const f=await issued(),empty={...f.registry,channels:[]};f.apply((await planFieldRegistryObservationMapV1(f.snapshot(),empty,'map-qa-b')).operations);await assert.rejects(planFieldLeaseIssuanceMapV1(f.snapshot(),f.requestValue,f.registry),/FIELD_REGISTRY_STALE/);
 f.apply((await planFieldRegistryObservationMapV1(f.snapshot(),f.registry,'map-qa-c')).operations);const at=Date.now(),request=checkRequest(f,at),result=await fieldCurrentLeaseCheckMapV1(f.snapshot(),request,f.registry,f.keys.publicKey,at);assert.equal(result.reason,'FIELD_LEASE_REGISTRY_CHANGED');assert.deepEqual(result,fieldCurrentLeaseCheck({...f.payload.business,audits:f.auditImage()},f.imports,request,f.registry,f.keys.publicKey,at));
});
test('competing plans cannot overwrite the audit position or existing issuance indexes',async()=>{
 const f=fixture();f.apply((await planFieldRegistryObservationMapV1(f.snapshot(),f.registry,'map-qa')).operations);const a=f.request(),b=f.request(),pa=await planFieldLeaseIssuanceMapV1(f.snapshot(),a,f.registry),pb=await planFieldLeaseIssuanceMapV1(f.snapshot(),b,f.registry);f.apply(pa.operations);assert.throws(()=>f.apply(pb.operations),/TEST_CAS_CONFLICT/);f.apply((await planFieldLeaseIssuanceMapV1(f.snapshot(),b,f.registry)).operations);assert(verifyAuditChain(f.auditImage(),'acme'));assert.equal([...f.map.keys()].filter(k=>k.startsWith('field_issuance\0')).length,2);
});
test('maintenance recompile preserves all persisted runtime observations and issuance indexes',async()=>{
 const f=await issued(),payload={...f.payload,audits:f.auditImage()},entries=compileFieldRuntimeMapV1(payload,'acme');assert.equal(entries.length,3);for(const e of entries)assert.deepEqual(JSON.parse(e.valueText),f.map.get(e.namespace+'\0'+e.key));
 const h=f.map.get('domain_head\0field_registry');h.registryDigest='0'.repeat(64);await assert.rejects(planFieldLeaseIssuanceMapV1(f.snapshot(),f.requestValue,f.registry),/FIELD_MAP_REGISTRY_INTEGRITY/);
});
