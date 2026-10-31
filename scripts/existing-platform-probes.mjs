import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import mqtt from 'mqtt';
import {runtimeHttpJson} from '../server/runtime-http.ts';
import {verifyDatabaseSecurity,validateRuntimeConfig} from '../server/postgres-security.ts';
import {authRegistryFile,validateAuthRuntime,businessBinding,verifyAuthStore} from '../server/auth-store.ts';
import {validateKeyRing} from '../server/auth-state.ts';
import {need,sha,jsonFile} from './existing-platform-binding.mjs';
export async function databaseRead(config,work){
 const client=new pg.Client({...config,connectionTimeoutMillis:2000,statement_timeout:15000,query_timeout:20000});
 try{await client.connect();await client.query('BEGIN READ ONLY');need((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only==='on','DATABASE_READ_ONLY_REQUIRED');const result=await work(client);await client.query('ROLLBACK');return result;}finally{await client.end().catch(()=>{});}
}
export async function verifyExistingStores(binding){
 const b=validateRuntimeConfig(await jsonFile(binding.files.business.path));
 for(const [id,a]of Object.entries(b.tenants))await databaseRead({host:b.host,port:b.port,...a},c=>verifyDatabaseSecurity(c,a,id));
 const auth=validateAuthRuntime(await jsonFile(authRegistryFile(b)),businessBinding(b)),ring=validateKeyRing(await jsonFile(auth.keyFile));
 await databaseRead({host:auth.host,port:auth.port,...auth.account},c=>verifyAuthStore(c,auth,ring));
 const identity=await jsonFile(binding.files.identity.path);
 await databaseRead({host:b.host,port:b.port,...identity.database},async c=>{
  need((await c.query('SELECT count(*)::int AS n FROM public.realm WHERE name=ANY($1::text[])',[['master',identity.realm]])).rows[0].n===2,'IDENTITY_REALM_MISSING');
  const versions=(await c.query('SELECT version FROM public.migration_model')).rows;need(versions.length===1&&versions[0].version==='26.8.1','IDENTITY_MIGRATION_REQUIRED');
 });
}
async function brokerReady(config){return new Promise(ok=>{
 const c=mqtt.connect(config.mqtt.url,{username:config.mqtt.username,password:config.mqtt.password,clientId:'idms-startup-'+randomUUID(),connectTimeout:1500,reconnectPeriod:0,protocolVersion:5});let done=false;
 const finish=v=>{if(done)return;done=true;clearTimeout(timer);c.end(true,()=>ok(v));};const timer=setTimeout(()=>finish(false),2000);c.once('connect',()=>finish(true));c.on('error',()=>finish(false));
});}
export async function serviceProbe(binding,name){
 const load=key=>jsonFile(binding.files[key].path),http=(url,headers={})=>runtimeHttpJson(url,{headers,timeoutMs:1500,maxBytes:65536});
 try{switch(name){
 case 'database': {const r=await load('database');return await databaseRead({host:r.host,port:r.port,database:'postgres',user:'idms_bootstrap',password:r.bootstrapPassword},async c=>{
  const value=(await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0];const path=(await c.query('SHOW data_directory')).rows[0].data_directory;return value.id===binding.identity.systemIdentifier&&resolve(path)===binding.identity.data;
 });}
 case 'identity': {const c=await load('identity');return (await http(c.origin+'/realms/'+c.realm+'/.well-known/openid-configuration')).issuer===c.origin+'/realms/'+c.realm;}
 case 'broker': return await brokerReady(await load('telemetry'));
 case 'workflow': {const c=await load('workflowClient'),digest=sha(await readFile('services/workflow/src/main/resources/maintenance-v1.bpmn20.xml'));for(const [t,a]of Object.entries(c.tenants)){const s=await http(c.baseUrl+'/v1/status',{Authorization:'Bearer '+a.serviceToken,'X-IDMS-Tenant':t});if(s.engine!=='Flowable'||s.version!=='7.2.0'||s.startupContract!=='IDMS_EXISTING_WORKFLOW_V1'||s.startupMode!=='runtime'||s.definitionVersion!==1||s.definitionDigest!==digest||!s.definitionId)return false;}return true;}
 case 'model': {const c=await load('ai'),version=await http(c.modelUrl+'/api/version'),tags=await http(c.modelUrl+'/api/tags');return version.version==='0.40.4'&&tags.models?.some(m=>m.name===c.model.name&&'sha256:'+m.digest.replace(/^sha256:/,'')===c.model.digest);}
 case 'ai': {const c=await load('aiClient');for(const[t,a]of Object.entries(c.tenants)){const s=await http(c.baseUrl+'/v1/status',{Authorization:'Bearer '+a.serviceToken,'X-IDMS-Tenant':t});if(s.service!=='IDMS_AI_GATEWAY'||s.mode!=='SHADOW'||!s.modelReady||s.model.digest!==c.model.digest)return false;}return true;}
 case 'predictor': {const s=await http('http://127.0.0.1:4012/health');return s.status==='UP'&&s.algorithm==='engineering-rule'&&s.rulAvailable===false;}
 case 'main': {const token=(await readFile(binding.files.serviceToken.path,'utf8')).trim(),s=await http('http://127.0.0.1:4010/api/v1/runtime/status',{Authorization:'Bearer '+token});return s.startup?.contract==='IDMS_EXISTING_MAIN_V1'&&s.startup.telemetryConnected&&s.startup.telemetrySubscribed&&!s.startup.telemetryClosing&&s.resourceCode==='CHECK_PASSED';}
 case 'simulator': {const c=await load('telemetry');return (await http('http://127.0.0.1:4015/status',{Authorization:'Bearer '+c.simulator.statusKey})).origin==='SIMULATOR';}
 case 'edge': {const c=await load('telemetry'),s=c.sources[0],r=await http(s.statusUrl,{Authorization:'Bearer '+s.statusKey});return r.edgeId===s.edgeId&&r.tenantId===s.tenantId&&r.origin==='SIMULATOR'&&r.mode==='READ_ONLY_POLL'&&r.mqttConnected&&r.opcConnected;}
 default:return false;
 }}catch{return false;}
}
