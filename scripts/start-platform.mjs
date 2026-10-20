import { spawn,execFile } from 'node:child_process';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { localConfig } from './keycloak-local.mjs';
import { createMqttConfig,launchBroker } from './mqtt-local.mjs';
import { setupWorkflow,buildWorkflow,launchWorkflow,workflowReady } from './workflow-local.mjs';
import {setupAi,launchOllama,stopOllama,ollamaReady,launchAi,aiReady} from './ai-local.mjs';
import { resolve } from 'node:path';
import net from 'node:net';
const exec=promisify(execFile);
await exec(process.execPath,['scripts/bootstrap-postgres.mjs'],{windowsHide:true});
await exec(process.execPath,['scripts/keycloak-local.mjs'],{windowsHide:true,timeout:300000});
const identity=await localConfig();
await mkdir('.local',{recursive:true});
let token;try{token=(await readFile('.local/service-token','utf8')).trim();}catch(e){if(e.code!=='ENOENT')throw e;}
if(!token){token=randomBytes(32).toString('base64url');await writeFile('.local/service-token',token,{mode:0o600});if(process.platform==='win32')await exec('icacls.exe',['.local/service-token','/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`],{windowsHide:true});}
const mqttRuntime=await createMqttConfig(resolve('.local/mqtt'));
const workflowRuntime=await setupWorkflow();
await exec(process.execPath,['scripts/migrate-postgres.mjs','--telemetry-tenants',[...new Set(mqttRuntime.config.sources.map(s=>s.tenantId))].join(',')],{windowsHide:true,env:{...process.env,IDMS_STORAGE:'file'}});
await exec(process.execPath,['scripts/auth-session-store.mjs'],{windowsHide:true});
const env={...process.env,IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:resolve('.local/postgres-business.json'),IDMS_SERVICE_TOKEN:token,IDMS_PREDICTOR_URL:'http://127.0.0.1:4012',IDMS_AUTH_MODE:'oidc',IDMS_OIDC_ISSUER:identity.origin+'/realms/'+identity.realm,IDMS_OIDC_CLIENT_ID:'idms-web',IDMS_OIDC_AUDIENCE:'idms-api',IDMS_PUBLIC_ORIGIN:'http://127.0.0.1:4010',IDMS_TELEMETRY_CONFIG:mqttRuntime.file,IDMS_WORKFLOW_CLIENT_CONFIG:workflowRuntime.clientFile,IDMS_AI_CLIENT_CONFIG:resolve('.local/ai/client.json')};
const children=[];
function run(file){const child=spawn(process.execPath,[file],{env,stdio:['ignore','inherit','inherit'],windowsHide:true});children.push(child);child.once('error',e=>{console.error(e.message);shutdown(1);});child.once('exit',code=>{if(!closing)shutdown(code||1);});return child;}
let closing=false,ownedModel;
function shutdown(code=0){if(closing)return;closing=true;for(const child of children)if(child!==ownedModel)child.kill();if(ownedModel)void stopOllama(ownedModel).catch(()=>{console.error('Local model process tree shutdown unconfirmed; inspect owned runtime PID before restarting');});process.exitCode=code;}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>shutdown());
async function occupied(port){return new Promise(r=>{const socket=net.connect(port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();r(true);});socket.once('error',()=>r(false));});}
function watch(child){children.push(child);for(const stream of [child.stdout,child.stderr])stream.on('data',b=>process.stderr.write(b));child.once('error',()=>shutdown(1));child.once('exit',()=>{if(!closing)shutdown(1);});return child;}
try{
  if(!await ollamaReady()){
    if(await occupied(11435))throw Error('Model port occupied by an unverified runtime; refusing to displace it');
    const model=watch(launchOllama());ownedModel=model;let ready=false;
    for(let i=0;i<100;i++){if(model.exitCode!==null)break;if(await ollamaReady()){ready=true;break;}await new Promise(r=>setTimeout(r,200));}
    if(!ready)throw Error('Local model runtime startup not confirmed');
  }
  const runtime=await setupAi();
  if(!await aiReady(runtime.client)){
    if(await occupied(4018))throw Error('AI gateway port occupied by an unverified instance');
    const gateway=watch(launchAi(runtime.file));let ready=false;
    for(let i=0;i<100;i++){if(gateway.exitCode!==null)break;if(await aiReady(runtime.client)){ready=true;break;}await new Promise(r=>setTimeout(r,200));}
    if(!ready)throw Error('AI gateway startup not confirmed');
  }
}catch(e){shutdown(1);throw e;}
if(!(await workflowReady(workflowRuntime.client))){
  const inUse=await new Promise(r=>{const socket=net.connect(4016,'127.0.0.1');socket.once('connect',()=>{socket.destroy();r(true);});socket.once('error',()=>r(false));});
  if(inUse)throw Error('Workflow port occupied by an unverified instance; refusing to displace it');
  await buildWorkflow();
  const workflow=launchWorkflow(workflowRuntime.file);children.push(workflow);
  for(const stream of [workflow.stdout,workflow.stderr])stream.on('data',b=>process.stderr.write(b));
  workflow.once('error',()=>shutdown(1));workflow.once('exit',()=>{if(!closing)shutdown(1);});
  let workflowOnline=false;
  for(let i=0;i<120;i++){if(workflow.exitCode!==null)break;if(await workflowReady(workflowRuntime.client)){workflowOnline=true;break;}await new Promise(r=>setTimeout(r,500));}
  if(!workflowOnline){shutdown(1);throw Error('Workflow startup not confirmed; inspect logs and process before retrying');}
}
const predictor=run('services/predictor/index.ts');
let ready=false;for(let i=0;i<100;i++){if(predictor.exitCode!==null)break;try{if((await fetch('http://127.0.0.1:4012/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
if(!ready){shutdown(1);throw Error('Independent predictor startup failed');}
const brokerOccupied=await occupied(Number(new URL(mqttRuntime.config.mqtt.url).port));
if(brokerOccupied){shutdown(1);throw Error('MQTT port already occupied; refusing to start another broker or displace a current core session');}
const broker=launchBroker(mqttRuntime.brokerFile);children.push(broker);for(const stream of [broker.stdout,broker.stderr])stream.on('data',b=>process.stderr.write(b));broker.once('error',()=>shutdown(1));broker.once('exit',()=>{if(!closing)shutdown(1);});
run('services/edge/simulator.ts');
run('services/edge/index.ts');
run('server/index.ts');
console.log('IDMS development platform: http://127.0.0.1:4010/?view=predictive');
console.log('PostgreSQL + Keycloak/OIDC + Flowable + predictor + MQTT + read-only OPC UA + local AI SHADOW gateway enabled. Simulator belongs to sandbox only. Private initial accounts: .local/本机登录账户.txt. Development only; production acceptance remains open.');
