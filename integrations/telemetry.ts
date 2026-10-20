import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
export type Quality = 'GOOD'|'BAD'|'UNCERTAIN';
export interface EdgePoint { tagCode:string; nodeId:string; unit:string }
export interface EdgeSource {
  edgeId:string; tenantId:string; deviceCode:string; origin:'SIMULATOR'|'FIELD'; mapVersion:string;
  signingKey:string; acknowledgementKey:string; statusKey:string; statusUrl:string; points:EdgePoint[];
}
export interface TelemetryEvent {
  version:1; eventId:string; tenantId:string; edgeId:string; deviceCode:string; tagCode:string;
  nodeId:string; mapVersion:string; sequenceNo:number; eventTime:string;
  value:number|null; unit:string; quality:Quality; signature:string;
}
export interface TelemetryAck { version:1; eventId:string; edgeId:string; tenantId:string; digest:string; status:'STORED'|'REJECTED'; reason?:string; signature:string }
export function stable(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>(value as Record<string,unknown>)[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+stable((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
export const sha=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
function signature(purpose:string,value:unknown,key:string){return createHmac('sha256',key).update(purpose+':'+stable(value)).digest('hex');}
export function signEvent(input:Omit<TelemetryEvent,'signature'>,key:string):TelemetryEvent {return {...input,signature:signature('telemetry-v1',input,key)};}
export function signAck(input:Omit<TelemetryAck,'signature'>,key:string):TelemetryAck{return {...input,signature:signature('ack-v1',input,key)};}
function matches(input:Record<string,unknown>,purpose:string,key:string){
  if(typeof input.signature!=='string'||!/^[a-f0-9]{64}$/.test(input.signature))return false;
  const {signature:supplied,...data}=input;return timingSafeEqual(Buffer.from(supplied),Buffer.from(signature(purpose,data,key)));
}
export function authenticEvent(input:unknown,key:string):input is TelemetryEvent{return !!input&&typeof input==='object'&&!Array.isArray(input)&&matches(input as Record<string,unknown>,'telemetry-v1',key);}
export function authenticAck(input:unknown,key:string):input is TelemetryAck{return !!input&&typeof input==='object'&&!Array.isArray(input)&&matches(input as Record<string,unknown>,'ack-v1',key);}
export const topicFor=(source:Pick<EdgeSource,'tenantId'|'edgeId'>,kind:'telemetry'|'ack')=>`idms/v1/${source.tenantId}/${source.edgeId}/${kind}`;
export function validateEvent(event:TelemetryEvent,source:EdgeSource,definitions:Record<string,{unit:string;min:number;max:number}>){
  const keys=['version','eventId','tenantId','edgeId','deviceCode','tagCode','nodeId','mapVersion','sequenceNo','eventTime','value','unit','quality','signature'];
  if(Object.keys(event).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(event,k)))throw Error('SCHEMA_INVALID');
  if(event.version!==1||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(event.eventId)||!Number.isSafeInteger(event.sequenceNo)||event.sequenceNo<1)throw Error('IDENTITY_INVALID');
  if(event.tenantId!==source.tenantId||event.edgeId!==source.edgeId||event.deviceCode!==source.deviceCode||event.mapVersion!==source.mapVersion)throw Error('SOURCE_SCOPE_MISMATCH');
  const point=source.points.find(p=>p.tagCode===event.tagCode&&p.nodeId===event.nodeId),definition=definitions[event.tagCode];
  if(!point||!definition||event.unit!==point.unit||event.unit!==definition.unit)throw Error('POINT_MAPPING_INVALID');
  if(typeof event.eventTime!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(event.eventTime)||!Number.isFinite(Date.parse(event.eventTime))||new Date(event.eventTime).toISOString()!==event.eventTime||Date.parse(event.eventTime)>Date.now()+300000)throw Error('EVENT_TIME_INVALID');
  if(!['GOOD','BAD','UNCERTAIN'].includes(event.quality))throw Error('QUALITY_INVALID');
  if(event.value!==null&&(typeof event.value!=='number'||!Number.isFinite(event.value)))throw Error('VALUE_INVALID');
  if(event.quality==='GOOD'&&(event.value===null||event.value<definition.min||event.value>definition.max))throw Error('VALUE_RANGE_INVALID');
}
