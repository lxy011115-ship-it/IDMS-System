import {canonical} from '../server/imports.ts';
import {fieldMaintenanceAuth} from './field-maintenance-record.mjs';
export const externalFailure=code=>Object.assign(Error(code),{code});
export const externalRequire=(ok,code='FIELD_RECOVERY_EXTERNAL_INVALID')=>{if(!ok)throw externalFailure(code);};
export function externalObject(v,keys){externalRequire(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)));return v;}
const text=(v,n)=>externalRequire(typeof v==='string'&&v.length>0&&v.length<=n&&!/[\u0000-\u001f\u007f]/.test(v));
export const externalUuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)&&!/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v);
export function recoveryExternalConfig(raw){
 const c=externalObject(raw,['format','tenantId','auth','identityReader','workflow']);externalRequire(c.format==='idms-field-recovery-external-config-v1'&&typeof c.tenantId==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(c.tenantId));fieldMaintenanceAuth(c.auth);
 const issuer=new URL(c.auth.issuer);externalRequire(/^\/realms\/[A-Za-z0-9_-]{1,80}$/.test(issuer.pathname));
 const i=externalObject(c.identityReader,['clientId','clientSecret','loginClientUuid']);text(i.clientId,128);text(i.clientSecret,256);externalRequire(i.clientSecret.length>=32&&externalUuid(i.loginClientUuid)&&![c.auth.clientId,'admin-cli','idms-web'].includes(i.clientId));
 const w=externalObject(c.workflow,['baseUrl','recoveryReadToken','authorityId','definitionSha256']);text(w.baseUrl,2048);text(w.recoveryReadToken,256);const u=new URL(w.baseUrl);externalRequire(u.origin===w.baseUrl&&!u.username&&!u.password&&(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname))&&w.recoveryReadToken.length>=32&&externalUuid(w.authorityId)&&typeof w.definitionSha256==='string'&&/^[a-f0-9]{64}$/.test(w.definitionSha256));return JSON.parse(canonical(c));
}
export async function externalJson(url,{method='GET',headers={},body,signal,max=1048576}={}){
 let response;try{response=await fetch(url,{method,headers,body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000),redirect:'error',cache:'no-store'});externalRequire(response.ok,'FIELD_RECOVERY_EXTERNAL_UNAVAILABLE');const size=response.headers.get('content-length');externalRequire(size===null||/^\d+$/.test(size)&&Number(size)<=max,'FIELD_RECOVERY_EXTERNAL_LIMIT');const reader=response.body?.getReader();externalRequire(reader,'FIELD_RECOVERY_EXTERNAL_UNAVAILABLE');let bytes=0;const parts=[];try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;externalRequire(bytes<=max,'FIELD_RECOVERY_EXTERNAL_LIMIT');parts.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}catch(e){await response?.body?.cancel().catch(()=>{});throw typeof e.code==='string'&&e.code.startsWith('FIELD_')?e:externalFailure('FIELD_RECOVERY_EXTERNAL_UNAVAILABLE');}
}
