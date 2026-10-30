import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {seedStore} from '../../server/store.ts';
import {tenantPayload} from '../../server/entity-repository.ts';
import {encodeDomainEntities,reconstructDomainPayload} from '../../server/domain-entities-v4.ts';
import {appendAudit} from '../../server/audit.ts';
import {canonical} from '../../server/imports.ts';
import {canonicalDigest} from '../../server/canonical-state.ts';
import {stateKey,stateValueText,stateValueHash,stateLeaf,stateBranch,stateRoot,stateCommonPrefix,stateBit,stateReceiptHash,stateEmptyHashes,parseStateValueText} from '../../server/state-map-v1.ts';
import {AuthAuditCryptoV4,authAuditFormatV4} from '../../server/auth-audit-event-v4.ts';
import {auditPositionKey} from '../../server/telemetry-map-v4.ts';
import {privateDirectory,privateNewFile} from '../../scripts/backup-support.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),hash=value=>sha(canonical(value));

/** Coherent offline data only: no original recovery session, SQL source, ACK or runtime capability. */
export async function coldAuthAuditMapEvidenceFixtureV1(workDirectory,tenantId='acme',options={}){
 const directory=join(workDirectory,'map-data-'+randomUUID());await privateDirectory(directory);
 const store=seedStore(),{audits,idempotency,...business}=store,payload=tenantPayload({version:2,business,audits,idempotency:[...idempotency],imports:{batches:[],records:[],requests:[]}},tenantId);
 const source={deployment:'a'.repeat(64),databaseOid:'39001',scope:'b'.repeat(64)},target={tenantId,databaseOid:'39002',catalogHash:'c'.repeat(64)},sourceKey=canonicalDigest(source),crypto=new AuthAuditCryptoV4({format:1,activeKeyId:'offline-unit-only',keys:[{keyId:'offline-unit-only',key:Buffer.alloc(32,23).toString('base64url')}]},source);
 const entries=new Map(),set=(namespace,key,value)=>entries.set(stateKey(tenantId,namespace,key),stateValueText(value));
 appendAudit(payload,{tenantId,objectType:'AUTHENTICATION',objectId:'legacy-'+tenantId,action:'AUTH_LOGIN',actorType:'USER',actorId:'legacy-'+tenantId,correlationId:randomUUID(),metadata:{authMode:'oidc',roles:['OPERATOR']}});
 let previous='0'.repeat(64),last;
 function metadata(event){return{authMode:'oidc',roles:event.payload.roles,reason:event.payload.reason,occurredAt:new Date(Number(event.header.occurredAtMs)).toISOString(),authenticationEvent:{format:authAuditFormatV4,source:sourceKey,eventId:event.header.eventId,position:event.header.position,previousHash:event.header.previousHash,chainHash:event.header.chainHash,digest:event.header.digest,sessionRef:event.header.sessionRef}};}
 for(let position=1;position<=2;position++){
  const event=crypto.event({scope:source.scope,tenantId,eventId:randomUUID(),position:String(position),action:position===1?'AUTH_LOGIN':'AUTH_LOGOUT',occurredAtMs:String(1700000000000+position),previousHash:previous},'d'.repeat(64),'actor-'+tenantId,['OPERATOR']),m=metadata(event);if(position===1&&options.malformedMetadata)m.authenticationEvent=null;
  const audit=appendAudit(payload,{tenantId,objectType:'AUTHENTICATION',objectId:event.payload.actorId,action:event.header.action,actorType:'USER',actorId:event.payload.actorId,correlationId:event.header.eventId,metadata:m});
  const completion={format:authAuditFormatV4,tenantId,source:sourceKey,requestHash:canonicalDigest({source,event}),sourceEventId:event.header.eventId,sourcePosition:event.header.position,sourceChainHash:event.header.chainHash,auditEventId:audit.eventId,auditPosition:String(payload.audits.length),auditHash:audit.hash};
  const key=position===1&&options.wrongReceiptKey?'wrong-fixed-receipt-key':'auth_audit:'+canonicalDigest([sourceKey,event.header.eventId]);set('receipt',key,completion);previous=event.header.chainHash;last=event;
 }
 set('domain_head','auth_audit:'+sourceKey,{format:authAuditFormatV4,tenantId,source:sourceKey,position:last.header.position,chainHash:last.header.chainHash,eventId:last.header.eventId});
 for(const entry of encodeDomainEntities(payload,tenantId))entries.set(stateKey(tenantId,entry.namespace,entry.key),entry.valueText);
 for(let i=0;i<payload.audits.length;i++){const audit=payload.audits[i];set('audit',audit.eventId,audit);set('audit_order',auditPositionKey(String(i+1)),{tenantId,position:String(i+1),eventId:audit.eventId});}
 set('domain_head','audit',{tenantId,count:String(payload.audits.length),eventId:payload.audits.at(-1)?.eventId??null,hash:payload.audits.at(-1)?.hash??'GENESIS'});
 if(options.orphanAudit){const event=crypto.event({scope:source.scope,tenantId,eventId:randomUUID(),position:'3',action:'AUTH_LOGIN',occurredAtMs:'1700000000003',previousHash:previous},'d'.repeat(64),'orphan-actor',['OPERATOR']),audit=appendAudit({audits:[]},{tenantId,objectType:'AUTHENTICATION',objectId:event.payload.actorId,action:event.header.action,actorType:'USER',actorId:event.payload.actorId,correlationId:event.header.eventId,metadata:metadata(event)});set('audit',audit.eventId,audit);}
 const leafPairs=[...entries].sort(([a],[b])=>a.localeCompare(b)),nodes=[];function build(pairs){if(pairs.length===1){const [key,text]=pairs[0],node=stateLeaf(key,stateValueHash(text));nodes.push({type:'NODE',node,valueText:text});return node;}const depth=stateCommonPrefix(pairs[0][0],pairs.at(-1)[0]);let split=0;while(split<pairs.length&&stateBit(pairs[split][0],depth)===0)split++;if(split===0||split===pairs.length)throw Error('OFFLINE_UNIT_TREE_SPLIT');const left=build(pairs.slice(0,split)),right=build(pairs.slice(split)),node=stateBranch(depth,left,right);nodes.push({type:'NODE',node,valueText:null});return node;}
 const root=stateRoot(build(leafPairs)),receipt={tenantId,commandId:randomUUID(),requestHash:'e'.repeat(64),beforeRevision:'0',beforeRoot:stateEmptyHashes[0],beforeReceiptHash:'0'.repeat(64),revision:'1',rootId:root.rootId,rootHash:root.rootHash,count:root.count,replayed:false};receipt.receiptHash=stateReceiptHash(receipt);
 const head={revision:'1',rootId:root.rootId,rootHash:root.rootHash,count:root.count,receiptHash:receipt.receiptHash},header={type:'HEADER',format:'FIELD_MAP_FULL_FACTS_EVIDENCE_V1',tenantId,profileSha256:'f'.repeat(64),head};
 let lookups=0;const reconstructed=await reconstructDomainPayload(tenantId,async(namespace,key)=>{lookups++;const value=entries.get(stateKey(tenantId,namespace,key));if(value===undefined)throw Error('OFFLINE_UNIT_MISSING_DOMAIN');return parseStateValueText(value);});
 const lines=[header,...nodes,{type:'RECEIPT',value:receipt}].map(value=>canonical(value)+'\n'),prefix=lines.join(''),body={format:'FIELD_MAP_FULL_FACTS_V1',tenantId,profileSha256:header.profileSha256,head,nodes:nodes.length,leaves:leafPairs.length,valueBytes:leafPairs.reduce((n,[,text])=>n+Buffer.byteLength(text),0),lookups,receiptRows:1,relations:[],sqlBytes:0,payloadSha256:hash(reconstructed),auditSha256:hash(reconstructed.audits),auditEvents:reconstructed.audits.length,evidencePrefixSha256:sha(prefix),entireCurrentRootVerified:true,allSqlReceiptsVerified:true,fullDomainPayloadReconstructed:true,currentOidcApprovalVerified:false,formalFieldActivationGranted:false},facts={...body,factsSha256:hash(body)},bytes=Buffer.from(prefix+canonical({type:'COMPLETE',facts})+'\n'),file=join(directory,'map.private.jsonl');await privateNewFile(file,bytes);
 return{map:{tenantId,facts,evidenceFile:file,evidenceSha256:sha(bytes)},target,workDirectory:directory};
}
