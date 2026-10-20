import test from 'node:test';
import assert from 'node:assert/strict';
import {fieldCertificateFixture,fieldProfileFixture} from '../scripts/fixtures/field-certificate-fixture.mjs';
import {CertificatePurpose} from 'node-opcua-crypto';
import {fieldSha256} from '../services/field/profile.ts';
import {verifyFieldCertificate,verifyFieldMaterials,PinnedFieldCertificateStore,fieldCertificateDer} from '../services/field/certificates.ts';
const server=await fieldCertificateFixture(),client=await fieldCertificateFixture({applicationUri:'urn:idms:field-qa-client'}),profile=()=>fieldProfileFixture(server,client),material=()=>({serverCertificate:server.certificate,clientCertificate:client.der,privateKeyPem:client.privateKey});
test('field certificates bind exact leaf, application URIs, hostname, purpose and actual private key before a connection',()=>{
 const checked=verifyFieldMaterials(profile(),material());assert.equal(checked.server.sha256,server.sha256);assert.equal(checked.client.sha256,client.sha256);assert.deepEqual(fieldCertificateDer(server.certificate),server.der);
});
test('expired, future, wrong-host and wrong-application certificates fail even with an explicitly trusted public leaf',()=>{
 const after=Date.now()+2*86400000,before=Date.now()-2*86400000;for(const at of [after,before])assert.throws(()=>verifyFieldCertificate(server.der,profile(),'SERVER',at),(e:any)=>e.code==='FIELD_CERTIFICATE_TIME_INVALID');const host=profile();host.opcua.endpoint='opc.tcp://other.invalid:4849/qa';assert.throws(()=>verifyFieldCertificate(server.der,host,'SERVER'),(e:any)=>e.code==='FIELD_CERTIFICATE_HOST_MISMATCH');const uri=profile();uri.opcua.serverApplicationUri='urn:idms:wrong';assert.throws(()=>verifyFieldCertificate(server.der,uri,'SERVER'),(e:any)=>e.code==='FIELD_CERTIFICATE_URI_MISMATCH');
});
test('unknown pins, explicit revocation and a different client key never become trusted material',()=>{
 const pin=profile();pin.opcua.serverCertificateSha256='c'.repeat(64);assert.throws(()=>verifyFieldMaterials(pin,material()),(e:any)=>e.code==='FIELD_CERTIFICATE_PIN_MISMATCH');const revoked=profile();revoked.opcua.revokedCertificateSha256=[server.sha256];assert.throws(()=>verifyFieldMaterials(revoked,material()),(e:any)=>e.code==='FIELD_CERTIFICATE_REVOKED');assert.throws(()=>verifyFieldMaterials(profile(),{...material(),privateKeyPem:server.privateKey}),(e:any)=>e.code==='FIELD_PRIVATE_KEY_MISMATCH');
});
test('a CA certificate or altered self-signature is rejected after pin matching',async()=>{
 const ca=await fieldCertificateFixture({purpose:CertificatePurpose.ForCertificateAuthority}),p=profile();p.opcua.serverCertificateSha256=ca.sha256;assert.throws(()=>verifyFieldCertificate(ca.der,p,'SERVER'),(e:any)=>e.code==='FIELD_CERTIFICATE_USAGE_INVALID');const bad=Buffer.from(server.der);bad[bad.length-1]^=1;const forged=profile();forged.opcua.serverCertificateSha256=fieldSha256(bad);assert.throws(()=>verifyFieldCertificate(bad,forged,'SERVER'),(e:any)=>e.code==='FIELD_CERTIFICATE_SIGNATURE_INVALID');
});
test('the strict connection store never auto-accepts unknown or outdated certificates or exposes trust mutation',async()=>{
 let now=Date.now();const store=new PinnedFieldCertificateStore(profile(),()=>now);await store.initialize();assert.equal((await store.checkCertificate(server.der)).name,'Good');assert.equal((await store.checkCertificate(client.der)).name,'BadCertificateUntrusted');await assert.rejects(store.trustCertificate(server.der),(e:any)=>e.code==='FIELD_TRUST_MUTATION_FORBIDDEN');await assert.rejects(store.addIssuer(server.der));now+=2*86400000;assert.equal(await store.verifyCertificate(server.der,{acceptOutdatedCertificate:true}),'BadCertificateTimeInvalid');await store.dispose();assert.equal((await store.checkCertificate(server.der)).name,'BadCertificateUntrusted');
});
test('certificate parsing rejects extra PEM material and private-credential errors remain fixed codes',()=>{
 assert.throws(()=>fieldCertificateDer(Buffer.concat([server.certificate,client.certificate])));assert.throws(()=>fieldCertificateDer(Buffer.from('private-not-a-certificate')));const p:any=profile();p.userIdentity={type:'UserName',userName:'readonly',passwordFile:'password.txt'};assert.throws(()=>verifyFieldMaterials(p,{...material(),password:'secret\nline'}),(e:any)=>e.code==='FIELD_USER_IDENTITY_INVALID'&&!e.message.includes('secret'));assert.throws(()=>verifyFieldMaterials(profile(),{...material(),password:'secret'}));
});
