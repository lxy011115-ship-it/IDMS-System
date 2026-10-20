import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {fieldIssuanceFixture} from '../scripts/fixtures/field-issuance-model.mjs';
import {appendFieldRegistryObservation} from './field-registry.ts';
import {prepareFieldLeaseIssuance} from './field-lease-issue.ts';
import {fieldCurrentLeaseCheck} from './field-current-check.ts';
import {signFieldLease,verifyFieldLease} from '../integrations/field-lease.ts';
import {signFieldCheck,verifyFieldCheck,signFieldCheckRequest,verifyFieldCheckRequest} from '../integrations/field-check.ts';
import {canonical} from './imports.ts';
function fixture(){const f=fieldIssuanceFixture();appendFieldRegistryObservation(f.store,f.snapshot,'check-core-a');const body=prepareFieldLeaseIssuance(f.store,f.imports,f.request(),f.snapshot),lease=signFieldLease(body,f.keys.privateKey),request=(at=Date.now())=>signFieldCheckRequest({format:'idms-field-lease-check-request-v1',requestId:randomUUID(),requestedAtMs:at,lease},f.requestKey);return {...f,lease,request};}
test('只读撤权核对独立HMAC和Ed25519域，绑定新挑战/原租约且不增加审计',()=>{
 const f=fixture(),now=Date.now(),r=f.request(now),before=canonical(f.store);assert.deepEqual(verifyFieldCheckRequest(r,f.requestKey,now),r);const body=fieldCurrentLeaseCheck(f.store,f.imports,r,f.snapshot,f.keys.publicKey,now),status=signFieldCheck(body,f.keys.privateKey);assert.equal(body.allowed,true);assert.ok(body.validUntilMs<=now+2000);assert.equal(canonical(f.store),before);assert.deepEqual(verifyFieldCheck(status,f.keys.publicKey,{requestId:r.requestId,requestedAtMs:r.requestedAtMs,lease:f.lease},now),status);assert.throws(()=>verifyFieldLease(status,f.keys.publicKey,f.lease.body,now));assert.throws(()=>verifyFieldCheck(f.lease,f.keys.publicKey,{requestId:r.requestId,requestedAtMs:r.requestedAtMs,lease:f.lease},now));
 for(const change of [{signature:'0'.repeat(64)},{format:'idms-field-lease-request-v1'},{secret:'bad'}])assert.throws(()=>verifyFieldCheckRequest({...r,...change},f.requestKey,now));assert.throws(()=>verifyFieldCheckRequest(r,randomBytes(32),now));
});
test('核对签名不能换挑战、换租约或延长有效窗口，过期及正文篡改拒绝',()=>{
 const f=fixture(),now=Date.now(),r=f.request(now),body=fieldCurrentLeaseCheck(f.store,f.imports,r,f.snapshot,f.keys.publicKey,now),status=signFieldCheck(body,f.keys.privateKey),expected={requestId:r.requestId,requestedAtMs:r.requestedAtMs,lease:f.lease};assert.throws(()=>verifyFieldCheck(status,f.keys.publicKey,{...expected,requestId:randomUUID()},now));assert.throws(()=>verifyFieldCheck(status,f.keys.publicKey,{...expected,requestedAtMs:now+1},now+1));assert.throws(()=>verifyFieldCheck(status,f.keys.publicKey,expected,body.validUntilMs));assert.throws(()=>verifyFieldCheck({...status,body:{...body,validUntilMs:body.validUntilMs+1}},f.keys.publicKey,expected,now));assert.throws(()=>signFieldCheck({...body,validUntilMs:now+2001},f.keys.privateKey));
});
test('已签租约在策略暂停或观察版本变化后返回独立签名拒绝，原记录不改',()=>{
 const f=fixture(),p=structuredClone(f.policy);p.changeIntent='RETROSPECTIVE_CORRECTION';p.entries[0].admission=null;f.publish('field-channel-policy','fieldChannelPolicy',p,'issuer-qa-field','1.1.0');const now=Date.now(),r=f.request(now),before=canonical(f.store),body=fieldCurrentLeaseCheck(f.store,f.imports,r,f.snapshot,f.keys.publicKey,now);assert.equal(body.allowed,false);assert.equal(body.reason,'FIELD_APPROVAL_PAUSED');assert.equal(canonical(f.store),before);const status=signFieldCheck(body,f.keys.privateKey);assert.equal(verifyFieldCheck(status,f.keys.publicKey,{requestId:r.requestId,requestedAtMs:r.requestedAtMs,lease:f.lease},now).body.allowed,false);
 const g=fixture(),empty={...g.snapshot,channels:[]};appendFieldRegistryObservation(g.store,empty,'check-core-b');appendFieldRegistryObservation(g.store,g.snapshot,'check-core-c');const at=Date.now(),result=fieldCurrentLeaseCheck(g.store,g.imports,g.request(at),g.snapshot,g.keys.publicKey,at);assert.equal(result.allowed,false);assert.equal(result.reason,'FIELD_LEASE_REGISTRY_CHANGED');
});
test('过期租约只可取得拒绝状态，无持久签发即使平台签名有效也不能核对为成功',()=>{
 const f=fixture(),at=f.lease.body.expiresAtMs,r=f.request(at),status=fieldCurrentLeaseCheck(f.store,f.imports,r,f.snapshot,f.keys.publicKey,at);assert.equal(status.allowed,false);assert.equal(status.reason,'FIELD_LEASE_EXPIRED');const noRecord=signFieldLease({...f.lease.body,leaseId:randomUUID(),requestId:randomUUID()},f.keys.privateKey),request=signFieldCheckRequest({format:'idms-field-lease-check-request-v1',requestId:randomUUID(),requestedAtMs:Date.now(),lease:noRecord},f.requestKey);assert.throws(()=>fieldCurrentLeaseCheck(f.store,f.imports,request,f.snapshot,f.keys.publicKey,Date.now()),/不可验证/);
});
