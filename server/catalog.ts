import {isFieldPolicy,validateFieldPublication} from './field-policy-history.ts';
import {isSourcePolicy,validateSourcePublication} from './source-policy-history.ts';
import {isOperationalPolicy,validateOperationalPublication} from './operational-policy-history.ts';
import {isQualityPolicy,validateQualityPolicyPublication} from './quality-policy-history.ts';
import {isCalendarSchedule,validateScheduleReferences,validateSchedulePublication} from './calendar-schedule.ts';
import {calendarScheduleSchema} from './calendar-schedule-schema.ts';
import {calendarTemplateAccess,calendarTemplateVisible,isOperationCalendar} from './operation-calendar.ts';
import type {ImportView} from './imports.ts';
import {fullBatchEvidence,metadataBatchEvidence,type BatchEvidence,type MetadataBatchEvidence,type BatchMetadata,type FrozenInputEvidence} from './batch-evidence.ts';
import type {StoreView} from './read-model.ts';
import {resolveEquipmentProfile,verifyEquipmentResolution,verifyEquipmentBinding,verifyEquipmentBindingEvidence,verifyEquipmentBindingMetadataEvidence} from './equipment-profiles.ts';
import {verifyCorrectionBatch,verifyCorrectionEvidence,verifyCorrectionMetadataEvidence,fullFrozenInputEvidence} from './import-revisions.ts';
import {randomUUID,createPublicKey,verify} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {appendAudit} from './audit.ts';
import {canonical,digest} from './imports.ts';
import {DomainError} from './service.ts';
import {requireAccess,type AccessContext} from './access.ts';
import {object,keys,text,semver,compareVersions,validateManifest,bindingDigest} from './template-schema.ts';
import type {Plugin,TemplateVersion,MaintenanceTemplateBinding} from './domain.ts';
import type {Store} from './store.ts';
import {mappingBindingDigest,verifyMappedBatch,verifyMappedBatchMetadata,type MappingBinding} from './import-mapping.ts';
import type {Batch,BatchBody} from './imports.ts';

