import {randomUUID} from 'node:crypto';
import {DomainMapV4,DomainMapSnapshot,domainMapAssert as need} from '../server/domain-map-v4.ts';
import {reconstructDomainPayload} from '../server/domain-entities-v4.ts';
import {compileDomainReadCatalogV4} from '../server/domain-read-catalog-v4.ts';
import {canonicalEqual} from '../server/canonical-state.ts';
import {telemetryDomainFormat} from '../server/telemetry-map-v4.ts';
/** Immutable preparation is invisible until one final CAS publishes the catalog. */
export async function activateDomainReadCatalogV4(account,binding){
 const store=new DomainMapV4(account,binding),source=await DomainMapSnapshot.open(account,binding,{maintenance:true});let compiled,anchor;
 try{const c=await source.get('domain_head','control');need(c.format===telemetryDomainFormat&&c.tenantId===binding.tenantId&&c.status==='ACTIVE','READ_ACTIVATION_NOT_ACTIVE');anchor=c.governanceAnchorDigest;compiled=compileDomainReadCatalogV4(await reconstructDomainPayload(binding.tenantId,(ns,k)=>source.get(ns,k)),binding.tenantId,anchor);}finally{await source.close();}
 async function commitBatch(entries,headValue){
  for(let attempt=0;;attempt++){
   const s=await store.snapshot();let ops=[];
   try{const c=await s.get('domain_head','control');need(c.status==='ACTIVE'&&c.governanceAnchorDigest===anchor,'READ_ACTIVATION_CHANGED');for(const e of entries){const old=await s.state(e.namespace,e.key);if(old.present){need(canonicalEqual(old.value,JSON.parse(e.valueText)),'READ_ACTIVATION_CONTENT_CONFLICT');continue;}ops.push({...e,expected:null});}if(headValue)ops.push(await s.operation('domain_head','read_catalog',headValue));}finally{await s.close();}
   if(!ops.length)return;
   try{await store.commit(s.head,randomUUID(),ops);return;}catch(e){if(attempt<7&&/STATE_MAP_(CAS|KEY)_CONFLICT/.test(e.message))continue;throw e;}
  }
 }
 let batch=[],bytes=0;for(const entry of compiled.entries){const size=Buffer.byteLength(entry.valueText)+Buffer.byteLength(entry.key)+256;if(batch.length&&(batch.length===24||bytes+size>4*1024*1024)){await commitBatch(batch);batch=[];bytes=0;}batch.push(entry);bytes+=size;}if(batch.length)await commitBatch(batch);
 const verify=await DomainMapSnapshot.open(account,binding,{maintenance:true});try{const c=await verify.get('domain_head','control');need(c.status==='ACTIVE'&&c.governanceAnchorDigest===anchor,'READ_ACTIVATION_CHANGED');for(const e of compiled.entries)need(canonicalEqual(await verify.get(e.namespace,e.key),JSON.parse(e.valueText)),'READ_ACTIVATION_INCOMPLETE');}finally{await verify.close();}
 await commitBatch([],compiled.head);
 return {head:compiled.head,immutableEntries:compiled.entries.length,allEntriesIndependentlyReadBeforeCatalogExposure:true,originalRuntimeMigrated:false};
}
