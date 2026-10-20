import pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {PostgresStateMapV1} from '../server/state-map-sql-v1.ts';
import {inspectStateMapCatalog} from '../server/state-map-catalog-v1.ts';
import {stateKey,stateValueHash,stateValueText,verifyStateProof,rebuildStateRoot} from '../server/state-map-v1.ts';
import {decodeLegacyPayload,decodeLegacyText,legacySqlRowKey} from '../server/legacy-map-v4.ts';
import {canonicalDigest,canonicalEqual} from '../server/canonical-state.ts';
const need=(ok,code)=>{if(!ok)throw Error(code);};
const rootOf=h=>({rootId:h.rootId,rootHash:h.rootHash,count:h.count});
export class LegacyV4MapBuilder{
 constructor(account,binding){this.client=new PostgresStateMapV1(account,binding);this.tenantId=binding.tenantId;this.entries=new Map();this.pending=[];this.bytes=0;this.head=null;}
 async begin(){this.head=await this.client.head();need(this.head.revision==='0'&&this.head.count==='0','LEGACY_V4_TARGET_NOT_EMPTY');}
 async accept(entry){
  need(this.head,'LEGACY_V4_BUILDER_NOT_STARTED');const k=stateKey(this.tenantId,entry.namespace,entry.key),h=stateValueHash(entry.valueText),prior=this.entries.get(k);
  if(prior){need(prior===h,'LEGACY_V4_DUPLICATE_DIFFERENT_VALUE');return;}
  const bytes=Buffer.byteLength(entry.valueText);if(this.pending.length>=32||this.bytes+bytes>4*1024*1024)await this.flush();
  this.entries.set(k,h);this.pending.push({...entry,expected:null});this.bytes+=bytes;
 }
 async flush(){if(!this.pending.length)return;const cmd={tenantId:this.tenantId,commandId:randomUUID(),expectedRevision:this.head.revision,expectedRoot:this.head.rootHash,operations:this.pending},r=await this.client.apply(cmd);this.head={revision:r.revision,rootId:r.rootId,rootHash:r.rootHash,count:r.count,receiptHash:r.receiptHash};need(canonicalEqual(rootOf(this.head),rebuildStateRoot(this.entries)),'LEGACY_V4_BUILDER_ROOT');this.pending=[];this.bytes=0;}
 async finish(){await this.flush();return {...this.head};}
}
/** Bounded proof reads under one read-only snapshot and one trusted external root. */
export async function verifyLegacyV4Map(account,binding,trustedHead,manifest){
 const c=new pg.Client(account);c.on('error',()=>{});const seen=new Map(),trustedRoot=rootOf(trustedHead);await c.connect();
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const identity=(await c.query("SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS db,session_user::regrole::oid::text AS role")).rows[0];need(identity.db===binding.databaseOid&&identity.role===binding.roleOid,'LEGACY_V4_TARGET_BINDING');need(await inspectStateMapCatalog(c)===binding.catalogHash,'LEGACY_V4_TARGET_CATALOG');
  const head=(await c.query('SELECT state_map_v1.read_head_v1($1) AS value',[binding.tenantId])).rows[0].value;need(canonicalEqual(head,trustedHead),'LEGACY_V4_TARGET_HEAD');
  const get=async(namespace,key)=>{const k=stateKey(binding.tenantId,namespace,key),proof=(await c.query('SELECT state_map_v1.read_proof_v1($1,$2,$3) AS value',[binding.tenantId,Buffer.from(k,'hex'),trustedRoot.rootId===null?null:Buffer.from(trustedRoot.rootId,'hex')])).rows[0].value,result=verifyStateProof(proof,trustedRoot,k);need(result.present,'LEGACY_V4_TARGET_MISSING');seen.set(k,result.valueHash);return result.value;};
  need(canonicalEqual(await get('legacy_meta','source'),manifest),'LEGACY_V4_TARGET_MANIFEST');
  const payload=await decodeLegacyPayload(binding.tenantId,get);need(canonicalDigest(payload)===manifest.root.payload_digest,'LEGACY_V4_TARGET_PAYLOAD');
  const facts=[];for(const f of manifest.tableFacts){const h=createHash('sha256');for(let i=0;i<f.rows;i++){const text=await decodeLegacyText('legacy_sql',legacySqlRowKey(f.table,i+1),get);h.update(text+'\n');}const sha256=h.digest('hex');need(sha256===f.sha256,'LEGACY_V4_TARGET_SQL_FACTS');facts.push({table:f.table,rows:f.rows,sha256});}
  need(canonicalEqual(rebuildStateRoot(seen),trustedRoot),'LEGACY_V4_TARGET_UNVISITED_OR_CHANGED');
  need(await inspectStateMapCatalog(c)===binding.catalogHash,'LEGACY_V4_TARGET_CATALOG');await c.query('COMMIT');
  return {format:'IDMS_LEGACY_V4_MAP_VERIFICATION_V1',tenantId:binding.tenantId,root:trustedRoot,entries:seen.size,allEntriesIndividuallyProven:true,independentFullRootEqual:true,payloadCanonicalDigest:canonicalDigest(payload),allLegacyPayloadCollectionsReconstructed:true,files:payload.imports.batches.map(b=>({batchId:b.batchId,sha256:b.fileSha256,bytes:Buffer.from(b.originalBase64,'base64').length})),facts};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end().catch(()=>{});}
}
export async function sealLegacyV4Map(account,binding,trustedHead,manifest,fence,verification){
 need(manifest.operationId===fence.operationId&&manifest.tenantId===binding.tenantId&&verification.tenantId===binding.tenantId&&canonicalEqual(verification.root,rootOf(trustedHead))&&verification.independentFullRootEqual&&verification.allEntriesIndividuallyProven&&fence.oldRuntimeTableAndColumnDmlRevoked&&fence.oldDataRootUnchanged,'LEGACY_V4_SEAL_PRECONDITION');
 const value={format:'IDMS_LEGACY_V4_SEAL_V1',operationId:manifest.operationId,tenantId:binding.tenantId,source:manifest.source,legacyManifestHash:canonicalDigest(manifest),legacyCanonicalDigest:manifest.root.payload_digest,sourceFence:fence,verifiedImportRoot:rootOf(trustedHead),verificationHash:canonicalDigest(verification),businessFormatActivated:false},client=new PostgresStateMapV1(account,binding),command={tenantId:binding.tenantId,commandId:manifest.operationId,expectedRevision:trustedHead.revision,expectedRoot:trustedHead.rootHash,operations:[{namespace:'receipt',key:'legacy_v3_seal:'+manifest.operationId,expected:null,valueText:stateValueText(value)}]};
 const receipt=await client.apply(command);return {value,command,receipt};
}
