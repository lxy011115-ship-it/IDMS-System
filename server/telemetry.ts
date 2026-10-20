import type {ReadWorkspace} from './read-model.ts';
import {sourceGovernanceDecision} from './source-governance.ts';
import {receiveGovernedTelemetry} from './source-governed-receive.ts';
import {publicRegistry} from './registry-history.ts';
import {observeRegistrySql,assertRegistryCurrent} from './registry-history-sql.ts';
import type {ImportData} from './imports.ts';
import {dataScope} from './data-scope.ts';
import {randomUUID} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mqtt,{type MqttClient} from 'mqtt';
import { authenticEvent,sha,signAck,topicFor,validateEvent,type EdgeSource,type TelemetryEvent,type TelemetryAck } from '../integrations/telemetry.ts';
import { measurementSchema } from './measurement-schema.ts';
import { tenantPool,storageMode } from './postgres-repository.ts';
import { mutate,importData } from './import-api.ts';
import { analyzeDevice } from './predictive-analysis.ts';
import { requireAccess,scopeAllows,type AccessContext } from './access.ts';
import { appendAudit } from './audit.ts';
import type { Store } from './store.ts';
import { DomainError } from './service.ts';
import {verifyModule} from './postgres-security.ts';

interface Config {version:1;mqtt:{url:string;username:string;password:string};sources:EdgeSource[]}
export class TelemetryService {
  config?:Config;client?:MqttClient;connected=false;subscribed=false;lastReceivedAt:string|null=null;lastError:string|null=null;closing=false;
  scopeStore?:Store;
  readonly registryInstanceId='registry-'+randomUUID();
  private async observeRegistry(store:Store,sources:readonly EdgeSource[]){
    for(const tenant of store.tenants)if(tenant.status==='ACTIVE')await observeRegistrySql(tenantPool(tenant.id),tenant.id,publicRegistry(sources,tenant.id),this.registryInstanceId);
  }
  async start(store:Store){
    this.scopeStore=store;
    const path=process.env.IDMS_TELEMETRY_CONFIG;if(!path){if(storageMode==='postgres-tenant-databases')await this.observeRegistry(store,[]);return;}
    if(storageMode!=='postgres-tenant-databases')throw Error('Telemetry requires tenant PostgreSQL storage');
    const config:Config=JSON.parse(await readFile(path,'utf8'));
    if(config.version!==1||!Array.isArray(config.sources)||!config.sources.length||config.sources.length>100)throw Error('Invalid telemetry registry');
    const transport=new URL(config.mqtt.url);
    if(transport.protocol!=='mqtts:'&&!(transport.protocol==='mqtt:'&&['127.0.0.1','localhost','[::1]'].includes(transport.hostname)))throw Error('MQTT requires TLS outside loopback');
    if(transport.username||transport.password)throw Error('Credentials must not be embedded in MQTT URL');
    const ids=new Set<string>();
    for(const source of config.sources){
      if(!store.tenants.some(t=>t.id===source.tenantId&&t.status==='ACTIVE')||![source.tenantId,source.edgeId].every(x=>/^[a-zA-Z0-9_-]{1,80}$/.test(x))||ids.has(source.edgeId))throw Error('Invalid/duplicate edge binding');
      ids.add(source.edgeId);
      if(source.origin!=='SIMULATOR')throw Error('Field source commissioning and certificate approval are not enabled');
      if([source.signingKey,source.acknowledgementKey,source.statusKey].some(k=>typeof k!=='string'||k.length<32))throw Error('Edge signing/status keys are missing');
      const status=new URL(source.statusUrl);if(status.protocol!=='http:'||status.hostname!=='127.0.0.1'||status.pathname!=='/status'||status.username||status.password)throw Error('Untrusted status URL');
      if(!source.points.length||source.points.some(p=>!Object.hasOwn(measurementSchema,p.tagCode)))throw Error('Unsupported point registry');
    }
    for(const tenantId of new Set(config.sources.map(s=>s.tenantId))){await verifyModule(tenantPool(tenantId),'telemetry_points');await verifyModule(tenantPool(tenantId),'telemetry_receipts');}
    await this.observeRegistry(store,config.sources);this.config=config;
    const client=this.client=mqtt.connect(config.mqtt.url,{username:config.mqtt.username,password:config.mqtt.password,clientId:'idms-core-'+randomUUID(),protocolVersion:5,reconnectPeriod:1000,connectTimeout:3000,clean:true,resubscribe:false,properties:{receiveMaximum:10,maximumPacketSize:16384}});
    client.on('connect',()=>{this.connected=true;client.subscribe(config.sources.map(s=>topicFor(s,'telemetry')),{qos:1},(err,grants)=>{this.subscribed=!err&&Array.isArray(grants)&&grants.length===config.sources.length&&grants.every(g=>g.qos<128);if(!this.subscribed)this.lastError='MQTT_SUBSCRIBE_DENIED';});});
    client.on('close',()=>{this.connected=false;this.subscribed=false;});client.on('error',()=>{this.lastError='MQTT_CONNECTION_ERROR';});
    // MQTT stream back-pressure: do not accept an unbounded async queue of broker messages.
    client.handleMessage=(packet,done)=>{
      void this.receive(store,packet.topic,Buffer.from(packet.payload)).catch(()=>{this.lastError='TELEMETRY_TRANSACTION_FAILED';}).finally(()=>done());
    };
  }
  async receive(store:Store,topic:string,bytes:Buffer){
    if(this.closing||!this.config||bytes.length>8192)return;
    const source=this.config.sources.find(s=>topicFor(s,'telemetry')===topic);if(!source)return;
    let event:unknown;try{event=JSON.parse(bytes.toString('utf8'));}catch{this.lastError='INVALID_JSON';return;}
    if(!authenticEvent(event,source.signingKey)){this.lastError='INVALID_SIGNATURE';return;}
    const authenticated=event;let reason:string|undefined;
    try{validateEvent(authenticated,source,measurementSchema);}catch(e){reason=e instanceof Error?e.message:'INVALID_EVENT';}
    // Limit attacker-controlled IDs even for signed invalid envelopes.
    if(typeof authenticated.eventId!=='string'||authenticated.eventId.length>100){this.lastError='INVALID_EVENT_ID';return;}
    const digest=sha(authenticated);
    const result=await mutate(store,async (client,workspace)=>{
      const {store,imports}=workspace,registry=await assertRegistryCurrent(client!,source.tenantId,publicRegistry(this.config!.sources,source.tenantId)),decision=sourceGovernanceDecision(store,imports,source,Date.now(),typeof authenticated.tagCode==='string'?authenticated.tagCode:null);
      if(decision.enforced)return receiveGovernedTelemetry(client!,workspace,source,authenticated,digest,decision,registry);
      const prior=(await client!.query('SELECT status,reason,point_id,digest FROM telemetry_receipts WHERE edge_id=$1 AND event_id=$2',[source.edgeId,authenticated.eventId])).rows;
      const exact=prior.find(p=>p.digest===digest);
      if(exact)return {status:exact.status as 'STORED'|'REJECTED',reason:exact.reason||undefined};
      let rejection=reason;
      if(prior.length)rejection='EVENT_ID_CONFLICT';
      let pointId:string|null=null;
      if(!rejection){
        const sequence=(await client!.query("SELECT event_id FROM telemetry_receipts WHERE edge_id=$1 AND sequence_no=$2 AND status='STORED'",[source.edgeId,authenticated.sequenceNo])).rows[0];
        if(sequence)rejection='SEQUENCE_CONFLICT';
      }
      if(!rejection){
        const e=authenticated;
        const existing=(await client!.query('SELECT id,value,quality,unit,node_id,map_version FROM telemetry_points WHERE edge_id=$1 AND device_code=$2 AND tag_code=$3 AND event_time=$4',[source.edgeId,source.deviceCode,e.tagCode,e.eventTime])).rows[0];
        if(existing){
          if(existing.value!==e.value||existing.quality!==e.quality||existing.unit!==e.unit||existing.node_id!==e.nodeId||existing.map_version!==e.mapVersion)rejection='POINT_TIME_CONFLICT';
          else pointId=existing.id;
        }else{
          pointId=e.eventId;
          await client!.query('INSERT INTO telemetry_points(id,tenant_id,edge_id,device_code,tag_code,node_id,map_version,origin,sequence_no,event_time,value,unit,quality,input_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[pointId,source.tenantId,source.edgeId,source.deviceCode,e.tagCode,e.nodeId,source.mapVersion,source.origin,e.sequenceNo,e.eventTime,e.value,e.unit,e.quality,digest]);
        }
      }
      const status=rejection?'REJECTED':'STORED';
      await client!.query('INSERT INTO telemetry_receipts(edge_id,event_id,digest,sequence_no,status,reason,point_id,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[source.edgeId,authenticated.eventId,digest,Number.isSafeInteger(authenticated.sequenceNo)?authenticated.sequenceNo:null,status,rejection||null,pointId,authenticated]);
      appendAudit(store,{tenantId:source.tenantId,objectType:'TELEMETRY_EVENT',objectId:authenticated.eventId,action:'TELEMETRY_'+status,actorType:'INTERFACE',actorId:source.edgeId,correlationId:authenticated.eventId,metadata:{inputDigest:digest,origin:source.origin,deviceCode:source.deviceCode,mapVersion:source.mapVersion,pointId,reason:rejection}});
      return {status:status as 'STORED'|'REJECTED',reason:rejection};
    },source.tenantId);
    // Both telemetry SQL and append-only business audit have committed before this acknowledgement.
    const ack:TelemetryAck=signAck({version:1,eventId:authenticated.eventId,tenantId:source.tenantId,edgeId:source.edgeId,digest,status:result.status,...(result.reason?{reason:result.reason}:{})},source.acknowledgementKey);
    if(this.client?.connected)this.client.publish(topicFor(source,'ack'),JSON.stringify(ack),{qos:1,retain:false});
    this.lastReceivedAt=new Date().toISOString();this.lastError=null;
  }
  sourcesFor(tenantId:string){return this.config?.sources.filter(s=>s.tenantId===tenantId)||[];}
  async overview(tenantId:string,ctx?:AccessContext,workspace?:ReadWorkspace){
    if(ctx&&storageMode==='postgres-tenant-databases'&&!workspace)throw new DomainError(503,'采集查询必须使用当前企业工作区');
    const sources=[];
    for(const source of this.sourcesFor(tenantId).filter(s=>!ctx||dataScope(workspace?.imports||importData,ctx,workspace?.store||this.scopeStore).device(s.deviceCode))){
      const pool=tenantPool(tenantId);
      const counts=(await pool.query('SELECT count(*)::int AS total,count(*) FILTER(WHERE quality=\'GOOD\')::int AS good,count(*) FILTER(WHERE quality<>\'GOOD\')::int AS low_quality,max(event_time) AS last_event_time,max(received_at) AS last_received_at FROM telemetry_points WHERE tenant_id=$1 AND edge_id=$2',[tenantId,source.edgeId])).rows[0];
      const rejects=(await pool.query("SELECT count(*)::int AS count FROM telemetry_receipts WHERE edge_id=$1 AND status='REJECTED'",[source.edgeId])).rows[0].count;
      const latest=(await pool.query('SELECT DISTINCT ON(tag_code) id,tag_code,event_time,received_at,value,unit,quality FROM telemetry_points WHERE tenant_id=$1 AND edge_id=$2 ORDER BY tag_code,event_time DESC',[tenantId,source.edgeId])).rows;
      let edge:unknown=null;try{const response=await fetch(source.statusUrl,{headers:{Authorization:'Bearer '+source.statusKey},signal:AbortSignal.timeout(1500),redirect:'error'});if(response.ok){const bytes=await response.text();if(bytes.length<16384){const parsed=JSON.parse(bytes);if(parsed.edgeId===source.edgeId&&parsed.tenantId===tenantId)edge=parsed;}}}catch{}
      const age=counts.last_event_time?Date.now()-Date.parse(counts.last_event_time):null;
      sources.push({edgeId:source.edgeId,deviceCode:source.deviceCode,origin:source.origin,mapVersion:source.mapVersion,...counts,rejections:rejects,latest,freshness:age===null?'NO_DATA':age<60000?'FRESH':'STALE',edge});
    }
    return {enabled:!!this.config,brokerConnected:this.connected,subscribed:this.subscribed,sources,storage:'PostgreSQL normalized telemetry (TimescaleDB not yet enabled)',readOnly:true,fieldCommissioned:false,lastError:this.lastError};
  }
  async points(tenantId:string,edgeId:string,limit=100,ctx?:AccessContext,workspace?:ReadWorkspace){
    if(ctx&&storageMode==='postgres-tenant-databases'&&!workspace)throw new DomainError(503,'采集查询必须使用当前企业工作区');
    const source=this.sourcesFor(tenantId).find(s=>s.edgeId===edgeId);if(!source)throw new DomainError(404,'采集源不存在');
    if(ctx&&!dataScope(workspace?.imports||importData,ctx,workspace?.store||this.scopeStore).device(source.deviceCode))throw new DomainError(403,'采集源设备不在当前账号授权范围内');
    return {items:(await tenantPool(tenantId).query('SELECT id,edge_id,device_code,tag_code,event_time,received_at,value,unit,quality,origin,map_version,sequence_no,input_digest FROM telemetry_points WHERE tenant_id=$1 AND edge_id=$2 ORDER BY event_time DESC,id LIMIT $3',[tenantId,edgeId,Math.min(200,Math.max(1,Number.isFinite(limit)?Math.floor(limit):100))])).rows};
  }
  async rejections(tenantId:string,edgeId:string,ctx?:AccessContext,workspace?:ReadWorkspace){
    if(ctx&&storageMode==='postgres-tenant-databases'&&!workspace)throw new DomainError(503,'采集查询必须使用当前企业工作区');
    const source=this.sourcesFor(tenantId).find(s=>s.edgeId===edgeId);if(!source)throw new DomainError(404,'采集源不存在');
    if(ctx&&!dataScope(workspace?.imports||importData,ctx,workspace?.store||this.scopeStore).device(source.deviceCode))throw new DomainError(403,'采集源设备不在当前账号授权范围内');
    return {items:(await tenantPool(tenantId).query("SELECT event_id,digest,reason,received_at FROM telemetry_receipts WHERE edge_id=$1 AND status='REJECTED' ORDER BY received_at DESC LIMIT 100",[edgeId])).rows};
  }
  async analyze(store:Store,edgeId:string,ctx:AccessContext,data:ImportData){
    requireAccess(ctx,'analyze');
    const source=this.sourcesFor(ctx.tenantId).find(s=>s.edgeId===edgeId);if(!source)throw new DomainError(404,'采集源不存在');
    if(!dataScope(data,ctx,store).device(source.deviceCode))throw new DomainError(403,'采集源设备不在当前账号授权范围内');
    const rows:{id:string;tag_code:string;event_time:Date;value:number;unit:string;quality:string}[]=[];
    for(const tag of Object.keys(measurementSchema)){
      const candidates=(await tenantPool(ctx.tenantId).query("SELECT id,tag_code,event_time,value,unit,quality FROM telemetry_points WHERE tenant_id=$1 AND edge_id=$2 AND tag_code=$3 AND quality='GOOD' ORDER BY event_time DESC LIMIT 200",[ctx.tenantId,edgeId,tag])).rows;
      // Analyze the latest contiguous window, not unrelated old backfill or a former operating episode.
      let length=0;
      for(let i=0;i<candidates.length;i++){
        if(i&&(new Date(candidates[i-1].event_time).getTime()-new Date(candidates[i].event_time).getTime()>300000||new Date(candidates[0].event_time).getTime()-new Date(candidates[i].event_time).getTime()>86400000))break;
        length++;
      }
      rows.push(...candidates.slice(0,length).reverse());
    }
    // Do not describe stale or future-timestamp observations as a current device assessment.
    const latest=(await tenantPool(ctx.tenantId).query('SELECT DISTINCT ON(tag_code) tag_code,quality FROM telemetry_points WHERE tenant_id=$1 AND edge_id=$2 ORDER BY tag_code,event_time DESC',[ctx.tenantId,edgeId])).rows;
    const stale=Object.keys(measurementSchema).some(tag=>{const last=rows.filter(r=>r.tag_code===tag).at(-1);return !last||latest.find(p=>p.tag_code===tag)?.quality!=='GOOD'||Date.now()-new Date(last.event_time).getTime()>60000||new Date(last.event_time).getTime()>Date.now()+5000;});
    return analyzeDevice(store,data,source.deviceCode,ctx,{points:rows.map(r=>({tag_code:r.tag_code,measured_at:new Date(r.event_time).toISOString(),value:r.value,unit:r.unit,quality:r.quality})),sourceEdgeId:edgeId,sourceEventIds:rows.map(r=>r.id),provenance:source.origin==='SIMULATOR'?'SIMULATED_TELEMETRY':'LIVE_TELEMETRY',...(stale?{failureReason:'采集数据缺失、过期或时钟超前；不得输出当前健康结论'}:{})});
  }
  close(){this.closing=true;return new Promise<void>(resolve=>{if(!this.client)return resolve();this.client.end(true,{},()=>resolve());});}
}
