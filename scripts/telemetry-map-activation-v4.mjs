import {createHash,randomUUID} from 'node:crypto';
import {DomainMapSnapshot,DomainMapV4,domainMapAssert as need} from '../server/domain-map-v4.ts';
import {decodeLegacyPayload,decodeLegacyText,legacySqlRowKey,encodeLegacyText,legacyJsonText} from '../server/legacy-map-v4.ts';
import {encodeDomainEntities,reconstructDomainPayload} from '../server/domain-entities-v4.ts';
import {compileGovernanceMap} from '../server/source-governance-map-v4.ts';
import {canonicalDigest,canonicalEqual} from '../server/canonical-state.ts';
import {stateKey,stateValueHash,stateValueText,rebuildStateRoot} from '../server/state-map-v1.ts';
import {telemetryDomainFormat,telemetryReceiptKey,telemetryEventKey,telemetrySequenceKey,telemetryTimeKey,telemetryPointKey,auditPositionKey,verifyLocalDomainAudit} from '../server/telemetry-map-v4.ts';
import {sourceGovernanceDecision} from '../server/source-governance.ts';
import {verifySourceReceipt,verifySourcePoint} from '../server/source-receipt-integrity.ts';
import {RegistryChain,publicRegistry,registryObservation} from '../server/registry-history.ts';
const rawRoot=h=>({rootId:h.rootId,rootHash:h.rootHash,count:h.count}),clean=x=>JSON.parse(JSON.stringify(x));
export class DomainMapInstaller {
 constructor(store,head,known){this.store=store;this.head=head;this.known=new Map(known);this.pending=[];this.bytes=0;}
 async accept(e,replace=false){const key=stateKey(this.store.tenantId,e.namespace,e.key),hash=stateValueHash(e.valueText),old=this.known.get(key);if(old===hash)return;if(old&&!replace)throw Error('DOMAIN_INSTALL_EXISTING_KEY');const bytes=Buffer.byteLength(e.valueText);if(this.pending.length>=32||this.bytes+bytes>4*1024*1024)await this.flush();this.known.set(key,hash);this.pending.push({...e,expected:old||null});this.bytes+=bytes;}
 async flush(){if(!this.pending.length)return;const r=await this.store.commit(this.head,randomUUID(),this.pending);this.head={revision:r.revision,rootId:r.rootId,rootHash:r.rootHash,count:r.count,receiptHash:r.receiptHash};need(canonicalEqual(rawRoot(this.head),rebuildStateRoot(this.known)),'DOMAIN_INSTALL_ROOT');this.pending=[];this.bytes=0;}
}
/** Only a maintenance caller with the accepted immutable legacy seal may activate. */
export async function activateTelemetryDomainV4({account,binding,sealKey,sources}){
 const store=new DomainMapV4(account,binding),snapshot=await DomainMapSnapshot.open(account,binding,{maintenance:true}),known=new Map();let payload,manifest,seal,head,sql={};
 const get=async(ns,key)=>{const r=await snapshot.state(ns,key);need(r.present,'DOMAIN_BOOTSTRAP_MISSING');known.set(stateKey(binding.tenantId,ns,key),r.valueHash);return r.value;};
 try{
  need(!(await snapshot.state('domain_head','control')).present,'DOMAIN_ALREADY_INITIALIZED');seal=await get('receipt',sealKey);need(seal.format==='IDMS_LEGACY_V4_SEAL_V1'&&seal.tenantId===binding.tenantId&&!seal.businessFormatActivated&&seal.sourceFence.oldRuntimeTableAndColumnDmlRevoked&&seal.sourceFence.oldDataRootUnchanged,'DOMAIN_LEGACY_SEAL');
  manifest=await get('legacy_meta','source');need(canonicalDigest(manifest)===seal.legacyManifestHash&&manifest.root.payload_digest===seal.legacyCanonicalDigest,'DOMAIN_LEGACY_MANIFEST');payload=await decodeLegacyPayload(binding.tenantId,get);
  for(const f of manifest.tableFacts){const hash=createHash('sha256');for(let i=0;i<f.rows;i++){const text=await decodeLegacyText('legacy_sql',legacySqlRowKey(f.table,i+1),get);hash.update(text+'\n');if(['telemetry_points','telemetry_receipts','registry_history'].includes(f.table))(sql[f.table]??=[]).push(JSON.parse(text));}need(hash.digest('hex')===f.sha256,'DOMAIN_LEGACY_SQL_FACTS');}
  need(canonicalEqual(rebuildStateRoot(known),rawRoot(snapshot.head)),'DOMAIN_UNEXPECTED_PREACTIVATION_DATA');head=snapshot.head;
 }finally{await snapshot.close();}
 const compiled=compileGovernanceMap(payload,binding.tenantId,sources),installer=new DomainMapInstaller(store,head,known),add=async(namespace,key,value)=>installer.accept({namespace,key,valueText:stateValueText(clean(value))}),control={format:telemetryDomainFormat,tenantId:binding.tenantId,status:'UPDATING',epoch:'1',legacySealKey:sealKey,governanceAnchorDigest:canonicalDigest(payload)};
 await add('domain_head','control',control);await installer.flush();
 for(const e of encodeDomainEntities(payload,binding.tenantId))await installer.accept(e);
 for(let i=0;i<payload.audits.length;i++){const a=verifyLocalDomainAudit(payload.audits[i],binding.tenantId);await add('audit',a.eventId,a);await add('audit_order',auditPositionKey(String(i+1)),{tenantId:binding.tenantId,position:String(i+1),eventId:a.eventId});}
 await add('domain_head','audit',{tenantId:binding.tenantId,count:String(payload.audits.length),eventId:payload.audits.at(-1)?.eventId||null,hash:payload.audits.at(-1)?.hash||'GENESIS'});
 for(const e of compiled.entries)await installer.accept(e);
 const points=new Map(),receipts=[],auditIndex=new Map();for(const a of payload.audits)if(a.objectType==='TELEMETRY_EVENT'&&['TELEMETRY_STORED','TELEMETRY_REJECTED'].includes(a.action)){const key=canonicalDigest([a.actorId,a.objectId,a.action,a.metadata.inputDigest]);need(!auditIndex.has(key),'DOMAIN_DUPLICATE_SOURCE_AUDIT');auditIndex.set(key,a);}
 for(const raw of sql.telemetry_points||[]){need(Number.isSafeInteger(raw.sequence_no)&&raw.sequence_no>0,'DOMAIN_SOURCE_POINT_SEQUENCE');const point={...raw,sequence_no:String(raw.sequence_no),event_time:new Date(raw.event_time).toISOString(),received_at:new Date(raw.received_at).toISOString()};need(!points.has(point.id),'DOMAIN_SOURCE_POINT_ID');points.set(point.id,point);await add('blob',telemetryPointKey(point.id),point);await add('telemetry_time',telemetryTimeKey(point.edge_id,point.device_code,point.tag_code,point.event_time),{pointId:point.id});}
 for(const raw of sql.telemetry_receipts||[]){need(raw.sequence_no===null||Number.isSafeInteger(raw.sequence_no),'DOMAIN_SOURCE_RECEIPT_SEQUENCE');const r={...raw,sequence_no:raw.sequence_no===null?null:String(raw.sequence_no),received_at:new Date(raw.received_at).toISOString()},a=auditIndex.get(canonicalDigest([r.edge_id,r.event_id,'TELEMETRY_'+r.status,r.digest]));need(a,'DOMAIN_SOURCE_RECEIPT_AUDIT');
  verifySourceReceipt(r,a,binding.tenantId,r.edge_id,(source,at,tag)=>sourceGovernanceDecision({...payload.business,audits:payload.audits},payload.imports,source,at,tag).binding);
  if(r.status==='STORED')verifySourcePoint(r,a,points.get(r.point_id),binding.tenantId,r.edge_id);
  const receiptKey=telemetryReceiptKey(r.edge_id,r.event_id,r.digest);receipts.push({r,a,receiptKey});await add('receipt',receiptKey,{format:telemetryDomainFormat,tenantId:binding.tenantId,receipt:r,auditEventId:a.eventId});
 }
 const eventKeys=new Set();for(const {r,receiptKey}of receipts){const key=telemetryEventKey(r.edge_id,r.event_id);if(!eventKeys.has(key)){eventKeys.add(key);await add('telemetry_event',key,{edgeId:r.edge_id,eventId:r.event_id,firstReceiptKey:receiptKey});}if(r.status==='STORED')await add('telemetry_sequence',telemetrySequenceKey(r.edge_id,r.sequence_no),{receiptKey});}
 for(const p of points.values()){const original=receipts.filter(({r})=>r.status==='STORED'&&r.edge_id===p.edge_id&&r.point_id===p.id&&r.event_id.toLowerCase()===p.id&&r.digest===p.input_digest);need(original.length===1,'DOMAIN_SOURCE_POINT_ORIGIN');await add('point_origin',p.id,{receiptKey:original[0].receiptKey});for(const {r,a}of receipts.filter(({r})=>r.point_id===p.id))verifySourcePoint(r,a,p,binding.tenantId,p.edge_id);}
 const registryRows=(sql.registry_history||[]).map(r=>({...r,revision:String(r.revision),observed_at:new Date(r.observed_at).toISOString()})).sort((a,b)=>BigInt(a.revision)<BigInt(b.revision)?-1:1),chain=new RegistryChain(binding.tenantId,Number.MAX_SAFE_INTEGER);for(const row of registryRows)chain.accept(row);chain.finish({tenant_id:binding.tenantId,count:String(registryRows.length),revision:String(registryRows.length),hash:registryRows.at(-1)?.hash||'GENESIS'});
 let last=registryRows.at(-1)||null;const observation=registryObservation(publicRegistry(sources,binding.tenantId),last,new Date().toISOString(),'v4-activation-'+randomUUID());if(observation){registryRows.push(observation);last=observation;}need(last,'DOMAIN_REGISTRY_REQUIRED');for(const row of registryRows)for(const e of encodeLegacyText('blob','registry_row:'+row.hash,legacyJsonText(row)))await installer.accept(e);
 await add('domain_head','registry',{tenantId:binding.tenantId,revision:last.revision,hash:last.hash,configurationHash:last.configuration_hash});await installer.flush();
 const check=await DomainMapSnapshot.open(account,binding,{maintenance:true});try{const rebuilt=await reconstructDomainPayload(binding.tenantId,(ns,k)=>check.get(ns,k));need(canonicalDigest(rebuilt)===canonicalDigest(payload),'DOMAIN_RECONSTRUCTED_PAYLOAD');}finally{await check.close();}
 await installer.accept({namespace:'domain_head',key:'control',valueText:stateValueText({...control,status:'ACTIVE'})},true);await installer.flush();
 return {store,head:installer.head,proof:{tenantId:binding.tenantId,allLegacySqlFactsRevalidated:true,fullPayloadAndAuditReconstructed:true,legacyAuditCount:payload.audits.length,legacyPoints:points.size,legacyReceipts:receipts.length,governanceConfigurations:compiled.heads.length,governanceBoundaryChecks:compiled.boundaryChecks,governanceDecisionDocuments:compiled.decisionDocuments,allInstallationRootsIndependentlyRebuilt:true,originalLegacyV3SourceStillFenced:true,allOtherBusinessHttpWritersEnabled:false}};
}
