import {fieldObject,fieldText,fieldHash,fieldInteger,parsePublicFieldProfile,publicFieldProfileDigest,type PublicFieldProfile} from '../integrations/field-profile.ts';
import {calendarTime} from './calendar-schema.ts';
import {DomainError} from './service.ts';
export const fieldPolicyVersion='field-channel-admission-1.0.0' as const;
export interface FieldSourcePolicyRef {templateId:string;templateKey:string;version:string;contentDigest:string}
export interface FieldAdmission {sourcePolicyRef:FieldSourcePolicyRef;profile:PublicFieldProfile;profileDigest:string;leaseDurationMs:number}
export interface FieldPolicyEntry {id:string;effectiveFrom:string;reason:string;admission:FieldAdmission|null}
export interface FieldPolicy {deviceCode:string;edgeId:string;definitionVersion:typeof fieldPolicyVersion;changeIntent:'INITIAL'|'PROSPECTIVE'|'RETROSPECTIVE_CORRECTION';changeReason:string;entries:FieldPolicyEntry[]}
export function fieldSourcePolicyRef(raw:unknown):FieldSourcePolicyRef{
 const r=fieldObject(raw,['templateId','templateKey','version','contentDigest']),templateId=fieldText(r.templateId,36),templateKey=fieldText(r.templateKey,80),version=fieldText(r.version,30),contentDigest=fieldHash(r.contentDigest);
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(templateId)||!/^[a-z][a-z0-9-]*$/.test(templateKey)||!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version))throw new DomainError(400,'现场通道必须引用准确来源策略版本');return {templateId,templateKey,version,contentDigest};
}
export function fieldPolicySchema(raw:unknown):FieldPolicy{
 try{const p=fieldObject(raw,['deviceCode','edgeId','definitionVersion','changeIntent','changeReason','entries']),deviceCode=fieldText(p.deviceCode,128),edgeId=fieldText(p.edgeId,80),changeReason=fieldText(p.changeReason,2000);
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deviceCode)||!/^[A-Za-z0-9_-]+$/.test(edgeId)||p.definitionVersion!==fieldPolicyVersion||!['INITIAL','PROSPECTIVE','RETROSPECTIVE_CORRECTION'].includes(String(p.changeIntent))||!Array.isArray(p.entries)||!p.entries.length||p.entries.length>64)throw Error();
  const ids=new Set<string>();let previous=-Infinity,totalPoints=0;
  const entries=p.entries.map(raw=>{const e=fieldObject(raw,['id','effectiveFrom','reason','admission']),id=fieldText(e.id,64),at=calendarTime(e.effectiveFrom),reason=fieldText(e.reason,500);if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)||ids.has(id)||at<=previous)throw Error();ids.add(id);previous=at;
   let admission:FieldAdmission|null=null;if(e.admission!==null){const a=fieldObject(e.admission,['sourcePolicyRef','profile','profileDigest','leaseDurationMs']),profile=parsePublicFieldProfile(a.profile),profileDigest=fieldHash(a.profileDigest),sourcePolicyRef=fieldSourcePolicyRef(a.sourcePolicyRef),leaseDurationMs=fieldInteger(a.leaseDurationMs,500,30000);
    if(profile.source.deviceCode!==deviceCode||profile.source.edgeId!==edgeId||profileDigest!==publicFieldProfileDigest(profile))throw Error();totalPoints+=profile.points.length;if(totalPoints>512)throw new DomainError(400,'现场通道全版最多512个测点绑定');admission={sourcePolicyRef,profile,profileDigest,leaseDurationMs};
   }return {id,effectiveFrom:new Date(at).toISOString(),reason,admission};
  });return {deviceCode,edgeId,definitionVersion:fieldPolicyVersion,changeIntent:p.changeIntent as FieldPolicy['changeIntent'],changeReason,entries};
 }catch(e){if(e instanceof DomainError)throw e;throw new DomainError(400,'现场通道策略、公开配置或准确摘要无效');}
}
export const fieldPolicyEntry=(p:FieldPolicy,at:number)=>p.entries.filter(e=>Date.parse(e.effectiveFrom)<=at).at(-1)||null;
