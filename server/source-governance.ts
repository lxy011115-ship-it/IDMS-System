import type {EdgeSource} from '../integrations/telemetry.ts';
import type {Store} from './store.ts';
import type {ImportView} from './imports.ts';
import {canonical,digest} from './imports.ts';
import {publicationIndex} from './template-history.ts';
import {sourcePolicyHistory,type SourcePolicyContext} from './source-policy-history.ts';
import {sourcePolicyEntry,type SourcePolicyMapping} from './source-policy-schema.ts';
import {sourceGovernanceFacts,sourceGovernanceIntegrity,sourceDefinitionRef,referencedPoint,type SourceGovernanceFacts} from './source-policy-references.ts';
import type {HistoricalImportRecord} from './asof-imports.ts';
export const sourceGovernanceVersion='approved-source-binding-1.0.0';
export type PublicGovernedSource=Pick<EdgeSource,'tenantId'|'edgeId'|'deviceCode'|'origin'|'mapVersion'|'points'>;
const safe=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
export function publicGovernedSource(source:PublicGovernedSource):PublicGovernedSource{
 if(!/^[A-Za-z0-9_-]{1,80}$/.test(source.tenantId)||!/^[A-Za-z0-9_-]{1,80}$/.test(source.edgeId)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(source.deviceCode)||!['SIMULATOR','FIELD'].includes(source.origin)||!safe(source.mapVersion,128)||!Array.isArray(source.points)||!source.points.length||source.points.length>128)throw sourceGovernanceIntegrity();const tags=new Set<string>(),nodes=new Set<string>();
 const points=source.points.map(p=>{if(!safe(p.tagCode,128)||!safe(p.nodeId,512)||!safe(p.unit,64)||tags.has(p.tagCode)||nodes.has(p.nodeId))throw sourceGovernanceIntegrity();tags.add(p.tagCode);nodes.add(p.nodeId);return {tagCode:p.tagCode,nodeId:p.nodeId,unit:p.unit};}).sort((a,b)=>a.tagCode<b.tagCode?-1:a.tagCode>b.tagCode?1:a.nodeId<b.nodeId?-1:a.nodeId>b.nodeId?1:0);
 return {tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,origin:source.origin,mapVersion:source.mapVersion,points};
}
export function approvedPublicSource(tenant:string,edge:string,device:string,mapping:SourcePolicyMapping){return publicGovernedSource({tenantId:tenant,edgeId:edge,deviceCode:device,origin:mapping.origin,mapVersion:mapping.mapVersion,points:mapping.points});}
const recordSource=(h:HistoricalImportRecord)=>({sourceSystem:h.record.sourceSystem,sourceRecordId:String(h.record.value.source_record_id),...h.source});
export interface SourceBinding {
 format:'idms-source-governance-binding-v1';ruleVersion:typeof sourceGovernanceVersion;clockBasis:'PARENT_AUDIT_BUSINESS_TIME';status:'APPROVED_CONFIGURATION'|'DENIED';
 policySource:NonNullable<SourcePolicyContext['selected']>['source']|null;entryId:string|null;entryDigest:string|null;configuredSource:PublicGovernedSource;configuredSourceDigest:string;approvedSourceDigest:string|null;
 approvedIdentity:{tenantId:string;edgeId:string;deviceCode:string}|null;
 assetSource:ReturnType<typeof recordSource>|null;pointDefinition:null|{tagCode:string;unit:string;minimum:number;maximum:number;source:ReturnType<typeof recordSource>};conditions:string[];fieldCommissioned:false;
}
export interface SourceGovernanceDecision {enforced:boolean;allowed:boolean;status:'LEGACY_SIMULATOR_UNAPPROVED'|'APPROVED_CONFIGURATION'|'DENIED';reason:string|null;binding:SourceBinding|null;definitions:Record<string,{unit:string;min:number;max:number}>}
// This versioned decision concerns the configuration at intake, not proof of
// the physical configuration at eventTime, human approval of each value, or
// field commissioning. Caller verifies the root and current source beforehand.
export function evaluateSourceGovernance(sourceRaw:PublicGovernedSource,history:SourcePolicyContext,facts:SourceGovernanceFacts|null,at:number,eventTagCode:string|null):SourceGovernanceDecision{
 if(!Number.isFinite(at))throw sourceGovernanceIntegrity();if(!history.everPublished&&sourceRaw.origin==='SIMULATOR')return {enforced:false,allowed:true,status:'LEGACY_SIMULATOR_UNAPPROVED',reason:null,binding:null,definitions:{}};const source=publicGovernedSource(sourceRaw);
 const selected=history.selected,entry=selected?sourcePolicyEntry(selected.policy,at):null,conditions:string[]=[],configuredSourceDigest=digest(canonical(source));let approvedSourceDigest:string|null=null,assetSource:SourceBinding['assetSource']=null,pointDefinition:SourceBinding['pointDefinition']=null;const definitions:SourceGovernanceDecision['definitions']={};
 if(source.origin==='FIELD')conditions.push('FIELD_COMMISSIONING_DISABLED');if(!selected)conditions.push('SOURCE_APPROVAL_UNDECLARED');else if(selected.policy.edgeId!==source.edgeId||selected.policy.deviceCode!==source.deviceCode)conditions.push('SOURCE_APPROVED_IDENTITY_MISMATCH');
 if(selected&&!entry)conditions.push('SOURCE_APPROVAL_NOT_EFFECTIVE');if(entry&&!entry.mapping)conditions.push('SOURCE_APPROVAL_PAUSED');
 if(selected&&entry?.mapping){const approved=approvedPublicSource(source.tenantId,selected.policy.edgeId,selected.policy.deviceCode,entry.mapping);approvedSourceDigest=digest(canonical(approved));if(approvedSourceDigest!==configuredSourceDigest)conditions.push('SOURCE_APPROVED_MAPPING_MISMATCH');
  if(!facts)throw sourceGovernanceIntegrity();const assets=facts.current.filter(h=>h.record.dataType==='DEVICE'&&h.record.value.device_code===selected.policy.deviceCode);if(assets.length>1)throw sourceGovernanceIntegrity();if(!assets.length)conditions.push('SOURCE_CURRENT_ASSET_UNAPPROVED');else assetSource=recordSource(assets[0]);
  const current=new Map<string,HistoricalImportRecord>();for(const h of facts.current.filter(h=>h.record.dataType==='POINT_DEFINITION'&&h.record.value.device_code===selected.policy.deviceCode)){const tag=String(h.record.value.tag_code);if(current.has(tag))throw sourceGovernanceIntegrity();current.set(tag,h);}
  for(const p of entry.mapping.points){let approved:HistoricalImportRecord;try{approved=referencedPoint(facts,selected.policy,p);}catch(error){if((error as {status?:unknown}).status===409)throw sourceGovernanceIntegrity();throw error;}const now=current.get(p.tagCode);if(!now||canonical(sourceDefinitionRef(now))!==canonical(p.definitionRef)){conditions.push('SOURCE_APPROVED_DEFINITION_CHANGED');continue;}const v=approved.record.value;definitions[p.tagCode]={unit:p.unit,min:Number(v.min_value),max:Number(v.max_value)};if(eventTagCode===p.tagCode)pointDefinition={tagCode:p.tagCode,unit:p.unit,minimum:Number(v.min_value),maximum:Number(v.max_value),source:recordSource(approved)};}
 }
 const unique=[...new Set(conditions)].sort(),status=unique.length?'DENIED':'APPROVED_CONFIGURATION',binding:SourceBinding={format:'idms-source-governance-binding-v1',ruleVersion:sourceGovernanceVersion,clockBasis:'PARENT_AUDIT_BUSINESS_TIME',status,policySource:selected?.source||null,entryId:entry?.id||null,entryDigest:entry?digest(canonical(entry)):null,configuredSource:source,configuredSourceDigest,approvedSourceDigest,approvedIdentity:selected?{tenantId:source.tenantId,edgeId:selected.policy.edgeId,deviceCode:selected.policy.deviceCode}:null,assetSource,pointDefinition,conditions:unique,fieldCommissioned:false};
 return {enforced:true,allowed:status==='APPROVED_CONFIGURATION',status,reason:unique[0]||null,binding,definitions};
}
export function sourceGovernanceContext(store:Pick<Store,'templates'|'audits'>,data:ImportView,source:PublicGovernedSource,at:number){const publications=publicationIndex(store.audits,source.tenantId),history=sourcePolicyHistory(store.templates,source.tenantId,source.edgeId,at,id=>publications.get(id),publications),facts=history.everPublished?sourceGovernanceFacts(data,store.audits,source.tenantId,at):null;return {history,facts};}
export function sourceGovernanceDecision(store:Pick<Store,'templates'|'audits'>,data:ImportView,source:PublicGovernedSource,at:number,eventTagCode:string|null){const {history,facts}=sourceGovernanceContext(store,data,source,at);return evaluateSourceGovernance(source,history,facts,at,eventTagCode);}
