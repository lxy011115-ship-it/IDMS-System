import {object,keys,text} from './schema-primitives.ts';
import {calendarIdentity,calendarTime} from './calendar-schema.ts';
import {DomainError} from './service.ts';

export const policyMetrics=['NON_GOOD_PERCENT','DUPLICATE_TIME_COUNT','UNIT_MISMATCH_COUNT','OUT_OF_RANGE_COUNT','RECEIVED_COVERAGE_PERCENT','GOOD_VALID_COVERAGE_PERCENT','MISSING_PLANNED_SLOT_COUNT'] as const;
export type PolicyMetric=typeof policyMetrics[number];
export interface PolicyRule {id:string;tagCode:string|null;source:'UPLOADS'|'TELEMETRY'|'BOTH';metric:PolicyMetric;operator:'GT'|'GTE'|'LT'|'LTE';threshold:number;severity:'WARNING'|'ERROR';reason:string}
export interface PolicyEntry {id:string;effectiveFrom:string;reason:string;rules:PolicyRule[]|null}
export interface DataQualityPolicy {deviceCode:string;changeIntent:'INITIAL'|'PROSPECTIVE'|'RETROSPECTIVE_CORRECTION';changeReason:string;entries:PolicyEntry[]}
const identifier=(raw:unknown,label:string,max=64)=>{const id=text(raw,label,max);if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))throw new DomainError(400,label+'格式无效');return id;};
export function dataQualityPolicySchema(raw:unknown):DataQualityPolicy{
 const v=object(raw,'质量策略');keys(v,['deviceCode','changeIntent','changeReason','entries']);const deviceCode=calendarIdentity(v),changeReason=text(v.changeReason,'质量策略变更依据',2000);
 if(!['INITIAL','PROSPECTIVE','RETROSPECTIVE_CORRECTION'].includes(String(v.changeIntent)))throw new DomainError(400,'质量策略须明确首次、未来调整或历史修订');
 if(!Array.isArray(v.entries)||v.entries.length<1||v.entries.length>64)throw new DomainError(400,'质量策略须有1至64条生效条目');
 const seen=new Set<string>();let previous=-Infinity;
 const entries=v.entries.map(raw=>{const e=object(raw,'质量生效条目');keys(e,['id','effectiveFrom','reason','rules']);const id=identifier(e.id,'条目编码'),at=calendarTime(e.effectiveFrom),reason=text(e.reason,'生效依据',500);if(seen.has(id)||at<=previous)throw new DomainError(400,'质量条目编码须唯一，生效时间须严格递增');seen.add(id);previous=at;
  let rules:PolicyRule[]|null=null;
  if(e.rules!==null){if(!Array.isArray(e.rules)||e.rules.length<1||e.rules.length>32)throw new DomainError(400,'每条须有1至32条质量规则，暂停须显式null');const ruleIds=new Set<string>();rules=e.rules.map(raw=>{const r=object(raw,'质量规则');keys(r,['id','tagCode','source','metric','operator','threshold','severity','reason']);const ruleId=identifier(r.id,'规则编码');if(ruleIds.has(ruleId))throw new DomainError(400,'同条目规则编码重复');ruleIds.add(ruleId);
   if(r.tagCode!==null&&(typeof r.tagCode!=='string'||!r.tagCode||r.tagCode.length>128||/[\u0000-\u001f]/.test(r.tagCode)))throw new DomainError(400,'规则测点须为明确编码或null');
   if(!['UPLOADS','TELEMETRY','BOTH'].includes(String(r.source))||!policyMetrics.includes(r.metric as PolicyMetric)||!['GT','GTE','LT','LTE'].includes(String(r.operator))||!['WARNING','ERROR'].includes(String(r.severity)))throw new DomainError(400,'规则来源、指标、比较符或严重度无效');
   const percent=String(r.metric).endsWith('_PERCENT');if(typeof r.threshold!=='number'||!Number.isFinite(r.threshold)||r.threshold<0||r.threshold>(percent?100:25000)||!percent&&!Number.isSafeInteger(r.threshold))throw new DomainError(400,'比例阈值须为0至100，计数阈值须为0至25000整数');
   return {id:ruleId,tagCode:r.tagCode as string|null,source:r.source as PolicyRule['source'],metric:r.metric as PolicyMetric,operator:r.operator as PolicyRule['operator'],threshold:r.threshold,severity:r.severity as PolicyRule['severity'],reason:text(r.reason,'规则依据',500)};
  });}
  return {id,effectiveFrom:new Date(at).toISOString(),reason,rules};
 });
 return {deviceCode,changeIntent:v.changeIntent as DataQualityPolicy['changeIntent'],changeReason,entries};
}
