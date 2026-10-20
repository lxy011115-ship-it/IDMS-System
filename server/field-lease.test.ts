import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,createHmac} from 'node:crypto';
import {fieldLeaseKeyId,signFieldLease,verifyFieldLease,FieldLeaseGuard} from '../integrations/field-lease.ts';
import {stable} from '../integrations/telemetry.ts';
const keys=generateKeyPairSync('ed25519'),now=Date.now(),expected={tenantId:'acme',edgeId:'field-qa',deviceCode:'FIELD-QA-01',mapVersion:'qa-1',profileDigest:'a'.repeat(64)},base=()=>({format:'idms-field-channel-lease-v1',keyId:fieldLeaseKeyId(keys.publicKey),leaseId:randomUUID(),requestId:randomUUID(),...expected,admissionDigest:'b'.repeat(64),registryRevision:'1',registryDigest:'c'.repeat(64),issuedAtMs:now,expiresAtMs:now+10000});
test('现场租约采用单独Ed25519签名域，边缘公钥不能签发；准确起止边界和身份绑定',()=>{
 const raw=base(),lease=signFieldLease(raw,keys.privateKey);assert.ok(Object.isFrozen(lease.body));assert.deepEqual(verifyFieldLease(lease,keys.publicKey,{...expected,requestId:raw.requestId,registryRevision:'1',registryDigest:raw.registryDigest,admissionDigest:raw.admissionDigest},now),lease);
 assert.throws(()=>signFieldLease(raw,keys.publicKey));assert.throws(()=>verifyFieldLease(lease,keys.privateKey,expected,now));assert.throws(()=>verifyFieldLease(lease,keys.publicKey,expected,now-1));assert.throws(()=>verifyFieldLease(lease,keys.publicKey,expected,raw.expiresAtMs));assert.equal(verifyFieldLease(lease,keys.publicKey,expected,raw.expiresAtMs-1).body.leaseId,raw.leaseId);
 for(const change of [{tenantId:'sandbox'},{edgeId:'other'},{deviceCode:'other'},{mapVersion:'other'},{profileDigest:'d'.repeat(64)},{requestId:randomUUID()},{admissionDigest:'d'.repeat(64)},{registryRevision:'2'},{registryDigest:'d'.repeat(64)}])assert.throws(()=>verifyFieldLease(lease,keys.publicKey,{...expected,...change},now));
});
test('签名正文/密钥/域/摘要篡改与长租约、秘密字段及非规范签名一律拒绝',()=>{
 const raw=base(),lease=signFieldLease(raw,keys.privateKey),other=generateKeyPairSync('ed25519');assert.throws(()=>verifyFieldLease(lease,other.publicKey,expected,now));
 for(const change of [{expiresAtMs:now+30001},{expiresAtMs:now},{issuedAtMs:'1'},{profileDigest:'A'.repeat(64)},{privateKey:'secret'},{registryRevision:'01'},{registryRevision:'9223372036854775808'},{requestId:'bad'}])assert.throws(()=>signFieldLease({...raw,...change},keys.privateKey));
 for(const change of [{body:{...lease.body,expiresAtMs:now+20000}},{signature:lease.signature+'='},{signature:lease.signature.slice(1)},{signature:createHmac('sha256','old-telemetry-key').update('telemetry-v1:'+stable(raw)).digest('base64url')},{secret:'private'}])assert.throws(()=>verifyFieldLease({...lease,...change},keys.publicKey,expected,now));
});
test('边缘守卫自己产生一次性挑战；过期、撤销及旧签名重放拒绝',()=>{
 let time=now,mono=1000;const guard=new FieldLeaseGuard(keys.publicKey,expected,()=>time,()=>mono);assert.throws(()=>guard.assertCurrent());const raw={...base(),requestId:guard.beginRequest()},lease=signFieldLease(raw,keys.privateKey);guard.install(lease);assert.equal(guard.assertCurrent().body.leaseId,raw.leaseId);guard.revoke();assert.throws(()=>guard.assertCurrent());assert.throws(()=>guard.install(lease),(e:any)=>e.code==='FIELD_LEASE_REQUEST_UNAVAILABLE');
 const repeated={...raw,requestId:guard.beginRequest()};assert.throws(()=>guard.install(signFieldLease(repeated,keys.privateKey)),(e:any)=>e.code==='FIELD_LEASE_REPLAY');
 time++;mono++;const next={...base(),requestId:guard.beginRequest(),issuedAtMs:time,expiresAtMs:time+10000};guard.install(signFieldLease(next,keys.privateKey));time=next.expiresAtMs;mono+=10000;assert.throws(()=>guard.assertCurrent());
});
test('失败刷新立即停止旧租约；倒退墙钟与单调时间超期也不能延长授权',()=>{
 for(const mode of ['INVALID_REFRESH','ROLLBACK','MONOTONIC']){let time=now,mono=1000;const guard=new FieldLeaseGuard(keys.publicKey,expected,()=>time,()=>mono),raw={...base(),requestId:guard.beginRequest()},lease=signFieldLease(raw,keys.privateKey);guard.install(lease);assert.ok(guard.assertCurrent());if(mode==='INVALID_REFRESH'){guard.beginRequest();assert.throws(()=>guard.install({...lease,signature:'bad'}));}if(mode==='ROLLBACK')time--;if(mode==='MONOTONIC')mono+=10000;assert.throws(()=>guard.assertCurrent());}
});
test('只读客户端授权回调绑定配置摘要、返回void且错误配置立即撤销租约',()=>{
 const guard=new FieldLeaseGuard(keys.publicKey,expected,()=>now,()=>1000),raw={...base(),requestId:guard.beginRequest()},callback=guard.authorize;guard.install(signFieldLease(raw,keys.privateKey));assert.equal(callback({profileDigest:expected.profileDigest,phase:'CONNECT'}),undefined);assert.throws(()=>callback({profileDigest:'d'.repeat(64),phase:'CONNECT'}),(e:any)=>e.code==='FIELD_LEASE_PROFILE_MISMATCH');assert.throws(()=>callback({profileDigest:expected.profileDigest,phase:'CONNECT'}),(e:any)=>e.code==='FIELD_LEASE_UNAVAILABLE');
});
test('旧请求回包、无待处理请求或挑战等待超时均不能安装授权',()=>{
 let time=now,mono=1000;const guard=new FieldLeaseGuard(keys.publicKey,expected,()=>time,()=>mono),old={...base(),requestId:guard.beginRequest()},lease=signFieldLease(old,keys.privateKey);const fresh=guard.beginRequest();assert.notEqual(fresh,old.requestId);assert.throws(()=>guard.install(lease));assert.throws(()=>guard.assertCurrent());assert.throws(()=>guard.install(signFieldLease({...old,requestId:fresh},keys.privateKey)));
 const requestId=guard.beginRequest();time+=30000;mono+=30000;assert.throws(()=>guard.install(signFieldLease({...base(),requestId,issuedAtMs:time,expiresAtMs:time+1000},keys.privateKey)),(e:any)=>e.code==='FIELD_LEASE_REQUEST_UNAVAILABLE');
});
