import {effectiveRecords} from './import-revisions.ts';
import type {ImportView,Row,StoredRow} from './imports.ts';
import {measurementSchema} from './measurement-schema.ts';

export const deviceOptionalFields=['equipment_type','brand','model','serial_number','criticality','profile_values','source_profile_ref'] as const;
export const pointOptionalFields=['expected_interval_seconds','source_profile_ref'] as const;
export function approvedPoint(data:ImportView,tenantId:string,deviceCode:string,tagCode:string,records?:StoredRow[]){
  const stored=(records||effectiveRecords(data)).find(r=>r.tenantId===tenantId&&r.dataType==='POINT_DEFINITION'&&r.value.device_code===deviceCode&&r.value.tag_code===tagCode);
  if(stored)return {label:String(stored.value.tag_name),unit:String(stored.value.unit),min:Number(stored.value.min_value),max:Number(stored.value.max_value),definitionBatchId:stored.batchId,expectedIntervalSeconds:stored.value.expected_interval_seconds?Number(stored.value.expected_interval_seconds):null,origin:'APPROVED_DEFINITION' as const};
  const legacy=Object.hasOwn(measurementSchema,tagCode)?measurementSchema[tagCode as keyof typeof measurementSchema]:undefined;
  return legacy?{label:legacy.label,unit:legacy.unit,min:legacy.min,max:legacy.max,definitionBatchId:null,expectedIntervalSeconds:null,origin:'LEGACY_ENGINEERING_SAMPLE' as const}:undefined;
}
export function legacyPointCompatible(row:Row){
  if(!Object.hasOwn(measurementSchema,String(row.tag_code)))return true;
  const legacy=measurementSchema[String(row.tag_code) as keyof typeof measurementSchema];
  return row.unit===legacy.unit&&Number(row.min_value)===legacy.min&&Number(row.max_value)===legacy.max;
}
