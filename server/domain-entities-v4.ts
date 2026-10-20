import {canonicalDigest} from './canonical-state.ts';
import {entityTables} from './entity-schema.ts';
import {validateTenantPayload,type TenantPayload} from './entity-repository.ts';
import {encodeLegacyText,decodeLegacyText,legacyJsonText,type LegacyEntry,type LegacyLookup} from './legacy-map-v4.ts';
import {stateValueText} from './state-map-v1.ts';
import {AuditChainVerifier} from './audit.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {auditPositionKey,type DomainAuditHead} from './telemetry-map-v4.ts';
import type {AuditEvent} from './domain.ts';
export const domainCollections=[...Object.keys(entityTables).sort().map(k=>'business/'+k),'imports/batches','imports/records','imports/requests','idempotency'];
export function domainEntityKey(collection:string,row:any){
 need(domainCollections.includes(collection));const identity=collection.startsWith('business/')?row.id:collection==='imports/batches'?row.batchId:collection==='imports/records'?[row.tenantId,row.sourceSystem,row.dataType,row.value.source_record_id]:collection==='imports/requests'?row.key:row[0];need(identity!==undefined);return collection+':'+canonicalDigest(identity);
}
function rowsFor(payload:TenantPayload,collection:string):unknown[]{if(collection.startsWith('business/'))return (payload.business as any)[collection.slice(9)];if(collection.startsWith('imports/'))return (payload.imports as any)[collection.slice(8)];return payload.idempotency;}
export function domainOrderKey(collection:string,position:string){need(domainCollections.includes(collection));return collection+':'+auditPositionKey(position);}
export function* encodeDomainEntities(payload:TenantPayload,tenantId:string):Generator<LegacyEntry>{
 validateTenantPayload(payload,tenantId);
 for(const collection of domainCollections){const rows=rowsFor(payload,collection),seen=new Set<string>();for(let i=0;i<rows.length;i++){const key=domainEntityKey(collection,rows[i]);need(!seen.has(key),'DOMAIN_ENTITY_DUPLICATE');seen.add(key);yield* encodeLegacyText('v4_entity',key,legacyJsonText(rows[i]));yield {namespace:'v4_order',key:domainOrderKey(collection,String(i+1)),valueText:stateValueText({tenantId,collection,position:String(i+1),entityKey:key})};}yield {namespace:'v4_collection',key:collection,valueText:stateValueText({tenantId,collection,count:String(rows.length)})};}
}
export async function reconstructDomainPayload(tenantId:string,get:LegacyLookup){
 const payload={business:Object.fromEntries(Object.keys(entityTables).map(k=>[k,[]])),imports:{batches:[],records:[],requests:[]},audits:[],idempotency:[]} as unknown as TenantPayload;
 for(const collection of domainCollections){const head=await get('v4_collection',collection) as {tenantId:string;collection:string;count:string};need(head.tenantId===tenantId&&head.collection===collection&&/^(0|[1-9][0-9]{0,6})$/.test(head.count)&&BigInt(head.count)<=1000000n);const rows=rowsFor(payload,collection),seen=new Set<string>();for(let i=0;i<Number(head.count);i++){const position=String(i+1),order=await get('v4_order',domainOrderKey(collection,position)) as {tenantId:string;collection:string;position:string;entityKey:string};need(order.tenantId===tenantId&&order.collection===collection&&order.position===position&&!seen.has(order.entityKey));seen.add(order.entityKey);const row=JSON.parse(await decodeLegacyText('v4_entity',order.entityKey,get));need(domainEntityKey(collection,row)===order.entityKey);rows.push(row as never);}}
 const h=await get('domain_head','audit') as DomainAuditHead;need(h.tenantId===tenantId&&/^(0|[1-9][0-9]{0,6})$/.test(h.count)&&BigInt(h.count)<=1000000n);const chain=new AuditChainVerifier(tenantId);for(let i=0;i<Number(h.count);i++){const position=String(i+1),order=await get('audit_order',auditPositionKey(position)) as {tenantId:string;position:string;eventId:string};need(order.tenantId===tenantId&&order.position===position);const a=await get('audit',order.eventId) as AuditEvent;need(a.eventId===order.eventId&&chain.accept(a),'DOMAIN_AUDIT_CHAIN');payload.audits.push(a);}need(chain.tip===h.hash&&(payload.audits.at(-1)?.eventId||null)===h.eventId);validateTenantPayload(payload,tenantId);return payload;
}
