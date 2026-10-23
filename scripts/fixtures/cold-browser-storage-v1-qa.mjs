import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const states=new Set(['UNKNOWN','ACCEPTED','RUNNING','WAITING_AUTH','RETRY','HUMAN_REVIEW','COMMITTED','FAILED','CANCELLED','NOT_ENQUEUED','CLOSED','SUPERSEDED','KNOWN']);
const ordinal=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const sha=v=>createHash('sha256').update(v).digest('hex');
function keys(value,allowed,required=[]){assert(value&&typeof value==='object'&&!Array.isArray(value),'BROWSER_STORAGE_OBJECT');assert(Object.keys(value).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(value,k)),'BROWSER_STORAGE_FIELDS');}
function reference(record,module){
 const common=['jobId','requestHash','action','status'];let allowed,required;
 if(module==='governance'){allowed=['commandId','jobId','rawHash','action','status','closedWithoutJob'];required=['commandId','action','status'];assert(['TEMPLATE_CREATE','TEMPLATE_EDIT','TEMPLATE_SUBMIT','TEMPLATE_APPROVE','IMPORT_CREATE','IMPORT_APPROVE'].includes(record.action),'BROWSER_STORAGE_ACTION');}
 else if(module==='maintenance'){allowed=['commandId',...common];required=['commandId','status'];assert(record.action===undefined||['claim','start','submit','approval','workflow/retry'].includes(record.action),'BROWSER_STORAGE_ACTION');}
 else if(module==='predictive'){
  assert(['COMMAND','RETRY','ADOPTION'].includes(record.kind),'BROWSER_STORAGE_KIND');
  allowed=record.kind==='COMMAND'?['kind','commandId',...common]:record.kind==='RETRY'?['kind','controlId','expectedGrantRevision',...common]:['kind','controlId','commandId','recoverClosedAcceptance','expectedNativeHash','jobId','action','status'];
  required=record.kind==='COMMAND'?['kind','commandId','status']:record.kind==='RETRY'?['kind','controlId','expectedGrantRevision','jobId','status']:['kind','controlId','commandId','recoverClosedAcceptance','status'];
  assert(record.action===undefined||['ANALYZE','REVIEW'].includes(record.action),'BROWSER_STORAGE_ACTION');
 }else{
  assert(module==='reconciliation'&&['ACTION','AUTH'].includes(record.kind),'BROWSER_STORAGE_KIND');
  allowed=record.kind==='AUTH'?['kind','caseId','operationId','authorizationId','expectedGrantRevision','status']:['kind','caseId','operationId','action','requestHash','commandId','expectedNativeHash','status'];
  required=record.kind==='AUTH'?allowed:['kind','caseId','operationId','action','requestHash','status'];
  if(record.kind==='ACTION'){assert(['OPEN','OBSERVE','REVIEW','CONFIRM','SETTLE'].includes(record.action),'BROWSER_STORAGE_ACTION');if(record.action==='OPEN'){assert(uuid(record.commandId)&&hash(record.expectedNativeHash)&&record.caseId===record.operationId,'BROWSER_STORAGE_OPEN');}else assert(!Object.hasOwn(record,'commandId')&&!Object.hasOwn(record,'expectedNativeHash'),'BROWSER_STORAGE_EXTRA_OPEN_FIELDS');}
 }
 keys(record,allowed,required);assert(states.has(record.status),'BROWSER_STORAGE_STATUS');
 for(const k of ['commandId','controlId','jobId','caseId','operationId','authorizationId'])if(Object.hasOwn(record,k))assert(uuid(record[k]),'BROWSER_STORAGE_UUID');
 for(const k of ['requestHash','rawHash','expectedNativeHash'])if(Object.hasOwn(record,k))assert(hash(record[k]),'BROWSER_STORAGE_DIGEST');
 if(Object.hasOwn(record,'expectedGrantRevision'))assert(ordinal(record.expectedGrantRevision),'BROWSER_STORAGE_REVISION');
 for(const k of ['recoverClosedAcceptance','closedWithoutJob'])if(Object.hasOwn(record,k))assert(typeof record[k]==='boolean','BROWSER_STORAGE_BOOLEAN');
 return record.commandId??record.controlId??record.authorizationId??record.operationId;
}

