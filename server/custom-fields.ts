import {canonical,digest} from './imports.ts';
import {DomainError} from './service.ts';
import type {MaintenanceField,MaintenanceTemplateBinding} from './domain.ts';
import {object,keys,text} from './schema-primitives.ts';
export function fieldsSchema(value:unknown):MaintenanceField[]{
  if(!Array.isArray(value)||value.length>12)throw new DomainError(400,'维修自定义字段最多12项');
  const seen=new Set<string>();
  return value.map(raw=>{
    const f=object(raw,'字段');keys(f,['key','label','type','required','unit','min','max','maxLength','options']);
    const key=text(f.key,'字段编码',40),label=text(f.label,'字段名称',80),type=f.type;
    if(!/^[a-z][a-z0-9_]*$/.test(key)||['tenant_id','actor_id','approval','signature','prototype','constructor','__proto__','digest','state','version'].includes(key)||seen.has(key))throw new DomainError(400,'字段编码重复、保留或无效');
    seen.add(key);if(!['TEXT','NUMBER','BOOLEAN','SELECT'].includes(String(type))||typeof f.required!=='boolean')throw new DomainError(400,'字段类型/必填标记无效');
    const result:MaintenanceField={key,label,type:type as MaintenanceField['type'],required:f.required};
    if(f.unit!==undefined)result.unit=text(f.unit,'单位',20);
    if(f.min!==undefined||f.max!==undefined){if(type!=='NUMBER')throw new DomainError(400,'仅数字字段支持范围');for(const k of ['min','max'] as const)if(f[k]!==undefined){if(typeof f[k]!=='number'||!Number.isFinite(f[k]))throw new DomainError(400,'字段数值范围无效');result[k]=f[k];}if(result.min!==undefined&&result.max!==undefined&&result.min>result.max)throw new DomainError(400,'字段范围倒置');}
    if(f.maxLength!==undefined){if(type!=='TEXT'||!Number.isInteger(f.maxLength)||Number(f.maxLength)<1||Number(f.maxLength)>2000)throw new DomainError(400,'文本长度上限无效');result.maxLength=Number(f.maxLength);}
    if(type==='SELECT'){if(!Array.isArray(f.options)||!f.options.length||f.options.length>20)throw new DomainError(400,'选项需1–20个');result.options=f.options.map(v=>text(v,'选项',80));if(new Set(result.options).size!==result.options.length)throw new DomainError(400,'选项重复');}else if(f.options!==undefined)throw new DomainError(400,'仅选择字段支持选项');
    return result;
  });
}
export function bindingDigest(binding:Omit<MaintenanceTemplateBinding,'bindingDigest'>){return digest(canonical(binding));}
export function validateCustomFields(binding:MaintenanceTemplateBinding|undefined,raw:unknown){
  const values=raw===undefined?{}:object(raw,'企业扩展字段');
  if(!binding){if(Object.keys(values).length)throw new DomainError(400,'历史工单未绑定企业模板');return undefined;}
  const {bindingDigest:expected,...snapshot}=binding;
  if(expected!==bindingDigest(snapshot))throw new DomainError(409,'工单模板冻结摘要不匹配');
  return validateFieldValues(binding.fields,values);
}
export function validateFieldValues(fields:MaintenanceField[],values:Record<string,unknown>){
  const schema=fieldsSchema(fields);keys(values,schema.map(f=>f.key));const normalized:Record<string,string|number|boolean>={};
  for(const f of schema){const value=values[f.key];if(value===undefined||value===''){if(f.required)throw new DomainError(400,f.label+'为必填项');continue;}
    if(f.type==='NUMBER'){if(typeof value!=='number'||!Number.isFinite(value)||(f.min!==undefined&&value<f.min)||(f.max!==undefined&&value>f.max))throw new DomainError(400,f.label+'数值/范围无效');normalized[f.key]=value;}
    else if(f.type==='BOOLEAN'){if(typeof value!=='boolean')throw new DomainError(400,f.label+'必须为布尔值');normalized[f.key]=value;}
    else {const v=text(value,f.label,f.type==='TEXT'?f.maxLength||2000:80);if(f.type==='SELECT'&&!f.options?.includes(v))throw new DomainError(400,f.label+'选项无效');normalized[f.key]=v;}
  }
  return normalized;
}
