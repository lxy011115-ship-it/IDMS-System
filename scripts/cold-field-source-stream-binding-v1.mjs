import {fieldEventProfile,fieldStreamId} from '../integrations/field-event.ts';
import {fieldLeaseBody,fieldLeaseKeyId} from '../integrations/field-lease.ts';
import {publicFieldProfileDigest} from '../integrations/field-profile.ts';

const need=value=>{if(!value)throw Object.assign(Error('COLD_FIELD_SOURCE_STREAM_BINDING'),{code:'COLD_FIELD_SOURCE_STREAM_BINDING'});};
/**
 * Pure historical projection. The body must separately be authenticated by
 * actual SOURCE history. This does not sign a lease or grant an authorization.
 */
export function coldFieldSourceStreamBindingV1(rawProfile,rawBody,key){
  const profile=fieldEventProfile(rawProfile),body=fieldLeaseBody(rawBody),profileDigest=publicFieldProfileDigest(profile);
  need(key?.type==='public'&&fieldLeaseKeyId(key)===profile.transport.acknowledgementKeyId&&body.keyId===profile.transport.acknowledgementKeyId);
  for(const name of ['tenantId','edgeId','deviceCode','mapVersion'])need(body[name]===profile.source[name]);need(body.profileDigest===profileDigest);
  const binding=Object.freeze({format:'idms-field-stream-binding-v1',tenantId:body.tenantId,edgeId:body.edgeId,deviceCode:body.deviceCode,mapVersion:body.mapVersion,profileDigest,admissionDigest:body.admissionDigest,registryRevision:body.registryRevision,registryDigest:body.registryDigest,leaseKeyId:body.keyId,eventKeySha256:profile.transport.eventKeySha256});
  return Object.freeze({binding,streamId:fieldStreamId(binding)});
}
