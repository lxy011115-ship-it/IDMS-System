import {canonical} from '../server/imports.ts';
import {applicationHashV1 as hash,applicationNeedV1 as need} from './runtime-application-config-v1.mjs';

const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const count=v=>Number.isSafeInteger(v)&&v>=0;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const error=v=>v===null||typeof v==='string'&&/^[A-Z][A-Z0-9_]{3,120}$/.test(v);

/** Compact journal facts; actual result bytes are checked separately by the fork owner. */
export function assertFieldSiteRetirementProofV1(p,e){
 need(p?.format==='FIELD_SITE_CHILD_RETIREMENT_V1'&&p.ownerId===e.ownerId&&p.componentId===e.componentId&&p.pid===e.pid&&p.parentPid===e.parentPid&&p.configSha256===e.configSha256&&p.manifestSha256===e.manifestSha256&&p.challengeSha256===e.challengeSha256&&p.enabled===e.enabled&&p.allOwnedResourcesRetired===true,'FIELD_SITE_PROOF_BINDING');
 need(typeof p.started==='boolean'&&typeof p.ready==='boolean'&&typeof p.normalClose==='boolean'&&typeof p.startupCancelled==='boolean'&&(!p.ready||p.started)&&(!p.normalClose||p.requestId===e.requestId&&uuid(p.requestId))&&p.startupCancelled===(p.normalClose&&!p.ready)&&digest(p.resultSha256),'FIELD_SITE_PROOF_FIELDS');
 need(p.runtimeOwner===null?p.runtimeSha256===null&&!p.ready:uuid(p.runtimeOwner)&&digest(p.runtimeSha256),'FIELD_SITE_PROOF_RUNTIME');
 const c=p.counts;
 need(c&&Object.keys(c).sort().join(',')===['httpActive','hostConnectionsCreated','hostConnectionsRetired','platformTenants','ownerConnectionsCreated','ownerConnectionsRetired','mqttSources'].sort().join(',')&&Object.values(c).every(count)&&c.httpActive===0&&c.hostConnectionsCreated===c.hostConnectionsRetired&&c.ownerConnectionsCreated===c.ownerConnectionsRetired,'FIELD_SITE_PROOF_COUNTS');
 need(p.enabled||Object.values(c).every(v=>v===0),'FIELD_SITE_PROOF_DISABLED');return p;
}

