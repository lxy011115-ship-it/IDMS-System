import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFieldProfile,publicFieldProfile,fieldProfileDigest} from '../services/field/profile.ts';
import {fieldProfileFixture} from '../scripts/fixtures/field-certificate-fixture.mjs';
import {canonical,digest} from './imports.ts';
test('field profile requires explicit secure pins and exact bounded numeric point declarations',()=>{
 const raw=fieldProfileFixture(),p=parseFieldProfile(raw);assert.equal(p.points[0].dataType,'Double');assert.ok(Object.isFrozen(p.points[0]));raw.points[0].unit='changed';assert.equal(p.points[0].unit,'kPa');assert.equal(publicFieldProfile(p).fieldCommissioned,false);assert.equal(publicFieldProfile(p).source.origin,'FIELD');
});
test('field profile rejects silent TLS downgrade, remote protocol changes, URL credentials and ambiguous identities',()=>{
 for(const change of [(p:any)=>p.opcua.securityMode='None',(p:any)=>p.opcua.securityPolicy='Basic256',(p:any)=>p.opcua.trustMode='AUTO_ACCEPT',(p:any)=>p.opcua.serverCertificateSha256='A'.repeat(64),(p:any)=>p.opcua.endpoint='http://127.0.0.1:4840',(p:any)=>p.opcua.endpoint='opc.tcp://user:PRIVATE@localhost:4840',(p:any)=>p.opcua.endpoint+='?private=x',(p:any)=>p.opcua.endpoint='opc.tcp://localhost/qa',(p:any)=>p.opcua.clientApplicationUri=p.opcua.serverApplicationUri,(p:any)=>p.source.tenantId='../other',(p:any)=>p.execute='write']){const p=fieldProfileFixture();change(p);assert.throws(()=>parseFieldProfile(p),(e:any)=>e.code==='FIELD_PROFILE_INVALID');}
});
test('field profile rejects duplicate, noncanonical, array, unsafe-limit or silently coerced definitions',()=>{
 for(const change of [(p:any)=>p.points.push(p.points[0]),(p:any)=>p.points[0].nodeId='pressure',(p:any)=>p.points[0].dataType='String',(p:any)=>p.points[0].minimum='0',(p:any)=>p.points[0].maximum=Infinity,(p:any)=>p.points[0].maximum=0,(p:any)=>p.limits.timeoutMs=0,(p:any)=>p.limits.maxFutureSkewMs=300001,(p:any)=>p.points=[],(p:any)=>p.points[0].namespaceUri='file:///private',(p:any)=>p.points[0].nodeId='ns=0;i=2258']){const p=fieldProfileFixture();change(p);assert.throws(()=>parseFieldProfile(p));}
});
test('public field digest binds endpoint, certificate, account, namespace and physical declaration while excluding private locations',()=>{
 const p=fieldProfileFixture(),digest=fieldProfileDigest(p),view=JSON.stringify(publicFieldProfile(p));for(const secret of [p.opcua.endpoint,p.certificates.privateKeyFile,p.certificates.serverFile])assert.ok(!view.includes(secret));
 for(const change of [(p:any)=>p.opcua.endpoint='opc.tcp://localhost:4849/qa',(p:any)=>p.opcua.serverCertificateSha256='c'.repeat(64),(p:any)=>p.points[0].namespaceUri='urn:idms:other',(p:any)=>p.points[0].maximum=999,(p:any)=>p.source.mapVersion='other']){const next=structuredClone(p);change(next);assert.notEqual(fieldProfileDigest(next),digest);}
 const moved=structuredClone(p);moved.certificates.privateKeyFile='keys/moved.pem';assert.equal(fieldProfileDigest(moved),digest);const account:any=structuredClone(p);account.userIdentity={type:'UserName',userName:'private-read-account',passwordFile:'password.txt'};const old=fieldProfileDigest(account);assert.ok(!JSON.stringify(publicFieldProfile(account)).includes('private-read-account'));account.userIdentity.userName='other-account';assert.notEqual(fieldProfileDigest(account),old);
});
test('private material paths cannot escape a profile bundle or become URI/device filenames',()=>{
 for(const path of ['../secret','/secret','C:/secret','keys\\secret','file:secret','a//b','a/./b','a/*','a/..']){const p=fieldProfileFixture();p.certificates.privateKeyFile=path;assert.throws(()=>parseFieldProfile(p));}
});
test('field profile digests use the existing canonical public JSON domain and survive object-order changes',()=>{
 const p=fieldProfileFixture(),view=publicFieldProfile(p),reordered=JSON.parse(JSON.stringify(view,Object.keys(view).reverse()));assert.equal(fieldProfileDigest(p),digest(canonical(view)));const order=(v:any):any=>v&&typeof v==='object'?(Array.isArray(v)?v.map(order):Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,order(x)]))):v;assert.equal(fieldProfileDigest(order(p)),fieldProfileDigest(p));assert.equal(digest(canonical(order(view))),fieldProfileDigest(p));assert.ok(reordered);
});
