import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalDigest,canonicalEqual} from '../server/canonical-state.ts';
import {fieldAdmissionDecision,fieldAdmissionBindingDigest} from '../server/field-admission.ts';
import {compileFieldAdmissionMapV1,readFieldAdmissionMapV1,readCurrentFieldAdmissionMapV1,fieldAdmissionProfilesV1} from '../server/field-admission-map-v1.ts';
import {encodeGovernanceCandidateV4} from '../server/governance-plan-v4.ts';
import {encodeGovernanceCandidateV5} from '../server/governance-plan-v5.ts';
import {telemetryDomainFormat} from '../server/telemetry-map-v4.ts';
import {publicGovernedSource} from '../server/source-governance.ts';
import {fieldIssuanceFixture} from '../scripts/fixtures/field-issuance-model.mjs';
import {telemetryQualityFixture} from '../scripts/fixtures/telemetry-quality-model.mjs';
import {tenantSeed} from '../scripts/database-migrations.mjs';

function payload(f){const {audits,idempotency,...business}=f.store;return tenantSeed({version:2,business,audits,imports:f.imports,idempotency:[...idempotency]},'acme');}
function compiled(entries){const map=new Map(entries.map(e=>[e.namespace+'\0'+e.key,JSON.parse(e.valueText)]));let reads=0;return {map,get:async(ns,key)=>{reads++;assert.ok(!['v4_entity','audit','audit_order','legacy_payload','v4_collection'].includes(ns),'runtime read reconstructed business history');assert(map.has(ns+'\0'+key),'FIELD_TEST_MEMBER_MISSING');return structuredClone(map.get(ns+'\0'+key));},get reads(){return reads;}};}
function scheduled(){const f=fieldIssuanceFixture(),last=Math.max(...f.store.audits.map(a=>Date.parse(a.businessTime))),pauseAt=last+2000,policy=structuredClone(f.policy);policy.changeIntent='PROSPECTIVE';policy.entries.push({id:'pause',effectiveFrom:new Date(pauseAt).toISOString(),reason:'scheduled independent QA pause',admission:null});f.publish('field-channel-policy','fieldChannelPolicy',policy,'issuer-qa-field','1.0.1');return {f,pauseAt};}

test('compiled field decisions equal the original rules on every boundary and preserve exact query time',async()=>{
  const {f}=scheduled(),p=payload(f),c=compileFieldAdmissionMapV1(p,'acme'),s=compiled(c.entries),anchor=canonicalDigest(p),boundaries=new Set([Date.now()+100]);
  for(const e of c.entries)if(e.key.startsWith('field_admission_node:')){const n=JSON.parse(e.valueText);if(n.kind==='LEAF'){boundaries.add(n.from);if(n.until!==null)boundaries.add(n.until);}}
  let comparisons=0;
  for(const b of boundaries)for(const at of [b-1,b,b+1].filter(n=>Number.isSafeInteger(n)&&n>=-8640000000000000&&n<=8640000000000000))for(const tag of [null,...f.profile.points.map(p=>p.tagCode),'unregistered_field_tag']){
    const v=await readFieldAdmissionMapV1(f.profile,at,tag,anchor,s.get),expected=fieldAdmissionDecision(f.store,f.imports,f.profile,at,tag);
    assert.deepEqual(v.decision,expected);assert.equal(v.decision.binding.evaluatedAt,new Date(at).toISOString());assert(v.nodeReads<=64);
    if(expected.allowed)assert.equal(fieldAdmissionBindingDigest(v.decision),fieldAdmissionBindingDigest(expected));comparisons++;
  }
  assert(comparisons>20);assert.equal(c.heads.length,1);assert.equal(c.heads[0].compiledPayloadDigest,anchor);
});

test('unknown point uses a separate denial; scheduled pause is effective at the exact boundary',async()=>{
  const {f,pauseAt}=scheduled(),p=payload(f),c=compileFieldAdmissionMapV1(p,'acme'),s=compiled(c.entries),anchor=canonicalDigest(p);
  assert.equal((await readFieldAdmissionMapV1(f.profile,pauseAt-1,null,anchor,s.get)).decision.allowed,true);
  const unknown=await readFieldAdmissionMapV1(f.profile,pauseAt-1,'unregistered_field_tag',anchor,s.get);assert.equal(unknown.decision.allowed,false);assert(unknown.decision.binding.conditions.includes('FIELD_EVENT_POINT_UNDECLARED'));
  assert.equal((await readFieldAdmissionMapV1(f.profile,pauseAt,null,anchor,s.get)).decision.allowed,false);
  assert.equal((await readFieldAdmissionMapV1(f.profile,pauseAt+1,null,anchor,s.get)).decision.allowed,false);
});