/** Validate the original fork's result after actual close; no PID adoption or resource creation. */
export function fieldSiteChildRetirementV1(result,expected){
 const r=result,e=expected;
 need(r?.format==='RUNTIME_FIELD_SITE_CHILD_RESULT_V1'&&r.ownerId===e.ownerId&&r.componentId===e.componentId&&r.pid===e.pid&&r.parentPid===e.parentPid&&r.configSha256===e.configSha256&&r.manifestSha256===e.manifestSha256&&r.challengeSha256===hash(e.challenge),'FIELD_SITE_RESULT_BINDING');
 need(uuid(r.ownerId)&&Number.isInteger(r.pid)&&r.pid>0&&Number.isInteger(r.parentPid)&&r.parentPid>0&&digest(r.configSha256)&&digest(r.manifestSha256)&&typeof e.enabled==='boolean'&&typeof r.started==='boolean'&&typeof r.ready==='boolean'&&typeof r.normalClose==='boolean'&&typeof r.startupCancelled==='boolean'&&count(r.rejectedStopRequests)&&error(r.errorCode),'FIELD_SITE_RESULT_FIELDS');
 need(!r.ready||r.started,'FIELD_SITE_RESULT_READY');
 need(r.requestId===null||uuid(r.requestId),'FIELD_SITE_RESULT_REQUEST');
 need(['REQUESTED','FAILED','PARENT_DISCONNECTED','SIGINT','SIGTERM'].includes(r.reason),'FIELD_SITE_RESULT_REASON');
 const normal=r.reason==='REQUESTED'&&r.errorCode===null;
 need(r.normalClose===normal&&r.startupCancelled===(normal&&!r.ready)&&(!normal||uuid(r.requestId)&&r.requestId===e.requestId),'FIELD_SITE_RESULT_NORMAL');
 const counts={httpActive:0,hostConnectionsCreated:0,hostConnectionsRetired:0,platformTenants:0,ownerConnectionsCreated:0,ownerConnectionsRetired:0,mqttSources:0};
 const t=r.runtimeTerminal;let runtimeOwner=null;
 if(t===null){need(!r.ready,'FIELD_SITE_RESULT_RUNTIME_MISSING');}
 else{
  const s=t?.state;
  need(r.started&&t?.format==='FIELD_MAP_SITE_TERMINAL_V1'&&uuid(t.owner)&&t.owner===s?.owner&&uuid(t.requestId)&&(!normal||t.requestId===e.requestId)&&t.allOwnedResourcesRetired===true&&typeof t.normal==='boolean'&&typeof t.startupCancelled==='boolean','FIELD_SITE_RESULT_RUNTIME');
  need(s?.format==='FIELD_MAP_SITE_STATE_V1'&&s.closed===true&&s.closing===true&&s.ready===false&&s.activeHttp===0&&error(s.failure)&&s.phase===(s.failure?'FAILED':'CLOSED')&&t.normal===(s.failure===null)&&(!normal||t.normal)&&(!r.ready||!t.startupCancelled),'FIELD_SITE_RESULT_HTTP_RETIRED');runtimeOwner=t.owner;
  const f=s.field;
  if(f===null){need(!r.ready||!e.enabled,'FIELD_SITE_RESULT_FIELD_MISSING');}
  else{
   need(e.enabled&&f.format==='FIELD_MAP_AUTHORITY_GATEWAY_STATE_V1'&&uuid(f.owner)&&f.closed===true&&f.closing===true&&f.ready===false&&f.activeHttp===0&&error(f.failure)&&f.phase===(f.failure?'FAILED':'CLOSED')&&(!normal||f.failure===null)&&(f.enabled===true||!r.ready&&f.enabled===null),'FIELD_SITE_RESULT_GATEWAY_RETIRED');
   const h=f.host,p=f.platform,m=f.intake;
   need(!r.ready||h&&p&&m&&h.connectionsCreated>0&&p.tenants?.length>0&&m.sources>0,'FIELD_SITE_RESULT_RESOURCES_MISSING');
   if(h){need(h.closed===true&&h.closing===true&&h.active===0&&h.connectionsActive===0&&count(h.connectionsCreated)&&h.connectionsCreated===h.connectionsRetired,'FIELD_SITE_RESULT_HOST_RETIRED');counts.hostConnectionsCreated=h.connectionsCreated;counts.hostConnectionsRetired=h.connectionsRetired;}
   if(p){need(p.closed===true&&p.closing===true&&p.configured===false&&p.active===0&&Array.isArray(p.tenants),'FIELD_SITE_RESULT_PLATFORM_RETIRED');counts.platformTenants=p.tenants.length;
    for(const tenant of p.tenants){const o=tenant.owner;need(o?.closed===true&&o.closing===true&&o.held===false&&o.active===0&&o.acquiring===false&&count(o.connectionsCreated)&&o.connectionsCreated===o.connectionsRetired,'FIELD_SITE_RESULT_OWNER_RETIRED');counts.ownerConnectionsCreated+=o.connectionsCreated;counts.ownerConnectionsRetired+=o.connectionsRetired;
     for(const c of [tenant.issuer,tenant.receiver])need(c?.closed===true&&c.closing===true&&c.active===0&&c.keyCount===0,'FIELD_SITE_RESULT_KEYS_RETIRED');
    }
   }
   if(m){need(m.closed===true&&m.closing===true&&m.configured===false&&m.connected===0&&m.reconnecting===0&&count(m.sources)&&Array.isArray(m.transports)&&m.transports.length===m.sources&&m.transports.every(v=>v===null||v.closed===true&&v.closing===true&&v.ready===false&&v.connecting===false&&v.publishing===false&&v.receiving===0),'FIELD_SITE_RESULT_MQTT_RETIRED');counts.mqttSources=m.sources;}
  }
 }
 return Object.freeze({format:'FIELD_SITE_CHILD_RETIREMENT_V1',ownerId:r.ownerId,componentId:r.componentId,pid:r.pid,parentPid:r.parentPid,configSha256:r.configSha256,manifestSha256:r.manifestSha256,challengeSha256:r.challengeSha256,requestId:r.requestId,started:r.started,ready:r.ready,normalClose:r.normalClose,startupCancelled:r.startupCancelled,enabled:e.enabled,runtimeOwner,runtimeSha256:t===null?null:hash(canonical(t)),resultSha256:hash(canonical(r)),allOwnedResourcesRetired:true,counts});
}
