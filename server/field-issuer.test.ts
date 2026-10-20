import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {fieldIssuanceFixture} from '../scripts/fixtures/field-issuance-model.mjs';
import {signFieldLeaseRequest,verifyFieldLeaseRequest} from '../integrations/field-request.ts';
import {signFieldLease,verifyFieldLease} from '../integrations/field-lease.ts';
import {fieldSha256} from '../integrations/field-profile.ts';
import {appendFieldRegistryObservation,assertFieldRegistryCurrent,fieldRegistryHistory,fieldRegistrySnapshot} from './field-registry.ts';
import {prepareFieldLeaseIssuance} from './field-lease-issue.ts';
import {canonical} from './imports.ts';
import {verifyAuditChain} from './audit.ts';
import {exactFieldSourceRef} from './field-policy-history.ts';
const clock=<T>(at:number,fn:()=>T):T=>{const Real=Date;globalThis.Date=class extends Real{constructor(v?:any){super(v===undefined?at:v);}static now(){return at;}} as DateConstructor;try{return fn();}finally{globalThis.Date=Real;}};
test('现场请求使用独立HMAC域、严格身份/时间/字段/密钥，旧遥测签名不能认证',()=>{
 const f=fieldIssuanceFixture(),now=Date.now(),r=f.request(now);assert.deepEqual(verifyFieldLeaseRequest(r,f.requestKey,now),r);assert.throws(()=>verifyFieldLeaseRequest(r,randomBytes(32),now));assert.throws(()=>verifyFieldLeaseRequest(r,f.requestKey,now-1));assert.throws(()=>verifyFieldLeaseRequest(r,f.requestKey,now+30000));
 for(const patch of [{secret:'x'},{profileDigest:'A'.repeat(64)},{signature:'0'.repeat(64)},{deviceCode:'other'},{requestedAtMs:String(now)}])assert.throws(()=>verifyFieldLeaseRequest({...r,...patch},f.requestKey,now));const {signature,...raw}=r;assert.throws(()=>signFieldLeaseRequest({...raw,origin:'FIELD'},f.requestKey));assert.throws(()=>signFieldLeaseRequest(raw,Buffer.alloc(31)));
});
test('现场注册观察绑定整个公开profile、签发公钥和机器认证键；重启相同配置不重复',()=>{
 const f=fieldIssuanceFixture(),a=appendFieldRegistryObservation(f.store,f.snapshot,'core-a');assert.equal(a.revision,'1');assert.equal(appendFieldRegistryObservation(f.store,f.snapshot,'core-b').changed,false);assert.equal(assertFieldRegistryCurrent(f.store,f.snapshot).revision,'1');
 const next=structuredClone(f.snapshot);next.channels[0].requestKeySha256='d'.repeat(64);assert.equal(appendFieldRegistryObservation(f.store,next,'core-b').revision,'2');assert.throws(()=>assertFieldRegistryCurrent(f.store,f.snapshot),/过期/);assert.equal(fieldRegistryHistory(f.store.audits,'acme').count,'2');assert.equal(verifyAuditChain(f.store.audits,'acme'),true);const empty={...next,channels:[]};assert.equal(appendFieldRegistryObservation(f.store,empty,'core-c').revision,'3');assert.throws(()=>assertFieldRegistryCurrent(f.store,next));
 for(const patch of [{signingKey:'secret'},{channels:[{...f.snapshot.channels[0],requestKey:'secret'}]},{tenantId:'sandbox'},{channels:[f.snapshot.channels[0],f.snapshot.channels[0]]}])assert.throws(()=>fieldRegistrySnapshot({...f.snapshot,...patch}));
});
test('注册观察正文或顺序不可改写，墙钟倒退不能追加新观察',()=>{
 const f=fieldIssuanceFixture();appendFieldRegistryObservation(f.store,f.snapshot,'core-a');const prior=canonical(f.store),next={...f.snapshot,channels:[]},at=Date.parse(f.store.audits.at(-1)!.businessTime);assert.throws(()=>clock(at-1,()=>appendFieldRegistryObservation(f.store,next,'core-b')));assert.equal(canonical(f.store),prior);const tampered=structuredClone(f.store);tampered.audits.at(-1)!.metadata.revision='2';assert.throws(()=>fieldRegistryHistory(tampered.audits,'acme'));
});
test('签发正文与真实审计时刻完全相同，原请求回放返回原到期且不追加记录',()=>{
 const f=fieldIssuanceFixture();appendFieldRegistryObservation(f.store,f.snapshot,'core-a');const request=f.request(),body=prepareFieldLeaseIssuance(f.store,f.imports,request,f.snapshot),audit=f.store.audits.at(-1)!;assert.equal(audit.businessTime,new Date(body.issuedAtMs).toISOString());assert.equal(audit.action,'FIELD_LEASE_ISSUED');assert.deepEqual(audit.metadata.leaseBody,body);assert.equal(body.expiresAtMs-body.issuedAtMs,30000);const before=canonical(f.store);assert.deepEqual(prepareFieldLeaseIssuance(f.store,f.imports,request,f.snapshot),body);assert.equal(canonical(f.store),before);assert.ok(!canonical(audit).includes(request.signature));assert.equal(verifyAuditChain(f.store.audits,'acme'),true);
 const lease=signFieldLease(body,f.keys.privateKey);assert.equal(verifyFieldLease(lease,f.keys.publicKey,{tenantId:'acme',edgeId:request.edgeId,deviceCode:request.deviceCode,mapVersion:request.mapVersion,profileDigest:request.profileDigest,requestId:request.requestId},Date.now()).body.leaseId,body.leaseId);
});
test('当前暂停先于旧签发回执；注册换键/旧配置/错误请求不能复用成功',()=>{
 const f=fieldIssuanceFixture();appendFieldRegistryObservation(f.store,f.snapshot,'core-a');const request=f.request();prepareFieldLeaseIssuance(f.store,f.imports,request,f.snapshot);const p=structuredClone(f.policy);p.changeIntent='RETROSPECTIVE_CORRECTION';p.entries[0].admission=null;f.publish('field-channel-policy','fieldChannelPolicy',p,'issuer-qa-field','1.1.0');const before=canonical(f.store);assert.throws(()=>prepareFieldLeaseIssuance(f.store,f.imports,request,f.snapshot),/FIELD_APPROVAL_PAUSED/);assert.equal(canonical(f.store),before);
 const g=fieldIssuanceFixture();appendFieldRegistryObservation(g.store,g.snapshot,'core-a');const r=g.request();prepareFieldLeaseIssuance(g.store,g.imports,r,g.snapshot);const next=structuredClone(g.snapshot);next.channels[0].requestKeySha256=fieldSha256(randomBytes(32));appendFieldRegistryObservation(g.store,next,'core-b');assert.throws(()=>prepareFieldLeaseIssuance(g.store,g.imports,r,g.snapshot),/过期/);assert.throws(()=>prepareFieldLeaseIssuance(g.store,g.imports,r,next),/REGISTRY_CHANGED/);assert.throws(()=>prepareFieldLeaseIssuance(g.store,g.imports,{...r,profileDigest:'d'.repeat(64)},next),(e:any)=>e.status===401);
});
test('最终审计时刻跨进暂停即完整回退，未来暂停截短租约且不能延长旧请求',()=>{
 const f=fieldIssuanceFixture(),base=Date.now()+100;clock(base,()=>{const p=structuredClone(f.policy);p.changeIntent='PROSPECTIVE';p.entries.push({id:'pause',effectiveFrom:new Date(base+1000).toISOString(),reason:'准确时刻撤销',admission:null});f.publish('field-channel-policy','fieldChannelPolicy',p,'issuer-qa-field','1.1.0');appendFieldRegistryObservation(f.store,f.snapshot,'core-a');const request=f.request(base),body=clock(base,()=>prepareFieldLeaseIssuance(f.store,f.imports,request,f.snapshot));assert.equal(body.expiresAtMs,base+1000);
 const second=f.request(base+999),before=canonical(f.store),Real=Date;let tick=base+999;globalThis.Date=class extends Real{constructor(v?:any){super(v===undefined?tick++:v);}static now(){return tick++;}} as DateConstructor;try{assert.throws(()=>prepareFieldLeaseIssuance(f.store,f.imports,second,f.snapshot),/FIELD_APPROVAL_PAUSED/);}finally{globalThis.Date=Real;}assert.equal(canonical(f.store),before);
 });
});
test('来源自己的未来生效条目也截短租约，即使物理映射相同也不跨越旧审批绑定',()=>{
 const f=fieldIssuanceFixture(),base=Date.now()+100;clock(base,()=>{const s=structuredClone(f.sourcePolicy);s.changeIntent='PROSPECTIVE';s.entries.push({...s.entries[0],id:'source-next',effectiveFrom:new Date(base+1000).toISOString(),reason:'相同物理映射的新来源生效依据'});const source=f.publish('telemetry-source-policy','telemetrySourcePolicy',s,'issuer-qa-source','1.1.0'),p=structuredClone(f.policy);p.changeIntent='RETROSPECTIVE_CORRECTION';p.entries[0].admission.sourcePolicyRef=exactFieldSourceRef(source);f.publish('field-channel-policy','fieldChannelPolicy',p,'issuer-qa-field','1.1.0');appendFieldRegistryObservation(f.store,f.snapshot,'core-a');const request=f.request(base),body=clock(base,()=>prepareFieldLeaseIssuance(f.store,f.imports,request,f.snapshot));assert.equal(body.expiresAtMs,base+1000);assert.throws(()=>clock(base+1000,()=>prepareFieldLeaseIssuance(f.store,f.imports,request,f.snapshot)),/APPROVAL_OR_REGISTRY_CHANGED/);
 });
});
