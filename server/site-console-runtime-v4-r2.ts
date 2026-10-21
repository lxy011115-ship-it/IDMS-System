import {resolve,dirname} from 'node:path';
import {siteConsoleConfigV4R2,sitePredictiveHttpMemberV4R2} from './site-console-config-v4-r2.ts';
import {siteNeedV4 as need} from './site-console-config-v4.ts';
import {loadSiteConsoleRuntimeV4,siteJsonV4} from './site-console-runtime-v4.ts';
import {loadPredictiveConsoleAuthRuntimeV4} from './predictive-console-auth-runtime-v4.ts';
import {canonicalEqual} from './canonical-state.ts';
type Pred=Awaited<ReturnType<typeof loadPredictiveConsoleAuthRuntimeV4>>;
/** The frozen host owns the only long-lived auth state, provider and sweep timer. */
export async function loadSiteConsoleRuntimeV4R2(file:string){
 const path=resolve(file),config=siteConsoleConfigV4R2(await siteJsonV4(path)),baseFile=resolve(dirname(path),config.baseSiteRuntimeFile),base=await loadSiteConsoleRuntimeV4(baseFile),predictive=new Map<string,Pick<Pred,'config'|'queue'|'crypto'>>();
 try{
  const authFiles=new Map<string,string>();
  for(const member of base.config.members){const gfile=resolve(dirname(baseFile),member.governanceRuntimeFile),g=await siteJsonV4(gfile),tenant=g.business?.binding?.tenantId,loaded=base.members.get(tenant);need(loaded&&canonicalEqual(g,loaded.governance.config),'SITE_R2_BASE_CHANGED');authFiles.set(tenant,resolve(dirname(gfile),g.authRuntimeFile));}
  const paths=new Set([baseFile]);
  for(const ref of config.predictiveRuntimeFiles){const pfile=resolve(dirname(path),ref);need(!paths.has(pfile),'SITE_R2_DUPLICATE_FILE');paths.add(pfile);const raw=sitePredictiveHttpMemberV4R2(await siteJsonV4(pfile)),member=base.members.get(raw.business.binding.tenantId);need(member&&!predictive.has(raw.business.binding.tenantId),'SITE_R2_TENANT_MEMBERSHIP');
   const g=member.governance.config;need(canonicalEqual(raw.business,g.business),'SITE_R2_BUSINESS_BINDING');need(canonicalEqual(raw.auth,g.auth)&&raw.authDeploymentDigest===g.authDeploymentDigest&&canonicalEqual(raw.authAuditBinding,g.authAuditBinding)&&resolve(dirname(pfile),raw.authRuntimeFile)===authFiles.get(raw.business.binding.tenantId),'SITE_R2_AUTH_BINDING');
   const p=await loadPredictiveConsoleAuthRuntimeV4(pfile);try{need(canonicalEqual(raw,p.config),'SITE_R2_PREDICTIVE_CHANGED');predictive.set(raw.business.binding.tenantId,{config:p.config,queue:p.queue,crypto:p.crypto});}finally{await p.close();}
  }
  need(predictive.size===base.members.size&&[...base.members.keys()].every(t=>predictive.has(t)),'SITE_R2_MISSING_TENANT');
  return {config:{...config,host:base.config.host,port:base.config.port},base,predictive,members:base.members,auth:base.auth,provider:base.provider,state:base.state,close:()=>base.close()};
 }catch(e){await base.close();throw e;}
}
