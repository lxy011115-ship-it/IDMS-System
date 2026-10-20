import {fieldPolicySchema} from './field-policy-schema.ts';
import {operationalPolicySchema} from './operational-policy-schema.ts';
import {sourcePolicySchema} from './source-policy-schema.ts';
import {equipmentProfileSchema} from './equipment-profile-schema.ts';
import {operationCalendarSchema} from './calendar-schema.ts';
import {calendarScheduleSchema} from './calendar-schedule-schema.ts';
import {dataQualityPolicySchema} from './quality-policy-schema.ts';
import {object,keys,text} from './schema-primitives.ts';
import {fieldsSchema} from './custom-fields.ts';
export {object,keys,text} from './schema-primitives.ts';
export {fieldsSchema,bindingDigest,validateCustomFields} from './custom-fields.ts';
import {DomainError} from './service.ts';
import {mappingSchema} from './import-mapping.ts';
export const platformVersion='0.1.0';
export function semver(value:unknown){const version=text(value,'版本',30);if(!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version))throw new DomainError(400,'版本必须为不带前导零的semver');return version;}
export function compareVersions(a:string,b:string){const x=semver(a).split('.').map(Number),y=semver(b).split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;}
export function validateManifest(raw:unknown,options:{materializeCalendar?:boolean;account?:(value:unknown)=>void}={}){
  const m=object(raw,'模板manifest');keys(m,['schemaVersion','minPlatformVersion','modules','policy','maintenance','purpose','importMapping','equipmentProfile','operationCalendar','calendarSchedule','dataQualityPolicy','operationalMetricPolicy','telemetrySourcePolicy','fieldChannelPolicy']);
  if(m.schemaVersion!==1)throw new DomainError(400,'模板schemaVersion必须为1');
  if(compareVersions(semver(m.minPlatformVersion),platformVersion)>0)throw new DomainError(409,'模板最低平台版本不兼容');
  const mapped=m.purpose==='import-mapping',profile=m.purpose==='equipment-profile';
  const calendar=m.purpose==='operation-calendar',schedule=m.purpose==='calendar-schedule',quality=m.purpose==='data-quality-policy',operational=m.purpose==='operational-metric-policy',source=m.purpose==='telemetry-source-policy',field=m.purpose==='field-channel-policy';
  if(m.purpose!==undefined&&!['maintenance-form','import-mapping','equipment-profile','operation-calendar','calendar-schedule','data-quality-policy','operational-metric-policy','telemetry-source-policy','field-channel-policy'].includes(String(m.purpose)))throw new DomainError(400,'模板用途无效');
  if(!Array.isArray(m.modules)||!m.modules.includes(quality?'quality':profile||calendar||schedule||operational||source||field?'equipment':mapped?'data-import':'maintenance')||m.modules.length>10||m.modules.some(v=>!['equipment','alarm','maintenance','quality','ai',...(mapped||profile?['data-import']:[])].includes(String(v)))||new Set(m.modules).size!==m.modules.length)throw new DomainError(400,'模块依赖无效');
  const policy=object(m.policy,'安全策略');keys(policy,['finalApproval','deviceAccess']);if(policy.finalApproval!=='INDEPENDENT_HUMAN'||policy.deviceAccess!=='READ_ONLY')throw new DomainError(400,'模板不能关闭独立人工终审或只读设备边界');
  const base={schemaVersion:1,minPlatformVersion:m.minPlatformVersion,modules:[...m.modules],policy:{finalApproval:'INDEPENDENT_HUMAN',deviceAccess:'READ_ONLY'}};
  if(field){if(['maintenance','importMapping','equipmentProfile','operationCalendar','calendarSchedule','dataQualityPolicy','operationalMetricPolicy','telemetrySourcePolicy'].some(k=>m[k]!==undefined))throw new DomainError(400,'现场通道不能混入其他用途');return {...base,purpose:'field-channel-policy' as const,fieldChannelPolicy:fieldPolicySchema(m.fieldChannelPolicy)};}
  if(m.fieldChannelPolicy!==undefined)throw new DomainError(400,'其他用途不能混入现场通道策略');
  if(source){if(['maintenance','importMapping','equipmentProfile','operationCalendar','calendarSchedule','dataQualityPolicy','operationalMetricPolicy'].some(k=>m[k]!==undefined))throw new DomainError(400,'来源策略不能混入其他用途');return {...base,purpose:'telemetry-source-policy' as const,telemetrySourcePolicy:sourcePolicySchema(m.telemetrySourcePolicy)};}
  if(m.telemetrySourcePolicy!==undefined)throw new DomainError(400,'其他用途不能混入来源策略');
  if(operational){if(['maintenance','importMapping','equipmentProfile','operationCalendar','calendarSchedule','dataQualityPolicy'].some(k=>m[k]!==undefined))throw new DomainError(400,'指标定义不能混入其他用途');return {...base,purpose:'operational-metric-policy' as const,operationalMetricPolicy:operationalPolicySchema(m.operationalMetricPolicy)};}
  if(m.operationalMetricPolicy!==undefined)throw new DomainError(400,'其他用途不能混入指标定义');
  if(quality){if(['maintenance','importMapping','equipmentProfile','operationCalendar','calendarSchedule'].some(k=>m[k]!==undefined))throw new DomainError(400,'质量策略不能混入其他用途');return {...base,purpose:'data-quality-policy' as const,dataQualityPolicy:dataQualityPolicySchema(m.dataQualityPolicy)};}
  if(m.dataQualityPolicy!==undefined)throw new DomainError(400,'其他用途不能混入质量策略');
  if(schedule){if(m.maintenance!==undefined||m.importMapping!==undefined||m.equipmentProfile!==undefined||m.operationCalendar!==undefined)throw new DomainError(400,'生效安排不能混入其他用途');return {...base,purpose:'calendar-schedule' as const,calendarSchedule:calendarScheduleSchema(m.calendarSchedule)};}
  if(m.calendarSchedule!==undefined)throw new DomainError(400,'其他用途不能混入生效安排');
  if(calendar){if(m.maintenance!==undefined||m.importMapping!==undefined||m.equipmentProfile!==undefined)throw new DomainError(400,'运行日历不能混入其他用途配置');return {...base,purpose:'operation-calendar' as const,operationCalendar:operationCalendarSchema(m.operationCalendar,options.materializeCalendar,options.account)};}
  if(m.operationCalendar!==undefined)throw new DomainError(400,'其他用途不能混入运行日历');
  if(profile){if(m.maintenance!==undefined||m.importMapping!==undefined)throw new DomainError(400,'设备类型不能混入其他用途配置');return {...base,purpose:'equipment-profile' as const,equipmentProfile:equipmentProfileSchema(m.equipmentProfile)};}
  if(m.equipmentProfile!==undefined)throw new DomainError(400,'其他用途不能混入设备类型配置');
  if(mapped){if(m.maintenance!==undefined)throw new DomainError(400,'上传映射不能混入维修字段');return {...base,purpose:'import-mapping' as const,importMapping:mappingSchema(m.importMapping)};}
  if(m.importMapping!==undefined)throw new DomainError(400,'维修模板不能混入上传映射');
  const maintenance=object(m.maintenance,'维修配置');keys(maintenance,['fields']);const fields=fieldsSchema(maintenance.fields);
  return {...base,...(m.purpose===undefined?{}:{purpose:'maintenance-form' as const}),maintenance:{fields}};
}

