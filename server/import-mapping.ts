import type {BatchMetadata,FrozenInputEvidence} from './batch-evidence.ts';
import {canonical,digest,definitions,type DataType,type Row,type Batch,type BatchBody} from './imports.ts';
import {deviceOptionalFields,pointOptionalFields} from './point-definitions.ts';
import {DomainError} from './service.ts';

export interface ImportMapping {dataType:DataType;sourceSystem:string;templateVersion:'1.0.0';columns:{sourceColumn:string;targetField:string}[]}
export interface MappingBinding {templateId:string;templateKey:string;version:string;contentDigest:string;mapping:ImportMapping;bindingDigest:string}
function object(raw:unknown):Record<string,unknown>{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DomainError(400,'映射对象无效');return raw as Record<string,unknown>;}
function keys(raw:Record<string,unknown>,allowed:string[]){if(Object.keys(raw).some(k=>!allowed.includes(k)))throw new DomainError(400,'映射存在未知或保留字段');}
export function requiredFields(type:DataType){const optional:readonly string[]=type==='DEVICE'?deviceOptionalFields:type==='POINT_DEFINITION'?pointOptionalFields:type==='STATE_INTERVAL'?['reason_code']:[];return definitions[type].fields.filter(f=>!optional.includes(f));}
export function validSourceHeader(value:unknown):value is string{return typeof value==='string'&&value.trim().length>0&&value.length<=120&&!/[\p{Cc}\p{Cf}]/u.test(value)&&!['__proto__','prototype','constructor'].includes(value.trim());}
export function validateHeaders(headers:string[],mapped=false){
 const names=headers.map(h=>h.trim());
 if(!headers.length||new Set(names).size!==names.length||headers.some(h=>mapped?!validSourceHeader(h):!/^[a-z][a-z0-9_]*$/.test(h.trim())))throw new DomainError(400,mapped?'映射表头为空、重复、保留或包含不可见字符':'模板列名必须唯一且为标准字段名');
 return names;
}
export function mappingSchema(raw:unknown):ImportMapping{
 const m=object(raw);keys(m,['dataType','sourceSystem','templateVersion','columns']);
 if(typeof m.dataType!=='string'||!Object.hasOwn(definitions,m.dataType))throw new DomainError(400,'映射数据类型无效');
 const dataType=m.dataType as DataType,fields=definitions[dataType].fields as readonly string[];
 if(typeof m.sourceSystem!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(m.sourceSystem)||m.templateVersion!=='1.0.0')throw new DomainError(400,'映射来源系统或标准模板版本无效');
 if(!Array.isArray(m.columns)||!m.columns.length||m.columns.length>fields.length)throw new DomainError(400,'映射列数无效');
 const sources=new Set<string>(),targets=new Set<string>();
 const columns=m.columns.map(raw=>{const c=object(raw);keys(c,['sourceColumn','targetField']);if(!validSourceHeader(c.sourceColumn)||c.sourceColumn!==c.sourceColumn.trim()||typeof c.targetField!=='string'||!fields.includes(c.targetField)||sources.has(c.sourceColumn)||targets.has(c.targetField))throw new DomainError(400,'映射列重复、保留、目标未知或表头无效');sources.add(c.sourceColumn);targets.add(c.targetField);return {sourceColumn:c.sourceColumn,targetField:c.targetField};});
 if(requiredFields(dataType).some(f=>!targets.has(f)))throw new DomainError(400,'映射未覆盖必填标准字段');
 return {dataType,sourceSystem:m.sourceSystem,templateVersion:'1.0.0',columns};
}
export function mappingBindingDigest(binding:Omit<MappingBinding,'bindingDigest'>){return digest(canonical(binding));}
export function verifyMappingBinding(binding:MappingBinding){
 const raw=object(binding);keys(raw,['templateId','templateKey','version','contentDigest','mapping','bindingDigest']);
 const {bindingDigest:expected,...snapshot}=binding;
 if(expected!==mappingBindingDigest(snapshot))throw new DomainError(409,'映射冻结摘要不匹配');
 const mapping=mappingSchema(binding.mapping);if(canonical(mapping)!==canonical(binding.mapping))throw new DomainError(409,'映射冻结配置不一致');
}
export function mapRows(rows:Row[],headers:string[],mapping:ImportMapping){
 const names=validateHeaders(headers,true),available=new Map(mapping.columns.map(c=>[c.sourceColumn,c.targetField]));
 for(const name of names)if(!available.has(name))throw new DomainError(400,`原表头“${name}”未配置映射`);
 const covered=new Set(names.map(n=>available.get(n)));
 for(const f of requiredFields(mapping.dataType))if(!covered.has(f))throw new DomainError(400,`表头缺少必填字段 ${f} 对应的来源列`);
 return rows.map(row=>{if(Object.keys(row).length!==names.length||names.some(n=>!Object.hasOwn(row,n)))throw new DomainError(400,'原始行与映射表头不一致');return Object.fromEntries(names.map(n=>[available.get(n)!,row[n]]));});
}
export function mappedSnapshotFields(batch:Pick<Batch,'templateVersion'|'sourceSystem'|'dataType'|'mappingBinding'|'sourceHeaders'|'fileSha256'|'lineNumbers'|'correction'|'equipmentProfileBinding'>){return {templateVersion:batch.templateVersion,ruleVersion:'upload-rules-1.0.0',sourceSystem:batch.sourceSystem,dataType:batch.dataType,mappingBinding:batch.mappingBinding,sourceHeaders:batch.sourceHeaders,fileSha256:batch.fileSha256,lineNumbers:batch.lineNumbers,...(batch.equipmentProfileBinding?{equipmentProfileBinding:batch.equipmentProfileBinding}:{}),...(batch.correction?{correction:batch.correction}: {})};}
export function mappedSnapshotValue(batch:Parameters<typeof mappedSnapshotFields>[0]&Pick<Batch,'rows'>){return {rows:batch.rows,...mappedSnapshotFields(batch)};}
export function mappedSnapshotDigest(batch:Parameters<typeof mappedSnapshotValue>[0]){return digest(canonical(mappedSnapshotValue(batch)));}
export function verifyMappedBatch(batch:BatchBody){return verifyMappedBatchMetadata(batch,{rowCount:batch.rows.length,digest:()=>mappedSnapshotDigest(batch),profileReferencesMatch:ref=>batch.rows.every(row=>row.source_profile_ref===ref)});}
export function verifyMappedBatchMetadata(batch:BatchMetadata,input:FrozenInputEvidence){
 if(!batch.mappingBinding){if(batch.sourceHeaders!==undefined)throw new DomainError(409,'原表头缺少冻结映射');return;}
 verifyMappingBinding(batch.mappingBinding);
 if(batch.mappingBinding.mapping.dataType!==batch.dataType||batch.mappingBinding.mapping.sourceSystem!==batch.sourceSystem||batch.mappingBinding.mapping.templateVersion!==batch.templateVersion||!Array.isArray(batch.sourceHeaders)||batch.lineNumbers.length!==input.rowCount||batch.snapshotDigest!==input.digest())throw new DomainError(409,'批次映射或输入冻结摘要不匹配');
 mapRows([],batch.sourceHeaders,batch.mappingBinding.mapping);
}
