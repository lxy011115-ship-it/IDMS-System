import {siteNeedV4 as need} from './site-console-config-v4.ts';
export interface SiteConsoleConfigV4R2 {format:2;purpose:'SITE_CONSOLE_HTTP_R2';baseSiteRuntimeFile:string;predictiveRuntimeFiles:string[]}
const file=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
export function siteConsoleConfigV4R2(v:any):SiteConsoleConfigV4R2 {
 need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')==='baseSiteRuntimeFile,format,predictiveRuntimeFiles,purpose','SITE_R2_CONFIG');
 need(v.format===2&&v.purpose==='SITE_CONSOLE_HTTP_R2'&&file(v.baseSiteRuntimeFile)&&Array.isArray(v.predictiveRuntimeFiles)&&v.predictiveRuntimeFiles.length>0&&v.predictiveRuntimeFiles.length<=32&&v.predictiveRuntimeFiles.every(file)&&new Set([v.baseSiteRuntimeFile,...v.predictiveRuntimeFiles]).size===v.predictiveRuntimeFiles.length+1,'SITE_R2_CONFIG');
 return structuredClone(v);
}
/** Validate the public-host member boundary before a loader can consume private service materials. */
export function sitePredictiveHttpMemberV4R2(v:any){
 const keys=['format','authAuditBinding','mode','queue','business','jobKeyFile','auth','authRuntimeFile','authDeploymentDigest','host','port'];
 need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k))&&v.format===1&&v.mode==='HTTP','SITE_R2_HTTP_ONLY');
 need(v.auth&&v.auth.mode==='oidc'&&Object.keys(v.auth).every(k=>['mode','issuer','audience','clientId','clientSecret','origin'].includes(k))&&file(v.authRuntimeFile)&&file(v.jobKeyFile)&&v.business&&v.queue,'SITE_R2_MEMBER');
 need((v.host===undefined||['127.0.0.1','::1'].includes(v.host))&&(v.port===undefined||Number.isInteger(v.port)&&v.port>=1&&v.port<=65535),'SITE_R2_MEMBER');return v;
}