/** Verify a real, independently captured RP-origin storage snapshot. Never return raw values. */
export function verifyColdBrowserStorageSnapshotV1(snapshot,{owner,nonce,origin,accounts,expectedSessionHash,startedAt,now=Date.now(),knownSecrets=[],permittedReferenceIds=null,requiredReferenceIds=[]}){
 keys(snapshot,['format','owner','nonce','origin','capturedAt','local','session','indexedDbNames','cacheNames','cookies','recoveryView'],['format','owner','nonce','origin','capturedAt','local','session','indexedDbNames','cacheNames','cookies','recoveryView']);
 assert(snapshot.format==='IDMS_COLD_BROWSER_STORAGE_SNAPSHOT_V1'&&snapshot.owner===owner&&uuid(owner)&&snapshot.nonce===nonce&&/^[a-f0-9]{12}$/.test(nonce),'BROWSER_STORAGE_OWNER');
 assert(new URL(origin).origin===origin&&new URL(origin).protocol==='http:'&&new URL(origin).hostname==='127.0.0.1'&&snapshot.origin===origin,'BROWSER_STORAGE_ORIGIN');
 assert(Number.isSafeInteger(startedAt)&&Number.isSafeInteger(now)&&Number.isSafeInteger(snapshot.capturedAt)&&snapshot.capturedAt>=startedAt&&snapshot.capturedAt<=now+1000,'BROWSER_STORAGE_TIME');
 assert(Array.isArray(accounts)&&accounts.length>0&&accounts.every(a=>uuid(a.id)&&/^[A-Za-z0-9_.-]{1,128}$/.test(a.tenantId)),'BROWSER_STORAGE_ACCOUNTS');
 assert(Array.isArray(snapshot.indexedDbNames)&&snapshot.indexedDbNames.length===0,'BROWSER_STORAGE_UNCLASSIFIED_INDEXED_DB');
 assert(Array.isArray(snapshot.cacheNames)&&snapshot.cacheNames.length===0,'BROWSER_STORAGE_UNCLASSIFIED_CACHE');
 const entries=[],recordIds=[],moduleCounts={governance:0,maintenance:0,predictive:0,reconciliation:0};
 for(const [kind,rows]of [['local',snapshot.local],['session',snapshot.session]]){
  assert(Array.isArray(rows)&&rows.length<=100,'BROWSER_STORAGE_ENTRY_LIMIT');const seen=new Set();
  for(const row of rows){
   assert(Array.isArray(row)&&row.length===2&&row.every(v=>typeof v==='string'),'BROWSER_STORAGE_ENTRY');const [key,value]=row;
   assert(key.length<=512&&Buffer.byteLength(value)<=65536&&!seen.has(key),'BROWSER_STORAGE_ENTRY_SIZE_OR_DUPLICATE');seen.add(key);
   assert(!knownSecrets.some(s=>typeof s==='string'&&s.length>=12&&(key.includes(s)||value.includes(s))),'BROWSER_STORAGE_KNOWN_CREDENTIAL');
   let module,tenant,actor;
   if(kind==='session'){
    const prefix=key.startsWith('idms-governance-operations-v4:')?'idms-governance-operations-v4:':key.startsWith('idms-maintenance-operations-v4:')?'idms-maintenance-operations-v4:':null;assert(prefix,'BROWSER_STORAGE_UNCLASSIFIED_KEY');
    module=prefix.includes('governance')?'governance':'maintenance';let identity;try{identity=JSON.parse(key.slice(prefix.length));}catch{assert.fail('BROWSER_STORAGE_NAMESPACE');}assert(Array.isArray(identity)&&identity.length===2,'BROWSER_STORAGE_NAMESPACE');[tenant,actor]=identity;
   }else{
    const p=key.match(/^idms-predictive-v4:([A-Za-z0-9_.-]+):([a-f0-9-]{36}):([a-f0-9]{64})$/),r=key.match(/^idms-reconciliation-v1:([A-Za-z0-9_.-]+):([a-f0-9-]{36})$/);assert(p||r,'BROWSER_STORAGE_UNCLASSIFIED_KEY');module=p?'predictive':'reconciliation';[,tenant,actor]=p??r;
   }
   assert(accounts.some(a=>a.id===actor&&a.tenantId===tenant),'BROWSER_STORAGE_FOREIGN_NAMESPACE');
   let records;try{records=JSON.parse(value);}catch{assert.fail('BROWSER_STORAGE_JSON');}assert(Array.isArray(records)&&records.length<=30,'BROWSER_STORAGE_RECORD_LIMIT');
   assert(JSON.stringify(records)===value,'BROWSER_STORAGE_NONCANONICAL_JSON');
   const ids=new Set();for(const record of records){assert(record&&typeof record==='object'&&!Array.isArray(record),'BROWSER_STORAGE_RECORD');const id=reference(record,module);assert(!ids.has(id),'BROWSER_STORAGE_DUPLICATE_RECORD');ids.add(id);recordIds.push(id);}
   moduleCounts[module]+=records.length;entries.push({kind,module,tenantId:tenant,actorId:actor,keySha256:sha(key),valueSha256:sha(value),records:records.length});
  }
 }
 assert(Array.isArray(snapshot.cookies),'BROWSER_STORAGE_COOKIES');
 assert(expectedSessionHash===null||hash(expectedSessionHash),'BROWSER_STORAGE_EXPECTED_SESSION');
 assert(snapshot.cookies.length===(expectedSessionHash===null?0:1),'BROWSER_STORAGE_COOKIE_COUNT');
 for(const c of snapshot.cookies){keys(c,['name','valueSha256','domain','path','httpOnly','secure','sameSite','session','expires'],['name','valueSha256','domain','path','httpOnly','secure','sameSite','session','expires']);assert(c.name==='idms_session'&&c.valueSha256===expectedSessionHash&&c.domain==='127.0.0.1'&&c.path==='/'&&c.httpOnly===true&&c.sameSite==='Lax'&&c.secure===false&&typeof c.session==='boolean'&&typeof c.expires==='number'&&Number.isFinite(c.expires),'BROWSER_STORAGE_COOKIE_POLICY');}
 if(snapshot.recoveryView!==null){const v=snapshot.recoveryView;keys(v,['page','visibleReferenceIds'],['page','visibleReferenceIds']);assert(v.page==='/maintenance/'&&Array.isArray(v.visibleReferenceIds)&&v.visibleReferenceIds.length<=100&&v.visibleReferenceIds.every(uuid),'BROWSER_STORAGE_RECOVERY_VIEW');assert(Array.isArray(permittedReferenceIds)&&v.visibleReferenceIds.every(id=>permittedReferenceIds.includes(id))&&requiredReferenceIds.every(id=>v.visibleReferenceIds.includes(id)),'BROWSER_STORAGE_FOREIGN_RECOVERY_VIEW');}
 else assert(requiredReferenceIds.length===0,'BROWSER_STORAGE_RECOVERY_VIEW_REQUIRED');
 return {origin,owner,nonce,capturedAt:snapshot.capturedAt,entries,moduleCounts,recordIds,sessionCookiePresent:expectedSessionHash!==null,recoveryView:snapshot.recoveryView,indexedDbCount:0,cacheCount:0,unclassifiedKeys:0,knownCredentialMatches:0,rawValuesReturned:false,scope:'RP_ORIGIN_ONLY_NOT_IDENTITY_PROVIDER'};
}
