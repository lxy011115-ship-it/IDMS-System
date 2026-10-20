import {randomUUID,createHash} from 'node:crypto';
import {decodeLegacyText,legacySqlRowKey} from '../server/legacy-map-v4.ts';
import {canonicalDigest} from '../server/canonical-state.ts';
import {DomainMapV4,DomainMapSnapshot,domainMapAssert as need} from '../server/domain-map-v4.ts';
import {reconstructDomainPayload} from '../server/domain-entities-v4.ts';
import {compileMaintenanceLinksV4} from '../server/maintenance-map-index-v4.ts';
import {maintenanceFormatV4} from '../server/maintenance-map-common-v4.ts';
import {canonicalEqual} from '../server/canonical-state.ts';
export async function verifyMaintenanceLegacyOutboxV4(snapshot){
 const control=await snapshot.get('domain_head','control'),manifest=await snapshot.get('legacy_meta','source'),seal=await snapshot.get('receipt',control.legacySealKey);need(manifest.tenantId===snapshot.tenantId&&manifest.format==='IDMS_LEGACY_V3_CAPTURE_V1'&&seal.legacyManifestHash===canonicalDigest(manifest),'MAINTENANCE_LEGACY_SEAL');const fact=manifest.tableFacts.find(f=>f.table==='workflow_outbox');need(fact&&Number.isSafeInteger(fact.rows)&&fact.rows>=0&&fact.rows<=1000000,'MAINTENANCE_LEGACY_OUTBOX_FACTS');const hash=createHash('sha256');let unresolved=false;
 for(let i=1;i<=fact.rows;i++){const text=await decodeLegacyText('legacy_sql',legacySqlRowKey('workflow_outbox',i),(ns,k)=>snapshot.get(ns,k));hash.update(text+'\n');const row=JSON.parse(text);need(typeof row.command_id==='string'&&typeof row.status==='string','MAINTENANCE_LEGACY_OUTBOX_ROW');if(row.status!=='SYNCED')unresolved=true;}need(hash.digest('hex')===fact.sha256,'MAINTENANCE_LEGACY_OUTBOX_DIGEST');need(!unresolved,'MAINTENANCE_LEGACY_OUTBOX_UNRESOLVED');return {rows:fact.rows,sha256:fact.sha256};
}
/** Explicit one-time trusted initialization. No public HTTP or original SQL writes. */
export async function activateMaintenanceMapV4(account,binding){
 const store=new DomainMapV4(account,binding),initial=await DomainMapSnapshot.open(account,binding,{maintenance:true});let links;
 try{need((await initial.get('domain_head','control')).status==='ACTIVE');await verifyMaintenanceLegacyOutboxV4(initial);links=compileMaintenanceLinksV4(await reconstructDomainPayload(binding.tenantId,(ns,k)=>initial.get(ns,k)),binding.tenantId);}finally{await initial.close();}
 for(let at=0;at<links.length;at+=24){for(let attempt=0;;attempt++){const s=await store.snapshot();let ops=[];try{need((await s.get('domain_head','control')).status==='ACTIVE','MAINTENANCE_ACTIVATION_FENCED');for(const link of links.slice(at,at+24)){const p=await s.state('maintenance_link',link.orderId);if(p.present)need(canonicalEqual(p.value,link),'MAINTENANCE_LINK_CHANGED');else ops.push(await s.operation('maintenance_link',link.orderId,link));}}finally{await s.close();}try{if(ops.length)await store.commit(s.head,randomUUID(),ops);break;}catch(e){if(attempt<7&&/STATE_MAP_(CAS|KEY)_CONFLICT/.test(e.message))continue;throw e;}}}
 // A full fresh view prevents exposing relations compiled from a drifting snapshot.
 for(let attempt=0;;attempt++){const s=await DomainMapSnapshot.open(account,binding,{maintenance:true});let ops=[];try{need((await s.get('domain_head','control')).status==='ACTIVE');need(canonicalEqual(links,compileMaintenanceLinksV4(await reconstructDomainPayload(binding.tenantId,(ns,k)=>s.get(ns,k)),binding.tenantId)),'MAINTENANCE_ACTIVATION_CHANGED');for(const link of links)need(canonicalEqual(await s.get('maintenance_link',link.orderId),link));const marker={format:maintenanceFormatV4,tenantId:binding.tenantId},old=await s.state('domain_head','maintenance');if(old.present)need(canonicalEqual(old.value,marker));else ops.push(await s.operation('domain_head','maintenance',marker));}finally{await s.close();}try{if(ops.length)await store.commit(s.head,randomUUID(),ops);break;}catch(e){if(attempt<7&&/STATE_MAP_(CAS|KEY)_CONFLICT/.test(e.message))continue;throw e;}}
 return {orders:links.length,fullPayloadValidatedBeforeExposure:true};
}
