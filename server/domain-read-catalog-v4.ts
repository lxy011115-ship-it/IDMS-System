import {canonicalDigest} from './canonical-state.ts';
import {effectiveRecords} from './import-revisions.ts';
import {validateTenantPayload,type TenantPayload} from './entity-repository.ts';
import {encodeLegacyText,type LegacyEntry} from './legacy-map-v4.ts';
import {stateValueText} from './state-map-v1.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
export const readCatalogFormat='IDMS_DOMAIN_READ_CATALOG_V4_1';
export interface DomainReadCatalogV4 {format:typeof readCatalogFormat;tenantId:string;governanceAnchorDigest:string;generation:string;assetsCount:number;legacyCount:number}
export const readAssetKey=(generation:string,code:string)=>'v4read:'+generation+':asset:'+canonicalDigest(code);
export const readAssetOrderKey=(generation:string,position:number)=>'v4read:'+generation+':order:'+String(position).padStart(20,'0');
export interface DomainReadAssetV4 {tenantId:string;deviceCode:string;kind:'APPROVED_IMPORT'|'LEGACY';scope:{device_code:string;site_code?:unknown;line_code?:unknown};record:unknown}
/** One-off full validation; never used by an HTTP request. */
export function compileDomainReadCatalogV4(payload:TenantPayload,tenantId:string,governanceAnchorDigest:string){
 validateTenantPayload(payload,tenantId);need(/^[a-f0-9]{64}$/.test(governanceAnchorDigest));
 const assets=new Map<string,DomainReadAssetV4>(),legacy=new Map<string,DomainReadAssetV4>(),clean=(value:DomainReadAssetV4):DomainReadAssetV4=>JSON.parse(JSON.stringify(value));
 for(const r of effectiveRecords(payload.imports))if(r.tenantId===tenantId&&r.dataType==='DEVICE'){
  const deviceCode=String(r.value.device_code);need(deviceCode.length>0&&deviceCode.length<=128);
  assets.set(deviceCode,clean({tenantId,deviceCode,kind:'APPROVED_IMPORT',scope:{device_code:deviceCode,site_code:r.value.site_code,line_code:r.value.line_code},record:r}));
 }
 for(const d of payload.business.devices)if(!assets.has(d.code))legacy.set(d.code,clean({tenantId,deviceCode:d.code,kind:'LEGACY',scope:{device_code:d.code,line_code:d.line},record:d}));
 const ordered=[...assets.values()].sort((a,b)=>a.deviceCode<b.deviceCode?-1:a.deviceCode>b.deviceCode?1:0),fallback=[...legacy.values()].sort((a,b)=>a.deviceCode<b.deviceCode?-1:a.deviceCode>b.deviceCode?1:0),generation=canonicalDigest({tenantId,governanceAnchorDigest,assets:ordered,legacy:fallback}),entries:LegacyEntry[]=[];
 for(const row of [...ordered,...fallback])entries.push(...encodeLegacyText('blob',readAssetKey(generation,row.deviceCode),JSON.stringify(row)));
 ordered.forEach((row,i)=>entries.push({namespace:'blob',key:readAssetOrderKey(generation,i+1),valueText:stateValueText({tenantId,generation,position:i+1,deviceCode:row.deviceCode})}));
 const head:DomainReadCatalogV4={format:readCatalogFormat,tenantId,governanceAnchorDigest,generation,assetsCount:ordered.length,legacyCount:fallback.length};
 return {head,entries,assets:ordered};
}
