import {effectiveRecords} from './import-revisions.ts';
import {DomainError} from './service.ts';
import {requireAccess,scopeAllows,type AccessContext} from './access.ts';
import {approvedPoint} from './point-definitions.ts';
import type {ImportView,StoredRow} from './imports.ts';

function query(params:URLSearchParams,allowed:string[]){
  if([...params.keys()].some(k=>!allowed.includes(k))||new Set([...params.keys()]).size!==[...params.keys()].length)throw new DomainError(400,'查询含未知或重复参数');
  for(const value of params.values())if(value.length>128)throw new DomainError(400,'查询条件过长');
}
function integer(value:string|null,fallback:number,max:number){if(value===null)return fallback;const parsed=Number(value);if(!/^\d+$/.test(value)||!Number.isSafeInteger(parsed)||parsed<1||parsed>max)throw new DomainError(400,'分页参数无效');return parsed;}
const tenantRows=(data:ImportView,ctx:AccessContext)=>{requireAccess(ctx,'read');return effectiveRecords(data).filter(r=>r.tenantId===ctx.tenantId);};
export const overviewNotice='仅展示已批准上传数据。GOOD是数据质量，不是设备健康；无数据不表示正常。当前按企业及受信任的数据范围过滤。';
export const measurementNotice='录入范围不是告警阈值；来源指向原批准批次和行号。手动上传不代表实时在线，不推断设备健康。';
export function overviewQuery(params:URLSearchParams){
  query(params,['q','equipmentType','siteCode','page','pageSize']);
  return {search:(params.get('q')||'').trim().toLowerCase(),type:params.get('equipmentType'),site:params.get('siteCode'),page:integer(params.get('page'),1,1000000),pageSize:integer(params.get('pageSize'),50,100)};
}
export function measurementQuery(params:URLSearchParams){
  query(params,['deviceCode','tagCode','quality','from','to','page','pageSize']);
  const quality=params.get('quality');if(quality&&!['GOOD','BAD','UNCERTAIN'].includes(quality))throw new DomainError(400,'数据质量筛选无效');
  const boundary=(name:string)=>{
    const value=params.get(name);if(!value)return null;const ms=Date.parse(value);
    if(!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)||!Number.isFinite(ms)||new Date(value.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==value.slice(0,10))throw new DomainError(400,'时间筛选须包含有效日期和时区');
    return ms;
  };
  const from=boundary('from'),to=boundary('to');if(from!==null&&to!==null&&from>to)throw new DomainError(400,'查询开始时间晚于结束时间');
  return {device:params.get('deviceCode'),tag:params.get('tagCode'),quality,from,to,page:integer(params.get('page'),1,1000000),pageSize:integer(params.get('pageSize'),50,100)};
}
function source(data:ImportView,row:StoredRow){
  const batch=data.batches.find(b=>b.batchId===row.batchId&&b.tenantId===row.tenantId);
  return {batchId:row.batchId,sourceSystem:row.sourceSystem,sourceRow:row.row,sourceRecordId:row.value.source_record_id,snapshotDigest:batch?.snapshotDigest||null,recordVersion:batch?.correction?.baseRows.find(b=>b.sourceRecordId===String(row.value.source_record_id))?.revision||1,supersedesBatchId:batch?.correction?.supersedesBatchId||null};
}
export const maxExportRows=10000;
export function exportWindow(q:{page:number;pageSize:number},total:number,exportAll:boolean){
  if(!exportAll)return;
  if(total>maxExportRows)throw new DomainError(422,`导出结果超过${maxExportRows}行，请缩小筛选范围`);
  q.page=1;q.pageSize=maxExportRows;
}
export function dataOverview(data:ImportView,ctx:AccessContext,params=new URLSearchParams(),exportAll=false){
  const q=overviewQuery(params),{search,type,site}=q;
  const records=tenantRows(data,ctx),assets=records.filter(r=>r.dataType==='DEVICE'),points=records.filter(r=>r.dataType==='POINT_DEFINITION'),measurements=records.filter(r=>r.dataType==='MEASUREMENT');
  const visibleAssets=assets.filter(({value:r})=>scopeAllows(ctx,r));
  const visibleCodes=new Set(visibleAssets.map(r=>String(r.value.device_code)));
  const visiblePoints=points.filter(r=>visibleCodes.has(String(r.value.device_code))),visibleMeasurements=measurements.filter(r=>visibleCodes.has(String(r.value.device_code)));
  const filtered=visibleAssets.filter(({value:r})=>(!type||(r.equipment_type||'未分类')===type)&&(!site||r.site_code===site)&&(!search||[r.device_code,r.device_name,r.equipment_type,r.brand,r.model].some(v=>String(v||'').toLowerCase().includes(search))));
  exportWindow(q,filtered.length,exportAll);const {page,pageSize}=q;
  const items=filtered.slice((page-1)*pageSize,page*pageSize).map(r=>({asset:r.value,source:source(data,r),definedPoints:visiblePoints.filter(p=>p.value.device_code===r.value.device_code).length,measurements:visibleMeasurements.filter(p=>p.value.device_code===r.value.device_code).length}));
  return {items,total:filtered.length,page,pageSize,summary:{devices:visibleAssets.length,definedPoints:visiblePoints.length,measurements:visibleMeasurements.length,nonGoodMeasurements:visibleMeasurements.filter(r=>r.value.quality!=='GOOD').length},equipmentTypes:[...new Set(visibleAssets.map(r=>String(r.value.equipment_type||'未分类')))].sort(),sites:[...new Set(visibleAssets.map(r=>String(r.value.site_code)))].sort(),notice:overviewNotice.replace('当前按企业隔离，工厂/设备细粒度权限仍待实现。','当前按企业及受信任的数据范围过滤。')};
}
export function dataMeasurements(data:ImportView,ctx:AccessContext,params=new URLSearchParams(),exportAll=false){
  const q=measurementQuery(params),{device,tag,quality,from,to}=q,records=tenantRows(data,ctx),assetByCode=new Map(records.filter(r=>r.dataType==='DEVICE').map(r=>[String(r.value.device_code),r.value]));
  const selected=records.filter(r=>r.dataType==='MEASUREMENT'&&scopeAllows(ctx,assetByCode.get(String(r.value.device_code))||{device_code:r.value.device_code})&&(!device||r.value.device_code===device)&&(!tag||r.value.tag_code===tag)&&(!quality||r.value.quality===quality)&&(from===null||Date.parse(String(r.value.measured_at))>=from)&&(to===null||Date.parse(String(r.value.measured_at))<=to)).sort((a,b)=>Date.parse(String(b.value.measured_at))-Date.parse(String(a.value.measured_at))||a.batchId.localeCompare(b.batchId)||a.row-b.row);
  exportWindow(q,selected.length,exportAll);const {page,pageSize}=q;
  const items=selected.slice((page-1)*pageSize,page*pageSize).map(r=>{const definition=approvedPoint(data,ctx.tenantId,String(r.value.device_code),String(r.value.tag_code),records);return {measurement:r.value,source:source(data,r),definition:definition||null};});
  const definitions=records.filter(r=>r.dataType==='POINT_DEFINITION'&&scopeAllows(ctx,assetByCode.get(String(r.value.device_code))||{device_code:r.value.device_code})&&(!device||r.value.device_code===device)&&(!tag||r.value.tag_code===tag)).slice(0,100).map(r=>({point:r.value,source:source(data,r)}));
  return {items,total:selected.length,page,pageSize,dataAsOf:selected[0]?.value.measured_at||null,definitions,notice:measurementNotice};
}
