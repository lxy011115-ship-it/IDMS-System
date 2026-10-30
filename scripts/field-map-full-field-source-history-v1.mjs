import {fieldLeaseKeyId} from '../integrations/field-lease.ts';
import {fieldMapReceiptFormatV1,fieldMapReceiptKeyV1,fieldMapPointKeyV1,fieldMapStorageV1,inspectFieldMapReceiptV1} from '../server/field-map-receive-v1.ts';
import {fieldIssuanceMapKeyV1,issuanceBodyFromMapV1} from '../server/field-runtime-map-v1.ts';
import {fieldRegistryHistory,fieldRegistrySnapshot} from '../server/field-registry.ts';
import {compileFieldRuntimeMapV1,inspectRegistryMapHeadV1} from '../server/field-runtime-map-v1.ts';
import {createReadStream} from 'node:fs';
import {unlink,lstat} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {resolve,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {privateNewFile} from './backup-support.mjs';
import {frozenMapHashV1 as hash,frozenMapNeedV1 as need} from './field-map-frozen-profile-v2.mjs';
import {validateStateNode,stateValueHash,parseStateValueText,stateBranch,stateRoot,stateEmptyHashes,stateReceiptHash,stateKey} from '../server/state-map-v1.ts';
import {reconstructDomainPayload} from '../server/domain-entities-v4.ts';
import {canonical} from '../server/imports.ts';
const same=(a,b)=>canonical(a)===canonical(b);

/** Offline verification against an independently trusted facts object; leaf lookup uses a private disk index. */
export async function verifyFieldMapFullFieldSourceHistoryV1({file,expectedFacts,workDirectory,publicKeys}){
 const keys=new Map();need(Array.isArray(publicKeys)&&publicKeys.length<=64,'COLD_FIELD_HISTORY_KEYS');for(const key of publicKeys){need(key?.type==='public','COLD_FIELD_HISTORY_KEYS');const id=fieldLeaseKeyId(key);need(!keys.has(id),'COLD_FIELD_HISTORY_KEYS');keys.set(id,key);}
 const {factsSha256,...body}=expectedFacts??{};need(expectedFacts?.format==='FIELD_MAP_FULL_FACTS_V1'&&hash(body)===factsSha256,'FIELD_FULL_EVIDENCE_TRUSTED_FACTS');
 const stat=await lstat(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=2*1024**3,'FIELD_FULL_EVIDENCE_FILE');
 const work=resolve(workDirectory),cache=join(work,'field-full-verify-'+randomUUID()+'.sqlite');need(dirname(cache)===work,'FIELD_FULL_EVIDENCE_CACHE');await privateNewFile(cache,'');let db,stream,lines,problem;const stack=[],digest=createHash('sha256');let header,complete,nodes=0,leaves=0,valueBytes=0,receiptRows=0,previous={revision:'0',rootHash:stateEmptyHashes[0],receiptHash:'0'.repeat(64)},bytes=0;const relations=[];
 try{
  db=new DatabaseSync(cache,{allowExtension:false});db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;CREATE TABLE leaf_values(key_hash TEXT PRIMARY KEY,value_text TEXT NOT NULL);BEGIN IMMEDIATE;');const insert=db.prepare('INSERT INTO leaf_values VALUES(?,?)'),get=db.prepare('SELECT value_text FROM leaf_values WHERE key_hash=?');
  stream=createReadStream(file,{encoding:'utf8'});lines=createInterface({input:stream,crlfDelay:Infinity});
  for await(const line of lines){
   bytes+=Buffer.byteLength(line)+1;need(bytes<=2*1024**3&&Buffer.byteLength(line)<=64*1024**2&&!complete,'FIELD_FULL_EVIDENCE_LIMIT');const v=JSON.parse(line);need(canonical(v)===line,'FIELD_FULL_EVIDENCE_CANONICAL');
   if(v.type==='COMPLETE'){need(header&&same(v.facts,expectedFacts)&&digest.digest('hex')===expectedFacts.evidencePrefixSha256,'FIELD_FULL_EVIDENCE_TRAILER');complete=v;continue;}
   digest.update(line+'\n');
   if(!header){need(v.type==='HEADER'&&v.format==='FIELD_MAP_FULL_FACTS_EVIDENCE_V1'&&v.tenantId===expectedFacts.tenantId&&v.profileSha256===expectedFacts.profileSha256&&same(v.head,expectedFacts.head),'FIELD_FULL_EVIDENCE_HEADER');header=v;continue;}
   if(v.type==='NODE'){
    need(++nodes<=2000000&&receiptRows===0&&relations.length===0,'FIELD_FULL_EVIDENCE_ORDER');const n=validateStateNode(v.node);
    if(n.kind===0){need(typeof v.valueText==='string'&&stateValueHash(v.valueText)===n.valueHash,'FIELD_FULL_EVIDENCE_VALUE_CHANGED');parseStateValueText(v.valueText);valueBytes+=Buffer.byteLength(v.valueText);need(valueBytes<=1024**3,'FIELD_FULL_EVIDENCE_LIMIT');leaves++;insert.run(n.prefix,v.valueText);}
    else{need(v.valueText===null&&stack.length>=2,'FIELD_FULL_EVIDENCE_BRANCH');const right=stack.pop(),left=stack.pop();need(n.left===left.id&&n.right===right.id&&same(stateBranch(n.depth,left,right),n),'FIELD_FULL_EVIDENCE_BRANCH');}
    stack.push(n);need(stack.length<=257,'FIELD_FULL_EVIDENCE_DEPTH');
   }else if(v.type==='RECEIPT'){
    need(relations.length===0&&++receiptRows<=4000000,'FIELD_FULL_EVIDENCE_ORDER');const r=v.value;need(r.tenantId===header.tenantId&&r.beforeRevision===previous.revision&&r.beforeRoot===previous.rootHash&&r.beforeReceiptHash===previous.receiptHash&&BigInt(r.revision)===BigInt(previous.revision)+1n&&r.receiptHash===stateReceiptHash(r),'FIELD_FULL_EVIDENCE_RECEIPT_CHAIN');previous=r;
   }else if(v.type==='RELATION'){need(relations.length<1024,'FIELD_FULL_EVIDENCE_LIMIT');relations.push(v.fact);}
   else need(false,'FIELD_FULL_EVIDENCE_RECORD');
  }
  need(complete&&nodes===expectedFacts.nodes&&leaves===expectedFacts.leaves&&valueBytes===expectedFacts.valueBytes&&receiptRows===expectedFacts.receiptRows&&BigInt(leaves)===BigInt(header.head.count),'FIELD_FULL_EVIDENCE_COVERAGE');
  need(stack.length===(leaves===0?0:1)&&same(stateRoot(stack[0]??null),{rootId:header.head.rootId,rootHash:header.head.rootHash,count:header.head.count}),'FIELD_FULL_EVIDENCE_ROOT');need(previous.revision===header.head.revision&&previous.rootHash===header.head.rootHash&&previous.receiptHash===header.head.receiptHash&&same(relations,expectedFacts.relations),'FIELD_FULL_EVIDENCE_FACTS_CHANGED');
  const payload=await reconstructDomainPayload(header.tenantId,async(namespace,key)=>{const r=get.get(stateKey(header.tenantId,namespace,key));need(r,'FIELD_FULL_EVIDENCE_DOMAIN_MISSING');return parseStateValueText(r.value_text);});need(hash(payload)===expectedFacts.payloadSha256&&hash(payload.audits)===expectedFacts.auditSha256&&payload.audits.length===expectedFacts.auditEvents,'FIELD_FULL_EVIDENCE_DOMAIN_CHANGED');db.exec('COMMIT;');
  const lookup=(namespace,key)=>{const row=get.get(stateKey(header.tenantId,namespace,key));return row?parseStateValueText(row.value_text):null;};
  const runtimeMarker=lookup('domain_head','field_runtime'),registryHead=lookup('domain_head','field_registry'),intakeMarker=lookup('domain_head','field_intake'),history=fieldRegistryHistory(payload.audits,header.tenantId),fieldLeaseHistoryCount=payload.audits.filter(a=>a.objectType==='FIELD_LEASE').length;
  if(runtimeMarker){need(same(runtimeMarker,{format:'IDMS_FIELD_RUNTIME_MAP_V1',tenantId:header.tenantId}),'COLD_FIELD_SOURCE_RUNTIME_MARKER');for(const entry of compileFieldRuntimeMapV1(payload,header.tenantId)){const row=get.get(stateKey(header.tenantId,entry.namespace,entry.key));need(row&&row.value_text===entry.valueText,'COLD_FIELD_SOURCE_FULL_HISTORY_INDEX');}}
  else need(!registryHead&&!intakeMarker&&history.count==='0'&&fieldLeaseHistoryCount===0,'COLD_FIELD_SOURCE_RUNTIME_MARKER_MISSING');
  need(!!registryHead===!!history.last,'COLD_FIELD_SOURCE_REGISTRY_MISSING');if(registryHead){inspectRegistryMapHeadV1(registryHead,history.last.event);need(same(registryHead.snapshot,history.last.snapshot),'COLD_FIELD_SOURCE_REGISTRY_CHANGED');}
  const fieldSourceFacts={format:'COLD_FIELD_MAP_SOURCE_FACTS_V1',runtimeMarker,registryHead,intakeMarker,registryHistoryCount:history.count,fieldLeaseHistoryCount,allFieldRuntimeIndicesMatchedToCompleteAuditedPayload:true,completeFieldMaterialsVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false};
  // The entire root, audit/domain payload, receipt chain and runtime indexes
  // above remain mandatory. Projection reads only that authenticated leaf index.
  const snapshot={tenantId:header.tenantId,head:header.head,state:async(namespace,key)=>{const value=lookup(namespace,key);return {present:value!==null,value};},get:async(namespace,key)=>{const value=lookup(namespace,key);need(value!==null,'COLD_FIELD_HISTORY_MEMBER_MISSING');return value;}};
  const issuances=[],events=[],eventIds=new Set();let projectedBytes=0;
  for(const audit of payload.audits){
    if(audit.objectType==='FIELD_LEASE'){
      const requestId=audit.metadata?.leaseBody?.requestId,index=lookup('field_issuance',fieldIssuanceMapKeyV1(requestId)),body=issuanceBodyFromMapV1(index,audit,header.tenantId,requestId);
      need(keys.has(body.keyId),'COLD_FIELD_HISTORY_KEY_MISSING');issuances.push({body,auditEventId:audit.eventId,registryEventId:audit.metadata.registryEventId});
    }
    if(audit.objectType!=='FIELD_EVENT'||!['FIELD_EVENT_STORED','FIELD_EVENT_REJECTED'].includes(audit.action))continue;
    need(audit.metadata?.format===fieldMapReceiptFormatV1,'COLD_FIELD_HISTORY_EVENT');const event=audit.metadata.envelope,key=keys.get(event?.lease?.body?.keyId);need(key,'COLD_FIELD_HISTORY_KEY_MISSING');
    const receipt=lookup('receipt',fieldMapReceiptKeyV1(event));need(receipt,'COLD_FIELD_HISTORY_RECEIPT_MISSING');
    const storage=fieldMapStorageV1(audit.metadata.storage);need(storage.tenantId===header.tenantId,'COLD_FIELD_HISTORY_STORAGE');
    const checked=await inspectFieldMapReceiptV1(snapshot,receipt,key,storage);
    need(checked.audit.eventId===audit.eventId&&same(checked.event,event)&&audit.action==='FIELD_EVENT_'+checked.receipt.status,'COLD_FIELD_HISTORY_RECEIPT');
    const id=fieldMapReceiptKeyV1(checked.event);need(!eventIds.has(id),'COLD_FIELD_HISTORY_DUPLICATE');eventIds.add(id);
    const point=checked.receipt.status==='STORED'?lookup('blob',fieldMapPointKeyV1(checked.event.eventId)):null;
    const value={event:checked.event,receipt:checked.receipt,point,storage};projectedBytes+=Buffer.byteLength(canonical(value));need(events.length<200000&&projectedBytes<=256*1024**2,'COLD_FIELD_HISTORY_LIMIT');events.push(value);
  }
  need(issuances.length===fieldLeaseHistoryCount,'COLD_FIELD_HISTORY_ISSUANCE_COVERAGE');
  const registries=payload.audits.filter(audit=>audit.objectType==='FIELD_REGISTRY').map(audit=>({auditEventId:audit.eventId,snapshot:fieldRegistrySnapshot(audit.after)}));need(String(registries.length)===fieldSourceFacts.registryHistoryCount,'COLD_FIELD_HISTORY_REGISTRY_COVERAGE');
  const fieldHistory={format:'COLD_FIELD_AUTHENTICATED_SOURCE_HISTORY_V1',tenantId:header.tenantId,head:header.head,factsSha256,issuances,registries,events,entireRootAndAuditedPayloadVerified:true,allHistoricalStoredAndRejectedReceiptsAndPointsVerified:true,currentTargetSqlCommitProven:false,currentHeldSessionVerified:false,completeFieldMaterialsVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false};
  return {fieldSourceFacts,fieldHistory,toJSON(){need(false,'COLD_FIELD_HISTORY_PRIVATE_ONLY');},format:'FIELD_MAP_FULL_SOURCE_HISTORY_VERIFIED_V1',tenantId:header.tenantId,head:header.head,factsSha256,nodes,leaves,receiptRows,auditEvents:payload.audits.length,entireCurrentRootIndependentlyRebuilt:true,fullDomainPayloadIndependentlyReconstructed:true,relationDigestsAuthenticatedFromCapturedFacts:true,sqlRelationRowsIndependentlyRecomputedOffline:false,currentOidcApprovalVerified:false,formalFieldActivationGranted:false};
 }catch(e){problem=e;throw e;}finally{try{const terminal=!stream||stream.closed?Promise.resolve():new Promise(ok=>stream.once('close',ok));lines?.close();stream?.destroy();await terminal;db?.close();need(dirname(resolve(cache))===work,'FIELD_FULL_EVIDENCE_CACHE');await unlink(cache);}catch(e){if(problem)problem.evidenceCleanupUnproven=true;else throw e;}}
}
