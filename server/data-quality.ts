import {defaultQualityPolicy} from './equipment-profile-schema.ts';
import {requireAccess,type AccessContext} from './access.ts';
import {dataScope} from './data-scope.ts';
import {measurementQuery} from './data-management.ts';
import {approvedPoint} from './point-definitions.ts';
import type {ImportView,StoredRow} from './imports.ts';
import {DomainError} from './service.ts';

export const qualityRuleVersion='upload-data-quality-1.0.0';
export function qualityQuery(params:URLSearchParams,now:number){
 const allowed=['deviceCode','tagCode','status','from','to','page','pageSize'];
 if([...params.keys()].some(k=>!allowed.includes(k))||new Set(params.keys()).size!==[...params.keys()].length)throw new DomainError(400,'质量查询含未知或重复参数');
 const status=params.get('status')||'ALL';if(!['ALL','ISSUE','UNKNOWN','CLEAN'].includes(status))throw new DomainError(400,'质量状态筛选无效');
 const base=new URLSearchParams(params);base.delete('status');const q=measurementQuery(base),to=q.to??now,from=q.from??to-86400000;
 if(from>to||to-from>31*86400000||to>now+300000)throw new DomainError(400,'查询须为不超过31天的有效窗口，截止时间不能超前5分钟');
 return {...q,from,to,status};
}
interface Source {batchId:string;sourceSystem:string;sourceRow:number;sourceRecordId:string|number;snapshotDigest:string|null;recordVersion:number;batchReadable:boolean}
interface Finding {code:string;severity:'ERROR'|'WARNING'|'UNKNOWN';message:string;count:number;sources:Source[]}
export function dataQuality(data:ImportView,ctx:AccessContext,params=new URLSearchParams(),now=Date.now()){
 requireAccess(ctx,'read');const q=qualityQuery(params,now),view=dataScope(data,ctx),records=view.records.filter(view.row),batches=new Map(data.batches.filter(b=>b.tenantId===ctx.tenantId).map(b=>[b.batchId,b]));
 const source=(r:StoredRow):Source=>{const b=batches.get(r.batchId);return {batchReadable:!!b&&view.batch(b),batchId:r.batchId,sourceSystem:r.sourceSystem,sourceRow:r.row,sourceRecordId:r.value.source_record_id,snapshotDigest:b?.snapshotDigest||null,recordVersion:b?.correction?.baseRows.find(v=>v.sourceRecordId===String(r.value.source_record_id))?.revision||1};};
 const assets=records.filter(r=>r.dataType==='DEVICE'&&(!q.device||r.value.device_code===q.device)),definitions=records.filter(r=>r.dataType==='POINT_DEFINITION'),measurements=records.filter(r=>r.dataType==='MEASUREMENT');
 const definitionsByDevice=new Map<string,StoredRow[]>(),readingsByPoint=new Map<string,StoredRow[]>(),tagsByDevice=new Map<string,Set<string>>();
 for(const r of definitions){const key=String(r.value.device_code);const group=definitionsByDevice.get(key)||[];group.push(r);definitionsByDevice.set(key,group);}
 for(const r of measurements){const key=JSON.stringify([r.value.device_code,r.value.tag_code]);const group=readingsByPoint.get(key)||[];group.push(r);readingsByPoint.set(key,group);const device=String(r.value.device_code),tags=tagsByDevice.get(device)||new Set<string>();tags.add(String(r.value.tag_code));tagsByDevice.set(device,tags);}
 const items=[];
 for(const asset of assets){
  const code=String(asset.value.device_code),declared=definitionsByDevice.get(code)||[],tags=new Set([...declared.map(r=>String(r.value.tag_code)),...(tagsByDevice.get(code)||[])]);
  if(!tags.size&&!q.tag)tags.add('');
  for(const tag of tags){
   if(q.tag&&q.tag!==tag)continue;
   const definition=tag?approvedPoint(data,ctx.tenantId,code,tag,records):undefined,definitionRow=declared.find(r=>r.value.tag_code===tag),all=readingsByPoint.get(JSON.stringify([code,tag]))||[];
   const valid=all.filter(r=>Number.isFinite(Date.parse(String(r.value.measured_at)))),window=valid.filter(r=>Date.parse(String(r.value.measured_at))>=q.from&&Date.parse(String(r.value.measured_at))<=q.to).sort((a,b)=>Date.parse(String(a.value.measured_at))-Date.parse(String(b.value.measured_at))||a.batchId.localeCompare(b.batchId)||a.row-b.row);
   const equipmentBinding=definitionRow?batches.get(definitionRow.batchId)?.equipmentProfileBinding:undefined,qualityPolicy=equipmentBinding?.resolution.profile.qualityRules||defaultQualityPolicy;
   const findings:Finding[]=[];
   const add=(code:string,severity:Finding['severity'],message:string,rows:StoredRow[]=[],count=rows.length)=>findings.push({code,severity,message,count,sources:rows.slice(0,5).map(source)});
   if(!definitionRow)add('MISSING_APPROVED_DEFINITION','UNKNOWN',definition?'仅有旧工程样板定义，企业测点定义尚未批准':'缺少已批准企业测点定义，无法确认单位、物理范围或记录间隔',[],1);
   if(!window.length)add('NO_RECORDS_IN_WINDOW','WARNING','所选时间窗口没有已批准测点记录；这不代表设备正常',[],1);
   const bad=window.filter(r=>r.value.quality!=='GOOD');if(bad.length)add('NON_GOOD_QUALITY','WARNING','存在BAD/UNCERTAIN数据质量记录',bad);
   const invalid=all.filter(r=>!Number.isFinite(Date.parse(String(r.value.measured_at))));if(invalid.length)add('INVALID_SAMPLE_TIME','ERROR','记录包含无效采样时间',invalid);
   const future=all.filter(r=>Date.parse(String(r.value.measured_at))>now+qualityPolicy.futureSkewSeconds*1000);if(future.length)add('FUTURE_SAMPLE_TIME','ERROR',`采样时间超前当前时间${qualityPolicy.futureSkewSeconds}秒以上`,future);
   if(definition){
    if(!definition.unit||!Number.isFinite(definition.min)||!Number.isFinite(definition.max)||definition.min>=definition.max)add('INVALID_DEFINITION','ERROR','当前定义的单位或物理范围无效，不能据此给出可用结论',definitionRow?[definitionRow]:[],1);
    const units=window.filter(r=>r.value.unit!==definition.unit);if(units.length)add('UNIT_MISMATCH','ERROR','记录单位与当前有效定义不一致，不执行自动换算',units);
    const ranges=window.filter(r=>!Number.isFinite(Number(r.value.value))||Number(r.value.value)<definition.min||Number(r.value.value)>definition.max);if(ranges.length)add('OUT_OF_DECLARED_RANGE','ERROR','数值超出当前定义的物理录入范围；这不是设备健康或报警阈值',ranges);
   }
   const seen=new Set<number>(),duplicates=window.filter(r=>{const time=Date.parse(String(r.value.measured_at)),duplicate=seen.has(time);seen.add(time);return duplicate;});if(duplicates.length)add('DUPLICATE_SAMPLE_TIME','ERROR','同设备同测点出现重复采样时间',duplicates);
   const latest=valid.filter(r=>Date.parse(String(r.value.measured_at))<=q.to).sort((a,b)=>Date.parse(String(b.value.measured_at))-Date.parse(String(a.value.measured_at)))[0],interval=definition?.expectedIntervalSeconds||null,age=latest?Math.max(0,(Math.min(q.to,now)-Date.parse(String(latest.value.measured_at)))/1000):null;
   let gapCount:number|null=null,estimatedMissing:number|null=null;
   if(!interval)add('INTERVAL_UNDECLARED','UNKNOWN','未声明记录间隔，不推断精确缺失数量或数据新鲜度',[],1);
   else{
    const gaps:StoredRow[]=[],times=[...new Map(window.map(r=>[Date.parse(String(r.value.measured_at)),r])).values()];gapCount=0;estimatedMissing=0;
    for(let i=1;i<times.length;i++){const delta=(Date.parse(String(times[i].value.measured_at))-Date.parse(String(times[i-1].value.measured_at)))/1000;if(delta>interval*qualityPolicy.gapMultiplier){gapCount++;estimatedMissing+=Math.max(1,Math.round(delta/interval)-1);if(gaps.length<5)gaps.push(times[i]);}}
    if(gapCount)add('OBSERVED_INTERVAL_GAPS','WARNING',`相邻记录间隔超过声明间隔${qualityPolicy.gapMultiplier}倍；缺失数量仅为内部缺口估计，不含窗口边界或停产日历`,gaps,gapCount);
    if(age!==null&&age>interval*qualityPolicy.staleMultiplier)add('STALE_AT_WINDOW_END','WARNING',`截至所选窗口末尾，最新记录年龄超过声明间隔${qualityPolicy.staleMultiplier}倍`,[latest!],1);
   }
   const grade=findings.some(f=>f.severity!=='UNKNOWN')?'ISSUE':findings.length?'UNKNOWN':'CLEAN',good=window.filter(r=>r.value.quality==='GOOD').length;
   items.push({deviceCode:code,deviceName:String(asset.value.device_name),siteCode:String(asset.value.site_code),tagCode:tag||null,tagName:definition?.label||null,unit:definition?.unit||null,status:grade,records:window.length,good,bad:window.filter(r=>r.value.quality==='BAD').length,uncertain:window.filter(r=>r.value.quality==='UNCERTAIN').length,goodRate:window.length?good/window.length*100:null,latestMeasurementAt:latest?.value.measured_at||null,latestSource:latest?source(latest):null,definitionSource:definitionRow?source(definitionRow):null,definitionOrigin:definition?.origin||null,expectedIntervalSeconds:interval,qualityPolicy:{...qualityPolicy,origin:equipmentBinding?'FROZEN_EQUIPMENT_PROFILE':'PLATFORM_DEFAULT',templateVersion:equipmentBinding?.version||null,templateKey:equipmentBinding?.templateKey||null},ageAtWindowEndSeconds:age,observedGapCount:gapCount,estimatedMissingWithinGaps:estimatedMissing,findings});
  }
 }
 items.sort((a,b)=>a.deviceCode.localeCompare(b.deviceCode)||(a.tagCode||'').localeCompare(b.tagCode||''));
 const filtered=items.filter(i=>q.status==='ALL'||i.status===q.status),failed=data.batches.filter(b=>view.batch(b)&&['VALIDATION_FAILED','RETURNED','REJECTED'].includes(b.status)&&(!q.device||b.rows.some(r=>r.device_code===q.device))&&(!q.tag||b.rows.some(r=>r.tag_code===q.tag))).slice().reverse();
 return {items:filtered.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:filtered.length,page:q.page,pageSize:q.pageSize,summary:{devices:assets.length,points:items.length,issuePoints:items.filter(i=>i.status==='ISSUE').length,unknownPoints:items.filter(i=>i.status==='UNKNOWN').length,cleanPoints:items.filter(i=>i.status==='CLEAN').length,approvedRecordsInWindow:items.reduce((n,i)=>n+i.records,0),nonGoodRecordsInWindow:items.reduce((n,i)=>n+i.bad+i.uncertain,0)},intake:{total:failed.length,items:failed.slice(0,20).map(b=>({batchId:b.batchId,dataType:b.dataType,filename:b.filename,status:b.status,sourceSystem:b.sourceSystem,createdAt:b.createdAt,invalid:b.counts.invalid,errors:b.errors.slice(0,5)}))},window:{from:new Date(q.from).toISOString(),to:new Date(q.to).toISOString()},evaluatedAt:new Date(now).toISOString(),ruleVersion:qualityRuleVersion,source:'APPROVED_EFFECTIVE_UPLOADS',notice:'质量结论仅针对已批准有效上传记录，不代表设备健康、实时在线、预测精度或质量放行。采集链路请查看设备采集页；未知条件不生成健康结论。'};
}
