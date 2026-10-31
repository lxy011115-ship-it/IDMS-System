import {runtimeCheckedPath as checkedPath,runtimeBoundedFile as boundedFile} from '../server/runtime-file.ts';
export {checkedPath,boundedFile};
import {join} from 'node:path';
import {createHash} from 'node:crypto';

import {RuntimeProbeError as InspectionError} from '../server/runtime-probe-error.ts';
export {InspectionError};
export const need=(condition,code='CONFIG_INVALID')=>{if(!condition)throw new InspectionError(code);};
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function keys(value,allowed){need(value&&typeof value==='object'&&!Array.isArray(value));need(Object.keys(value).every(k=>allowed.includes(k)));}
export function localHost(host){need(['127.0.0.1','localhost','::1','[::1]'].includes(host),'LOCAL_ENDPOINT_REQUIRED');return host==='localhost'?'127.0.0.1':host==='[::1]'?'::1':host;}
export function localUrl(value,{origin=false,protocol='http:'}={}){
 let u;try{u=new URL(value);}catch{throw new InspectionError('LOCAL_ENDPOINT_REQUIRED');}
 need(u.protocol===protocol&&['127.0.0.1','[::1]'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash,'LOCAL_ENDPOINT_REQUIRED');
 if(origin)need(u.pathname==='/','LOCAL_ENDPOINT_REQUIRED');return u;
}
export async function privateJson(path,max=256*1024){const raw=await boundedFile(path,max);try{const value=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));need(value&&typeof value==='object'&&!Array.isArray(value));return {value,sha256:hash(raw)};}catch(e){if(e instanceof InspectionError)throw e;throw new InspectionError('CONFIG_INVALID');}}
export const components=['core','business','sessions','identity','workflow','predictor','ai','model','telemetry','mqtt','disk','resources','backups'];
export function validateProfile(p){
 keys(p,['format','required','budgetMs','concurrency','httpMs','tcpMs','databaseMs','core','business','sessions','identity','workflow','predictor','ai','model','telemetry','resources','disks','backups']);need(p.format===1);
 need(Array.isArray(p.required)&&p.required.includes('core')&&new Set(p.required).size===p.required.length&&p.required.every(k=>components.includes(k)));
 for(const [key,min,max,fallback]of [['budgetMs',100,120000,30000],['concurrency',1,2,2],['httpMs',50,3000,3000],['tcpMs',50,2000,2000],['databaseMs',50,3000,3000]]){p[key]??=fallback;need(Number.isSafeInteger(p[key])&&p[key]>=min&&p[key]<=max);}
 const path=v=>need(typeof v==='string'&&v.length>0&&v.length<=2048&&!v.includes('\0'));
 keys(p.core,['url','authentication','storage','sessionStorage']);p.core.url=localUrl(p.core.url,{origin:true}).origin;need(p.core.authentication==='oidc'&&p.core.storage==='postgres-tenant-databases'&&p.core.sessionStorage==='POSTGRES_ENCRYPTED');
 keys(p.business,['config']);path(p.business.config);keys(p.sessions,['config']);if(p.sessions.config!==null)path(p.sessions.config);
 keys(p.identity,['config','issuer']);if(p.identity.config!==null)path(p.identity.config);if(p.identity.issuer!==null)localUrl(p.identity.issuer);
 for(const c of ['workflow','ai']){keys(p[c],['config','url']);path(p[c].config);p[c].url=localUrl(p[c].url,{origin:true}).origin;}
 keys(p.predictor,['url']);p.predictor.url=localUrl(p.predictor.url,{origin:true}).origin;keys(p.model,['url','version']);p.model.url=localUrl(p.model.url,{origin:true}).origin;need(typeof p.model.version==='string'&&/^\d+\.\d+\.\d+$/.test(p.model.version));
 keys(p.telemetry,['config','statusOrigins']);path(p.telemetry.config);need(Array.isArray(p.telemetry.statusOrigins)&&p.telemetry.statusOrigins.length>=1&&p.telemetry.statusOrigins.length<=16);for(const u of p.telemetry.statusOrigins)localUrl(u,{origin:true});
 need(Array.isArray(p.disks)&&p.disks.length>=1&&p.disks.length<=8);for(const d of p.disks){keys(d,['path','minFreeBytes']);path(d.path);need(d.minFreeBytes===null||Number.isSafeInteger(d.minFreeBytes)&&d.minFreeBytes>=0);}
 p.resources??={tokenFile:null};keys(p.resources,['tokenFile']);if(p.resources.tokenFile!==null)path(p.resources.tokenFile);
 keys(p.backups,['directories','keyFile','maxAgeHours']);need(Array.isArray(p.backups.directories)&&p.backups.directories.length>=1&&p.backups.directories.length<=8);for(const d of p.backups.directories)path(d);path(p.backups.keyFile);need(p.backups.maxAgeHours===null||Number.isFinite(p.backups.maxAgeHours)&&p.backups.maxAgeHours>0&&p.backups.maxAgeHours<=175200);return p;
}
export async function sourceMetadata(root){
 const result={commit:null,manifestSha256:null,provesRunningCommit:false};
 try{result.manifestSha256=hash(await boundedFile(join(root,'source-release-manifest.json'),4*1024*1024));}catch{}
 try{let h=(await boundedFile(join(root,'.git/HEAD'),1024)).toString().trim();if(h.startsWith('ref: ')){const ref=h.slice(5);need(/^refs\/heads\/[A-Za-z0-9_/-]+$/.test(ref)&&!ref.split('/').includes('..'));try{h=(await boundedFile(join(root,'.git',ref),1024)).toString().trim();}catch{const lines=(await boundedFile(join(root,'.git/packed-refs'),4*1024*1024)).toString().split('\n');h=lines.find(l=>l.endsWith(' '+ref))?.split(' ')[0];}}if(/^[a-f0-9]{40}$/.test(h))result.commit=h;}catch{}return result;
}
