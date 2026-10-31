import {join,resolve,dirname} from 'node:path';
import {readFile} from 'node:fs/promises';
import {existingIdentityCommand} from './keycloak-runtime.mjs';
import {need} from './existing-platform-binding.mjs';
export async function serviceCommand(binding,name){
 const file=key=>binding.files[key].path;
 const root=JSON.parse(await readFile(file('database'),'utf8')),id=JSON.parse(await readFile(file('identity'),'utf8'));
 const env={};for(const key of ['SystemRoot','WINDIR','ComSpec','USERPROFILE','USERNAME','USERDOMAIN','TEMP','TMP','PATH','PATHEXT','APPDATA','ALLUSERSPROFILE','PROGRAMDATA'])if(process.env[key])env[key]=process.env[key];
 env.LOCALAPPDATA=dirname(dirname(binding.runtime));
 env.IDMS_EXISTING_ONLY='1';
 Object.assign(env,{IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:file('business'),IDMS_SERVICE_TOKEN:(await readFile(file('serviceToken'),'utf8')).trim(),IDMS_PREDICTOR_URL:'http://127.0.0.1:4012',IDMS_AUTH_MODE:'oidc',IDMS_OIDC_ISSUER:id.origin+'/realms/'+id.realm,IDMS_OIDC_CLIENT_ID:'idms-web',IDMS_OIDC_AUDIENCE:'idms-api',IDMS_PUBLIC_ORIGIN:'http://127.0.0.1:4010',IDMS_TELEMETRY_CONFIG:file('telemetry'),IDMS_WORKFLOW_CLIENT_CONFIG:file('workflowClient'),IDMS_AI_CLIENT_CONFIG:file('aiClient'),IDMS_READINESS_CONFIG:file('readiness'),PORT:'4010'});
 const node=script=>({executable:process.execPath,args:[resolve(script)],env,cwd:resolve('.')});
 switch(name){
  case 'database': return {executable:file('pgCtl'),args:['start','-D',binding.identity.data,'-w','-t','60','-o',`-h 127.0.0.1 -p ${root.port}`],env,cwd:binding.runtime};
  case 'identity': {const c=existingIdentityCommand(id,root,{runtimeRoot:binding.runtime});c.env={...env,...Object.fromEntries(Object.entries(c.env).filter(([k])=>k.startsWith('KC_')||k==='JAVA_HOME'))};return c;}
  case 'broker': return {executable:file('brokerExe'),args:['-c',file('broker')],env,cwd:resolve('.')};
  case 'workflow': return {executable:file('java'),args:['-Xms64m','-Xmx384m','-Dfile.encoding=UTF-8','-jar',file('workflowJar'),'--server.address=127.0.0.1','--server.port=4016'],env:{...env,IDMS_WORKFLOW_CONFIG:file('workflow'),IDMS_WORKFLOW_STARTUP_MODE:'runtime'},cwd:resolve('.')};
  case 'model': return {executable:file('ollama'),args:['serve'],env:{...env,OLLAMA_HOST:'127.0.0.1:11435',OLLAMA_MODELS:join(dirname(binding.runtime),'models'),OLLAMA_NO_CLOUD:'1',OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_CONTEXT_LENGTH:'8192'},cwd:resolve('.')};
  case 'ai': return {...node('services/ai-gateway/index.ts'),env:{...env,IDMS_AI_GATEWAY_CONFIG:file('ai'),IDMS_AI_GATEWAY_PORT:'4018'}};
  case 'predictor': return node('services/predictor/index.ts');
  case 'main': return node('server/index.ts');
  case 'simulator': return node('services/edge/simulator.ts');
  case 'edge': return node('services/edge/index.ts');
  default: need(false,'SERVICE_NAME_INVALID');
 }
}
