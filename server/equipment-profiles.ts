import {fullBatchEvidence,metadataBatchEvidence,type BatchEvidence,type TemplateEvidence,type BatchMetadata,type MetadataBatchEvidence,type FrozenInputEvidence} from './batch-evidence.ts';
import {dataScope} from './data-scope.ts';
import {requireAccess,type AccessContext} from './access.ts';
import {fullFrozenInputEvidence} from './import-revisions.ts';
import {canonical,digest,type Batch,type BatchBody,type ImportData,type Row} from './imports.ts';
import type {Store} from './store.ts';
import type {TemplateVersion} from './domain.ts';
import {object,keys} from './schema-primitives.ts';
import {validateManifest} from './template-schema.ts';
import {validateFieldValues} from './custom-fields.ts';
import {equipmentProfileSchema,mergeEquipmentProfile,type ResolvedEquipmentProfile} from './equipment-profile-schema.ts';
import {DomainError} from './service.ts';

export interface ProfileReference {templateId:string;version:string;contentDigest:string}
export interface EquipmentResolution {profile:ResolvedEquipmentProfile;ancestors:{templateId:string;templateKey:string;version:string;contentDigest:string}[];resolutionDigest:string}
export interface EquipmentProfileBinding extends ProfileReference {templateKey:string;resolution:EquipmentResolution;bindingDigest:string}
function contentDigest(t:TemplateVersion){return digest(canonical({kind:'template',templateKey:t.templateKey,version:t.version,industry:t.industry,parent:t.parent||null,manifest:t.manifest}));}
function frozen(t:TemplateVersion){if(t.contentDigest!==contentDigest(t)||validateManifest(t.manifest).purpose!=='equipment-profile')throw new DomainError(409,'设备类型模板用途或内容摘要无效');}
export function resolveEquipmentProfile(store:Pick<Store,'templates'>,t:TemplateVersion,visited=new Set<string>()):EquipmentResolution{
 frozen(t);if(visited.has(t.id)||visited.size>=5)throw new DomainError(409,'设备类型继承循环或超过5层');const next=new Set(visited).add(t.id);
 let parent:EquipmentResolution|undefined,ancestors:EquipmentResolution['ancestors']=[];
 if(t.parent){const candidates=store.templates.filter(p=>p.tenantId===t.tenantId&&p.templateKey+'@'+p.version===t.parent&&['PUBLISHED','RETIRED'].includes(p.status));if(candidates.length!==1)throw new DomainError(409,'父类型版本不存在或未发布');const p=candidates[0];parent=resolveEquipmentProfile(store,p,next);if(!p.equipmentResolution||canonical(p.equipmentResolution)!==canonical(parent))throw new DomainError(409,'父类型冻结解析不一致');ancestors=[...parent.ancestors,{templateId:p.id,templateKey:p.templateKey,version:p.version,contentDigest:p.contentDigest!}];}
 const profile=mergeEquipmentProfile(parent?.profile,equipmentProfileSchema(t.manifest.equipmentProfile)),resolutionDigest=digest(canonical({profile,ancestors}));return {profile,ancestors,resolutionDigest};
}
export function verifyEquipmentResolution(store:Pick<Store,'templates'>,t:TemplateVersion){const resolved=resolveEquipmentProfile(store,t);if(!t.equipmentResolution||canonical(t.equipmentResolution)!==canonical(resolved))throw new DomainError(409,'设备类型冻结解析与父链不一致');return resolved;}
export function verifyEquipmentCatalog(store:Store){return verifyEquipmentCatalogEvidence(fullBatchEvidence(store));}
export function verifyEquipmentCatalogEvidence(store:TemplateEvidence){for(const t of store.templates.filter(t=>t.manifest.purpose==='equipment-profile')){frozen(t);const anchor=store.templateAnchor(t.tenantId,t.id);if(!anchor||canonical(anchor.after)!==canonical(t))throw new DomainError(409,'设备类型版本与最后治理审计不一致');if(t.status!=='DRAFT')verifyEquipmentResolution(store,t);}}
export function bindEquipmentProfile(store:Store,raw:unknown,tenantId:string):EquipmentProfileBinding{
 const ref=object(raw,'设备类型引用');keys(ref,['templateId','version','contentDigest']);const t=store.templates.find(t=>t.tenantId===tenantId&&t.id===ref.templateId);
 if(!t)throw new DomainError(404,'本企业设备类型模板不存在');if(t.status!=='PUBLISHED'||t.version!==ref.version||t.contentDigest!==ref.contentDigest)throw new DomainError(409,'设备类型未发布、已退役或版本变化');
 const resolution=verifyEquipmentResolution(store,t),snapshot={templateId:t.id,templateKey:t.templateKey,version:t.version,contentDigest:t.contentDigest!,resolution:structuredClone(resolution)};return {...snapshot,bindingDigest:digest(canonical(snapshot))};
}
export function verifyEquipmentBinding(store:Store,batch:Batch){return verifyEquipmentBindingEvidence(fullBatchEvidence(store),batch);}
export function verifyEquipmentBindingEvidence(store:BatchEvidence,batch:BatchBody){return verifyEquipmentBindingMetadataEvidence(metadataBatchEvidence(store,batch),batch,fullFrozenInputEvidence(batch));}
export function verifyEquipmentBindingMetadataEvidence(store:MetadataBatchEvidence,batch:BatchMetadata,input:FrozenInputEvidence){
 const anchors=store.received(batch.tenantId,batch.batchId),binding=batch.equipmentProfileBinding;
 if(!binding&&!anchors.hasEquipmentProfile)return;
 if(!binding||input.digest()!==batch.snapshotDigest||!store.originalMatches(batch)||anchors.count!==1||canonical(anchors.first!.metadata.equipmentProfileBinding)!==canonical(binding)||anchors.first!.metadata.snapshotDigest!==batch.snapshotDigest)throw new DomainError(409,'设备类型绑定与接收审计不一致');
 const {bindingDigest:expected,...snapshot}=binding;if(expected!==digest(canonical(snapshot)))throw new DomainError(409,'设备类型绑定摘要不一致');
 const template=store.templates.find(t=>t.tenantId===batch.tenantId&&t.id===binding.templateId);if(!template||!['PUBLISHED','RETIRED'].includes(template.status)||template.templateKey!==binding.templateKey||template.version!==binding.version||template.contentDigest!==binding.contentDigest||canonical(verifyEquipmentResolution(store,template))!==canonical(binding.resolution))throw new DomainError(409,'原设备类型版本或父链不一致');
 const expectedRef=profileReferenceText(binding);if(!['DEVICE','POINT_DEFINITION'].includes(batch.dataType)||!input.profileReferencesMatch(expectedRef))throw new DomainError(409,'记录类型来源与冻结绑定不一致');
}
export function profileReferenceText(binding:EquipmentProfileBinding){return canonical({templateId:binding.templateId,templateKey:binding.templateKey,version:binding.version,contentDigest:binding.contentDigest});}
export function inheritedProfileBinding(data:ImportData,tenantId:string,parent:unknown,store?:Store){
 if(typeof parent!=='string')return;const batch=data.batches.find(b=>b.tenantId===tenantId&&b.batchId===parent);if(batch&&store)verifyEquipmentBinding(store,batch);return batch?.equipmentProfileBinding;
}
export function prepareProfileRows(rows:Row[],type:string,binding:EquipmentProfileBinding|undefined,previous?:EquipmentProfileBinding){
 if(!binding)return;
 if(!['DEVICE','POINT_DEFINITION'].includes(type))throw new DomainError(400,'设备类型仅用于设备台账或测点定义');
 if(previous&&previous.resolution.profile.typeCode!==binding.resolution.profile.typeCode)throw new DomainError(400,'更正只允许同设备类型配置升级，不能隐式重分类');
 const ref=profileReferenceText(binding);
 for(const row of rows){if(row.source_profile_ref!==undefined&&row.source_profile_ref!==''&&row.source_profile_ref!==ref&&(!previous||row.source_profile_ref!==profileReferenceText(previous)))throw new DomainError(400,'来源类型字段必须与所选冻结版本一致');row.source_profile_ref=ref;if(type==='DEVICE'&&(row.equipment_type===undefined||row.equipment_type===''))row.equipment_type=binding.resolution.profile.typeName;}
}
export function validateProfileRow(row:Row,type:string,binding:EquipmentProfileBinding|undefined){
 if(!binding){if((row.source_profile_ref!==undefined&&row.source_profile_ref!=='')||(row.profile_values!==undefined&&row.profile_values!==''))throw new DomainError(400,'类型来源和扩展字段必须绑定已发布设备类型');return;}
 const p=binding.resolution.profile;
 if(type==='DEVICE'){
  if(row.equipment_type!==p.typeName)throw new DomainError(400,'设备类型名称与模板不匹配');let values:Record<string,unknown>;
  try{values=object(JSON.parse(String(row.profile_values||'{}')),'设备扩展值');}catch{throw new DomainError(400,'设备扩展值须为JSON对象文本');}row.profile_values=canonical(validateFieldValues(p.assetFields,values));
 }else if(type==='POINT_DEFINITION'){
  const point=p.points.find(p=>p.tag_code===row.tag_code);if(!point)throw new DomainError(400,'测点不属于所选设备类型');if(row.unit!==point.unit||Number(row.min_value)<point.min_value||Number(row.max_value)>point.max_value)throw new DomainError(400,'测点单位必须匹配类型，物理范围不可超出类型声明');
 }
}
export function profilePoints(binding:EquipmentProfileBinding,deviceCode:string){return binding.resolution.profile.points.map(point=>({...point,device_code:deviceCode,source_record_id:'point-'+digest(canonical([deviceCode,point.tag_code]))}));}

export function equipmentBindingForDevice(store:Store,data:ImportData,deviceCode:string,ctx:AccessContext){
 requireAccess(ctx,'upload');const view=dataScope(data,ctx,store),asset=view.records.find(r=>r.dataType==='DEVICE'&&r.value.device_code===deviceCode);
 if(!asset||!view.row(asset))throw new DomainError(404,'本范围内已批准设备不存在');const batch=data.batches.find(b=>b.tenantId===ctx.tenantId&&b.batchId===asset.batchId);
 if(!batch?.equipmentProfileBinding)throw new DomainError(409,'设备尚未绑定已批准类型配置');verifyEquipmentBinding(store,batch);return structuredClone(batch.equipmentProfileBinding);
}