const pluginTypes=['device-adapter','business-connector','metric-provider','workflow-action','ai-tool','report-widget'];
export function templateContentDigest(item:Pick<TemplateVersion,'templateKey'|'version'|'industry'|'parent'|'manifest'>){return digest(canonical({kind:'template',templateKey:item.templateKey,version:item.version,industry:item.industry,parent:item.parent||null,manifest:item.manifest}));}
function find(store:Pick<Store,'templates'>,id:string,ctx:AccessContext){const item=store.templates.find(t=>t.id===id&&t.tenantId===ctx.tenantId);if(!item)throw new DomainError(404,'模板不存在');return item;}
function frozen(item:TemplateVersion){if(!item.contentDigest||item.contentDigest!==templateContentDigest(item))throw new DomainError(409,'模板内容摘要不匹配');validateManifest(item.manifest);}
function expected(item:TemplateVersion,input:Record<string,unknown>){if(input.expectedDigest!==item.contentDigest||input.expectedRevision!==item.revision)throw new DomainError(409,'模板版本或摘要已变化，请刷新');frozen(item);}
function audit(store:Store,item:TemplateVersion,action:string,ctx:AccessContext,before?:TemplateVersion){return appendAudit(store,{tenantId:ctx.tenantId,objectType:'TEMPLATE',objectId:item.id,action,actorType:'USER',actorId:ctx.actorId,correlationId:ctx.correlationId,before,after:item,metadata:{contentDigest:item.contentDigest,revision:item.revision,comment:item.approvalComment}});}
export function createTemplate(store:Store,input:Record<string,unknown>,ctx:AccessContext,data?:ImportView,account?:(value:unknown)=>void){
  requireAccess(ctx,'template:edit');keys(input,['templateKey','version','industry','parent','manifest']);
  const templateKey=text(input.templateKey,'模板编码',80),version=semver(input.version),industry=text(input.industry,'行业',100);
  if(!/^[a-z][a-z0-9-]*$/.test(templateKey))throw new DomainError(400,'模板编码无效');
  const manifest=validateManifest(input.manifest,{materializeCalendar:true,account}),parent=input.parent===undefined?undefined:text(input.parent,'父版本',120);
  if(templateKey==='maintenance-form'&&manifest.purpose!==undefined&&manifest.purpose!=='maintenance-form')throw new DomainError(400,'维修模板编码不能用于上传映射');
  if(store.templates.some(t=>t.tenantId===ctx.tenantId&&t.templateKey===templateKey&&(t.manifest.purpose||'maintenance-form')!==(manifest.purpose||'maintenance-form')))throw new DomainError(409,'同一模板编码不能更换用途');
  if(parent&&!store.templates.some(t=>t.tenantId===ctx.tenantId&&t.templateKey+'@'+t.version===parent&&['PUBLISHED','RETIRED'].includes(t.status)))throw new DomainError(409,'父模板版本不存在或未发布');
  if(store.templates.some(t=>t.tenantId===ctx.tenantId&&t.templateKey===templateKey&&t.version===version))throw new DomainError(409,'模板版本已存在');
  if(manifest.purpose==='equipment-profile'&&store.templates.some(t=>t.tenantId===ctx.tenantId&&t.templateKey===templateKey&&t.manifest.purpose==='equipment-profile'&&(t.manifest.equipmentProfile as {typeCode:string}).typeCode!==manifest.equipmentProfile.typeCode))throw new DomainError(409,'同一模板编码不能更换设备类型编码');
  if(['operation-calendar','calendar-schedule','data-quality-policy','operational-metric-policy','telemetry-source-policy','field-channel-policy'].includes(manifest.purpose||'')&&parent)throw new DomainError(400,'运行日历不能继承，须完整声明区间');
  calendarTemplateAccess(store,data,manifest,ctx,templateKey);if(manifest.purpose==='calendar-schedule')validateScheduleReferences(store,ctx.tenantId,manifest.calendarSchedule);
  const active=store.templates.find(t=>t.tenantId===ctx.tenantId&&t.templateKey===templateKey&&t.status==='PUBLISHED');
  if(active&&compareVersions(version,active.version)<=0)throw new DomainError(409,'新版本必须高于当前发布版；回滚请创建更高版本');
  const item:TemplateVersion={id:randomUUID(),tenantId:ctx.tenantId,templateKey,version,industry,parent,manifest,status:'DRAFT',createdAt:new Date().toISOString(),createdBy:ctx.actorId,contributors:[ctx.actorId],revision:1};
  item.contentDigest=templateContentDigest(item);store.templates.push(item);audit(store,item,'DRAFT_CREATED',ctx);return item;
}
export function editTemplate(store:Store,id:string,input:Record<string,unknown>,ctx:AccessContext,data?:ImportView,account?:(value:unknown)=>void){
  requireAccess(ctx,'template:edit');keys(input,['manifest','expectedDigest','expectedRevision']);const item=find(store,id,ctx);if(item.status!=='DRAFT')throw new DomainError(409,'提交后的模板不可编辑，请新建版本');expected(item,input);
  const manifest=validateManifest(input.manifest,{materializeCalendar:true,account});if((manifest.purpose||'maintenance-form')!==(item.manifest.purpose||'maintenance-form'))throw new DomainError(409,'草稿不能更换模板用途');
  if(manifest.purpose==='equipment-profile'&&store.templates.some(t=>t.id!==item.id&&t.tenantId===ctx.tenantId&&t.templateKey===item.templateKey&&t.manifest.purpose==='equipment-profile'&&(t.manifest.equipmentProfile as {typeCode:string}).typeCode!==manifest.equipmentProfile.typeCode))throw new DomainError(409,'同一模板编码不能更换设备类型编码');
  calendarTemplateAccess(store,data,item.manifest,ctx,item.templateKey);calendarTemplateAccess(store,data,manifest,ctx,item.templateKey);if(manifest.purpose==='calendar-schedule')validateScheduleReferences(store,ctx.tenantId,manifest.calendarSchedule);
  const before=structuredClone(item);item.manifest=manifest;item.revision=(item.revision||0)+1;item.editedBy=ctx.actorId;item.contributors=[...new Set([...(item.contributors||[]),item.createdBy!,ctx.actorId])];item.contentDigest=templateContentDigest(item);audit(store,item,'DRAFT_EDITED',ctx,before);return item;
}
export function submitTemplate(store:Store,id:string,input:Record<string,unknown>,ctx:AccessContext,data?:ImportView){
  requireAccess(ctx,'template:submit');keys(input,['expectedDigest','expectedRevision']);const item=find(store,id,ctx);if(item.status!=='DRAFT')throw new DomainError(409,'仅草稿模板可以提交');expected(item,input);calendarTemplateAccess(store,data,item.manifest,ctx,item.templateKey);if(isCalendarSchedule(item))validateScheduleReferences(store,ctx.tenantId,calendarScheduleSchema(item.manifest.calendarSchedule));const before=structuredClone(item);if(item.manifest.purpose==='equipment-profile')item.equipmentResolution=resolveEquipmentProfile(store,item);item.status='AWAITING_APPROVAL';item.submittedBy=ctx.actorId;item.revision=(item.revision||0)+1;audit(store,item,'SUBMITTED_FOR_APPROVAL',ctx,before);return item;
}
export function approveTemplate(store:Store,id:string,input:Record<string,unknown>,ctx:AccessContext,data?:ImportView){
  requireAccess(ctx,'template:publish');keys(input,['decision','comment','expectedDigest','expectedRevision']);const item=find(store,id,ctx);if(item.status!=='AWAITING_APPROVAL')throw new DomainError(409,'仅待审批模板可以决定');expected(item,input);
  calendarTemplateAccess(store,data,item.manifest,ctx,item.templateKey);
  if([item.createdBy,item.editedBy,item.submittedBy,...(item.contributors||[])].includes(ctx.actorId))throw new DomainError(403,'创建、编辑或提交人不得终审本人版本');
  const decision=text(input.decision,'审批决定',20),comment=text(input.comment,'审批意见',2000);if(!['APPROVED','REJECTED','RETURNED'].includes(decision))throw new DomainError(400,'审批决定无效');
  if(item.manifest.purpose==='equipment-profile')verifyEquipmentResolution(store,item);
  const current=store.templates.find(t=>t.tenantId===ctx.tenantId&&t.templateKey===item.templateKey&&t.status==='PUBLISHED');
  if(decision==='APPROVED'&&current&&compareVersions(item.version,current.version)<=0)throw new DomainError(409,'发布版已经更新，旧草稿不能覆盖新版本');
  const publicationTime=new Date().toISOString();if(decision==='APPROVED'){validateSchedulePublication(store,item,publicationTime);validateQualityPolicyPublication(store,item,publicationTime);validateOperationalPublication(store,item,publicationTime);validateSourcePublication(store,item,publicationTime,data);validateFieldPublication(store,item,publicationTime,data);}
  const before=structuredClone(item),currentBefore=current?structuredClone(current):undefined,auditOffset=store.audits.length;
  // The appendAudit clock is the persisted approval cutoff. Validate again at
  // that exact logical timestamp so a millisecond boundary cannot slip a past
  // edit through a PROSPECTIVE declaration. Keep direct domain calls atomic too.
  const scheduleBefore=(isCalendarSchedule(item)||isQualityPolicy(item)||isOperationalPolicy(item)||isSourcePolicy(item)||isFieldPolicy(item))&&decision==='APPROVED'?{templates:store.templates.filter(t=>t.id!==item.id).map(t=>t===current?currentBefore!:t),audits:store.audits.slice()}:null;
  try{
  if(decision==='APPROVED'){if(current){const old=structuredClone(current);current.status='RETIRED';audit(store,current,'RETIRED_BY_NEW_VERSION',ctx,old);}item.status='PUBLISHED';item.publishedAt=publicationTime;item.publishedBy=ctx.actorId;}else item.status=decision as 'RETURNED'|'REJECTED';
  item.approvalComment=comment;item.revision=(item.revision||0)+1;const event=audit(store,item,'TEMPLATE_'+decision,ctx,before);
  if(scheduleBefore){validateSchedulePublication(scheduleBefore,item,event.businessTime);validateQualityPolicyPublication(scheduleBefore,item,event.businessTime);validateOperationalPublication(scheduleBefore,item,event.businessTime);validateSourcePublication(scheduleBefore,item,event.businessTime,data);validateFieldPublication(scheduleBefore,item,event.businessTime,data);}return item;
  }catch(error){for(const key of Object.keys(item))delete (item as unknown as Record<string,unknown>)[key];Object.assign(item,before);if(current&&currentBefore)Object.assign(current,currentBefore);store.audits.splice(auditOffset);throw error;}
}
export function presentTemplate(item:TemplateVersion){let validated=false;try{frozen(item);validated=true;}catch{}const mapped=item.manifest.purpose==='import-mapping',profile=item.manifest.purpose==='equipment-profile';return {...item,immutable:item.status!=='DRAFT',validated,runtimeApplicable:validated&&(mapped||profile||isOperationCalendar(item)||isCalendarSchedule(item)||isQualityPolicy(item)||isOperationalPolicy(item)||isSourcePolicy(item)||isFieldPolicy(item)||item.templateKey==='maintenance-form'),notice:validated?(isFieldPolicy(item)?'独立现场通道配置审批；绑定准确来源版本、公开配置与证书摘要，仍须当前准入租约和真实安全链路，未代表现场验收':isSourcePolicy(item)?'独立批准的采集来源与点表；接收时校验批准版本、当前定义与公开运行配置，审批不解除现场验收门禁':isOperationalPolicy(item)?'独立批准的运营指标口径；按生效时间和资料截止计算生产、维修及检验，保留缺失条件与来源':isQualityPolicy(item)?'独立发布的质量规则；按生效时间与资料截止复核，仅说明数据条件与规则触发，不代表设备健康或质量放行':isCalendarSchedule(item)?'独立发布的生效安排；按生效时间和审批记录截止时间复核日历，测点定义和数据仍为当前授权结果':isOperationCalendar(item)?'已声明运行/停产区间；仅发布版用于计划采样覆盖，历史查询使用当前配置':profile?'声明式设备类型、测点及质量配置；新批次冻结版本':mapped?'显式字段映射；新上传批次冻结已发布版本':'声明式维修字段；新工单绑定已发布版本'):'历史元数据，未通过当前schema，不能用于新企业表单'};}
export function exportTemplate(store:StoreView,id:string,ctx:AccessContext,data?:ImportView){requireAccess(ctx,'read');const item=find(store,id,ctx);if(!calendarTemplateVisible(item,store,data,ctx))throw new DomainError(404,'模板不存在');if(!['PUBLISHED','RETIRED'].includes(item.status))throw new DomainError(409,'仅发布过的版本可导出为交付包');frozen(item);const {templateKey,version,industry,parent,manifest}=item;return {format:'idms-template-v1',content:{templateKey,version,industry,...(parent?{parent}:{}),manifest:structuredClone(manifest)},contentDigest:item.contentDigest};}
export function importTemplate(store:Store,input:Record<string,unknown>,ctx:AccessContext,data?:ImportView,account?:(value:unknown)=>void){requireAccess(ctx,'template:edit');keys(input,['format','content','contentDigest']);if(input.format!=='idms-template-v1')throw new DomainError(400,'模板包格式无效');const content=object(input.content);if(templateContentDigest(content as unknown as TemplateVersion)!==input.contentDigest)throw new DomainError(409,'模板包摘要不一致');return createTemplate(store,content,ctx,data,account);}
export function bindMaintenanceTemplate(store:Store,tenantId:string):MaintenanceTemplateBinding|undefined{
  const active=store.templates.filter(t=>t.tenantId===tenantId&&t.templateKey==='maintenance-form'&&t.status==='PUBLISHED');if(!active.length)return;if(active.length!==1)throw new DomainError(409,'存在多个有效维修模板，禁止模糊绑定');const item=active[0];frozen(item);const manifest=validateManifest(item.manifest);
  if(manifest.purpose==='import-mapping'||manifest.purpose==='equipment-profile'||manifest.purpose==='operation-calendar'||manifest.purpose==='calendar-schedule'||manifest.purpose==='data-quality-policy'||manifest.purpose==='operational-metric-policy'||manifest.purpose==='telemetry-source-policy'||manifest.purpose==='field-channel-policy')throw new DomainError(409,'维修模板用途不匹配');
  const snapshot={templateId:item.id,templateKey:item.templateKey,version:item.version,contentDigest:item.contentDigest!,fields:structuredClone(manifest.maintenance.fields)};return {...snapshot,bindingDigest:bindingDigest(snapshot)};
}
export function bindImportMapping(store:Store,raw:unknown,tenantId:string,dataType:string,sourceSystem:string):MappingBinding{
 const ref=object(raw,'映射引用');keys(ref,['templateId','version','contentDigest']);
 const item=store.templates.find(t=>t.id===ref.templateId&&t.tenantId===tenantId);if(!item)throw new DomainError(404,'本企业映射不存在');
 frozen(item);const manifest=validateManifest(item.manifest);
 if(item.status!=='PUBLISHED'||item.version!==ref.version||item.contentDigest!==ref.contentDigest||manifest.purpose!=='import-mapping'||manifest.importMapping.dataType!==dataType||manifest.importMapping.sourceSystem!==sourceSystem)throw new DomainError(409,'映射未发布、版本变化或类型/来源不匹配');
 const snapshot={templateId:item.id,templateKey:item.templateKey,version:item.version,contentDigest:item.contentDigest!,mapping:structuredClone(manifest.importMapping)};return {...snapshot,bindingDigest:mappingBindingDigest(snapshot)};
}
export function verifyBatchMapping(store:Store,batch:Batch){return verifyBatchMappingEvidence(fullBatchEvidence(store),batch);}
export function verifyBatchMappingEvidence(store:BatchEvidence,batch:BatchBody){return verifyBatchMappingMetadataEvidence(metadataBatchEvidence(store,batch),batch,fullFrozenInputEvidence(batch));}
export function verifyBatchMappingMetadataEvidence(store:MetadataBatchEvidence,batch:BatchMetadata,input:FrozenInputEvidence){
 verifyCorrectionMetadataEvidence(store,batch,input);
 verifyEquipmentBindingMetadataEvidence(store,batch,input);
 const received=store.received(batch.tenantId,batch.batchId);
 if(batch.mappingBinding||received.hasMapping){
  const origin=received.first?.metadata;
  if(received.count!==1||!batch.mappingBinding||!origin?.mappingBinding||canonical(origin.mappingBinding)!==canonical(batch.mappingBinding)||canonical(origin.sourceHeaders)!==canonical(batch.sourceHeaders)||origin.snapshotDigest!==batch.snapshotDigest||!store.originalMatches(batch))throw new DomainError(409,'批次映射与原接收审计不一致');
 }
 verifyMappedBatchMetadata(batch,input);if(!batch.mappingBinding)return;
 const b=batch.mappingBinding,item=store.templates.find(t=>t.tenantId===batch.tenantId&&t.id===b.templateId);
 if(!item||!['PUBLISHED','RETIRED'].includes(item.status))throw new DomainError(409,'批次原映射版本不存在或从未发布');
 frozen(item);const m=validateManifest(item.manifest);
 if(item.templateKey!==b.templateKey||item.version!==b.version||item.contentDigest!==b.contentDigest||m.purpose!=='import-mapping'||canonical(m.importMapping)!==canonical(b.mapping))throw new DomainError(409,'批次原映射与冻结配置不一致');
}

