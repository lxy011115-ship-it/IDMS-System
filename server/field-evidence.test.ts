import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {fieldIssuanceFixture} from '../scripts/fixtures/field-issuance-model.mjs';
import {appendFieldRegistryObservation} from './field-registry.ts';
import {tenantPayload} from './entity-repository.ts';
import {canonical,digest} from './imports.ts';
import {fieldModuleChecksum} from './field-schema.ts';
import {fieldLeaseKeyId} from '../integrations/field-lease.ts';
import {signFieldEvidencePack,verifyFieldEvidencePack,fieldEvidenceTrust} from './field-evidence.ts';
import {fieldCertificateFixture,fieldProfileFixture} from '../scripts/fixtures/field-certificate-fixture.mjs';
import {publicFieldProfile} from '../services/field/profile.ts';
import {verifyFieldCertificate,verifyPublicFieldCertificate} from '../services/field/certificates.ts';

function model(){
 const f=fieldIssuanceFixture();appendFieldRegistryObservation(f.store,f.snapshot,'evidence-unit-model');const {audits,idempotency,...business}=f.store,payload=tenantPayload({version:2,business,imports:f.imports,audits,idempotency:[...idempotency]} as any,'acme'),at=new Date().toISOString(),keyId=fieldLeaseKeyId(f.keys.publicKey),baseChecksum='c'.repeat(64);
 const body={format:'idms-field-evidence-body-v1',tenantId:'acme',edgeId:f.profile.source.edgeId,capturedAt:at,signingKeyId:keyId,reader:{actorId:'unit-model-reader',roles:['auditor'],scope:{provided:true,sites:['*'],lines:['*'],devices:['*']},authenticatedAt:at,currentIdentitySha256:'a'.repeat(64)},registration:f.snapshot,rootRecord:JSON.stringify({tenant_id:'acme',schema_version:3,revision:1,payload_digest:digest(canonical(payload)),updated_at:at}),payload,auditSequence:payload.audits.map((_,i)=>String(i+1)),module:{version:1,checksum:fieldModuleChecksum(baseChecksum),baseChecksum},points:[],receipts:[],observations:{format:'idms-field-evidence-observations-v1',tenantId:'acme',edgeId:f.profile.source.edgeId,events:[],acks:[],checks:[]},publicMaterials:{format:'idms-field-evidence-public-materials-v1',profiles:[{profileDigest:f.profileDigest,opcuaEndpoint:'opc.tcp://127.0.0.1:4849/qa',mqttBrokerUrl:'mqtts://127.0.0.1:8883'}],certificates:[]}};
 const trust=fieldEvidenceTrust({format:'idms-field-evidence-trust-v1',tenantId:'acme',edgeId:f.profile.source.edgeId,keys:[{keyId,publicKeyPem:f.keys.publicKey.export({type:'spki',format:'pem'})}]});return {f,body,trust,pack:signFieldEvidencePack(body,f.keys.privateKey)};
}
test('external pinned trust authenticates an empty model snapshot without claiming data, HMAC, physical read or current database proof',()=>{const m=model(),v=verifyFieldEvidencePack(m.pack,m.trust);assert.equal(v.points,0);assert.equal(v.hmacVerifiedEvents,0);assert.equal(v.allEventHmacReauthenticated,false);assert.equal(v.historicalCertificatePolicyVerified,false);assert.equal(v.currentDatabaseOrFreshnessProven,false);assert.equal(v.physicalDeviceAttestation,false);});
test('changing signed bytes, replacing external trust or selecting a foreign tenant never becomes a verified snapshot',()=>{const m=model(),bad=structuredClone(m.pack);bad.body.capturedAt='2026-01-01T00:00:00.000Z';assert.throws(()=>verifyFieldEvidencePack(bad,m.trust),{code:'FIELD_EVIDENCE_SIGNATURE_INVALID'});const other=generateKeyPairSync('ed25519'),trust={...m.trust,keys:new Map([[m.body.signingKeyId,other.publicKey]])};assert.throws(()=>verifyFieldEvidencePack(m.pack,trust));assert.throws(()=>verifyFieldEvidencePack(m.pack,{...m.trust,tenantId:'sandbox'}),{code:'FIELD_EVIDENCE_SCOPE_MISMATCH'});});
test('a correctly re-signed malformed snapshot still rejects root, SQL sequence, boundary and unknown-field corruption',()=>{
 const m=model();for(const mutate of [(b:any)=>{b.extra='unknown';},(b:any)=>{b.rootRecord=JSON.stringify({...JSON.parse(b.rootRecord),payload_digest:'0'.repeat(64)});},(b:any)=>{b.auditSequence[1]=b.auditSequence[0];},(b:any)=>{b.payload.business.templates[0].tenantId='sandbox';},(b:any)=>{b.reader.scope.devices=['FIELD-QA-01'];},(b:any)=>{b.reader.roles=['system-admin'];}]){const b=structuredClone(m.body);mutate(b);assert.throws(()=>verifyFieldEvidencePack(signFieldEvidencePack(b,m.f.keys.privateKey),m.trust));}
});
test('public-only DER checks reuse exact pin, URI, host and historical validity without loading private profile files',async()=>{
 const server=await fieldCertificateFixture(),client=await fieldCertificateFixture({applicationUri:'urn:idms:field-qa-client'}),p=fieldProfileFixture(server,client),pub=publicFieldProfile(p),at=Date.now();assert.deepEqual(verifyPublicFieldCertificate(server.der,pub,p.opcua.endpoint,'SERVER',at),verifyFieldCertificate(server.der,p,'SERVER',at));assert.throws(()=>verifyPublicFieldCertificate(server.der,pub,'opc.tcp://elsewhere.invalid:4849/qa','SERVER',at),{code:'FIELD_CERTIFICATE_ENDPOINT_MISMATCH'});assert.throws(()=>verifyPublicFieldCertificate(client.der,pub,p.opcua.endpoint,'SERVER',at),{code:'FIELD_CERTIFICATE_PIN_MISMATCH'});assert.throws(()=>verifyPublicFieldCertificate(server.der,pub,p.opcua.endpoint,'SERVER',at+4*86400000),{code:'FIELD_CERTIFICATE_TIME_INVALID'});
});
