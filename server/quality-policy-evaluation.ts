import {canonical,digest} from './imports.ts';
import {object,keys} from './schema-primitives.ts';
import {calendarTime} from './calendar-schema.ts';
import {dataQualityPolicySchema,type PolicyRule} from './quality-policy-schema.ts';
import {qualityPolicyIntegrity,type QualityPolicyContext} from './quality-policy-history.ts';
import {validateFrozenCoverageInput,computeFrozenCoverageV1,type FrozenCoverageInput,type FrozenSegment} from './frozen-coverage-v1.ts';
import {DomainError} from './service.ts';

export const policyEvaluationVersion='governed-data-quality-1.0.0';
type Status='PASS'|'TRIGGERED'|'UNKNOWN'|'NOT_APPLICABLE';
interface Observation {time:number;value:unknown;unit:unknown;quality:unknown;bindingValid:boolean;source:Record<string,unknown>}
interface RuleEvaluation {rule:PolicyRule;value:number|null;status:Status;conditions:string[];recordCount:number;examples:Record<string,unknown>[]}
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function contextFor(raw:QualityPolicyContext,input:FrozenCoverageInput){
 if(raw===null)return null;
 try{const c=object(raw);keys(c,['policy','source']);const policy=dataQualityPolicySchema(c.policy),s=object(c.source);keys(s,['templateId','templateKey','version','contentDigest','recordedAt','governanceEventId','changeIntent','changeReason']);
  if(canonical(policy)!==canonical(c.policy)||policy.deviceCode!==input.deviceCode||typeof s.templateId!=='string'||!s.templateId||typeof s.templateKey!=='string'||!/^[a-z][a-z0-9-]{0,79}$/.test(s.templateKey)||typeof s.version!=='string'||!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(s.version)||!sha(s.contentDigest)||calendarTime(s.recordedAt)>calendarTime(input.query.knownAt)||typeof s.governanceEventId!=='string'||!s.governanceEventId||s.changeIntent!==policy.changeIntent||s.changeReason!==policy.changeReason)throw Error();return raw;
 }catch{throw qualityPolicyIntegrity();}
}
function observations(input:FrozenCoverageInput){
 const groups=new Map<string,Observation[]>(),add=(edge:string|null,tag:string,item:Observation)=>{const key=canonical([edge,tag]),rows=groups.get(key)||[];rows.push(item);groups.set(key,rows);};
 if(input.source==='UPLOADS')for(const r of input.imports){if(r.record.dataType!=='MEASUREMENT')continue;const v=r.record.value;add(null,String(v.tag_code),{time:calendarTime(v.measured_at),value:v.value,unit:v.unit,quality:v.quality,bindingValid:true,source:{kind:'UPLOAD',...r.source,sourceSystem:r.record.sourceSystem,sourceRecordId:v.source_record_id}});}
 else for(const r of input.telemetry){const source=input.registry!.sources.find(s=>s.edgeId===r.edgeId),point=source?.points.find(p=>p.tagCode===r.tagCode);add(r.edgeId,r.tagCode,{time:calendarTime(r.eventTime),value:r.value,unit:r.unit,quality:r.quality,bindingValid:!!point&&r.receiptValid&&r.mapVersion===source!.mapVersion&&r.origin===source!.origin&&r.nodeId===point.nodeId&&r.unit===point.unit,source:{kind:'TELEMETRY',pointId:r.pointId,edgeId:r.edgeId,eventTime:r.eventTime,receivedAt:r.receivedAt,inputDigest:r.inputDigest,mapVersion:r.mapVersion,origin:r.origin}});}
 return groups;
}
const applies=(r:PolicyRule,source:FrozenCoverageInput['source'],tag:string)=>r.source==='BOTH'||r.source===source? r.tagCode===null||r.tagCode===tag:false;
const trigger=(r:PolicyRule,value:number)=>r.operator==='GT'?value>r.threshold:r.operator==='GTE'?value>=r.threshold:r.operator==='LT'?value<r.threshold:value<=r.threshold;
const numeric=(v:unknown)=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
export function evaluateQualityPolicy(raw:FrozenCoverageInput,rawPolicy:QualityPolicyContext){
 const input=validateFrozenCoverageInput(raw),context=contextFor(rawPolicy,input),from=calendarTime(input.query.from),to=calendarTime(input.query.to),policy=context?.policy||null;
 const cuts=[...new Set([from,to,...input.calendarContext.segments.map(s=>calendarTime(s.from)),...(policy?.entries.map(e=>calendarTime(e.effectiveFrom)).filter(t=>t>from&&t<to)||[])])].sort((a,b)=>a-b);
 if(cuts.length-1>129)throw new DomainError(422,'规则与日历合并超过129段，请缩小时间窗口');
 const segments:FrozenSegment[]=cuts.slice(1).map((b,index)=>{const a=cuts[index],old=input.calendarContext.segments.find(s=>calendarTime(s.from)<=a&&calendarTime(s.to)>=b);if(!old)throw qualityPolicyIntegrity();return {...old,index,from:new Date(a).toISOString(),to:new Date(b).toISOString()};});
 const coverage=computeFrozenCoverageV1({...input,calendarContext:{...input.calendarContext,segments}}),records=observations(input),definitions=new Map(input.imports.filter(r=>r.record.dataType==='POINT_DEFINITION').map(r=>[String(r.record.value.tag_code),r])),asset=input.imports.some(r=>r.record.dataType==='DEVICE');
 let ruleEvaluations=0;const unmatchedRules:{entryId:string;ruleId:string;tagCode:string|null;reason:string}[]=[],seenUnmatched=new Set<string>(),points=new Set(coverage.items.map(i=>canonical([i.edgeId,i.tagCode])));
 const items=coverage.items.map(point=>{
  const entry=policy?.entries.filter(e=>calendarTime(e.effectiveFrom)<=calendarTime(point.segmentFrom)).at(-1)||null,rows=(records.get(canonical([point.edgeId,point.tagCode]))||[]).filter(r=>r.time>=calendarTime(point.segmentFrom)&&r.time<calendarTime(point.segmentTo)),definition=definitions.get(point.tagCode),conditions:string[]=[];
  if(!asset)conditions.push('HISTORICAL_ASSET_UNDECLARED');if(!definition)conditions.push('MISSING_APPROVED_DEFINITION');if(!rows.length)conditions.push('NO_RECORDS_IN_SEGMENT');if(rows.some(r=>!r.bindingValid))conditions.push('SAMPLE_BINDING_UNVERIFIED');
  if(!context)conditions.push('POLICY_UNDECLARED');else if(!entry)conditions.push('NO_EFFECTIVE_POLICY_ENTRY');else if(entry.rules===null)conditions.push('POLICY_SUSPENDED');
  const selected=entry?.rules?.filter(r=>applies(r,input.source,point.tagCode))||[];if(entry?.rules&&selected.length===0)conditions.push('NO_MATCHING_RULE');
  ruleEvaluations+=selected.length;if(ruleEvaluations>4096)throw new DomainError(422,'完整质量规则评估超过4096项，请缩小范围');
  const seen=new Set<number>(),duplicates=rows.filter(r=>{const duplicate=seen.has(r.time);seen.add(r.time);return duplicate;}),nonGood=rows.filter(r=>r.quality!=='GOOD'),units=definition?rows.filter(r=>r.unit!==definition.record.value.unit):[],outOfRange=definition?rows.filter(r=>!numeric(r.value)||Number(r.value)<Number(definition.record.value.min_value)||Number(r.value)>Number(definition.record.value.max_value)):[];
  const rules:RuleEvaluation[]=selected.map(rule=>{
   let value:number|null=null,examples:Observation[]=[],extra:string[]=[],notApplicable=false;
   switch(rule.metric){
    case 'NON_GOOD_PERCENT':value=rows.length?nonGood.length/rows.length*100:null;examples=nonGood;break;
    case 'DUPLICATE_TIME_COUNT':value=duplicates.length;examples=duplicates;break;
    case 'UNIT_MISMATCH_COUNT':value=definition?units.length:null;examples=units;break;
    case 'OUT_OF_RANGE_COUNT':value=definition?outOfRange.length:null;examples=outOfRange;if(units.length)extra.push('UNIT_MISMATCH_PREVENTS_RANGE');break;
    case 'RECEIVED_COVERAGE_PERCENT':value=point.receivedCoveragePercent;break;
    case 'GOOD_VALID_COVERAGE_PERCENT':value=point.goodValidCoveragePercent;break;
    case 'MISSING_PLANNED_SLOT_COUNT':value=point.missingSlots;break;
   }
   if(['RECEIVED_COVERAGE_PERCENT','GOOD_VALID_COVERAGE_PERCENT','MISSING_PLANNED_SLOT_COUNT'].includes(rule.metric)){
    extra.push(...point.conditions);notApplicable=point.status==='NOT_APPLICABLE';if(point.status==='UNKNOWN')value=null;
   }
   const causes=[...new Set([...conditions,...extra])];if(value===null&&!causes.length&&!notApplicable)causes.push('METRIC_UNAVAILABLE');
   const status:Status=notApplicable&&asset&&definition&&!rows.some(r=>!r.bindingValid)?'NOT_APPLICABLE':causes.length||value===null?'UNKNOWN':trigger(rule,value)?'TRIGGERED':'PASS';
   return {rule,value,status,conditions:causes,recordCount:rows.length,examples:examples.slice(0,5).map(r=>({...r.source,sample:{at:new Date(r.time).toISOString(),value:r.value,unit:r.unit,quality:r.quality}}))};
  });
  const status:Status=rules.some(r=>r.status==='TRIGGERED')?'TRIGGERED':!rules.length||rules.some(r=>r.status==='UNKNOWN')?'UNKNOWN':rules.every(r=>r.status==='NOT_APPLICABLE')?'NOT_APPLICABLE':'PASS';
  return {deviceCode:input.deviceCode,edgeId:point.edgeId,tagCode:point.tagCode,tagName:point.tagName,configuredOrigin:point.configuredOrigin,segmentIndex:point.segmentIndex,from:point.segmentFrom,to:point.segmentTo,policyEntry:entry?{id:entry.id,effectiveFrom:entry.effectiveFrom,reason:entry.reason}:null,status,conditions,recordCount:rows.length,definitionSource:definition?.source||null,calendarSource:point.calendarSource,coverage:{expectedSlots:point.expectedSlots,receivedSlots:point.receivedSlots,goodValidSlots:point.goodValidSlots,missingSlots:point.missingSlots,partialSlots:point.partialSlots,plannedSeconds:point.plannedSeconds,stoppedSeconds:point.stoppedSeconds,undeclaredSeconds:point.undeclaredSeconds},rules};
 });
 for(const segment of segments){const entry=policy?.entries.filter(e=>calendarTime(e.effectiveFrom)<=calendarTime(segment.from)).at(-1);for(const rule of entry?.rules||[]){if(rule.source!=='BOTH'&&rule.source!==input.source)continue;if([...points].some(key=>{const [,tag]=JSON.parse(key);return rule.tagCode===null||rule.tagCode===tag;}))continue;const key=canonical([entry!.id,rule.id]);if(seenUnmatched.has(key))continue;seenUnmatched.add(key);unmatchedRules.push({entryId:entry!.id,ruleId:rule.id,tagCode:rule.tagCode,reason:'NO_MATCHING_POINT'});}}
 const allRules=items.flatMap(i=>i.rules),summary={segments:segments.length,pointSegments:items.length,ruleEvaluations,triggeredRules:allRules.filter(r=>r.status==='TRIGGERED').length,errorRules:allRules.filter(r=>r.status==='TRIGGERED'&&r.rule.severity==='ERROR').length,warningRules:allRules.filter(r=>r.status==='TRIGGERED'&&r.rule.severity==='WARNING').length,unknownRules:allRules.filter(r=>r.status==='UNKNOWN').length,notApplicableRules:allRules.filter(r=>r.status==='NOT_APPLICABLE').length,unmatchedRules:unmatchedRules.length};
 const conditions=coverage.unmappedReceivedRecords?['UNMAPPED_SOURCE_RECORDS']:[];
 const status:Status=summary.triggeredRules?'TRIGGERED':!items.length||unmatchedRules.length||conditions.length||items.some(i=>i.status==='UNKNOWN')?'UNKNOWN':items.every(i=>i.status==='NOT_APPLICABLE')?'NOT_APPLICABLE':'PASS';
 return {source:input.source,deviceCode:input.deviceCode,window:{from:input.query.from,to:input.query.to,boundary:'FROM_INCLUSIVE_TO_EXCLUSIVE'},knownAt:input.query.knownAt,ruleVersion:policyEvaluationVersion,coverageRuleVersion:coverage.ruleVersion,status,conditions,summary,policySource:context?.source||null,unmatchedRules,unmappedReceivedRecords:coverage.unmappedReceivedRecords,items,total:items.length,readOnly:true,fieldCommissioned:false,notice:'按已批准历史规则与完整输入逐段评估；PASS仅表示这些质量规则未触发，不代表设备健康、质量放行或现场验收。无规则及缺条件保持未知；各段分母独立。资料截止是持久逻辑时间，普通SHA不证明外部签名或可信授时。'};
}
export function qualityEvaluationPackage(raw:FrozenCoverageInput,policy:QualityPolicyContext){
 const input=JSON.parse(JSON.stringify(raw)) as FrozenCoverageInput,context=JSON.parse(JSON.stringify(policy)) as QualityPolicyContext,result=evaluateQualityPolicy(input,context);
 return {format:'idms-quality-policy-evaluation-v1' as const,input,policy:context,result,inputDigest:digest(canonical(input)),policyDigest:digest(canonical(context)),resultDigest:digest(canonical(result)),verification:'SHA_AND_RECOMPUTATION_NOT_AN_EXTERNAL_SIGNATURE' as const};
}
export function verifyQualityEvaluationPackage(raw:unknown){
 try{const p=object(raw);keys(p,['format','input','policy','result','inputDigest','policyDigest','resultDigest','verification']);if(p.format!=='idms-quality-policy-evaluation-v1'||p.verification!=='SHA_AND_RECOMPUTATION_NOT_AN_EXTERNAL_SIGNATURE')throw Error();const computed=qualityEvaluationPackage(p.input as FrozenCoverageInput,p.policy as QualityPolicyContext);if(canonical(p)!==canonical(computed))throw Error();return {consistent:true,ruleVersion:policyEvaluationVersion,inputDigest:computed.inputDigest,policyDigest:computed.policyDigest,resultDigest:computed.resultDigest,status:computed.result.status,externalAuthenticity:'NOT_PROVEN',persistentApprovalReport:false};}catch{throw qualityPolicyIntegrity();}
}
