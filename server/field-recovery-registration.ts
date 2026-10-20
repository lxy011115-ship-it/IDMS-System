import {fieldObject,fieldText,fieldHash,fieldSha256,freezeFieldValue} from '../integrations/field-profile.ts';
import {stable} from '../integrations/telemetry.ts';
import {fieldRegistrySnapshot,type FieldRegistrySnapshot} from './field-registry.ts';
import {DomainError} from './service.ts';
export interface FieldRegistrationCandidate {
 format:'idms-field-recovery-registration-candidate-v1';tenantId:string;operationId:string;controlSha256:string;operationIntentSha256:string;configSha256:string;registry:FieldRegistrySnapshot;registrySha256:string;fieldEnabled:false;activationGranted:false;
}
export function fieldRegistrationCandidate(raw:unknown):FieldRegistrationCandidate{
 try{
  const r=fieldObject(raw,['format','tenantId','operationId','controlSha256','operationIntentSha256','configSha256','registry','registrySha256','fieldEnabled','activationGranted']),tenantId=fieldText(r.tenantId,80),operationId=fieldText(r.operationId,36),registry=fieldRegistrySnapshot(r.registry);
  if(r.format!=='idms-field-recovery-registration-candidate-v1'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId)||operationId==='00000000-0000-0000-0000-000000000000'||registry.tenantId!==tenantId||registry.format!=='idms-field-registry-v2'||!registry.channels.length||registry.channels.some(c=>c.profile.format!=='idms-field-channel-public-profile-v2'||!c.profile.transport)||stable(registry)!==stable(r.registry)||r.fieldEnabled!==false||r.activationGranted!==false)throw Error();
  const value:FieldRegistrationCandidate={format:'idms-field-recovery-registration-candidate-v1',tenantId,operationId,controlSha256:fieldHash(r.controlSha256),operationIntentSha256:fieldHash(r.operationIntentSha256),configSha256:fieldHash(r.configSha256),registry,registrySha256:fieldHash(r.registrySha256),fieldEnabled:false,activationGranted:false};if(value.registrySha256!==fieldSha256(stable(registry)))throw Error();freezeFieldValue(value);return value;
 }catch{throw new DomainError(503,'恢复注册候选不可验证');}
}