test('stale governance anchor, mismatched profile and tenant are rejected before returning admission',async()=>{
  const f=fieldIssuanceFixture(),p=payload(f),c=compileFieldAdmissionMapV1(p,'acme'),s=compiled(c.entries),anchor=canonicalDigest(p),at=Math.max(...p.audits.map(a=>Date.parse(a.businessTime)))+10;
  await assert.rejects(readFieldAdmissionMapV1(f.profile,at,null,'0'.repeat(64),s.get),/FIELD_ADMISSION_MAP_STALE/);
  const profile=structuredClone(f.profile);profile.opcua.serverCertificateSha256='c'.repeat(64);
  await assert.rejects(readFieldAdmissionMapV1(profile,at,null,anchor,async(ns,key)=>ns==='field_admission'?c.heads[0]:s.get(ns,key)),/FIELD_ADMISSION_MAP_INTEGRITY/);
  assert.throws(()=>fieldAdmissionProfilesV1(p,'sandbox'));
  await assert.rejects(readFieldAdmissionMapV1(f.profile,NaN,null,anchor,s.get),/FIELD_ADMISSION_MAP_INTEGRITY/);
  await assert.rejects(readFieldAdmissionMapV1(f.profile,at,'bad\0tag',anchor,s.get),/FIELD_ADMISSION_MAP_TAG/);
});

test('changed tree or decision bytes cannot produce a successful decision',async()=>{
  const f=fieldIssuanceFixture(),p=payload(f),c=compileFieldAdmissionMapV1(p,'acme'),anchor=canonicalDigest(p),at=Math.max(...p.audits.map(a=>Date.parse(a.businessTime)))+10;
  const tree=compiled(c.entries),id='blob\0field_admission_node:'+c.heads[0].root;tree.map.get(id).profileDigest='0'.repeat(64);
  await assert.rejects(readFieldAdmissionMapV1(f.profile,at,null,anchor,tree.get),/FIELD_ADMISSION_MAP_INTEGRITY/);
  const doc=compiled(c.entries);for(const [key,value]of doc.map)if(key.startsWith('blob\0field_admission_decision:')&&value.inline)value.inline=value.inline.replace('APPROVED_FIELD_CONFIGURATION','DENIED');
  await assert.rejects(readFieldAdmissionMapV1(f.profile,at,null,anchor,doc.get));
});

test('one candidate contains both the current governance anchor and all matching field heads',()=>{
  const f=fieldIssuanceFixture(),p=payload(f),control={format:telemetryDomainFormat,tenantId:'acme',status:'ACTIVE',epoch:'1',legacySealKey:'0'.repeat(64),governanceAnchorDigest:canonicalDigest(p)},sources=[publicGovernedSource(f.sources[0])];
  const entries=[...encodeGovernanceCandidateV5(p,0,control,sources)],head=JSON.parse(entries.find(e=>e.namespace==='domain_head'&&e.key==='control').valueText),field=entries.filter(e=>e.namespace==='field_admission');
  assert.equal(field.length,1);assert.equal(JSON.parse(field[0].valueText).compiledPayloadDigest,head.governanceAnchorDigest);
  const keys=new Set();for(const e of entries){assert(!keys.has(e.namespace+'\0'+e.key));keys.add(e.namespace+'\0'+e.key);}
  const text=JSON.stringify(entries);for(const secret of [f.requestKey.toString('hex'),f.requestKey.toString('base64'),'BEGIN PRIVATE KEY'])assert(!text.includes(secret));
});

test('when no field policy is published the candidate remains identical to the original governance planner',()=>{
  const f=telemetryQualityFixture({count:0}),p=payload(f),control={format:telemetryDomainFormat,tenantId:'acme',status:'ACTIVE',epoch:'1',legacySealKey:'0'.repeat(64),governanceAnchorDigest:canonicalDigest(p)},sources=[publicGovernedSource(f.sources[0])];
  assert.equal(compileFieldAdmissionMapV1(p,'acme').heads.length,0);assert(canonicalEqual([...encodeGovernanceCandidateV4(p,0,control,sources)],[...encodeGovernanceCandidateV5(p,0,control,sources)]));
});

test('current entry withdraws admission during UPDATING or PAUSED before loading any field decision',async()=>{
  const f=fieldIssuanceFixture(),p=payload(f),c=compileFieldAdmissionMapV1(p,'acme'),s=compiled(c.entries),at=Math.max(...p.audits.map(a=>Date.parse(a.businessTime)))+10;
  const control={format:telemetryDomainFormat,tenantId:'acme',status:'ACTIVE',epoch:'1',legacySealKey:'0'.repeat(64),governanceAnchorDigest:canonicalDigest(p)};let fieldReads=0;
  const get=async(ns,key)=>{if(ns==='domain_head'&&key==='control')return control;fieldReads++;return s.get(ns,key);};
  assert.equal((await readCurrentFieldAdmissionMapV1(f.profile,at,null,get)).decision.allowed,true);
  for(const status of ['UPDATING','PAUSED']){control.status=status;fieldReads=0;await assert.rejects(readCurrentFieldAdmissionMapV1(f.profile,at,null,get),/FIELD_ADMISSION_MAP_NOT_ACTIVE/);assert.equal(fieldReads,0);}
});
