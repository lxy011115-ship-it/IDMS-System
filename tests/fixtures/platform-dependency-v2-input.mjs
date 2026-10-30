import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateDirectory,privateNewFile} from '../../scripts/backup-support.mjs';

export function dependencyV2Config(base){return{format:2,purpose:'PLATFORM_DEPENDENCIES_V2',workDirectory:join(base,'records'),postgres:[{id:'business',binDirectory:join(base,'pg-bin-not-created'),dataDirectory:join(base,'pg-data-not-created'),workDirectory:join(base,'pg-records-not-created'),expectedSystemIdentifier:'7699793510957429456',port:24501,account:{user:'bootstrap',password:'a'.repeat(43),database:'postgres'}}],identity:{id:'identity',postgresId:'business',javaHome:join(base,'jdk-not-created'),keycloakDirectory:join(base,'kc-not-created'),workDirectory:join(base,'id-records-not-created'),port:34501,database:{host:'127.0.0.1',port:24501,database:'identity_db',user:'identity_app',password:'b'.repeat(43)},admin:{username:'platform-admin',password:'c'.repeat(43)}},workflows:[{id:'flow',postgresIds:['business'],javaHome:join(base,'jdk-not-created'),workDirectory:join(base,'flow-records-not-created'),jarFile:join(base,'workflow-not-created.jar'),jarSha256:'3'.repeat(64),runtimeFile:join(base,'flow.json'),cancelFile:null,reservationFile:null,port:24502}],predictor:{id:'rule-predictor',port:24503,runtimeFile:join(base,'predictor.json'),workDirectory:join(base,'predictor-records-not-created')},applicationManifestFile:join(base,'applications.json')};}

export async function dependencyV2Files(label){
 const base=resolve('work/platform-dependency-v2-unit-20261024',label+'-'+randomUUID()),config=dependencyV2Config(base);await privateDirectory(config.workDirectory);
 const write=(file,value)=>privateNewFile(file,JSON.stringify(value)),trustFile=join(base,'trust.json'),authorityRuntimeFile=join(base,'authority.json');
 await write(trustFile,{});await write(authorityRuntimeFile,{});await write(config.workflows[0].runtimeFile,{tenants:{acme:{jdbcUrl:'jdbc:postgresql://127.0.0.1:24501/flow_acme'}}});
 const serviceToken=randomUUID()+randomUUID();await write(config.predictor.runtimeFile,{format:1,purpose:'PREDICTOR_SERVICE',host:'127.0.0.1',port:24503,serviceToken});
 const members=[],bases=[];
 for(const tenant of ['acme','sandbox'])for(const kind of ['GOVERNANCE','MAINTENANCE','PREDICTIVE','RECONCILIATION']){
  const runtimeFile=join(base,tenant+'-'+kind+'.json');members.push({id:tenant+'-'+kind.toLowerCase(),kind,tenantId:tenant,runtimeFile});
  if(kind==='PREDICTIVE'){
   const baseRuntimeFile=join(base,tenant+'-predictor-base.json'),value={mode:'WORKER',business:{binding:{tenantId:tenant}},predictor:{baseUrl:'http://127.0.0.1:24503',serviceToken}};
   await write(baseRuntimeFile,value);await write(runtimeFile,{format:1,purpose:'RUNTIME_COLD_BACKGROUND_V1',kind,baseRuntimeFile,authorityRuntimeFile,trustFile});bases.push({tenant,file:baseRuntimeFile,value,wrapperFile:runtimeFile});
  }else await write(runtimeFile,{});
 }
 const siteFile=join(base,'site.json');await write(siteFile,{});members.push({id:'site',kind:'SITE',tenantId:null,runtimeFile:siteFile});
 await write(config.applicationManifestFile,{format:1,purpose:'RUNTIME_APPLICATION_SUITE_V1',registryDirectory:join(base,'app-records'),trustFile,authorityRuntimeFile,binding:{controlId:randomUUID(),sourceHash:'1'.repeat(64),authorityHash:'2'.repeat(64)},tenantIds:['acme','sandbox'],components:members});
 return{base,config,bases,serviceToken};
}
