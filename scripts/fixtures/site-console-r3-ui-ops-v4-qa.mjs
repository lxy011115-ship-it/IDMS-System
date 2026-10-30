import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {TelemetryMapV4Receiver} from '../../server/telemetry-map-v4.ts';
import {DomainMapSnapshot,DomainMapV4} from '../../server/domain-map-v4.ts';
import {signEvent,topicFor} from '../../integrations/telemetry.ts';
/** Native sample and network controls only. Browser actions must come from Cua. */
export function createSiteConsoleR3UiOpsQa({qa,boots,flowProxies,predictorProxy,engines}){
 const seeded=new Set();return async c=>{
  if(!['seedTelemetry','network','release','nativeState','phase'].includes(c.op))return {handled:false};
  const tenant=c.tenant||'sandbox';assert.ok(['acme','sandbox'].includes(tenant));const t=qa.targets[tenant];
  if(c.op==='seedTelemetry'){
   assert.ok(!seeded.has(tenant),'This run already supplied its eighteen receiver samples');const source=boots[tenant].model.source,now=Date.now();const receiver=new TelemetryMapV4Receiver(new DomainMapV4(t.account,t.binding),[source],()=>{}),values={vibration_rms:8,bearing_temperature:90,motor_current_std:23};let sequence=5000;
   for(const tag of Object.keys(values))for(let i=0;i<6;i++){const point=source.points.find(p=>p.tagCode===tag),event=signEvent({version:1,eventId:randomUUID(),tenantId:tenant,edgeId:source.edgeId,deviceCode:source.deviceCode,tagCode:tag,nodeId:point.nodeId,mapVersion:source.mapVersion,sequenceNo:sequence++,eventTime:new Date(now-300000+i*60000).toISOString(),value:values[tag],unit:point.unit,quality:'GOOD'},source.signingKey),ack=await receiver.receive(topicFor(source,'telemetry'),Buffer.from(JSON.stringify(event)));assert.equal(ack.status,'STORED',ack.reason);}
   seeded.add(tenant);return {handled:true,value:{tenant,signedReceiverSamples:18,source:source.edgeId,provenance:'SIMULATED_TELEMETRY'}};
  }
  if(c.op==='network'||c.op==='release'){assert.ok(['FLOW','PREDICTOR'].includes(c.service));const proxy=c.service==='FLOW'?flowProxies[tenant]:predictorProxy;if(c.op==='network')proxy.arm(c.mode);else proxy.release();return {handled:true,value:{tenant,service:c.service,held:proxy.held,events:proxy.events.slice(-8)}};}
  if(c.op==='phase'){assert.ok(['ACTIVE','PAUSED','UPDATING'].includes(c.value));const map=new DomainMapV4(t.account,t.binding),s=await map.snapshot();try{const control=await s.get('domain_head','control');await map.commit(s.head,randomUUID(),[await s.operation('domain_head','control',{...control,status:c.value})]);}finally{await s.close();}return {handled:true,value:{tenant,phase:c.value}};}
  const sql=new pg.Client({...qa.adminAccount,database:t.account.database});await sql.connect();try{
   await sql.query('BEGIN READ ONLY');const rows=(await sql.query('SELECT id::text,command_id::text,actor_id,action,status,grant_revision::text,business_key,retry_id::text,retry_actor,retry_grant IS NOT NULL AS retry_pending FROM predictive_jobs_v4.jobs ORDER BY ordinal')).rows;await sql.query('COMMIT');const s=await DomainMapSnapshot.open(t.account,t.binding);try{for(const row of rows){const native=await s.state('predictive_job',row.business_key);if(native.present)row.native={status:native.value.status,actorId:native.value.actorId,planDigest:native.value.planDigest,grantRevision:native.value.grantRevision,hasResult:!!native.value.result};}}finally{await s.close();}
   return {handled:true,value:{tenant,jobs:rows,engineCommands:(await engines[tenant].sql.query('SELECT count(*)::int AS n FROM idms_workflow_commands')).rows[0].n,flowEvents:flowProxies[tenant].events.slice(-10),predictorEvents:predictorProxy.events.slice(-8)}};
  }finally{await sql.end();}
 };
}
