import {canonicalDigest,canonicalEqual} from '../server/canonical-state.ts';
import {stateKey} from '../server/state-map-v1.ts';
import {verifyLocalDomainAudit} from '../server/telemetry-map-v4.ts';
import {authAuditFormatV4,authAuditPayloadV4,verifyAuthAuditEventV4} from '../server/auth-audit-event-v4.ts';

// Pure persisted-value checks only. These descriptors are not runtime brands,
// complete-root proofs, source acknowledgements, or permission to write.
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const ordinal=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const oid=v=>typeof v==='string'&&/^[1-9][0-9]{0,9}$/.test(v)&&BigInt(v)<=4294967295n;
const tenant=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(v);
const record=v=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===Object.keys(v).length&&Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>Object.hasOwn(d,'value')&&d.enumerable);
const exact=(v,keys)=>record(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const need=v=>{if(!v)throw Error('COLD_AUTH_AUDIT_MAP_VALUE_UNVERIFIABLE');};
const completionKeys=['format','tenantId','source','requestHash','sourceEventId','sourcePosition','sourceChainHash','auditEventId','auditPosition','auditHash'];
const cursorKeys=['format','tenantId','source','position','chainHash','eventId'];

function guarded(task){try{return task();}catch{throw Object.assign(Error('COLD_AUTH_AUDIT_MAP_VALUE_UNVERIFIABLE'),{code:'COLD_AUTH_AUDIT_MAP_VALUE_UNVERIFIABLE'});}}
function sourceValue(source){need(exact(source,['deployment','databaseOid','scope'])&&hash(source.deployment)&&oid(source.databaseOid)&&hash(source.scope));return source;}
function targetValue(target){need(exact(target,['tenantId','databaseOid','catalogHash'])&&tenant(target.tenantId)&&oid(target.databaseOid)&&hash(target.catalogHash));return target;}
function keys(source,event){sourceValue(source);verifyAuthAuditEventV4(event);need(event.header.scope===source.scope);const sourceKey=canonicalDigest(source);return{sourceKey,receiptKey:'auth_audit:'+canonicalDigest([sourceKey,event.header.eventId]),cursorKey:'auth_audit:'+sourceKey,requestHash:canonicalDigest({source,event})};}
function metadata(sourceKey,event){return{authMode:'oidc',roles:event.payload.roles,reason:event.payload.reason,occurredAt:new Date(Number(event.header.occurredAtMs)).toISOString(),authenticationEvent:{format:authAuditFormatV4,source:sourceKey,eventId:event.header.eventId,position:event.header.position,previousHash:event.header.previousHash,chainHash:event.header.chainHash,digest:event.header.digest,sessionRef:event.header.sessionRef}};}

/** Identify reserved V4 values from every full-root leaf, validating its actual hashed key. */
export function classifyColdAuthAuditMapValueV1(tenantId,keyHash,value){return guarded(()=>{
 need(tenant(tenantId)&&hash(keyHash));
 if(!record(value)||value.format!==authAuditFormatV4)return null;
 need(value.tenantId===tenantId&&hash(value.source));
 if(exact(value,completionKeys)){
  need(hash(value.requestHash)&&uuid(value.sourceEventId)&&ordinal(value.sourcePosition)&&hash(value.sourceChainHash)&&uuid(value.auditEventId)&&ordinal(value.auditPosition)&&hash(value.auditHash));
  need(keyHash===stateKey(tenantId,'receipt','auth_audit:'+canonicalDigest([value.source,value.sourceEventId])));
  return Object.freeze({kind:'RECEIPT',source:value.source,sourceEventId:value.sourceEventId,sourcePosition:value.sourcePosition,auditEventId:value.auditEventId,auditPosition:value.auditPosition});
 }
 need(exact(value,cursorKeys)&&ordinal(value.position)&&hash(value.chainHash)&&uuid(value.eventId));
 need(keyHash===stateKey(tenantId,'domain_head','auth_audit:'+value.source));
 return Object.freeze({kind:'CURSOR',source:value.source,sourceEventId:value.eventId,sourcePosition:value.position});
});}

/** Legacy authentication audits remain part of the caller's complete audit chain. */
export function classifyColdAuthAuditMapAuditV1(tenantId,keyHash,audit){return guarded(()=>{
 need(tenant(tenantId)&&hash(keyHash));
 if(!record(audit)||audit.objectType!=='AUTHENTICATION')return null;
 need(audit.tenantId===tenantId&&uuid(audit.eventId)&&record(audit.metadata));
 verifyLocalDomainAudit(audit,tenantId);need(keyHash===stateKey(tenantId,'audit',audit.eventId));
 if(!Object.hasOwn(audit.metadata,'authenticationEvent'))return Object.freeze({kind:'LEGACY_AUTHENTICATION_AUDIT',auditEventId:audit.eventId});
 const m=audit.metadata,e=m.authenticationEvent;
 need(exact(m,['authMode','roles','reason','occurredAt','authenticationEvent'])&&m.authMode==='oidc'&&exact(e,['format','source','eventId','position','previousHash','chainHash','digest','sessionRef']));
 need(e.format===authAuditFormatV4&&hash(e.source)&&uuid(e.eventId)&&ordinal(e.position)&&[e.previousHash,e.chainHash,e.digest,e.sessionRef].every(hash));
 need(audit.actorType==='USER'&&typeof audit.actorId==='string'&&audit.objectId===audit.actorId&&audit.correlationId===e.eventId);
 const payload=authAuditPayloadV4(audit.actorId,m.roles,audit.action);need(canonicalEqual(payload.roles,m.roles)&&payload.reason===m.reason);
 need(typeof m.occurredAt==='string'&&Number.isSafeInteger(Date.parse(m.occurredAt))&&new Date(Date.parse(m.occurredAt)).toISOString()===m.occurredAt);
 return Object.freeze({kind:'V4_AUTHENTICATION_AUDIT',source:e.source,sourceEventId:e.eventId,sourcePosition:e.position,auditEventId:audit.eventId,auditHash:audit.hash});
});}

/** Caller must bind target to a genuine complete-root index, and prove stream coverage separately. */
export function matchColdAuthAuditMapReceiptV1(raw){return guarded(()=>{
 need(exact(raw,['source','target','event','completion','audit','order','sourceReceipt']));
 const {source,target,event,completion,audit,order,sourceReceipt}=raw;sourceValue(source);targetValue(target);
 const k=keys(source,event);need(event.header.tenantId===target.tenantId);
 const leaf=classifyColdAuthAuditMapValueV1(target.tenantId,stateKey(target.tenantId,'receipt',k.receiptKey),completion);
 need(leaf?.kind==='RECEIPT'&&completion.source===k.sourceKey&&completion.requestHash===k.requestHash&&completion.sourceEventId===event.header.eventId&&completion.sourcePosition===event.header.position&&completion.sourceChainHash===event.header.chainHash);
 const described=classifyColdAuthAuditMapAuditV1(target.tenantId,stateKey(target.tenantId,'audit',completion.auditEventId),audit);
 need(described?.kind==='V4_AUTHENTICATION_AUDIT'&&audit.eventId===completion.auditEventId&&audit.hash===completion.auditHash);
 need(exact(order,['tenantId','position','eventId'])&&order.tenantId===target.tenantId&&order.position===completion.auditPosition&&order.eventId===audit.eventId);
 need(audit.actorId===event.payload.actorId&&audit.objectId===event.payload.actorId&&audit.action===event.header.action&&audit.correlationId===event.header.eventId&&canonicalEqual(audit.metadata,metadata(k.sourceKey,event)));
 if(sourceReceipt!==null)need(exact(sourceReceipt,['completion','businessDatabaseOid','businessCatalogHash'])&&sourceReceipt.businessDatabaseOid===target.databaseOid&&sourceReceipt.businessCatalogHash===target.catalogHash&&canonicalEqual(sourceReceipt.completion,completion));
 return Object.freeze({tenantId:target.tenantId,source:k.sourceKey,sourceEventId:event.header.eventId,sourcePosition:event.header.position,auditEventId:completion.auditEventId,auditPosition:completion.auditPosition,auditHash:completion.auditHash,sourceReceiptPresent:sourceReceipt!==null});
});}

/** lastEvent is the caller-verified business prefix tip, not the source ACK tip. */
export function matchColdAuthAuditMapCursorV1(raw){return guarded(()=>{
 need(exact(raw,['source','target','cursor','lastEvent']));
 const {source,target,cursor,lastEvent}=raw;sourceValue(source);targetValue(target);
 if(lastEvent===null){need(cursor===null);return Object.freeze({source:canonicalDigest(source),businessPosition:'0'});}
 const k=keys(source,lastEvent);need(lastEvent.header.tenantId===target.tenantId);
 const described=classifyColdAuthAuditMapValueV1(target.tenantId,stateKey(target.tenantId,'domain_head',k.cursorKey),cursor);
 need(described?.kind==='CURSOR'&&cursor.source===k.sourceKey&&cursor.position===lastEvent.header.position&&cursor.chainHash===lastEvent.header.chainHash&&cursor.eventId===lastEvent.header.eventId);
 return Object.freeze({source:k.sourceKey,businessPosition:cursor.position});
});}
