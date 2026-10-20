import { measurementSchema } from "../../server/measurement-schema.ts";
export const modelVersion = "engineering-health-rules-1.0.1";
export interface Point {tag_code:string;measured_at:string;value:number;unit:string;quality:string}
export function analyze(points: Point[]) {
  if (!Array.isArray(points) || points.length < 18 || points.length > 600) throw Error("每设备需18–600条批准测点记录");
  if (points.some(p=>!p || !Object.hasOwn(measurementSchema,p.tag_code) || typeof p.value!=="number" || !Number.isFinite(p.value) || !Number.isFinite(Date.parse(p.measured_at)))) throw Error("分析输入无效");
  const features=Object.entries(measurementSchema).map(([name,definition])=>{
    const selected=points.filter(p=>p.tag_code===name && p.quality==='GOOD').sort((a,b)=>Date.parse(a.measured_at)-Date.parse(b.measured_at));
    if (selected.length<6) throw Error(`测点 ${name} 至少需要6条GOOD记录`);
    if (selected.some(p=>p.unit!==definition.unit || p.value<definition.min || p.value>definition.max)) throw Error('测点范围或单位无效');
    const timestamps=selected.map(p=>Date.parse(p.measured_at));
    if (new Set(timestamps).size!==timestamps.length) throw Error('重复时刻不可作为独立样本');
    if (timestamps.at(-1)!-timestamps[0]<300000 || timestamps.at(-1)!-timestamps[0]>86400000) throw Error('分析窗口需5分钟至24小时');
    for(let i=1;i<timestamps.length;i++)if(timestamps[i]-timestamps[i-1]>300000)throw Error('测点缺口大于5分钟');
    const mean=selected.reduce((s,p)=>s+p.value,0)/selected.length;
    const severity=Math.min(1,Math.max(0,(mean-definition.warning)/(definition.critical-definition.warning)));
    return {name,label:definition.label,value:Number(mean.toFixed(3)),unit:definition.unit,baseline:definition.warning,status:(mean>=definition.critical?'CRITICAL':mean>=definition.warning?'ELEVATED':'NORMAL') as 'CRITICAL'|'ELEVATED'|'NORMAL',severity};
  });
  const times=Object.keys(measurementSchema).map(tag=>{const t=points.filter(p=>p.tag_code===tag&&p.quality==='GOOD').map(p=>Date.parse(p.measured_at));return {start:Math.min(...t),end:Math.max(...t)};});
  if(Math.max(...times.map(t=>t.start))-Math.min(...times.map(t=>t.start))>60000||Math.max(...times.map(t=>t.end))-Math.min(...times.map(t=>t.end))>60000)throw Error('测点时间窗口未对齐');
  const max=Math.max(...features.map(f=>f.severity)),avg=features.reduce((s,f)=>s+f.severity,0)/features.length;
  // A warning may never be reported as healthy; a critical feature sets the minimum overall risk.
  const cap=features.some(f=>f.status==='CRITICAL')?34:features.some(f=>f.status==='ELEVATED')?79:100;
  const score=Math.min(cap,Math.round(100-70*max-30*avg));
  return {modelVersion,score,band:score>=80?'HEALTHY':score>=65?'WATCH':score>=35?'RISK':'CRITICAL',features:features.map(({severity,...feature})=>feature),anomalyScore:Number(max.toFixed(4)),confidence:null,probability:null,rul:null,windowStart:new Date(Math.min(...times.map(t=>t.start))).toISOString(),windowEnd:new Date(Math.max(...times.map(t=>t.end))).toISOString(),sampleCount:points.length,disclaimer:'工程阈值冷启动规则，未经设备厂家和现场验证；不代表故障概率或剩余寿命'};
}
