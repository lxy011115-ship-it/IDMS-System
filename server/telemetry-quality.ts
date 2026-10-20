import type {EdgeSource} from '../integrations/telemetry.ts';
import type {AccessContext} from './access.ts';
import {requireAccess,scopeAllows} from './access.ts';
import {qualityQuery} from './data-quality.ts';
import {defaultQualityPolicy} from './equipment-profile-schema.ts';
import {measurementSchema} from './measurement-schema.ts';
import {DomainError} from './service.ts';

export const telemetryQualityVersion='telemetry-data-quality-1.0.0';
export const telemetryQualityIntegrity=()=>new DomainError(503,'采集质量快照或来源绑定不可验证');
export type QualitySource=Pick<EdgeSource,'tenantId'|'edgeId'|'deviceCode'|'mapVersion'|'origin'|'points'>;
export type QualityPolicy=typeof defaultQualityPolicy;
export interface QualityDefinition {deviceCode:string;tagCode:string;name:string;unit:string;min:number;max:number;interval:number|null;policy:QualityPolicy;policyOrigin:'FROZEN_EQUIPMENT_PROFILE'|'PLATFORM_DEFAULT';templateKey:string|null;templateVersion:string|null;source:{batchId:string;sourceRow:number;snapshotDigest:string;recordVersion:number}}
export interface QualityDevice {device_code:string;site_code?:unknown;line_code?:unknown;device_name?:string}
export interface QualityPoint {index:number;tenantId:string;edgeId:string;deviceCode:string;deviceName:string;siteCode:string|null;tagCode:string;nodeId:string;unit:string;mapVersion:string;origin:EdgeSource['origin'];definition:QualityDefinition|null}
export type QualityQuery=ReturnType<typeof telemetryQualityQuery>;
export function telemetryQualityQuery(params:URLSearchParams,now:number){
 const keys=[...params.keys()];if(new Set(keys).size!==keys.length)throw new DomainError(400,'采集质量查询含重复参数');
 const edge=params.get('edgeId');if(edge!==null&&(!/^[A-Za-z0-9_-]{1,80}$/.test(edge)))throw new DomainError(400,'采集源筛选无效');
 const rest=new URLSearchParams(params);rest.delete('edgeId');return {...qualityQuery(rest,now),edge};
}
const code=(s:unknown,max=128):s is string=>typeof s==='string'&&s.length>0&&s.length<=max;
// Whitelist before any planning or response. Registry credentials and URLs never
// become quality data, even if a caller passes the complete EdgeSource object.
export function qualitySources(sources:readonly EdgeSource[],tenant:string):QualitySource[]{
 const seen=new Set<string>();if(sources.length>100)throw telemetryQualityIntegrity();
 return sources.filter(s=>s.tenantId===tenant).map(s=>{
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(s.edgeId)||seen.has(s.edgeId)||!code(s.deviceCode)||!code(s.mapVersion)||!['SIMULATOR','FIELD'].includes(s.origin)||!Array.isArray(s.points)||!s.points.length||s.points.length>Object.keys(measurementSchema).length)throw telemetryQualityIntegrity();seen.add(s.edgeId);const tags=new Set<string>();
  const points=s.points.map(p=>{if(!Object.hasOwn(measurementSchema,p.tagCode)||tags.has(p.tagCode)||!code(p.nodeId,512)||!code(p.unit,64))throw telemetryQualityIntegrity();tags.add(p.tagCode);return {tagCode:p.tagCode,nodeId:p.nodeId,unit:p.unit};});
  return {tenantId:s.tenantId,edgeId:s.edgeId,deviceCode:s.deviceCode,mapVersion:s.mapVersion,origin:s.origin,points};
 });
}
export function qualityPlans(sources:readonly QualitySource[],ctx:AccessContext,q:QualityQuery,assets:ReadonlyMap<string,QualityDevice>,legacy:ReadonlyMap<string,{line:unknown;name:string}>,definitions:ReadonlyMap<string,QualityDefinition>):QualityPoint[]{
 requireAccess(ctx,'read');const points:QualityPoint[]=[];
 for(const s of sources){if(s.tenantId!==ctx.tenantId)throw telemetryQualityIntegrity();if(q.edge&&q.edge!==s.edgeId||q.device&&q.device!==s.deviceCode)continue;const a=assets.get(s.deviceCode),old=legacy.get(s.deviceCode);
  if(!scopeAllows(ctx,a||{device_code:s.deviceCode,line_code:old?.line}))continue;
  for(const p of s.points){if(q.tag&&q.tag!==p.tagCode)continue;points.push({index:0,tenantId:ctx.tenantId,edgeId:s.edgeId,deviceCode:s.deviceCode,deviceName:a?.device_name||old?.name||s.deviceCode,siteCode:typeof a?.site_code==='string'?a.site_code:null,tagCode:p.tagCode,nodeId:p.nodeId,unit:p.unit,mapVersion:s.mapVersion,origin:s.origin,definition:definitions.get(JSON.stringify([s.deviceCode,p.tagCode]))||null});}
 }
 points.sort((a,b)=>a.edgeId.localeCompare(b.edgeId)||a.deviceCode.localeCompare(b.deviceCode)||a.tagCode.localeCompare(b.tagCode));points.forEach((p,i)=>p.index=i);return points;
}
export interface PointEvidence {pointId:string;edgeId:string;deviceCode:string;tagCode:string;eventTime:string;receivedAt:string;inputDigest:string;origin:string;mapVersion:string;nodeId:string;sequenceNo:string;value:number|null|'NaN'|'Infinity'|'-Infinity';unit:string;quality:'GOOD'|'BAD'|'UNCERTAIN'}
export interface RejectionEvidence {eventId:string;receivedAt:string;inputDigest:string;reason:string}
export interface SourceRejections {edgeId:string;deviceCode:string;origin:EdgeSource['origin'];count:number;unmapped:number;unmappedReceived:number;examples:RejectionEvidence[];unmappedExamples:PointEvidence[]}
export interface QualityIntake {total:number;unmapped:number;unmappedReceived:number;totalSources:number;registeredSources:number;registeredDevices:number;items:SourceRejections[];hasMore:boolean}
export function qualityIntake(rows:SourceRejections[],registeredSources:number,registeredDevices:number):QualityIntake{
 if(qualityCount(registeredSources)!==rows.length||rows.length>100||new Set(rows.map(r=>r.edgeId)).size!==rows.length||qualityCount(registeredDevices)!==new Set(rows.map(r=>r.deviceCode)).size)throw telemetryQualityIntegrity();
 const clean=rows.map(r=>{const count=qualityCount(r.count),unmapped=qualityCount(r.unmapped),unmappedReceived=qualityCount(r.unmappedReceived);if(!Array.isArray(r.unmappedExamples)||r.unmappedExamples.length>Math.min(5,unmappedReceived)||unmapped>count||!Array.isArray(r.examples)||r.examples.length>Math.min(5,count))throw telemetryQualityIntegrity();return {edgeId:r.edgeId,deviceCode:r.deviceCode,origin:r.origin,count,unmapped,unmappedReceived,unmappedExamples:r.unmappedExamples.map(e=>pointEvidence(e,{edgeId:r.edgeId,deviceCode:r.deviceCode})),examples:r.examples.map(e=>({eventId:e.eventId,receivedAt:e.receivedAt,inputDigest:e.inputDigest,reason:e.reason}))};});
 const sum=(pick:(r:SourceRejections)=>number)=>clean.reduce((n,r)=>qualityCount(n+pick(r)),0),selected=clean.filter(r=>r.count>0||r.unmappedReceived>0).sort((a,b)=>a.edgeId.localeCompare(b.edgeId));
 return {total:sum(r=>r.count),unmapped:sum(r=>r.unmapped),unmappedReceived:sum(r=>r.unmappedReceived),totalSources:selected.length,registeredSources,registeredDevices,items:selected.slice(0,20),hasMore:selected.length>20};
}
export const metricKeys=['records','good','bad','uncertain','nullValues','invalidValues','unitMappingMismatch','unitDefinitionMismatch','outOfRange','mappingMismatch','receiptMismatch','gapCount','estimatedMissing','futureCount','rejected'] as const;
export type PointMetrics=Record<typeof metricKeys[number],number>&{latest:PointEvidence|null;examples:Record<string,PointEvidence[]>;rejections:RejectionEvidence[]};
export function qualityCount(v:unknown){const s=typeof v==='number'?String(v):v;if(typeof s!=='string'||!/^(0|[1-9][0-9]*)$/.test(s)||!Number.isSafeInteger(Number(s)))throw telemetryQualityIntegrity();return Number(s);}
export function qualityPolicy(raw:unknown):QualityPolicy{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw telemetryQualityIntegrity();const p=raw as QualityPolicy;
 if(Object.keys(p).length!==3||!Number.isFinite(p.gapMultiplier)||p.gapMultiplier<1.1||p.gapMultiplier>20||!Number.isFinite(p.staleMultiplier)||p.staleMultiplier<1||p.staleMultiplier>100||!Number.isSafeInteger(p.futureSkewSeconds)||p.futureSkewSeconds<0||p.futureSkewSeconds>300)throw telemetryQualityIntegrity();return {gapMultiplier:p.gapMultiplier,staleMultiplier:p.staleMultiplier,futureSkewSeconds:p.futureSkewSeconds};
}
const iso=(s:unknown)=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
export function pointEvidence(raw:any,p:{edgeId:string;deviceCode:string;tagCode?:string}):PointEvidence{
 if(!raw||!code(raw.pointId,100)||raw.edgeId!==p.edgeId||raw.deviceCode!==p.deviceCode||!code(raw.tagCode)||p.tagCode!==undefined&&raw.tagCode!==p.tagCode||!iso(raw.eventTime)||!iso(raw.receivedAt)||!/^[a-f0-9]{64}$/.test(raw.inputDigest)||!['SIMULATOR','FIELD'].includes(raw.origin)||!code(raw.mapVersion)||!code(raw.nodeId,512)||!code(raw.unit,64)||!['GOOD','BAD','UNCERTAIN'].includes(raw.quality)||!(raw.value===null||typeof raw.value==='number'&&Number.isFinite(raw.value)||typeof raw.value==='string'&&['NaN','Infinity','-Infinity'].includes(raw.value))||typeof raw.sequenceNo!=='string'||!/^[1-9][0-9]*$/.test(raw.sequenceNo)||BigInt(raw.sequenceNo)>9223372036854775807n)throw telemetryQualityIntegrity();
 return {pointId:raw.pointId,edgeId:raw.edgeId,deviceCode:raw.deviceCode,tagCode:raw.tagCode,eventTime:raw.eventTime,receivedAt:raw.receivedAt,inputDigest:raw.inputDigest,origin:raw.origin,mapVersion:raw.mapVersion,nodeId:raw.nodeId,sequenceNo:raw.sequenceNo,value:raw.value,unit:raw.unit,quality:raw.quality};
}
export function qualityItem(p:QualityPoint,m:PointMetrics,q:QualityQuery,now:number){
 const findings:{code:string;severity:'ERROR'|'WARNING'|'UNKNOWN';message:string;count:number;sources:PointEvidence[]}[]=[],d=p.definition,policy=d?.policy||defaultQualityPolicy;
 const add=(code:string,severity:'ERROR'|'WARNING'|'UNKNOWN',message:string,count:number,sources=m.examples[code]||[])=>{if(count)findings.push({code,severity,message,count,sources});};
 if(!d)add('MISSING_APPROVED_DEFINITION','UNKNOWN','未绑定当前批准的企业测点定义，物理范围与记录间隔不能确认',1);
 if(!m.records)add('NO_RECORDS_IN_WINDOW','WARNING','所选窗口没有已接收采集记录；无数据不能视为正常',1);
 add('NON_GOOD_QUALITY','WARNING','存在BAD/UNCERTAIN采集质量记录',m.bad+m.uncertain);
 add('NULL_SAMPLE_VALUE','WARNING','存在空采样值，不进行数值补齐',m.nullValues);
 add('INVALID_SAMPLE_VALUE','ERROR','存在非有限数值或GOOD记录缺少数值',m.invalidValues);
 add('POINT_MAP_UNIT_MISMATCH','ERROR','采集单位与当前接入点表不一致，不执行自动换算',m.unitMappingMismatch);
 add('UNIT_DEFINITION_MISMATCH','ERROR','采集单位与当前批准定义不一致，异单位数值不比较物理范围',m.unitDefinitionMismatch);
 add('OUT_OF_DECLARED_RANGE','ERROR','同单位采样超出当前批准物理录入范围；这不是报警阈值',m.outOfRange);
 add('SOURCE_BINDING_MISMATCH','ERROR','记录的点位、映射版本或来源类型与当前注册不一致',m.mappingMismatch);
 add('SOURCE_RECEIPT_MISMATCH','ERROR','采集记录与已存储接收回执不一致，需核查来源',m.receiptMismatch);
 add('FUTURE_SAMPLE_TIME','ERROR',`本测点存在超前当前时间${policy.futureSkewSeconds}秒以上的采样`,m.futureCount);
 if(!d?.interval)add('INTERVAL_UNDECLARED','UNKNOWN','未声明批准记录间隔，不推断时效或精确缺失数量',1);
 else add('OBSERVED_INTERVAL_GAPS','WARNING',`相邻采样超过声明间隔${policy.gapMultiplier}倍；遗漏为内部估计，不含窗口边界或停产日历`,m.gapCount);
 const age=m.latest?Math.max(0,(Math.min(q.to,now)-Date.parse(m.latest.eventTime))/1000):null;
 if(d?.interval&&age!==null&&age>d.interval*policy.staleMultiplier)add('STALE_AT_WINDOW_END','WARNING',`截至所选窗口末尾，最新采样年龄超过声明间隔${policy.staleMultiplier}倍`,1,[m.latest!]);
 add('REJECTED_INGESTION','WARNING','本源测点在所选接收时间窗口存在拒收；拒收不计入已接收记录',m.rejected,[]);
 const status=findings.some(f=>f.severity!=='UNKNOWN')?'ISSUE':findings.length?'UNKNOWN':'CLEAN';
 return {edgeId:p.edgeId,deviceCode:p.deviceCode,deviceName:p.deviceName,siteCode:p.siteCode,tagCode:p.tagCode,tagName:d?.name||null,unit:p.unit,declaredRange:d?{min:d.min,max:d.max,unit:d.unit}:null,configuredOrigin:p.origin,provenance:p.origin==='SIMULATOR'?'SIMULATED_TELEMETRY':'LIVE_TELEMETRY',mapVersion:p.mapVersion,nodeId:p.nodeId,status,records:m.records,good:m.good,bad:m.bad,uncertain:m.uncertain,goodRate:m.records?m.good/m.records*100:null,latestMeasurementAt:m.latest?.eventTime||null,latestSource:m.latest,definitionSource:d?.source||null,definitionOrigin:d?'APPROVED_DEFINITION':'EDGE_POINT_MAP_ONLY',expectedIntervalSeconds:d?.interval||null,qualityPolicy:{...policy,origin:d?.policyOrigin||'PLATFORM_DEFAULT',templateKey:d?.templateKey||null,templateVersion:d?.templateVersion||null},ageAtWindowEndSeconds:age,observedGapCount:d?.interval?m.gapCount:null,estimatedMissingWithinGaps:d?.interval?m.estimatedMissing:null,rejectedReceipts:m.rejected,rejectionExamples:m.rejections,findings};
}
export function qualityResponse(items:ReturnType<typeof qualityItem>[],q:QualityQuery,now:number,enabled:boolean,intake:QualityIntake){
 const sum=(pick:(i:typeof items[number])=>number)=>items.reduce((n,i)=>qualityCount(n+pick(i)),0);const selected=items.filter(i=>q.status==='ALL'||i.status===q.status);
 return {source:'TELEMETRY',enabled,items:selected.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:selected.length,page:q.page,pageSize:q.pageSize,summary:{sources:intake.registeredSources,devices:intake.registeredDevices,points:items.length,issuePoints:items.filter(i=>i.status==='ISSUE').length,unknownPoints:items.filter(i=>i.status==='UNKNOWN').length,cleanPoints:items.filter(i=>i.status==='CLEAN').length,receivedRecordsInWindow:qualityCount(sum(i=>i.records)+intake.unmappedReceived),registeredPointRecordsInWindow:sum(i=>i.records),unmappedReceivedRecordsInWindow:intake.unmappedReceived,nonGoodRecordsInWindow:sum(i=>i.bad+i.uncertain),rejectedReceiptsInWindow:intake.total,unmappedRejectedReceiptsInWindow:intake.unmapped},rejections:intake,window:{from:new Date(q.from).toISOString(),to:new Date(q.to).toISOString(),rejectionsUse:'RECEIVED_AT'},evaluatedAt:new Date(now).toISOString(),ruleVersion:telemetryQualityVersion,fieldCommissioned:false,readOnly:true,verificationScope:'SERVER_FULL_BUSINESS_CANONICAL_AND_TELEMETRY_READ_SNAPSHOT',telemetryIntegrity:'INGEST_AUTHENTICATION_AND_PERSISTED_SOURCE_BINDING',notice:'采集质量按已接收记录、当前注册点表及批准定义评估；模拟数据保留标记。缺口不含停产日历，历史窗口不代表当前在线；质量结论不表示设备健康、预测精度或质量放行。来源按已存接收凭证追溯；拒收按接收时间单列，包含未注册或缺少标签的报文。未在当前点表中的历史采集记录单列数量与凭证，不套用当前测点规则。'};
}