export interface TrustedPluginKey {keyId:string;publicKey:string;pluginTypes:string[];permissions:string[];tenantIds:string[];expiresAt:string;revoked:boolean}
export type PluginTrust=ReadonlyMap<string,TrustedPluginKey>;
const none:PluginTrust=new Map();
function base64(value:string,max:number){if(value.length>max||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw Error('Invalid encoding');return Buffer.from(value,'base64');}
export async function loadPluginTrust():Promise<PluginTrust>{
  if(!process.env.IDMS_PLUGIN_TRUST_CONFIG)return none;
  try{const bytes=await readFile(process.env.IDMS_PLUGIN_TRUST_CONFIG);if(bytes.length>100000)throw Error();const config=object(JSON.parse(bytes.toString('utf8')));keys(config,['version','keys']);if(config.version!==1||!Array.isArray(config.keys)||config.keys.length>100)throw Error();const result=new Map<string,TrustedPluginKey>();
    for(const raw of config.keys){const k=object(raw);keys(k,['keyId','publicKey','pluginTypes','permissions','tenantIds','expiresAt','revoked']);const keyId=text(k.keyId,'密钥ID',100),publicKey=text(k.publicKey,'公钥',200);if(result.has(keyId)||createPublicKey({key:base64(publicKey,200),format:'der',type:'spki'}).asymmetricKeyType!=='ed25519')throw Error();for(const list of ['pluginTypes','permissions','tenantIds'])if(!Array.isArray(k[list])||(k[list] as unknown[]).some(v=>typeof v!=='string')||(k[list] as unknown[]).length>100)throw Error();if(!Number.isFinite(Date.parse(String(k.expiresAt)))||typeof k.revoked!=='boolean')throw Error();result.set(keyId,{keyId,publicKey,pluginTypes:k.pluginTypes as string[],permissions:k.permissions as string[],tenantIds:k.tenantIds as string[],expiresAt:String(k.expiresAt),revoked:k.revoked});}return result;
  }catch{throw new DomainError(503,'平台插件信任配置无效，认证失败关闭');}
}
export function pluginContentDigest(item:Pick<Plugin,'tenantId'|'name'|'type'|'version'|'permissions'|'manifest'|'signingKeyId'>){return digest(canonical({kind:'plugin-manifest-v1',tenantId:item.tenantId,name:item.name,type:item.type,version:item.version,permissions:[...item.permissions].sort(),manifest:item.manifest||{},signingKeyId:item.signingKeyId||null}));}
export function pluginMetadataStatus(item:Plugin,trust:PluginTrust=none){
  const result={valid:false,scope:'MANIFEST_ONLY',runtime:'BLOCKED',reason:'UNVERIFIED_OR_LEGACY'};
  try{const k=trust.get(item.signingKeyId||'');if(!k||k.revoked||Date.parse(k.expiresAt)<=Date.now()||!k.tenantIds.includes(item.tenantId)||!k.pluginTypes.includes(item.type)||item.permissions.some(p=>!k.permissions.includes(p))||item.publicKey||item.contentDigest!==pluginContentDigest(item))return result;
    const key=createPublicKey({key:base64(k.publicKey,200),format:'der',type:'spki'}),sig=base64(item.signature||'',100);if(key.asymmetricKeyType!=='ed25519'||sig.length!==64||!verify(null,Buffer.from(item.contentDigest!),key,sig))return result;return {...result,valid:true,reason:'TRUSTED_MANIFEST_SIGNATURE_NOT_ARTIFACT_CERTIFICATION'};
  }catch{return result;}
}
export function createPlugin(store:Store,input:Record<string,unknown>,ctx:AccessContext,trust:PluginTrust=none){
  requireAccess(ctx,'plugin:submit');keys(input,['name','type','version','permissions','manifest','signature','signingKeyId']);const name=text(input.name,'插件名称'),type=text(input.type,'插件类型'),version=semver(input.version);if(!pluginTypes.includes(type))throw new DomainError(400,'插件类型无效');
  if(!Array.isArray(input.permissions)||input.permissions.length>20||input.permissions.some(p=>!['device:read','telemetry:read','work-order:read','report:read','telemetry:ingest'].includes(String(p)))||new Set(input.permissions).size!==input.permissions.length)throw new DomainError(400,'插件权限无效或越权');
  const manifest=object(input.manifest,'插件manifest');keys(manifest,['minPlatformVersion','artifactSha256','networkTargets','maxMemoryMb']);if(compareVersions(semver(manifest.minPlatformVersion),'0.1.0')>0)throw new DomainError(409,'插件平台版本不兼容');if(typeof manifest.artifactSha256!=='string'||! /^[a-f0-9]{64}$/.test(manifest.artifactSha256))throw new DomainError(400,'制品摘要无效');
  if(!Array.isArray(manifest.networkTargets)||manifest.networkTargets.length>10||manifest.networkTargets.some(v=>typeof v!=='string'||!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(v))||!Number.isInteger(manifest.maxMemoryMb)||Number(manifest.maxMemoryMb)<16||Number(manifest.maxMemoryMb)>1024)throw new DomainError(400,'插件网络或资源声明无效');
  if(store.plugins.some(p=>p.tenantId===ctx.tenantId&&p.name===name&&p.type===type&&p.version===version))throw new DomainError(409,'插件版本已存在');
  const item:Plugin={id:randomUUID(),tenantId:ctx.tenantId,name,type:type as Plugin['type'],version,permissions:input.permissions as string[],manifest:structuredClone(manifest),signingKeyId:input.signingKeyId===undefined?undefined:text(input.signingKeyId,'签名密钥ID',100),signature:input.signature===undefined?undefined:text(input.signature,'签名',100),status:'DRAFT',signed:false,createdBy:ctx.actorId};
  item.contentDigest=pluginContentDigest(item);item.signed=pluginMetadataStatus(item,trust).valid;store.plugins.push(item);appendAudit(store,{tenantId:ctx.tenantId,objectType:'PLUGIN',objectId:item.id,action:'PLUGIN_METADATA_REGISTERED',actorType:ctx.actorType as 'USER'|'INTERFACE',actorId:ctx.actorId,correlationId:ctx.correlationId,after:item,metadata:{verification:pluginMetadataStatus(item,trust),artifactVerified:false}});return item;
}
export function certifyPlugin(store:Store,id:string,ctx:AccessContext,trust:PluginTrust=none):never{requireAccess(ctx,'plugin:certify');const item=store.plugins.find(p=>p.id===id&&p.tenantId===ctx.tenantId);if(!item)throw new DomainError(404,'插件不存在');if(item.createdBy===ctx.actorId)throw new DomainError(403,'插件提交人不得自行认证');if(!pluginMetadataStatus(item,trust).valid)throw new DomainError(409,'平台信任签名未通过，不能认证');throw new DomainError(503,'完整制品扫描、认证流水线和运行隔离尚未验收；不把元数据验签视作插件认证');}
export function activatePlugin(store:Store,id:string,ctx:AccessContext):never{requireAccess(ctx,'plugin:activate');if(!store.plugins.some(p=>p.id===id&&p.tenantId===ctx.tenantId))throw new DomainError(404,'插件不存在');throw new DomainError(503,'插件运行隔离与制品认证尚未验收，激活失败关闭；历史ACTIVE元数据不代表正在执行');}


