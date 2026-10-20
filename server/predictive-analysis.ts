import {dataScope} from './data-scope.ts';
import {effectiveRecords} from './import-revisions.ts';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { appendAudit } from './audit.ts';
import { canonical, digest } from './imports.ts';
import { DomainError } from './service.ts';
import { measurementSchema } from './measurement-schema.ts';
import type { ImportData } from './imports.ts';
import type { Store } from './store.ts';
import type { HealthSnapshot } from './domain.ts';
import type { PredictiveContext } from './predictive.ts';
import { requireAccess,scopeAllows } from './access.ts';
import { modelVersion } from '../services/predictor/model.ts';
import type { Point } from '../services/predictor/model.ts';

export interface TelemetryAnalysisInput {points:Point[];sourceEdgeId:string;sourceEventIds:string[];provenance:'SIMULATED_TELEMETRY'|'LIVE_TELEMETRY';failureReason?:string}

export async function analyzeDevice(store:Store, data:ImportData, deviceCode:string, ctx:PredictiveContext, telemetry?:TelemetryAnalysisInput) {
  requireAccess(ctx, 'analyze');
  if(!dataScope(data,ctx,store).device(deviceCode))throw new DomainError(403,'设备不在当前账号授权范围内');
  const asset=effectiveRecords(data).find(r=>r.tenantId===ctx.tenantId&&r.dataType==='DEVICE'&&r.value.device_code===deviceCode);
  if(!asset&&!telemetry)throw new DomainError(404,'需要先批准设备台账');
  const source=effectiveRecords(data).filter(r=>r.tenantId===ctx.tenantId&&r.dataType==='MEASUREMENT'&&r.value.device_code===deviceCode&&r.value.quality==='GOOD');
  const rows=Object.keys(measurementSchema).flatMap(tag=>source.filter(r=>r.value.tag_code===tag).sort((a,b)=>Date.parse(String(a.value.measured_at))-Date.parse(String(b.value.measured_at))).slice(-200));
  const points=telemetry?.points||rows.map(r=>({tag_code:String(r.value.tag_code),measured_at:String(r.value.measured_at),value:Number(r.value.value),unit:String(r.value.unit),quality:String(r.value.quality)}));
  const inputDigest=digest(canonical(telemetry?{points,sourceEdgeId:telemetry.sourceEdgeId,sourceEventIds:telemetry.sourceEventIds,provenance:telemetry.provenance}:{points,sources:rows.map(r=>({batchId:r.batchId,row:r.row}))})),sourceBatchIds=telemetry?[]:[...new Set(rows.map(r=>r.batchId))];
  const lineage=telemetry?{sourceEdgeId:telemetry.sourceEdgeId,sourceEventIds:telemetry.sourceEventIds}:{};
  const prior=store.healthSnapshots.find(h=>h.tenantId===ctx.tenantId&&h.deviceCode===deviceCode&&h.inputDigest===inputDigest&&h.modelVersion===modelVersion);
  if(prior&&!telemetry?.failureReason)return {status:'ANALYZED',snapshot:prior,reused:true};
  try{
    if(telemetry?.failureReason)throw Error(telemetry.failureReason);
    const endpoint=process.env.IDMS_PREDICTOR_URL;
    if(!endpoint)throw Error('独立预测服务未配置');
    const url=new URL('/v1/analyze',endpoint);
    if(url.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('预测服务必须使用本机回环地址或HTTPS');
    const token=process.env.IDMS_SERVICE_TOKEN||(await readFile('.local/service-token','utf8')).trim();
    if(token.length<32)throw Error('预测服务身份未配置');
    const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({points}),signal:AbortSignal.timeout(10000),redirect:'error'});
    const text=await response.text();if(text.length>65536)throw Error('预测输出超过限制');
    const result=JSON.parse(text);
    if(!response.ok)throw Error(typeof result.error==='string'?result.error:'预测服务不可用');
    const expectedBand=result.score>=80?'HEALTHY':result.score>=65?'WATCH':result.score>=35?'RISK':'CRITICAL';
    if(result.modelVersion!==modelVersion||!Number.isInteger(result.score)||result.score<0||result.score>100||result.band!==expectedBand||result.confidence!==null||result.probability!==null||result.rul!==null||!Number.isFinite(result.anomalyScore)||result.anomalyScore<0||result.anomalyScore>1||!Array.isArray(result.features)||result.features.length!==3||new Set(result.features.map((f:any)=>f.name)).size!==3||result.sampleCount!==points.length)throw Error('预测输出结构或策略验证失败');
    for(const f of result.features){const definition=measurementSchema[f.name as keyof typeof measurementSchema];if(!definition||f.unit!==definition.unit||f.baseline!==definition.warning||!Number.isFinite(f.value)||f.value<definition.min||f.value>definition.max||!['NORMAL','ELEVATED','CRITICAL'].includes(f.status))throw Error('特征证据验证失败');}
    const times=points.map(p=>Date.parse(p.measured_at));
    if(Date.parse(result.windowStart)!==Math.min(...times)||Date.parse(result.windowEnd)!==Math.max(...times))throw Error('输出时间窗口与输入不一致');
    const deviceId=telemetry?`edge:${telemetry.sourceEdgeId}:${deviceCode}`:store.devices.find(d=>d.tenantId===ctx.tenantId&&d.code===deviceCode)?.id||String(asset!.value.source_record_id);
    const snapshot:HealthSnapshot={id:randomUUID(),tenantId:ctx.tenantId,deviceId,deviceCode,capturedAt:result.windowEnd,evaluatedAt:new Date().toISOString(),score:result.score,band:result.band,confidence:null,features:result.features,modelVersion:result.modelVersion,inputWindow:`${result.windowStart} — ${result.windowEnd} / ${points.length}点`,inputDigest,sourceBatchIds,provenance:telemetry?.provenance||'APPROVED_IMPORT',...lineage};
    store.healthSnapshots.push(snapshot);
    if(!store.predictiveModels.some(m=>m.tenantId===ctx.tenantId&&m.key==='engineering-health-rules'&&m.version==='1.0.1'))store.predictiveModels.push({id:randomUUID(),tenantId:ctx.tenantId,key:'engineering-health-rules',name:'工程阈值健康分析',version:'1.0.1',modelType:'RULE',status:'SHADOW',trainedAt:new Date().toISOString(),note:'无训练指标；工程阈值需现场验证。RUL/故障概率不输出。'});
    if(snapshot.band==='RISK'||snapshot.band==='CRITICAL'){
      const id=randomUUID();
      const active=store.predictiveAlerts.find(a=>a.tenantId===ctx.tenantId&&a.deviceId===deviceId&&a.modelVersion===result.modelVersion&&['OPEN','AWAITING_APPROVAL','WORK_ORDER_CREATED'].includes(a.state));
      // An active maintenance episode keeps its approved evidence frozen; new snapshots remain traceable.
      if(!active){
      store.predictiveAlerts.push({id,tenantId:ctx.tenantId,deviceId,deviceCode,title:telemetry?'采集测点工程阈值异常（'+(telemetry.provenance==='SIMULATED_TELEMETRY'?'模拟设备':'现场设备')+'）':'批准测点工程阈值异常',severity:snapshot.band==='CRITICAL'?'HIGH':'MEDIUM',state:'AWAITING_APPROVAL',version:1,healthScore:snapshot.score,anomalyScore:result.anomalyScore,probability:null,horizon:'历史窗口分析，不提供故障时间预测',evidence:[`健康快照 ${snapshot.id} / 输入摘要 ${inputDigest}`,...result.features.map((f:any)=>`${f.name} 窗口均值 ${f.value}${f.unit}，示范阈值 ${f.baseline}`)],recommendation:'安排现场检查轴承、润滑与传感器安装，现场确认故障原因后制定维修措施',modelVersion:result.modelVersion,generatedAt:new Date().toISOString()});
      store.maintenanceRecommendations.push({id:randomUUID(),tenantId:ctx.tenantId,alertId:id,deviceId,action:'现场检查并复测；不得仅凭规则评分直接更换部件',priority:'P2',estimatedMinutes:30,parts:[],status:'PROPOSED'});
      }
    }
    appendAudit(store,{tenantId:ctx.tenantId,objectType:'HEALTH_SNAPSHOT',objectId:snapshot.id,action:telemetry?'TELEMETRY_MEASUREMENT_ANALYZED':'APPROVED_MEASUREMENT_ANALYZED',actorType:'RULE',actorId:'idms.predictor',correlationId:ctx.correlationId,after:structuredClone(snapshot),metadata:{requestedBy:ctx.actorId,inputDigest,sourceBatchIds,...lineage,modelVersion:result.modelVersion,ruleVersion:'engineering-limits-demo-1.0',rul:null}});
    return {status:'ANALYZED',snapshot,reused:false};
  }catch(e){
    const reason=e instanceof Error?e.message:'预测服务不可用';
    appendAudit(store,{tenantId:ctx.tenantId,objectType:'PREDICTIVE_REVIEW',objectId:deviceCode,action:'PREDICTION_HUMAN_REVIEW_REQUIRED',actorType:'SYSTEM',actorId:'idms.predictor-gateway',correlationId:ctx.correlationId,metadata:{reason,inputDigest,sourceBatchIds,...lineage,requestedBy:ctx.actorId}});
    return {status:'HUMAN_REVIEW',reason,snapshot:null};
  }
}
