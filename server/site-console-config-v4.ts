export interface SiteConsoleConfigV4 {format:1;purpose:'SITE_CONSOLE_HTTP';host:'127.0.0.1'|'::1';port:number;members:{governanceRuntimeFile:string;maintenanceRuntimeFile:string}[]}
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
export function siteNeedV4(ok:unknown,code='SITE_CONFIG_INVALID'):asserts ok {if(!ok)throw Error(code);}
export function siteConsoleConfigV4(raw:unknown):SiteConsoleConfigV4 {
 siteNeedV4(exact(raw,['format','purpose','host','port','members']));siteNeedV4(raw.format===1&&raw.purpose==='SITE_CONSOLE_HTTP'&&['127.0.0.1','::1'].includes(raw.host)&&Number.isInteger(raw.port)&&raw.port>=1&&raw.port<=65535&&Array.isArray(raw.members)&&raw.members.length>0&&raw.members.length<=32);
 const seen=new Set<string>();for(const m of raw.members){siteNeedV4(exact(m,['governanceRuntimeFile','maintenanceRuntimeFile']));for(const key of ['governanceRuntimeFile','maintenanceRuntimeFile']){const value=m[key];siteNeedV4(typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\u0000-\u001f]/.test(value)&&!seen.has(value));seen.add(value);}}
 return structuredClone(raw) as SiteConsoleConfigV4;
}
/** Reject service credentials and misspelled fields before invoking a legacy loader. */
export function siteHttpMemberV4(value:unknown,kind:'governance'|'maintenance'){
 const keys=['format','authAuditBinding','mode','queue','business','jobKeyFile','auth','authRuntimeFile','authDeploymentDigest','host','port'];siteNeedV4(value&&typeof value==='object'&&!Array.isArray(value),'SITE_MEMBER_CONFIG');const v=value as Record<string,any>;siteNeedV4(Object.keys(v).every(k=>keys.includes(k))&&v.mode==='HTTP'&&v.format===1,'SITE_MEMBER_HTTP_ONLY');siteNeedV4(v.auth&&v.auth.mode==='oidc'&&Object.keys(v.auth).every(k=>['mode','issuer','audience','clientId','clientSecret','origin'].includes(k)),'SITE_MEMBER_AUTH');siteNeedV4(typeof v.authRuntimeFile==='string'&&typeof v.jobKeyFile==='string'&&v.business&&v.queue,'SITE_MEMBER_CONFIG');return v;
}
