import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {readdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {privateDirectory,privateNewFile} from '../scripts/backup-support.mjs';
import {createPlatformDependenciesV3} from '../scripts/platform-dependency-controller-v3.mjs';

test('startup cancellation before creation retains the controller API and produces zero owned services without touching PGDATA',async()=>{
 const base=resolve('work/platform-dependency-controller-unit-v3-20261023',randomUUID()),records=join(base,'records');await privateDirectory(records);
 const runtime=join(base,'flow.private.json'),appFile=join(base,'application.private.json'),trustFile=join(base,'trust.json'),authorityRuntimeFile=join(base,'authority.json');
 await privateNewFile(runtime,JSON.stringify({tenants:{acme:{jdbcUrl:'jdbc:postgresql://127.0.0.1:24501/flow_acme'}}}));
 const components=[...['GOVERNANCE','MAINTENANCE','PREDICTIVE','RECONCILIATION'].map(kind=>({id:kind.toLowerCase(),kind,tenantId:'acme',runtimeFile:join(base,kind+'.json')})),{id:'site',kind:'SITE',tenantId:null,runtimeFile:join(base,'site.json')}];
 for(const file of [trustFile,authorityRuntimeFile,...components.map(c=>c.runtimeFile)])await privateNewFile(file,'{}');
 await privateNewFile(appFile,JSON.stringify({format:1,purpose:'RUNTIME_APPLICATION_SUITE_V1',registryDirectory:join(base,'application-records'),trustFile,authorityRuntimeFile,binding:{controlId:randomUUID(),sourceHash:'1'.repeat(64),authorityHash:'2'.repeat(64)},tenantIds:['acme'],components}));
 const config={format:1,purpose:'PLATFORM_DEPENDENCIES_V1',workDirectory:records,postgres:[{id:'business',binDirectory:join(base,'pg-bin-not-created'),dataDirectory:join(base,'pg-data-not-created'),workDirectory:join(base,'pg-records-not-created'),expectedSystemIdentifier:'7699793510957429456',port:24501,account:{user:'bootstrap',password:'a'.repeat(43),database:'postgres'}}],identity:{id:'identity',postgresId:'business',javaHome:join(base,'jdk-not-created'),keycloakDirectory:join(base,'kc-not-created'),workDirectory:join(base,'identity-records-not-created'),port:34501,database:{host:'127.0.0.1',port:24501,database:'identity_db',user:'identity_app',password:'b'.repeat(43)},admin:{username:'platform-admin',password:'c'.repeat(43)}},workflows:[{id:'flow',postgresIds:['business'],javaHome:join(base,'jdk-not-created'),workDirectory:join(base,'workflow-records-not-created'),jarFile:join(base,'workflow-not-created.jar'),jarSha256:'3'.repeat(64),runtimeFile:runtime,cancelFile:null,reservationFile:null,port:24502}],applicationManifestFile:appFile};
 const controller=new AbortController();controller.abort();const api=await createPlatformDependenciesV3(config,{startupSignal:controller.signal});assert.equal(typeof api.close,'function');await assert.rejects(api.ready,/PLATFORM_DEPENDENCY_START_CANCELLED/);
 const done=await api.closed;assert(done.normal&&done.startupCancelled&&done.allOwnedResourcesRetired);assert.equal(done.componentsCreated,0);assert.equal(done.fullyReady,false);assert.deepEqual(api.resources(),[]);assert.equal(api.status().phase,'CLOSED');assert.deepEqual(await api.close(),done);assert.throws(()=>api.close({requestId:randomUUID()}),/PLATFORM_DEPENDENCY_STOP_REQUEST_CHANGED/);
 const names=await readdir(base);assert(!names.some(n=>n.includes('not-created')));await privateNewFile(join(base,'verification.json'),JSON.stringify({scope:'CANCEL_BEFORE_ANY_SERVICE_CREATION',componentsCreated:0,noPgDataOrProgramsCreated:true,result:done,fullStackNativeVerified:false,fullGoalComplete:false}));
 const before=await readdir(records),target=components[0].runtimeFile;try{await writeFile(target,'{"password":"sensitive-private-graph-fragment" invalid}');await assert.rejects(createPlatformDependenciesV3(config,{startupSignal:controller.signal}),e=>e.message==='PLATFORM_DEPENDENCY_FAILURE'&&!e.message.includes('sensitive-private-graph-fragment'));assert.deepEqual(await readdir(records),before);}finally{await writeFile(target,'{}');}
});
