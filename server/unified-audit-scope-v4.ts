import type {AccessContext} from './access.ts';
import {requiredScope,scopeAllows,scopeFilter} from './access.ts';
import type {AuditEvent} from './domain.ts';
import type {StateHead} from './state-map-sql-v1.ts';
import {GovernanceConsoleSnapshotV4} from './governance-console-snapshot-v4.ts';
import {consoleKeyV4,consoleScopeVisibleV4,governanceConsoleFormatV4,type ConsoleCatalogV4,type ConsoleMetaV4} from './governance-console-catalog-v4.ts';
import {readAssetKey,type DomainReadAssetV4,type DomainReadCatalogV4} from './domain-read-catalog-v4.ts';
import {domainEntityKey} from './domain-entities-v4.ts';
import {decodeLegacyText} from './legacy-map-v4.ts';
import {auditNeedV4 as need,auditFailV4} from './unified-audit-query-v4.ts';
/** No payload reconstruction or retained business-value cache. */
export class UnifiedAuditScopeV4 {
 #s:GovernanceConsoleSnapshotV4;#ctx:AccessContext;#read:DomainReadCatalogV4;#console:ConsoleCatalogV4;#root:StateHead;
 constructor(s:GovernanceConsoleSnapshotV4,ctx:AccessContext,read:DomainReadCatalogV4,console:ConsoleCatalogV4,root:StateHead){this.#s=s;this.#ctx=ctx;this.#read=read;this.#console=console;this.#root=root;}
 async #entity(collection:string,identity:unknown,root?:StateHead){const key=domainEntityKey(collection,identity),v=await this.#s.state('v4_entity',key,root);return v.present?JSON.parse(await decodeLegacyText('v4_entity',key,(ns,k)=>this.#s.get(ns,k,root))):null;}
 async #device(code:string){if(!code||code.length>128)return false;for(const root of [undefined,this.#root]){const key=readAssetKey(this.#read.generation,code),present=await this.#s.state('blob',key,root);let scope:Record<string,unknown>={device_code:code};if(present.present){const asset=JSON.parse(await decodeLegacyText('blob',key,(ns,k)=>this.#s.get(ns,k,root))) as DomainReadAssetV4;need(asset.tenantId===this.#ctx.tenantId&&asset.deviceCode===code&&asset.scope.device_code===code,'AUDIT_ASSET');scope=asset.scope;}if(!scopeAllows(this.#ctx,scope))return false;}return true;}
 async #batch(id:string):Promise<boolean|'DEFER'>{const filter=scopeFilter(this.#ctx),values=[];let cost=0;for(const root of [undefined,this.#root]){const state=await this.#s.state('blob',consoleKeyV4(this.#console.generation,'batches',id,'meta'),root);if(!state.present)return false;const m=state.value as ConsoleMetaV4;need(m.format===governanceConsoleFormatV4&&m.kind==='batches'&&m.id===id&&m.tenantId===this.#ctx.tenantId&&m.generation===this.#console.generation,'AUDIT_BATCH_SCOPE');for(const [dim,allowed]of Object.entries(filter)){const rule=(m.coverage.dimensions as any)[dim];if(allowed!==null&&!rule.values&&rule.distinct<=new Set(allowed).size)cost+=new Set(allowed).size;}values.push({m,root});}
  if(cost>1400)auditFailV4(413,'AUDIT_SCOPE_BUDGET');if(this.#s.stats.keys+cost+32>1950)return 'DEFER';for(const {m,root}of values)if(!await consoleScopeVisibleV4(m,this.#ctx,async key=>{const v=await this.#s.state('blob',key,root);return v.present?v.value:null;}))return false;return true;
 }
 async visible(event:AuditEvent):Promise<boolean|'DEFER'>{if(event.tenantId!==this.#ctx.tenantId)return false;const scope=requiredScope(this.#ctx.roles||[]),own=scope==='OWN_TASKS';if(!own&&Object.values(scopeFilter(this.#ctx)).every(v=>v===null))return true;if(event.objectType==='AUTHENTICATION')return event.actorId===this.#ctx.actorId;if(event.objectType==='DATA_IMPORT')return this.#batch(event.objectId);if(event.objectType==='TELEMETRY_EVENT')return typeof event.metadata.deviceCode==='string'&&this.#device(event.metadata.deviceCode);if(event.objectType==='PREDICTIVE_REVIEW')return this.#device(event.objectId);
  const collections:Record<string,string>={WORK_ORDER:'business/workOrders',ALARM:'business/alarms',PREDICTIVE_ALERT:'business/predictiveAlerts',HEALTH_SNAPSHOT:'business/healthSnapshots'},collection=collections[event.objectType];if(!collection)return false;for(const root of [undefined,this.#root]){const row=await this.#entity(collection,{id:event.objectId},root);if(!row||row.tenantId!==this.#ctx.tenantId)return false;if(event.objectType==='ALARM'){const d=await this.#entity('business/devices',{id:row.deviceId},root);if(!d||d.tenantId!==this.#ctx.tenantId||!await this.#device(d.code)||own&&row.assignee!==this.#ctx.actorId)return false;}else if(!await this.#device(row.deviceCode)||event.objectType==='WORK_ORDER'&&own&&row.assignee!==this.#ctx.actorId)return false;}return true;
 }
}
