import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import {DomainMapSnapshot,domainMapAssert as need} from './domain-map-v4.ts';
import {domainEntityKey} from './domain-entities-v4.ts';
import {decodeLegacyText} from './legacy-map-v4.ts';
import {readCatalogFormat,readAssetKey,type DomainReadAssetV4,type DomainReadCatalogV4} from './domain-read-catalog-v4.ts';
import {telemetryDomainFormat,type TelemetryDomainControl} from './telemetry-map-v4.ts';
import {domainReadAccessV4} from './domain-read-api-v4.ts';
import {governanceBasicAccessV4,type GovernanceCommandV4} from './governance-plan-v4.ts';
import {scopeAllows,scopeFilter,type AccessContext} from './access.ts';
import {templateContentDigest} from './catalog.ts';
import {validateManifest} from './template-schema.ts';
import {mapRows} from './import-mapping.ts';
import type {Row} from './imports.ts';
import type {TemplateVersion} from './domain.ts';
import {DomainError} from './service.ts';
/** Bounded by this command/batch and its devices; never reconstructs tenant history. */
export async function authorizeGovernanceJobV4(account:ClientConfig,binding:StateMapBinding,command:GovernanceCommandV4,ctx:AccessContext,result?:Record<string,unknown>|null,{cancel=false}:{cancel?:boolean}={}){
 if(cancel)domainReadAccessV4(ctx);else governanceBasicAccessV4(command,ctx);if(ctx.tenantId!==binding.tenantId)throw new DomainError(404,'GOVERNANCE_JOB_NOT_FOUND');const s=await DomainMapSnapshot.open(account,binding,{maintenance:true}),cache=new Map<string,unknown>();
 try{
  const get=async(namespace:string,key:string)=>{const id=namespace+'\0'+key;if(cache.has(id))return cache.get(id);const v=await s.get(namespace,key);need(s.stats.keys<=50000&&s.stats.valueBytes<=128*1024*1024,'GOVERNANCE_SCOPE_BUDGET');cache.set(id,v);return v;};
  const entity=async(collection:string,identity:unknown)=>JSON.parse(await decodeLegacyText('v4_entity',domainEntityKey(collection,identity),get));
  const tenant=await entity('business/tenants',{id:ctx.tenantId});if(tenant.id!==ctx.tenantId||tenant.status!=='ACTIVE')throw new DomainError(403,'GOVERNANCE_TENANT_INACTIVE');const control=await get('domain_head','control') as TelemetryDomainControl;need(control.format===telemetryDomainFormat&&control.tenantId===ctx.tenantId&&['ACTIVE','UPDATING','PAUSED'].includes(control.status),'GOVERNANCE_SCOPE_CONTROL');
  if(control.status==='UPDATING'){const pending=await get('domain_head','governance_job') as any;need(pending?.format==='IDMS_GOVERNANCE_COMMAND_V4_1'&&['FENCED','PLANNED'].includes(pending.phase),'GOVERNANCE_SCOPE_INITIALIZING');}
  const catalog=await get('domain_head','read_catalog') as DomainReadCatalogV4;need(catalog.format===readCatalogFormat&&catalog.tenantId===ctx.tenantId&&catalog.governanceAnchorDigest===control.governanceAnchorDigest,'GOVERNANCE_SCOPE_CATALOG');if(cancel)return {keys:s.stats.keys,valueBytes:s.stats.valueBytes};
  const unrestricted=Object.values(scopeFilter(ctx)).every(v=>v===null);
  const device=async(code:unknown,approved=false)=>{if(typeof code!=='string'||!code||code.length>128)throw new DomainError(403,'GOVERNANCE_DEVICE_SCOPE');if(unrestricted&&!approved)return;const key=readAssetKey(catalog.generation,code),row=JSON.parse(await decodeLegacyText('blob',key,get)) as DomainReadAssetV4;if(row.tenantId!==ctx.tenantId||row.deviceCode!==code||approved&&row.kind!=='APPROVED_IMPORT'||!scopeAllows(ctx,row.scope))throw new DomainError(403,'GOVERNANCE_DEVICE_SCOPE');};
  const manifest=async(raw:unknown)=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DomainError(400,'GOVERNANCE_MANIFEST');const m=raw as Record<string,any>,field:Record<string,string>={'field-channel-policy':'fieldChannelPolicy','telemetry-source-policy':'telemetrySourcePolicy','operation-calendar':'operationCalendar','calendar-schedule':'calendarSchedule','data-quality-policy':'dataQualityPolicy','operational-metric-policy':'operationalMetricPolicy'};if(field[m.purpose])await device(m[field[m.purpose]]?.deviceCode,true);};
  const rows=async(values:readonly any[],type:unknown)=>{if(unrestricted)return;const codes=new Set<string>();for(const row of values){if(type==='DEVICE'){if(!scopeAllows(ctx,row))throw new DomainError(403,'GOVERNANCE_DEVICE_SCOPE');}else codes.add(String(row.device_code||''));}if(codes.size>10000)throw new DomainError(413,'GOVERNANCE_SCOPE_SIZE');for(const code of codes)await device(code);};
  const batch=async(id:string)=>{const b=await entity('imports/batches',{batchId:id});if(b.tenantId!==ctx.tenantId)throw new DomainError(404,'GOVERNANCE_BATCH_SCOPE');if(!unrestricted&&!b.rows.length)throw new DomainError(404,'GOVERNANCE_BATCH_SCOPE');await rows(b.rows,b.dataType);if(b.correction)await rows(b.correction.baseRows.map((r:any)=>r.before),b.dataType);};
  if(command.action==='IMPORT_APPROVE')await batch(command.id||'');
  else if(command.action==='IMPORT_CREATE'){
   if(result?.batchId)await batch(String(result.batchId));else{let input=command.input.rows as Row[];if(!Array.isArray(input)||input.length>10000)throw new DomainError(400,'GOVERNANCE_IMPORT_ROWS');if(command.input.mappingRef){const ref=command.input.mappingRef as any,t=await entity('business/templates',{id:ref.templateId}) as TemplateVersion,m=validateManifest(t.manifest);if(t.tenantId!==ctx.tenantId||t.status!=='PUBLISHED'||t.version!==ref.version||t.contentDigest!==ref.contentDigest||t.contentDigest!==templateContentDigest(t)||m.purpose!=='import-mapping'||m.importMapping.dataType!==command.input.dataType||m.importMapping.sourceSystem!==command.input.sourceSystem)throw new DomainError(409,'GOVERNANCE_MAPPING_CHANGED');input=mapRows(structuredClone(input),command.input.sourceHeaders as string[],m.importMapping);}await rows(input,command.input.dataType);if(command.input.supersedesBatchId)await batch(String(command.input.supersedesBatchId));}
  }else{
   if(command.action!=='TEMPLATE_CREATE'||result?.id){const t=await entity('business/templates',{id:command.id||result?.id});if(t.tenantId!==ctx.tenantId)throw new DomainError(404,'GOVERNANCE_TEMPLATE_SCOPE');await manifest(t.manifest);}
   if(command.action==='TEMPLATE_CREATE'||command.action==='TEMPLATE_EDIT')await manifest(command.input.manifest);
  }
  return {keys:s.stats.keys,valueBytes:s.stats.valueBytes};
 }finally{await s.close();}
}
