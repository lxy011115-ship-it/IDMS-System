import {resolve,dirname,isAbsolute} from 'node:path';

const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const text=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\u0000-\u001f\u007f]/.test(value);
const normal=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
const states=['START','EXPECT_COLD','EXPECT_AUTHORITY','BASE','LEGACY'];

/** Parse wrapper topology only. File capture, current trust and admission remain the caller's responsibility. */
export function advanceColdCoreSiteWrapperV1(raw){
  need(exact(raw,['value','file','authorityFile','state','depth'])&&text(raw.file)&&isAbsolute(raw.file)&&text(raw.authorityFile)&&isAbsolute(raw.authorityFile)&&states.includes(raw.state)&&Number.isInteger(raw.depth)&&raw.depth>=0&&raw.depth<8,'COLD_REGISTRATION_CORE_SITE_WRAPPER_ARGUMENTS');
  const {value,file,authorityFile,state,depth}=raw;
  need(value&&Object.getPrototypeOf(value)===Object.prototype,'COLD_REGISTRATION_CORE_SITE_WRAPPER_SCHEMA');
  const from=reference=>{need(text(reference),'COLD_REGISTRATION_CORE_SITE_WRAPPER_REFERENCE');return resolve(dirname(file),reference);};
  const next=()=>{const path=from(value.baseRuntimeFile);need(normal(path)!==normal(file),'COLD_REGISTRATION_CORE_SITE_CYCLE');return path;};
  if(state==='EXPECT_COLD')need(value.purpose==='RUNTIME_COLD_SITE_V1','COLD_REGISTRATION_CORE_SITE_WRAPPER_ORDER');
  if(state==='EXPECT_AUTHORITY')need(value.purpose==='SITE_CONSOLE_AUTHORITY_V1','COLD_REGISTRATION_CORE_SITE_WRAPPER_ORDER');
  if(value.purpose==='FIELD_MAP_SITE_RUNTIME_V1'){
    need(state==='START'&&depth===0,'COLD_REGISTRATION_CORE_SITE_WRAPPER_ORDER');
    need(exact(value,['format','purpose','baseRuntimeFile','field'])&&value.format===1&&value.field&&typeof value.field.enabled==='boolean','COLD_REGISTRATION_CORE_SITE_WRAPPER_SCHEMA');
    need(value.field.enabled?exact(value.field,['enabled','gatewayFile'])&&text(value.field.gatewayFile):exact(value.field,['enabled']),'COLD_REGISTRATION_CORE_SITE_WRAPPER_SCHEMA');
    const nextFile=next();
    if(value.field.enabled){const gateway=from(value.field.gatewayFile);need(![file,nextFile].some(path=>normal(path)===normal(gateway)),'COLD_REGISTRATION_CORE_SITE_WRAPPER_ALIAS');}
    return Object.freeze({handled:true,state:'EXPECT_COLD',nextFile,trustFile:null,fieldEnabled:value.field.enabled});
  }
  if(value.purpose==='RUNTIME_COLD_SITE_V1'){
    need(state==='START'&&depth===0||state==='EXPECT_COLD'&&depth===1,'COLD_REGISTRATION_CORE_SITE_WRAPPER_ORDER');
    need(exact(value,['format','purpose','baseRuntimeFile','trustFile'])&&value.format===1,'COLD_REGISTRATION_CORE_SITE_WRAPPER_SCHEMA');
    const nextFile=next(),trustFile=from(value.trustFile);
    need(![file,nextFile].some(path=>normal(path)===normal(trustFile)),'COLD_REGISTRATION_CORE_SITE_WRAPPER_ALIAS');
    return Object.freeze({handled:true,state:'EXPECT_AUTHORITY',nextFile,trustFile,fieldEnabled:null});
  }
  if(state==='EXPECT_AUTHORITY'){
    need(exact(value,['format','purpose','baseRuntimeFile','authorityRuntimeFile'])&&value.format===1,'COLD_REGISTRATION_CORE_SITE_WRAPPER_SCHEMA');
    need(normal(from(value.authorityRuntimeFile))===normal(authorityFile),'COLD_REGISTRATION_CORE_SITE_AUTHORITY');
    return Object.freeze({handled:true,state:'BASE',nextFile:next(),trustFile:null,fieldEnabled:null});
  }
  need(state!=='BASE'||value.purpose!=='SITE_CONSOLE_AUTHORITY_V1','COLD_REGISTRATION_CORE_SITE_WRAPPER_ORDER');
  return Object.freeze({handled:false,state:state==='BASE'?'BASE':'LEGACY',nextFile:null,trustFile:null,fieldEnabled:null});
}
