import {readFile,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import pg from 'pg';
import {siteConsoleConfigV4,siteHttpMemberV4,siteNeedV4 as need} from './site-console-config-v4.ts';
import {loadGovernanceAiAuthRuntimeV4} from './governance-ai-auth-runtime-v4.ts';
import {loadMaintenanceConsoleAuthRuntimeV4} from './maintenance-console-auth-runtime-v4.ts';
import {validateAuthRuntime,verifyAuthStore} from './auth-store.ts';
import {validateKeyRing} from './auth-state.ts';
import type {Session} from './auth-state.ts';
import {AuthAuditStateV4,createAuditedAuthV4} from './auth-audit-state-v4.ts';
import {checkAuthAuditConnectionV4} from './auth-audit-source-v4.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import {DomainMapSnapshot} from './domain-map-v4.ts';
import {domainEntityKey} from './domain-entities-v4.ts';
import {decodeLegacyText} from './legacy-map-v4.ts';
import {canonicalEqual} from './canonical-state.ts';
import {DomainError} from './service.ts';
import {requireAuthAuditTransportV4} from './auth-audit-transport-v4.ts';
export async function siteJsonV4(path:string){const stat=await lstat(path);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=2*1024*1024,'SITE_RUNTIME_FILE');try{return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));}catch{throw Error('SITE_RUNTIME_JSON');}}
type Gov=Awaited<ReturnType<typeof loadGovernanceAiAuthRuntimeV4>>;
type Maint=Awaited<ReturnType<typeof loadMaintenanceConsoleAuthRuntimeV4>>;
export interface SiteMemberV4 {governance:Pick<Gov,'config'|'queue'|'crypto'>;maintenance:Pick<Maint,'config'|'queue'|'crypto'>}
/** Reuse proven role/catalog checks, then own one multi-tenant session state and one sweep. */
export async function loadSiteConsoleRuntimeV4(file:string){
 const path=resolve(file),config=siteConsoleConfigV4(await siteJsonV4(path)),members=new Map<string,SiteMemberV4>(),loaded:(Gov|Maint)[]=[];let base:Gov['config']|undefined,authFile:string|undefined;
 try{for(const item of config.members){const gfile=resolve(dirname(path),item.governanceRuntimeFile),mfile=resolve(dirname(path),item.maintenanceRuntimeFile);siteHttpMemberV4(await siteJsonV4(gfile),'governance');siteHttpMemberV4(await siteJsonV4(mfile),'maintenance');const g=await loadGovernanceAiAuthRuntimeV4(gfile);loaded.push(g);const m=await loadMaintenanceConsoleAuthRuntimeV4(mfile);loaded.push(m);siteHttpMemberV4(g.config,'governance');siteHttpMemberV4(m.config,'maintenance');
  const tenant=g.config.business.binding.tenantId,gAuth=resolve(dirname(gfile),g.config.authRuntimeFile),mAuth=resolve(dirname(mfile),m.config.authRuntimeFile);need(!members.has(tenant)&&tenant===m.config.business.binding.tenantId&&canonicalEqual(g.config.business,m.config.business),'SITE_BUSINESS_BINDING');need(canonicalEqual(g.config.auth,m.config.auth)&&g.config.authDeploymentDigest===m.config.authDeploymentDigest&&canonicalEqual(g.config.authAuditBinding,m.config.authAuditBinding)&&gAuth===mAuth,'SITE_AUTH_BINDING');
  if(base)need(canonicalEqual(base.auth,g.config.auth)&&base.authDeploymentDigest===g.config.authDeploymentDigest&&canonicalEqual(base.authAuditBinding,g.config.authAuditBinding)&&authFile===gAuth,'SITE_SHARED_AUTH_BINDING');else{base=g.config;authFile=gAuth;}
  members.set(tenant,{governance:{config:g.config,queue:g.queue,crypto:g.crypto},maintenance:{config:m.config,queue:m.queue,crypto:m.crypto}});
  const closed=await Promise.allSettled(loaded.splice(0).map(r=>r.close()));need(closed.every(r=>r.status==='fulfilled'),'SITE_MEMBER_CLOSE_FAILED');
 }}finally{const results=await Promise.allSettled(loaded.map(r=>r.close()));for(const r of results)if(r.status==='rejected')throw Error('SITE_MEMBER_CLOSE_FAILED');}
 need(base&&authFile,'SITE_MEMBERS_REQUIRED');const runtime=validateAuthRuntime(await siteJsonV4(authFile),base.authDeploymentDigest),ring=validateKeyRing(await siteJsonV4(resolve(dirname(authFile),runtime.keyFile))),account={host:runtime.host,port:runtime.port,...runtime.account};requireAuthAuditTransportV4(account);const pool=new pg.Pool({...account,max:4,connectionTimeoutMillis:5000,statement_timeout:15000});pool.on('error',()=>{});
 try{const c=await pool.connect();try{await verifyAuthStore(c,runtime,ring);await c.query('BEGIN READ ONLY');await checkAuthAuditConnectionV4(c,base.authAuditBinding,false);await c.query('COMMIT');}finally{c.release();}}catch(e){await pool.end();throw e;}
 const admit=async(session:Session)=>{const member=members.get(session.identity.tenantId);if(!member)throw new DomainError(403,'SITE_LOGIN_TENANT');const business=member.governance.config.business;let s:DomainMapSnapshot|undefined;try{s=await DomainMapSnapshot.open(business.account,business.binding);const tenant=JSON.parse(await decodeLegacyText('v4_entity',domainEntityKey('business/tenants',{id:session.identity.tenantId}),(ns,k)=>s!.get(ns,k)));if(tenant.id!==session.identity.tenantId||tenant.status!=='ACTIVE')throw new DomainError(403,'SITE_LOGIN_TENANT_INACTIVE');}catch(e){if(e instanceof DomainError)throw e;throw new DomainError(503,'SITE_LOGIN_TENANT_UNAVAILABLE');}finally{await s?.close();}};
 const state=new AuthAuditStateV4(pool,runtime,ring,base.authAuditBinding,admit),auth=createAuditedAuthV4(base.auth,state),provider=new GovernanceJobAuthV4(auth,state);let sweeping:Promise<unknown>|undefined,closed=false;const timer=setInterval(()=>{if(!sweeping)sweeping=state.sweepExpired(16).catch(()=>console.error('SITE_AUTH_SWEEP_RETRY')).finally(()=>{sweeping=undefined;});},30000);timer.unref();
 return {config,members,state,auth,provider,async close(){if(closed)return;closed=true;clearInterval(timer);await sweeping;await auth.close();}};
}
