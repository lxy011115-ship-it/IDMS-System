import {resolve,dirname} from 'node:path';
import {siteConsoleConfigV4R4} from './site-console-config-v4-r4.ts';
import {loadSiteConsoleRuntimeV4R3} from './site-console-runtime-v4-r3.ts';
import {siteJsonV4} from './site-console-runtime-v4.ts';
import {siteNeedV4 as need} from './site-console-config-v4.ts';
import {loadReconciliationRuntimeMemberV1,reconciliationRuntimeConfigV1} from './reconciliation-runtime-v1.ts';
import {PredictiveReconciliationAuthV1} from './predictive-reconciliation-auth-v1.ts';
import {ReconciliationUiReadV1} from './reconciliation-ui-read-v1.ts';
import {canonicalEqual} from './canonical-state.ts';
export async function loadSiteConsoleRuntimeV4R4(file:string){
 const path=resolve(file),config=siteConsoleConfigV4R4(await siteJsonV4(path)),r3file=resolve(dirname(path),config.baseSiteRuntimeFile),r3config=await siteJsonV4(r3file),base=await loadSiteConsoleRuntimeV4R3(r3file),members=new Map<string,Awaited<ReturnType<typeof loadReconciliationRuntimeMemberV1>>&{ui:ReconciliationUiReadV1}>(),sessionAuth=new PredictiveReconciliationAuthV1(base.provider,base.state);
 try{const sitefile=resolve(dirname(r3file),r3config.baseSiteRuntimeFile),authFiles=new Map<string,string>();for(const item of base.base.config.members){const gfile=resolve(dirname(sitefile),item.governanceRuntimeFile),g=await siteJsonV4(gfile);authFiles.set(g.business.binding.tenantId,resolve(dirname(gfile),g.authRuntimeFile));}
  const paths=new Set([r3file,sitefile]);for(const ref of config.reconciliationRuntimeFiles){const memberFile=resolve(dirname(path),ref);need(!paths.has(memberFile),'SITE_R4_DUPLICATE_FILE');paths.add(memberFile);const raw=reconciliationRuntimeConfigV1(await siteJsonV4(memberFile));need(raw.mode==='HTTP','SITE_R4_HTTP_ONLY');const tenant=raw.business.binding.tenantId,g=base.members.get(tenant)?.governance.config;need(g&&!members.has(tenant),'SITE_R4_TENANT');need(canonicalEqual(raw.business,g.business),'SITE_R4_BUSINESS_BINDING');need(canonicalEqual(raw.auth,g.auth)&&raw.authDeploymentDigest===g.authDeploymentDigest&&canonicalEqual(raw.authAuditBinding,g.authAuditBinding)&&resolve(dirname(memberFile),raw.authRuntimeFile)===authFiles.get(tenant),'SITE_R4_SHARED_AUTH');const loaded=await loadReconciliationRuntimeMemberV1(memberFile,'HTTP');need(canonicalEqual(raw,loaded.config),'SITE_R4_MEMBER_CHANGED');members.set(tenant,{...loaded,ui:new ReconciliationUiReadV1({read:loaded.read,queue:loaded.queue,crypto:loaded.crypto,codec:base.auth.auditCursors})});}
  need(members.size===base.members.size&&[...base.members.keys()].every(t=>members.has(t)),'SITE_R4_MISSING_TENANT');return {config:{...config,host:base.config.host,port:base.config.port},base,members,sessionAuth,auth:base.auth,provider:base.provider,state:base.state,close:()=>base.close()};
 }catch(e){await base.close();throw e;}
}
