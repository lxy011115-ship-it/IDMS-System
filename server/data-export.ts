import {DomainError} from './service.ts';
import type {dataOverview,dataMeasurements} from './data-management.ts';

export function exportFilters(params:URLSearchParams){
  if(params.has('page')||params.has('pageSize'))throw new DomainError(400,'导出使用完整筛选结果，不接受分页参数');
  return params;
}
// CSV quoting alone does not prevent a spreadsheet from executing a formula.
const formulaText=(value:unknown,text:string)=>typeof value!=='number'&&/^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/u.test(text);
function cell(value:unknown){
  let text=String(value??'');
  if(formulaText(value,text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
export function csv(headers:string[],rows:unknown[][]){return '\uFEFF'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';}
export function* csvParts(row:unknown[]):Generator<string>{
 for(let i=0;i<row.length;i++){
  if(i)yield ',';const value=row[i],text=String(value??'');yield '"';if(formulaText(value,text))yield "'";
  for(let start=0;start<text.length;){let end=Math.min(start+8192,text.length);if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;yield text.slice(start,end).replaceAll('"','""');start=end;}
  yield '"';
 }yield '\r\n';
}
export const assetCsvHeaders=['device_code','device_name','site_code','line_code','equipment_type','brand','model','serial_number','criticality','defined_points','measurements','source_system','source_record_id','batch_id','source_row','snapshot_digest','record_version','supersedes_batch_id'];
export const measurementCsvHeaders=['device_code','tag_code','tag_name','measured_at','value','unit','quality','definition_origin','definition_batch_id','source_system','source_record_id','batch_id','source_row','snapshot_digest','record_version','supersedes_batch_id'];
export const assetCsvCells=({asset:a,source:s,definedPoints,measurements}:ReturnType<typeof dataOverview>['items'][number])=>[a.device_code,a.device_name,a.site_code,a.line_code,a.equipment_type,a.brand,a.model,a.serial_number,a.criticality,definedPoints,measurements,s.sourceSystem,s.sourceRecordId,s.batchId,s.sourceRow,s.snapshotDigest,s.recordVersion,s.supersedesBatchId];
export const measurementCsvCells=({measurement:r,source:s,definition:d}:ReturnType<typeof dataMeasurements>['items'][number])=>[r.device_code,r.tag_code,d?.label,r.measured_at,r.value,r.unit,r.quality,d?.origin,d?.definitionBatchId,s.sourceSystem,s.sourceRecordId,s.batchId,s.sourceRow,s.snapshotDigest,s.recordVersion,s.supersedesBatchId];
export function assetCsv(result:ReturnType<typeof dataOverview>){
  return csv(assetCsvHeaders,result.items.map(assetCsvCells));
}
export function measurementCsv(result:ReturnType<typeof dataMeasurements>){
  return csv(measurementCsvHeaders,result.items.map(measurementCsvCells));
}
