import {canonicalDigest,canonicalEqual,jsonWireClone} from './canonical-state.ts';
import {validateTenantPayload,type TenantPayload} from './entity-repository.ts';
import {fieldAdmissionDecision,fieldAdmissionVersion} from './field-admission.ts';
import {fieldPolicySchema} from './field-policy-schema.ts';
import {sourcePolicySchema} from './source-policy-schema.ts';
import {parsePublicFieldProfile,publicFieldProfileDigest,type PublicFieldProfile} from '../integrations/field-profile.ts';
import {encodeLegacyText,decodeLegacyText,legacyJsonText,type LegacyEntry,type LegacyLookup} from './legacy-map-v4.ts';
import {stateValueText} from './state-map-v1.ts';
import type {Store} from './store.ts';
import {telemetryDomainFormat,type TelemetryDomainControl} from './telemetry-map-v4.ts';

export const fieldAdmissionMapFormatV1='IDMS_FIELD_ADMISSION_MAP_V1';
const minimum=-8640000000000000,maximum=8640000000000000,unknownTag='\u0000field-map-undeclared';
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function need(v:unknown,code='FIELD_ADMISSION_MAP_INTEGRITY'):asserts v{if(!v)throw Object.assign(Error(code),{code});}
function exact(v:unknown,keys:string[]){return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');}
type Decision=ReturnType<typeof fieldAdmissionDecision>;
type StoredDecision=Omit<Decision,'binding'>&{binding:Omit<Decision['binding'],'evaluatedAt'>};
type Branch={format:typeof fieldAdmissionMapFormatV1;profileDigest:string;kind:'BRANCH';split:number;left:string;right:string};
type Leaf={format:typeof fieldAdmissionMapFormatV1;profileDigest:string;kind:'LEAF';from:number;until:number|null;fallback:string;unknown:string;tags:[string,string][]};
export interface FieldAdmissionMapHeadV1 {format:typeof fieldAdmissionMapFormatV1;tenantId:string;profileDigest:string;profile:PublicFieldProfile;compiledPayloadDigest:string;root:string;intervals:number;ruleVersion:typeof fieldAdmissionVersion}

/** Public policy profiles only. A compiled profile is not runtime registration. */
export function fieldAdmissionProfilesV1(payload:TenantPayload,tenantId:string,additional:readonly unknown[]=[]){
  validateTenantPayload(payload,tenantId);const profiles=new Map<string,PublicFieldProfile>();
  const add=(raw:unknown)=>{const p=parsePublicFieldProfile(raw),id=publicFieldProfileDigest(p);need(p.source.tenantId===tenantId,'FIELD_ADMISSION_MAP_TENANT');const prior=profiles.get(id);need(!prior||canonicalEqual(prior,p));profiles.set(id,p);need(profiles.size<=4096,'FIELD_ADMISSION_MAP_BUILD_LIMIT');};
  for(const raw of additional)add(raw);
  for(const t of payload.business.templates)if(t.tenantId===tenantId&&['PUBLISHED','RETIRED'].includes(t.status)&&t.manifest.purpose==='field-channel-policy')for(const e of fieldPolicySchema(t.manifest.fieldChannelPolicy).entries)if(e.admission)add(e.admission.profile);
  return [...profiles.values()].sort((a,b)=>publicFieldProfileDigest(a).localeCompare(publicFieldProfileDigest(b)));
}

/** Maintenance compiler. Runtime reads never reconstruct the tenant payload. */
export function compileFieldAdmissionMapV1(payload:TenantPayload,tenantId:string,additional:readonly unknown[]=[]){
  const profiles=fieldAdmissionProfilesV1(payload,tenantId,additional),store={...payload.business,audits:payload.audits,idempotency:new Map(payload.idempotency)} as Store;
  const anchor=canonicalDigest(payload),entries=new Map<string,LegacyEntry>(),heads:FieldAdmissionMapHeadV1[]=[],documents=new Set<string>();let boundaryChecks=0;
  const add=(entry:LegacyEntry)=>{const key=entry.namespace+'\0'+entry.key,old=entries.get(key);need(!old||old.valueText===entry.valueText);entries.set(key,entry);need(entries.size<=1000000,'FIELD_ADMISSION_MAP_BUILD_LIMIT');};
  for(const profile of profiles){
    const profileDigest=publicFieldProfileDigest(profile),templates=payload.business.templates.filter(t=>t.tenantId===tenantId&&['PUBLISHED','RETIRED'].includes(t.status)&&((t.manifest.purpose==='field-channel-policy'&&(t.manifest.fieldChannelPolicy as any)?.edgeId===profile.source.edgeId)||(t.manifest.purpose==='telemetry-source-policy'&&(t.manifest.telemetrySourcePolicy as any)?.edgeId===profile.source.edgeId)));
    const ids=new Set(templates.map(t=>t.id)),batchIds=new Set(payload.imports.batches.filter(b=>['DEVICE','POINT_DEFINITION'].includes(b.dataType)).map(b=>b.batchId)),times=new Set<number>([minimum]);
    for(const t of templates){const policy=t.manifest.purpose==='field-channel-policy'?fieldPolicySchema(t.manifest.fieldChannelPolicy):sourcePolicySchema(t.manifest.telemetrySourcePolicy);for(const e of policy.entries)times.add(Date.parse(e.effectiveFrom));}
    for(const a of payload.audits)if(a.objectType==='TEMPLATE'&&a.action==='TEMPLATE_APPROVED'&&ids.has(a.objectId)||a.objectType==='DATA_IMPORT'&&a.action==='IMPORT_COMMITTED'&&batchIds.has(a.objectId))times.add(Date.parse(a.businessTime));
    need(times.size<=100000&&[...times].every(t=>Number.isSafeInteger(t)&&t>=minimum&&t<=maximum),'FIELD_ADMISSION_MAP_BUILD_LIMIT');
    const document=(at:number,tag:string|null)=>{
      const decision=fieldAdmissionDecision(store,payload.imports,profile,at,tag),{evaluatedAt,...binding}=decision.binding;
      const normalized:StoredDecision=jsonWireClone({...decision,binding}),body={format:fieldAdmissionMapFormatV1,profileDigest,decision:normalized},id=canonicalDigest(body);
      for(const e of encodeLegacyText('blob','field_admission_decision:'+id,legacyJsonText(body)))add(e);documents.add(id);boundaryChecks++;return id;
    };
    const intervals:{from:number;fallback:string;unknown:string;tags:[string,string][]}[]=[];
    for(const at of [...times].sort((a,b)=>a-b)){
      const value={from:at,fallback:document(at,null),unknown:document(at,unknownTag),tags:profile.points.map(p=>[p.tagCode,document(at,p.tagCode)] as [string,string])},prior=intervals.at(-1);
      if(!prior||prior.fallback!==value.fallback||prior.unknown!==value.unknown||!canonicalEqual(prior.tags,value.tags))intervals.push(value);
    }
    const node=(value:Branch|Leaf)=>{const id=canonicalDigest(value);add({namespace:'blob',key:'field_admission_node:'+id,valueText:stateValueText(value)});return id;};
    const build=(lo:number,hi:number):string=>{if(hi-lo===1)return node({format:fieldAdmissionMapFormatV1,profileDigest,kind:'LEAF',...intervals[lo],until:intervals[hi]?.from??null});const mid=(lo+hi)>>1;return node({format:fieldAdmissionMapFormatV1,profileDigest,kind:'BRANCH',split:intervals[mid].from,left:build(lo,mid),right:build(mid,hi)});};
    const head:FieldAdmissionMapHeadV1={format:fieldAdmissionMapFormatV1,tenantId,profileDigest,profile,compiledPayloadDigest:anchor,root:build(0,intervals.length),intervals:intervals.length,ruleVersion:fieldAdmissionVersion};heads.push(head);add({namespace:'field_admission',key:profileDigest,valueText:stateValueText(head)});
  }
  return {entries:[...entries.values()],heads,boundaryChecks,decisionDocuments:documents.size};
}

/** get must verify membership at one trusted map root; expectedAnchor is current control.governanceAnchorDigest. */
export async function readFieldAdmissionMapV1(rawProfile:unknown,at:number,tag:string|null,expectedAnchor:string,get:LegacyLookup){
  const profile=parsePublicFieldProfile(rawProfile),profileDigest=publicFieldProfileDigest(profile);
  need(Number.isSafeInteger(at)&&at>=minimum&&at<=maximum&&digest(expectedAnchor)&&typeof get==='function');
  need(tag===null||typeof tag==='string'&&Buffer.byteLength(tag)<=128&&!tag.includes('\0'),'FIELD_ADMISSION_MAP_TAG');
  const h=await get('field_admission',profileDigest) as FieldAdmissionMapHeadV1;
  need(exact(h,['format','tenantId','profileDigest','profile','compiledPayloadDigest','root','intervals','ruleVersion'])&&h.format===fieldAdmissionMapFormatV1&&h.ruleVersion===fieldAdmissionVersion&&h.tenantId===profile.source.tenantId&&h.profileDigest===profileDigest&&canonicalEqual(parsePublicFieldProfile(h.profile),profile)&&digest(h.root)&&Number.isSafeInteger(h.intervals)&&h.intervals>0&&h.intervals<=100000);
  need(h.compiledPayloadDigest===expectedAnchor,'FIELD_ADMISSION_MAP_STALE');
  let id=h.root,lower=minimum,upper:number|null=null,steps=0;
  for(;;){
    need(++steps<=64,'FIELD_ADMISSION_MAP_READ_LIMIT');const n=await get('blob','field_admission_node:'+id) as Branch|Leaf;
    need(n&&n.format===fieldAdmissionMapFormatV1&&n.profileDigest===profileDigest&&canonicalDigest(n)===id);
    if(n.kind==='BRANCH'){
      need(exact(n,['format','profileDigest','kind','split','left','right'])&&Number.isSafeInteger(n.split)&&n.split>lower&&(upper===null||n.split<upper)&&digest(n.left)&&digest(n.right));
      if(at<n.split){id=n.left;upper=n.split;}else{id=n.right;lower=n.split;}continue;
    }
    need(n.kind==='LEAF'&&exact(n,['format','profileDigest','kind','from','until','fallback','unknown','tags'])&&n.from===lower&&n.until===upper&&at>=n.from&&(n.until===null||at<n.until)&&digest(n.fallback)&&digest(n.unknown)&&Array.isArray(n.tags)&&n.tags.length===profile.points.length);
    need(n.tags.every((p,i)=>Array.isArray(p)&&p.length===2&&p[0]===profile.points[i].tagCode&&digest(p[1])));
    const decisionId=tag===null?n.fallback:n.tags.find(p=>p[0]===tag)?.[1]??n.unknown;
    const body=JSON.parse(await decodeLegacyText('blob','field_admission_decision:'+decisionId,get));
    need(exact(body,['format','profileDigest','decision'])&&body.format===fieldAdmissionMapFormatV1&&body.profileDigest===profileDigest&&canonicalDigest(body)===decisionId);
    const d=body.decision as StoredDecision;
    need(exact(d,['allowed','reason','binding','definitions','leaseDurationMs','nextBoundary'])&&typeof d.allowed==='boolean'&&d.binding?.format==='idms-field-channel-binding-v1'&&d.binding.ruleVersion===fieldAdmissionVersion&&d.binding.profileDigest===profileDigest&&d.binding.fieldCommissioned===false&&Array.isArray(d.binding.conditions)&&d.binding.conditions.every(c=>typeof c==='string')&&d.allowed===(d.binding.conditions.length===0));
    need(d.allowed?d.reason===null&&d.binding.status==='APPROVED_FIELD_CONFIGURATION'&&Number.isSafeInteger(d.leaseDurationMs)&&d.leaseDurationMs>=500&&d.leaseDurationMs<=30000:typeof d.reason==='string'&&/^(?:FIELD|SOURCE)_[A-Z0-9_]+$/.test(d.reason)&&d.binding.status==='DENIED'&&d.leaseDurationMs===0);
    need(d.nextBoundary===null||Number.isSafeInteger(d.nextBoundary)&&d.nextBoundary>at);
    const decision:Decision=jsonWireClone({...d,binding:{...d.binding,evaluatedAt:new Date(at).toISOString()}});
    return {decision,head:h,nodeReads:steps};
  }
}

/** Runtime entry: maintenance preparation must withdraw intake even while the old index remains present. */
export async function readCurrentFieldAdmissionMapV1(rawProfile:unknown,at:number,tag:string|null,get:LegacyLookup){
  const profile=parsePublicFieldProfile(rawProfile),control=await get('domain_head','control') as TelemetryDomainControl;
  need(control?.format===telemetryDomainFormat&&control.tenantId===profile.source.tenantId&&typeof control.epoch==='string'&&/^[1-9][0-9]*$/.test(control.epoch)&&digest(control.governanceAnchorDigest));
  need(control.status==='ACTIVE','FIELD_ADMISSION_MAP_NOT_ACTIVE');
  const result=await readFieldAdmissionMapV1(profile,at,tag,control.governanceAnchorDigest,get);
  return {...result,control};
}
