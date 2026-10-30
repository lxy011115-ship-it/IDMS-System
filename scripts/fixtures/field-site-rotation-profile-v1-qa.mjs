import assert from 'node:assert/strict';
import {canonical} from '../../server/imports.ts';
import {parsePublicFieldProfile,publicFieldProfileDigest} from '../../integrations/field-profile.ts';

/** Exact single-purpose change; callers cannot replace prior history or source identity. */
export function fieldSiteRotationProfileQaV1(previous, next, kind) {
  assert(['PROFILE','EVENT_KEY','PLATFORM_KEY'].includes(kind),'FIELD_SITE_ROTATION_KIND');
  const before=parsePublicFieldProfile(previous), after=parsePublicFieldProfile(next), expected=structuredClone(before);
  assert(before.transport&&after.transport,'FIELD_SITE_ROTATION_TRANSPORT');
  if(kind==='PROFILE') {
    assert.equal(after.limits.maxSampleAgeMs,before.limits.maxSampleAgeMs+1000,'FIELD_SITE_ROTATION_PROFILE_LIMIT');
    expected.limits.maxSampleAgeMs=after.limits.maxSampleAgeMs;
  }
  if(kind==='EVENT_KEY') {
    assert.notEqual(after.transport.eventKeySha256,before.transport.eventKeySha256,'FIELD_SITE_ROTATION_EVENT_KEY_UNCHANGED');
    expected.transport.eventKeySha256=after.transport.eventKeySha256;
  }
  if(kind==='PLATFORM_KEY') {
    assert.notEqual(after.transport.acknowledgementKeyId,before.transport.acknowledgementKeyId,'FIELD_SITE_ROTATION_PLATFORM_KEY_UNCHANGED');
    expected.transport.acknowledgementKeyId=after.transport.acknowledgementKeyId;
  }
  assert.equal(canonical(after),canonical(expected),'FIELD_SITE_ROTATION_UNRELATED_CHANGE');
  assert.notEqual(publicFieldProfileDigest(after),publicFieldProfileDigest(before),'FIELD_SITE_ROTATION_DIGEST_UNCHANGED');
  return after;
}
