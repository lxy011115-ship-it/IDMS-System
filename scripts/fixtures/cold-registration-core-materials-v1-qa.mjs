import {readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
import {readRuntimeColdReviewV3} from '../runtime-cold-readonly-control-v5.mjs';

/** New private configuration copies only; the original retired case and all original material files stay read-only. */
export async function createColdRegistrationCoreMaterialQaV1({directory,originalDirectory}){
 const root=resolve(directory),original=resolve(originalDirectory),read=async p=>JSON.parse(await readFile(p,'utf8'));await privateDirectory(root);
 const trust=await read(join(original,'cold-control/trust.json')),state=await readRuntimeColdReviewV3(trust),authority=await read(join(original,'authority-runtime.private.json'));
 const paths=new Map(),save=async(name,value)=>{const file=join(root,name);await privateNewFile(file,canonical(value));paths.set(name,file);return file;};
 const authorityFile=await save('authority.private.json',authority),http=new Map(),components=[];
 const first=await read(join(original,'acme-g.private.json')),authSource=resolve(original,first.authRuntimeFile),auth=await read(authSource),authKey=await read(resolve(dirname(authSource),auth.keyFile)),authKeyFile=await save('auth-key.private.json',authKey),authFile=await save('auth-runtime.private.json',{...auth,keyFile:authKeyFile});
 const predictor=await read(join(original,'predictor.private.json')),predictorFile=await save('predictor.private.json',predictor),workflowBase=await read(join(original,'flow-runtime-sealed.private.json')),cancel=await read(join(original,'flow-cancel.private.json')),reservation=await read(join(original,'flow-reservation.private.json'));
 const workflowEndpoints=new Set();
 for(const tenant of state.source.fullFacts.databases.filter(d=>d.map).map(d=>d.map.tenantId)){
  const writer=await read(join(original,tenant+'-worker.private.json')),sourceKey=resolve(original,writer.jobKeyFile),jobKey=await read(sourceKey),jobKeyFile=await save(tenant+'-job-key.private.json',jobKey),sources=writer.read.sources,common={authRuntimeFile:authFile,jobKeyFile};workflowEndpoints.add(writer.transport.workflow.baseUrl);
  for(const[kind,suffix]of[['GOVERNANCE','g'],['MAINTENANCE','m'],['PREDICTIVE','p'],['RECONCILIATION','r']]){
   const base=await read(join(original,tenant+'-'+suffix+'.private.json')),httpFile=await save(tenant+'-'+kind.toLowerCase()+'-http.private.json',{...base,...common});http.set(tenant+':'+kind,httpFile);components.push({tenantId:tenant,kind,mode:'HTTP',runtimeFile:httpFile});
   let worker;if(kind==='RECONCILIATION')worker={...writer,...common};else{
    worker={...base,...common,mode:'WORKER',business:structuredClone(writer.business),queue:{account:structuredClone(writer.queue.account),binding:{...base.queue.binding,roleOid:writer.business.binding.roleOid}}};delete worker.host;delete worker.port;
    if(kind==='GOVERNANCE'||kind==='PREDICTIVE')worker.sources=sources;
    if(kind==='MAINTENANCE'||kind==='PREDICTIVE')worker.workflow=writer.transport.workflow;
    if(kind==='PREDICTIVE')worker.predictor={baseUrl:'http://127.0.0.1:'+predictor.port,serviceToken:predictor.serviceToken};
   }
   const workerFile=await save(tenant+'-'+kind.toLowerCase()+'-worker.private.json',worker);components.push({tenantId:tenant,kind,mode:'WORKER',runtimeFile:workerFile});
  }
 }
 if(workflowEndpoints.size!==1)throw Error('QA_ORIGINAL_WORKFLOW_ENDPOINT_SPLIT');
 const tenantIds=[...new Set(components.map(c=>c.tenantId))].sort(),originalSite=await read(join(original,'site-base.private.json')),siteBase=await save('site-base.private.json',{...originalSite,members:tenantIds.map(t=>({governanceRuntimeFile:http.get(t+':GOVERNANCE'),maintenanceRuntimeFile:http.get(t+':MAINTENANCE')}))}),siteR3=await save('site-r3.private.json',{format:3,purpose:'SITE_CONSOLE_HTTP_R3',baseSiteRuntimeFile:siteBase,predictiveRuntimeFiles:tenantIds.map(t=>http.get(t+':PREDICTIVE'))}),siteR4=await save('site-r4.private.json',{format:4,purpose:'SITE_CONSOLE_HTTP_R4',baseSiteRuntimeFile:siteR3,reconciliationRuntimeFiles:tenantIds.map(t=>http.get(t+':RECONCILIATION'))}),siteFile=await save('site-authority.private.json',{format:1,purpose:'SITE_CONSOLE_AUTHORITY_V1',baseRuntimeFile:siteR4,authorityRuntimeFile:authorityFile});
 const runtimeFile=await save('workflow-runtime.private.json',workflowBase),cancelFile=await save('workflow-cancel.private.json',cancel),reservationFile=await save('workflow-reservation.private.json',reservation),program=state.source.proofs[0].binding;
 const declaration={format:1,purpose:'COLD_REGISTRATION_CORE_DEPLOYMENT_V1',binding:{controlId:trust.controlId,sourceHash:trust.sourceHash,recoveryId:state.details.review.recoveryId},authorityRuntimeFile:authorityFile,authRuntimeFile:authFile,siteFile,predictorRuntimeFile:predictorFile,components,workflows:[{tenantIds,baseUrl:[...workflowEndpoints][0],runtimeFile,cancelFile,reservationFile,jarFile:program.jar,jarSha256:program.jarSha256}]},configurationFile=await save('core-deployment.private.json',declaration);
 return{root,trust,state,declaration,configurationFile,paths,authority,config:{trust,recoveryId:state.details.review.recoveryId,configurationFile,roots:[resolve('.')],authority},http,components,async change(file,mutate){const value=await read(file);mutate(value);await import('node:fs/promises').then(fs=>fs.writeFile(file,canonical(value)));},async rotateJobKey(tenant){await this.change(paths.get(tenant+'-job-key.private.json'),v=>{v.keys[0].key=randomBytes(32).toString('base64url');});}};
}
