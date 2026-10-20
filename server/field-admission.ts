import {parsePublicFieldProfile,publicFieldProfileDigest} from '../integrations/field-profile.ts';
import type {Store} from './store.ts';
import type {ImportView} from './imports.ts';
import {canonical,digest} from './imports.ts';
import {publicationIndex} from './template-history.ts';
import {fieldPolicyHistory,validateFieldPolicyReferences,fieldPolicyIntegrity} from './field-policy-history.ts';
import {fieldPolicyEntry} from './field-policy-schema.ts';
import {sourceGovernanceDecision} from './source-governance.ts';
import {sourcePolicyHistory} from './source-policy-history.ts';
import {DomainError} from './service.ts';
export const fieldAdmissionVersion='approved-field-channel-binding-1.0.0' as const;
// A configuration decision is deliberately separate from permission to open a
// socket: runtime registry verification, signed lease and actual peer checks
// must all succeed in the caller before acquisition or intake.
export function fieldAdmissionDecision(store:Pick<Store,'templates'|'audits'>,data:ImportView,raw:unknown,at:number,eventTag:string|null=null){
 if(!Number.isSafeInteger(at))throw fieldPolicyIntegrity();const profile=parsePublicFieldProfile(raw),source={...profile.source,points:profile.points.map(({tagCode,nodeId,unit})=>({tagCode,nodeId,unit}))},profileDigest=publicFieldProfileDigest(profile),index=publicationIndex(store.audits,source.tenantId),history=fieldPolicyHistory(store.templates,source.tenantId,source.edgeId,at,id=>index.get(id),index),selected=history.selected,entry=selected?fieldPolicyEntry(selected.policy,at):null,admission=entry?.admission;
 const prior=sourceGovernanceDecision(store,data,source,at,eventTag);if(!prior.binding||!prior.enforced)throw fieldPolicyIntegrity();
 // Only this explicitly new FIELD rule replaces the old rule's unconditional
 // commissioning gate. Every other source-policy check remains mandatory.
 const conditions=prior.binding.conditions.filter(c=>c!=='FIELD_COMMISSIONING_DISABLED');
 if(!selected)conditions.push('FIELD_APPROVAL_UNDECLARED');else if(selected.policy.deviceCode!==source.deviceCode||selected.policy.edgeId!==source.edgeId)conditions.push('FIELD_APPROVED_IDENTITY_MISMATCH');
 if(selected&&!entry)conditions.push('FIELD_APPROVAL_NOT_EFFECTIVE');if(entry&&!admission)conditions.push('FIELD_APPROVAL_PAUSED');
 if(admission){
  if(admission.profileDigest!==profileDigest||canonical(admission.profile)!==canonical(profile))conditions.push('FIELD_APPROVED_PROFILE_MISMATCH');
  const p=prior.binding.policySource,ref=admission.sourcePolicyRef;if(!p||canonical(ref)!==canonical({templateId:p.templateId,templateKey:p.templateKey,version:p.version,contentDigest:p.contentDigest}))conditions.push('FIELD_APPROVED_SOURCE_VERSION_CHANGED');
  try{validateFieldPolicyReferences(store,selected!.policy,source.tenantId,at,data);}catch(e){if((e as {status?:number}).status!==409)throw e;conditions.push('FIELD_CURRENT_REFERENCE_INVALID');}
 }
 if(profile.opcua.revokedCertificateSha256.includes(profile.opcua.serverCertificateSha256)||profile.opcua.revokedCertificateSha256.includes(profile.opcua.clientCertificateSha256))conditions.push('FIELD_DECLARED_CERTIFICATE_REVOKED');
 if(profile.transport&&[profile.transport.caCertificateSha256,profile.transport.serverCertificateSha256,profile.transport.edgeCertificateSha256,profile.transport.platformCertificateSha256].some(pin=>profile.transport!.revokedCertificateSha256.includes(pin)))conditions.push('FIELD_DECLARED_TRANSPORT_CERTIFICATE_REVOKED');
 if(eventTag!==null&&!Object.hasOwn(prior.definitions,eventTag))conditions.push('FIELD_EVENT_POINT_UNDECLARED');
 const unique=[...new Set(conditions)].sort(),allowed=unique.length===0,{format:_format,ruleVersion:sourceRuleVersion,status:_status,conditions:_conditions,...sourceChecks}=prior.binding;
 const sourceConfiguration={format:'idms-field-source-configuration-v1' as const,sourceRuleVersion,...sourceChecks};
 const sourceHistory=sourcePolicyHistory(store.templates,source.tenantId,source.edgeId,at,id=>index.get(id),index),boundaries=[...(selected?.policy.entries||[]),...(sourceHistory.selected?.policy.entries||[])].map(e=>Date.parse(e.effectiveFrom)).filter(t=>t>at),nextBoundary=boundaries.length?Math.min(...boundaries):null;
 const binding={format:'idms-field-channel-binding-v1' as const,ruleVersion:fieldAdmissionVersion,evaluatedAt:new Date(at).toISOString(),status:allowed?'APPROVED_FIELD_CONFIGURATION' as const:'DENIED' as const,profileDigest,policySource:selected?.source||null,entryId:entry?.id||null,entryDigest:entry?digest(canonical(entry)):null,sourceConfiguration,conditions:unique,fieldCommissioned:false as const};
 return {allowed,reason:unique[0]||null,binding,definitions:prior.definitions,leaseDurationMs:allowed?admission!.leaseDurationMs:0,nextBoundary};
}
export function fieldAdmissionBindingDigest(decision:ReturnType<typeof fieldAdmissionDecision>){if(!decision.allowed)throw new DomainError(409,'现场通道当前审批条件不满足');const {evaluatedAt:_,...binding}=decision.binding;return digest(canonical(binding));}
