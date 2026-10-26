import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {fieldSiteRotationProfileQaV1} from '../scripts/fixtures/field-site-rotation-profile-v1-qa.mjs';
import {fieldIssuanceFixture} from '../scripts/fixtures/field-issuance-model.mjs';
import {fieldMqttDeclaration} from '../scripts/fixtures/field-mqtt-fixture.mjs';
import {fieldSha256,parsePublicFieldProfile} from '../integrations/field-profile.ts';
import {fieldLeaseKeyId} from '../integrations/field-lease.ts';

function fixture(){const f=fieldIssuanceFixture();return parsePublicFieldProfile({...structuredClone(f.profile),format:'idms-field-channel-public-profile-v2',transport:fieldMqttDeclaration(f.profile.source,{eventKeySha256:fieldSha256(randomBytes(32)),acknowledgementKeyId:fieldLeaseKeyId(f.keys.publicKey)})});}
function change(profile,kind){const next=structuredClone(profile);if(kind==='PROFILE')next.limits.maxSampleAgeMs+=1000;if(kind==='EVENT_KEY')next.transport.eventKeySha256=fieldSha256(randomBytes(32));if(kind==='PLATFORM_KEY')next.transport.acknowledgementKeyId=fieldLeaseKeyId(generateKeyPairSync('ed25519').publicKey);return next;}
for(const kind of ['PROFILE','EVENT_KEY','PLATFORM_KEY'])test(kind+' rejects mixed changes and a structurally valid other-tenant proposal',()=>{
  const previous=fixture(),mixed=change(previous,kind);if(kind==='PROFILE')mixed.transport.eventKeySha256=fieldSha256(randomBytes(32));else mixed.limits.maxSampleAgeMs+=1000;
  parsePublicFieldProfile(mixed);assert.throws(()=>fieldSiteRotationProfileQaV1(previous,mixed,kind),/FIELD_SITE_ROTATION_UNRELATED_CHANGE/);
  const foreign=change(previous,kind);foreign.source.tenantId='other-tenant';foreign.transport=fieldMqttDeclaration(foreign.source,{eventKeySha256:foreign.transport.eventKeySha256,acknowledgementKeyId:foreign.transport.acknowledgementKeyId});
  parsePublicFieldProfile(foreign);assert.throws(()=>fieldSiteRotationProfileQaV1(previous,foreign,kind),/FIELD_SITE_ROTATION_UNRELATED_CHANGE/);
  const malformed=change(previous,kind);malformed.source.tenantId='other-tenant';assert.throws(()=>fieldSiteRotationProfileQaV1(previous,malformed,kind),/FIELD_TRANSPORT_INVALID/);
});
