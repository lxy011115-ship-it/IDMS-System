import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {platformDependencyConfigV1,inspectPlatformDependencyFilesV1} from '../scripts/platform-dependency-config-v1.mjs';

const config=base=>({format:1,purpose:'PLATFORM_DEPENDENCIES_V1',workDirectory:join(base,'records'),postgres:[{id:'business',binDirectory:join(base,'pg-bin'),dataDirectory:join(base,'business-data'),workDirectory:join(base,'pg-records'),expectedSystemIdentifier:'7699793510957429456',port:24501,account:{user:'bootstrap',password:'a'.repeat(43),database:'postgres'}}],identity:{id:'identity',postgresId:'business',javaHome:join(base,'jdk'),keycloakDirectory:join(base,'kc'),workDirectory:join(base,'identity-records'),port:34501,database:{host:'127.0.0.1',port:24501,database:'identity_db',user:'identity_app',password:'b'.repeat(43)},admin:{username:'platform-admin',password:'c'.repeat(43)}},workflows:[{id:'workflow',postgresIds:['business'],javaHome:join(base,'jdk'),workDirectory:join(base,'workflow-records'),jarFile:join(base,'workflow.jar'),jarSha256:'1'.repeat(64),runtimeFile:join(base,'runtime.json'),cancelFile:null,reservationFile:null,port:24502}],applicationManifestFile:join(base,'applications.json')});

test('a dependency cannot be redirected to an undeclared identity database or management port',()=>{
 const c=config(resolve('work/platform-config-unit'));assert.equal(platformDependencyConfigV1(c).identity.postgresId,'business');
 c.identity.database.port=24503;assert.throws(()=>platformDependencyConfigV1(c),/PLATFORM_IDENTITY_DATABASE_ENDPOINT/);
 c.identity.database.port=24501;c.workflows[0].port=44501;assert.throws(()=>platformDependencyConfigV1(c),/PLATFORM_DEPENDENCY_PORT_COLLISION/);
});

test('external PID and arbitrary program injection are rejected before filesystem or process activity',()=>{
 const c=config(resolve('work/platform-config-unit'));c.postgres[0].pid=12345;assert.throws(()=>platformDependencyConfigV1(c),/PLATFORM_POSTGRES_FIELDS/);
 delete c.postgres[0].pid;c.command='arbitrary';assert.throws(()=>platformDependencyConfigV1(c),/PLATFORM_DEPENDENCY_FIELDS/);
 delete c.command;c.identity.admin.username=undefined;assert.throws(()=>platformDependencyConfigV1(c),/PLATFORM_IDENTITY_ACCOUNT/);
});

test('cross-component records and programs cannot lie in or contain any PGDATA',()=>{
 const c=config(resolve('work/platform-config-unit'));c.identity.workDirectory=join(c.postgres[0].dataDirectory,'identity');assert.throws(()=>platformDependencyConfigV1(c),/PLATFORM_RECORD_OR_PROGRAM_IN_PGDATA/);
 c.identity.workDirectory=resolve('work/platform-config-unit/identity-records');c.workDirectory=resolve('work/platform-config-unit');assert.throws(()=>platformDependencyConfigV1(c),/PLATFORM_RECORD_OR_PROGRAM_IN_PGDATA/);
});

test('nested clusters cannot be declared as two independent database owners',()=>{
 const c=config(resolve('work/platform-config-unit'));c.postgres.push({...c.postgres[0],id:'identity-pg',port:24503,dataDirectory:join(c.postgres[0].dataDirectory,'nested')});assert.throws(()=>platformDependencyConfigV1(c),/PLATFORM_POSTGRES_DIRECTORY_OVERLAP/);
});

test('every actual workflow credential file is checked; cancellation endpoints and tenant sets cannot escape declarations',async()=>{
 const base=await mkdtemp(join(tmpdir(),'idms-platform-config-'));try{
  const c=config(base);await mkdir(c.workDirectory);c.workflows[0].cancelFile=join(base,'cancel.json');
  const runtime={tenants:{acme:{jdbcUrl:'jdbc:postgresql://127.0.0.1:24501/flow_acme'}}};await writeFile(c.workflows[0].runtimeFile,JSON.stringify(runtime));
  const app={format:1,purpose:'RUNTIME_APPLICATION_SUITE_V1',registryDirectory:join(base,'app-records'),trustFile:join(base,'trust.json'),authorityRuntimeFile:join(base,'authority.json'),binding:{controlId:randomUUID(),sourceHash:'2'.repeat(64),authorityHash:'3'.repeat(64)},tenantIds:['acme'],components:[...['GOVERNANCE','MAINTENANCE','PREDICTIVE','RECONCILIATION'].map(kind=>({id:kind.toLowerCase(),kind,tenantId:'acme',runtimeFile:join(base,kind+'.json')})),{id:'site',kind:'SITE',tenantId:null,runtimeFile:join(base,'site.json')}]};await writeFile(c.applicationManifestFile,JSON.stringify(app));
  await writeFile(c.workflows[0].cancelFile,JSON.stringify({tenants:{acme:{jdbcUrl:'jdbc:postgresql://localhost:24501/flow_acme'}}}));await assert.rejects(inspectPlatformDependencyFilesV1(c),/PLATFORM_WORKFLOW_DATABASE_ENDPOINT/);
  await writeFile(c.workflows[0].cancelFile,JSON.stringify({tenants:{sandbox:{jdbcUrl:'jdbc:postgresql://127.0.0.1:24501/flow_acme'}}}));await assert.rejects(inspectPlatformDependencyFilesV1(c),/PLATFORM_WORKFLOW_TENANT_SET/);
  await writeFile(c.workflows[0].cancelFile,JSON.stringify(runtime));const result=await inspectPlatformDependencyFilesV1(c);assert.equal(result.pins.length,3);assert(result.pins.every(p=>/^[a-f0-9]{64}$/.test(p.sha256)));assert.equal(c.workflows[0].postgresIds[0],'business');
  await writeFile(c.workflows[0].cancelFile,'{"private": "sensitive-example-fragment" invalid}');await assert.rejects(inspectPlatformDependencyFilesV1(c),e=>e.message==='PLATFORM_DEPENDENCY_FILE_READ'&&!e.message.includes('sensitive-example-fragment'));
 }finally{await rm(base,{recursive:true});}
});
