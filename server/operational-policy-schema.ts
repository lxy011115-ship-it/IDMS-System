import {object,keys,text} from './schema-primitives.ts';
import {calendarIdentity,calendarTime} from './calendar-schema.ts';
import {DomainError} from './service.ts';
export const operationalDefinitionVersion='operational-metrics-1.0.0';
export interface OperationalDefinition {planMode:'FULL_PRODUCTION_PERIOD'|'APPROVED_CALENDAR';countUnit:string}
export interface OperationalEntry {id:string;effectiveFrom:string;reason:string;definition:OperationalDefinition|null}
export interface OperationalPolicy {deviceCode:string;definitionVersion:typeof operationalDefinitionVersion;changeIntent:'INITIAL'|'PROSPECTIVE'|'RETROSPECTIVE_CORRECTION';changeReason:string;entries:OperationalEntry[]}
export function operationalPolicySchema(raw:unknown):OperationalPolicy{
 const p=object(raw,'运营指标定义');keys(p,['deviceCode','definitionVersion','changeIntent','changeReason','entries']);const deviceCode=calendarIdentity(p),changeReason=text(p.changeReason,'指标口径变更依据',2000);
 if(p.definitionVersion!==operationalDefinitionVersion||!['INITIAL','PROSPECTIVE','RETROSPECTIVE_CORRECTION'].includes(String(p.changeIntent)))throw new DomainError(400,'指标定义版本或变更意图无效');
 if(!Array.isArray(p.entries)||p.entries.length<1||p.entries.length>64)throw new DomainError(400,'指标口径须有1至64条生效定义');let previous=-Infinity;const seen=new Set<string>();
 const entries=p.entries.map(raw=>{const e=object(raw,'指标生效条目');keys(e,['id','effectiveFrom','reason','definition']);const id=text(e.id,'指标条目编码',64),at=calendarTime(e.effectiveFrom),reason=text(e.reason,'生效依据',500);if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)||seen.has(id)||at<=previous)throw new DomainError(400,'指标条目编码须唯一，时间须严格递增');seen.add(id);previous=at;
  let definition:OperationalDefinition|null=null;if(e.definition!==null){const d=object(e.definition,'指标计算口径');keys(d,['planMode','countUnit']);if(!['FULL_PRODUCTION_PERIOD','APPROVED_CALENDAR'].includes(String(d.planMode)))throw new DomainError(400,'计划来源须为完整生产期间或明确批准日历');const countUnit=text(d.countUnit,'生产计数单位',32);if(/[\u0000-\u001f]/.test(countUnit))throw new DomainError(400,'计数单位含控制字符');definition={planMode:d.planMode as OperationalDefinition['planMode'],countUnit};}
  return {id,effectiveFrom:new Date(at).toISOString(),reason,definition};
 });return {deviceCode,definitionVersion:operationalDefinitionVersion,changeIntent:p.changeIntent as OperationalPolicy['changeIntent'],changeReason,entries};
}
