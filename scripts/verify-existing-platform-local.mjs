// Read-only verification of the currently registered local platform. No login or mutation requests.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {loadExistingBinding,sha} from './existing-platform-binding.mjs';
import {runtimeHttpJson} from '../server/runtime-http.ts';
const binding=await loadExistingBinding(),run=JSON.parse(await readFile('.local/platform-startup/latest.json','utf8'));
assert.equal(run.status,'STARTED');assert.equal(run.structureAndPrivilegesUnchanged,true);
const base='http://127.0.0.1:4010',token=(await readFile(binding.files.serviceToken.path,'utf8')).trim();
const html=await fetch(base+'/',{redirect:'error',signal:AbortSignal.timeout(3000)});assert.equal(html.status,200);assert.match(await html.text(),/IDMS/);
const issuer=await runtimeHttpJson('http://127.0.0.1:8081/realms/idms/.well-known/openid-configuration');assert.equal(issuer.issuer,'http://127.0.0.1:8081/realms/idms');
const detail=await runtimeHttpJson(base+'/api/v1/runtime/status',{headers:{Authorization:'Bearer '+token}});assert.equal(detail.startup.contract,'IDMS_EXISTING_MAIN_V1');assert.equal(detail.startup.telemetrySubscribed,true);assert.equal(detail.resourceCode,'CHECK_PASSED');
const ready=await fetch(base+'/api/v1/ready',{redirect:'error',signal:AbortSignal.timeout(3000)}),readiness=await ready.json();assert([200,503].includes(ready.status));assert.equal(readiness.productionApproved,false);
const assets=[];
for(const file of ['manual.js','workspace.css','workspace-navigation.js','spares-ui.js','spares-insights-controller.js','spares-history-ui.js','roadshow-ui.js','import-assistance-ui.js','spares-paged-ui.js']){
 const bytes=await readFile(join('public',file)),response=await fetch(base+'/'+file,{redirect:'error',signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);const actual=Buffer.from(await response.arrayBuffer());assert(actual.equals(bytes));assets.push({file,bytes:actual.length,sha256:sha(actual)});
}
const result={observedAt:new Date().toISOString(),runId:run.runId,ordinaryRuntimeRecovered:true,html:200,identityIssuerMatched:true,maintenanceContractPassed:true,liveMainResources:detail.resources,readinessHttp:ready.status,readiness,dependencies:detail.rows,assets,structureAndPrivilegesUnchanged:true,queueBefore:run.before.queue,queueAfter:run.after.queue,businessBefore:Object.fromEntries(Object.entries(run.before.databases).filter(([,v])=>v.businessRevisions).map(([k,v])=>[k,v.businessRevisions])),businessAfter:Object.fromEntries(Object.entries(run.after.databases).filter(([,v])=>v.businessRevisions).map(([k,v])=>[k,v.businessRevisions])),artificialEnterpriseWrites:0,accountOrPasswordChanges:0,productionApproved:false};
const directory=resolve('work/existing-platform-20261031/local-'+randomBytes(6).toString('hex'));await mkdir(directory,{recursive:true});await writeFile(join(directory,'verification.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({html:200,identity:true,maintenance:true,assets:assets.length,readiness:ready.status,dependencyCodes:detail.rows.filter(r=>r.status!=='PASS').map(r=>({component:r.component,status:r.status,code:r.code})),evidence:directory,productionApproved:false}));
