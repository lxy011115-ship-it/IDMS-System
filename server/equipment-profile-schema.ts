import {object,keys,text} from './schema-primitives.ts';
import {fieldsSchema} from './custom-fields.ts';
import {DomainError} from './service.ts';
import {measurementSchema} from './measurement-schema.ts';
import type {MaintenanceField} from './domain.ts';

export interface QualityPolicy {gapMultiplier:number;staleMultiplier:number;futureSkewSeconds:number}
export const defaultQualityPolicy:QualityPolicy={gapMultiplier:1.5,staleMultiplier:3,futureSkewSeconds:300};
export interface ProfilePoint {tag_code:string;tag_name:string;unit:string;min_value:number;max_value:number;expected_interval_seconds?:number}
export interface EquipmentProfile {typeCode:string;typeName:string;assetFields:MaintenanceField[];points:ProfilePoint[];qualityRules:Partial<QualityPolicy>;removePoints:string[];removeAssetFields:string[]}
export interface ResolvedEquipmentProfile {typeCode:string;typeName:string;assetFields:MaintenanceField[];points:ProfilePoint[];qualityRules:QualityPolicy}
const tag=(value:unknown)=>{const code=text(value,'测点编码',64);if(!/^[a-z][a-z0-9_]*$/.test(code)||['constructor','prototype','__proto__'].includes(code))throw new DomainError(400,'测点编码无效或保留');return code;};
export function qualityPolicy(raw:unknown):Partial<QualityPolicy>{
 const input=raw===undefined?{}:object(raw,'质量规则');keys(input,['gapMultiplier','staleMultiplier','futureSkewSeconds']);const result:Partial<QualityPolicy>={};
 for(const [key,min,max] of [['gapMultiplier',1.1,20],['staleMultiplier',1,100],['futureSkewSeconds',0,300]] as const)if(input[key]!==undefined){const v=input[key];if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(key==='futureSkewSeconds'&&!Number.isInteger(v)))throw new DomainError(400,'质量参数'+key+'数值或范围无效');result[key]=v;}
 return result;
}
export function equipmentProfileSchema(raw:unknown):EquipmentProfile{
 const p=object(raw,'设备类型配置');keys(p,['typeCode','typeName','assetFields','points','qualityRules','removePoints','removeAssetFields']);
 const typeCode=text(p.typeCode,'设备类型编码',64),typeName=text(p.typeName,'设备类型名称',80);if(!/^[a-z][a-z0-9_]*$/.test(typeCode)||['constructor','prototype','__proto__'].includes(typeCode))throw new DomainError(400,'设备类型编码无效');
 const assetFields=fieldsSchema(p.assetFields===undefined?[]:p.assetFields);
 if(!Array.isArray(p.points)||p.points.length>64)throw new DomainError(400,'设备类型测点最多64项');const seen=new Set<string>();
 const points=p.points.map(raw=>{const v=object(raw,'类型测点');keys(v,['tag_code','tag_name','unit','min_value','max_value','expected_interval_seconds']);const code=tag(v.tag_code),name=text(v.tag_name,'测点名称',80),unit=text(v.unit,'测点单位',32);if(seen.has(code)||/[\u0000-\u001f]/.test(unit))throw new DomainError(400,'测点重复或单位无效');seen.add(code);
  if(typeof v.min_value!=='number'||typeof v.max_value!=='number'||!Number.isFinite(v.min_value)||!Number.isFinite(v.max_value)||v.min_value>=v.max_value)throw new DomainError(400,'测点物理范围必须为递增有限数值');
  const point:ProfilePoint={tag_code:code,tag_name:name,unit,min_value:v.min_value,max_value:v.max_value};
  if(v.expected_interval_seconds!==undefined){const seconds=v.expected_interval_seconds;if(typeof seconds!=='number'||!Number.isInteger(seconds)||seconds<1||seconds>31536000)throw new DomainError(400,'测点间隔须为1至31536000整数秒');point.expected_interval_seconds=seconds;}
  if(Object.hasOwn(measurementSchema,code)){const legacy=measurementSchema[code as keyof typeof measurementSchema];if(unit!==legacy.unit||v.min_value!==legacy.min||v.max_value!==legacy.max)throw new DomainError(400,'旧工程编码的单位和物理范围不可重定义，请使用独立测点编码');}
  return point;
 });
 const removals=(value:unknown,label:string,field=false)=>{if(value===undefined)return [];if(!Array.isArray(value)||value.length>(field?12:64))throw new DomainError(400,label+'列表无效');const result=value.map(v=>field?text(v,label,40):tag(v));if(result.some(v=>!/^[a-z][a-z0-9_]*$/.test(v)||['constructor','prototype','__proto__'].includes(v))||new Set(result).size!==result.length)throw new DomainError(400,label+'重复或保留');return result;};
 const removePoints=removals(p.removePoints,'移除测点'),removeAssetFields=removals(p.removeAssetFields,'移除字段',true);
 if(points.some(p=>removePoints.includes(p.tag_code))||assetFields.some(f=>removeAssetFields.includes(f.key)))throw new DomainError(400,'同一项不能同时声明和移除');
 return {typeCode,typeName,assetFields,points,qualityRules:qualityPolicy(p.qualityRules),removePoints,removeAssetFields};
}
export function mergeEquipmentProfile(parent:ResolvedEquipmentProfile|undefined,child:EquipmentProfile):ResolvedEquipmentProfile{
 const fields=new Map((parent?.assetFields||[]).map(f=>[f.key,f])),points=new Map((parent?.points||[]).map(p=>[p.tag_code,p]));
 for(const key of child.removeAssetFields)if(!fields.delete(key))throw new DomainError(409,'要移除的父字段不存在');for(const key of child.removePoints)if(!points.delete(key))throw new DomainError(409,'要移除的父测点不存在');
 for(const field of child.assetFields)fields.set(field.key,field);for(const point of child.points)points.set(point.tag_code,point);
 if(fields.size>12||points.size>64||!points.size)throw new DomainError(400,'解析后的类型需1至64项测点，扩展字段最多12项');
 return {typeCode:child.typeCode,typeName:child.typeName,assetFields:fieldsSchema([...fields.values()]),points:[...points.values()],qualityRules:{...defaultQualityPolicy,...parent?.qualityRules,...child.qualityRules}};
}
