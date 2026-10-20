import type {AuditEvent} from './domain.ts';
import type {SourceBinding,PublicGovernedSource} from './source-governance.ts';
import {canonical} from './imports.ts';
import {sha,type TelemetryEvent} from '../integrations/telemetry.ts';
import {sourceGovernanceIntegrity} from './source-policy-references.ts';

export interface SourceReceipt {edge_id:string;event_id:string;digest:string;sequence_no:string|null;status:string;reason:string|null;point_id:string|null;envelope:TelemetryEvent;received_at:string|Date}
export interface SourcePoint {tenant_id:string;id:string;edge_id:string;device_code:string;tag_code:string;node_id:string;map_version:string;origin:string;sequence_no:string;event_time:string|Date;received_at:string|Date;value:number|null;unit:string;quality:string;input_digest:string}
export const sourceIso=(v:unknown)=>{const n=v instanceof Date?v.getTime():typeof v==='string'?Date.parse(v):NaN;if(!Number.isFinite(n))throw sourceGovernanceIntegrity();return new Date(n).toISOString();};
export type RecomputeSourceBinding=(source:PublicGovernedSource,at:number,tag:string|null)=>SourceBinding|null;
// Raw envelopes stay within the verified server transaction. Public evidence
// records this check's result, not foreign rejected payloads or HMAC secrets.
export function verifySourceReceipt(receipt:SourceReceipt,anchor:AuditEvent,tenant:string,edge:string,recompute:RecomputeSourceBinding){
 const e=receipt.envelope;if(!e||!['STORED','REJECTED'].includes(receipt.status)||receipt.edge_id!==edge||receipt.event_id!==e.eventId||receipt.digest!==sha(e)||receipt.sequence_no!==(Number.isSafeInteger(e.sequenceNo)?String(e.sequenceNo):null))throw sourceGovernanceIntegrity();
 if(anchor.tenantId!==tenant||anchor.objectType!=='TELEMETRY_EVENT'||anchor.objectId!==receipt.event_id||anchor.action!=='TELEMETRY_'+receipt.status||anchor.actorType!=='INTERFACE'||anchor.actorId!==edge||anchor.correlationId!==receipt.event_id||anchor.metadata.inputDigest!==receipt.digest||(anchor.metadata.pointId||null)!==receipt.point_id||(anchor.metadata.reason||null)!==(receipt.reason||null))throw sourceGovernanceIntegrity();
 const frozen=anchor.metadata.sourceGovernance as SourceBinding|undefined;if(frozen!==undefined){if(!frozen?.configuredSource||frozen.configuredSource.tenantId!==tenant||frozen.configuredSource.edgeId!==edge||canonical(recompute(frozen.configuredSource,Date.parse(anchor.businessTime),typeof e.tagCode==='string'?e.tagCode:null))!==canonical(frozen)||sourceIso(receipt.received_at)!==anchor.businessTime)throw sourceGovernanceIntegrity();}
 if(receipt.status==='REJECTED'){if(receipt.point_id!==null||!receipt.reason)throw sourceGovernanceIntegrity();return;}
 if(!receipt.point_id||receipt.reason!==null||e.tenantId!==tenant||e.edgeId!==edge||e.deviceCode!==anchor.metadata.deviceCode||e.mapVersion!==anchor.metadata.mapVersion||frozen&&frozen.status!=='APPROVED_CONFIGURATION')throw sourceGovernanceIntegrity();
 if(frozen){const point=frozen.configuredSource.points.find(p=>p.tagCode===e.tagCode&&p.nodeId===e.nodeId),definition=frozen.pointDefinition;
  if(!point||!definition||definition.tagCode!==e.tagCode||definition.unit!==e.unit||point.unit!==e.unit||e.version!==1||!Number.isSafeInteger(e.sequenceNo)||e.sequenceNo<1||sourceIso(e.eventTime)!==e.eventTime||Date.parse(e.eventTime)>Date.parse(anchor.businessTime)+300000||!['GOOD','BAD','UNCERTAIN'].includes(e.quality)||e.value!==null&&(typeof e.value!=='number'||!Number.isFinite(e.value))||e.quality==='GOOD'&&(e.value===null||e.value<definition.minimum||e.value>definition.maximum))throw sourceGovernanceIntegrity();
 }
}
export function verifySourcePoint(receipt:SourceReceipt,anchor:AuditEvent,p:SourcePoint,tenant:string,edge:string){
 const e=receipt.envelope;if(receipt.status!=='STORED'||!p||p.tenant_id!==tenant||p.id!==receipt.point_id||p.edge_id!==edge||p.device_code!==e.deviceCode||p.tag_code!==e.tagCode||p.node_id!==e.nodeId||p.map_version!==e.mapVersion||p.origin!==anchor.metadata.origin||p.unit!==e.unit||p.quality!==e.quality||p.value!==e.value||sourceIso(p.event_time)!==e.eventTime)throw sourceGovernanceIntegrity();
 if(p.input_digest===receipt.digest&&(p.id!==e.eventId.toLowerCase()||p.sequence_no!==String(e.sequenceNo)||anchor.metadata.sourceGovernance!==undefined&&sourceIso(p.received_at)!==anchor.businessTime))throw sourceGovernanceIntegrity();
}
