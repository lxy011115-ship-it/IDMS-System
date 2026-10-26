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
for(const kind of ['PROFILE','EVENT_KEY','PLATFORM_KEY']) {
  test(kind+' accepts only its intended material and preserves input bytes',()=>{const previous=fixture(),bytes=JSON.stringify(previous),next=change(previous,kind),nextBytes=JSON.stringify(next);assert.deepEqual(fieldSiteRotationProfileQaV1(previous,next,kind),parsePublicFieldProfile(next));assert.equal(JSON.stringify(previous),bytes);assert.equal(JSON.stringify(next),nextBytes);});
  test(kind+' rejects an unchanged proposal',()=>{const previous=fixture();assert.throws(()=>fieldSiteRotationProfileQaV1(previous,previous,kind));});
  test(kind+' rejects mixed key/config changes and source replacement',()=>{const previous=fixture(),next=change(previous,kind);if(kind==='PROFILE')next.transport.eventKeySha256=fieldSha256(randomBytes(32));else next.limits.maxSampleAgeMs+=1000;assert.throws(()=>fieldSiteRotationProfileQaV1(previous,next,kind),/FIELD_SITE_ROTATION_UNRELATED_CHANGE/);const foreign=change(previous,kind);foreign.source.tenantId='other-tenant';assert.throws(()=>fieldSiteRotationProfileQaV1(previous,foreign,kind),/FIELD_SITE_ROTATION_UNRELATED_CHANGE/);});
}
test('a caller cannot introduce an unrecognised rotation category',()=>{const profile=fixture();assert.throws(()=>fieldSiteRotationProfileQaV1(profile,profile,'SOURCE_KEY'),/FIELD_SITE_ROTATION_KIND/);});
