import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {resolve,isAbsolute} from 'node:path';
import {FieldRecoveryControlOperation} from './field-recovery-control.mjs';
import {readBoundedFieldFile} from '../services/field/profile.ts';
import {fieldMaintenanceFence,readMaintenanceJson,fieldMaintenanceAuth} from './field-maintenance-record.mjs';
import {recoveryExternalConfig} from './field-recovery-external-config.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const code=e=>typeof e?.code==='string'&&/^FIELD_[A-Z0-9_]+$/.test(e.code)?e.code:'FIELD_MAINTENANCE_REVIEW_FAILED';
const keys=['format','tenantId','operationId','controlFile','authorityConfig','runtimeConfig','targetRuntimeConfig','targetMigrationConfig','targetBackupConfig','backupFile','keyFile','externalConfig','authConfig','outputDirectory'];
export async function startFieldMaintenanceSupervisor({configFile,expectedSha256}){
 if(process.env.NODE_ENV==='production')fail('FIELD_MAINTENANCE_PRODUCTION_GATE_PENDING');
 configFile=resolve(configFile);const raw=await readMaintenanceJson(configFile),registered=raw.format==='idms-field-maintenance-supervisor-v2',configKeys=[...keys,...(registered?['registrationConfig']:[])];if(sourceFreezeSha(raw)!==expectedSha256||!registered&&raw.format!=='idms-field-maintenance-supervisor-v1'||Object.keys(raw).length!==configKeys.length||configKeys.some(k=>!Object.hasOwn(raw,k))||!/^[A-Za-z0-9_-]{1,80}$/.test(raw.tenantId)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(raw.operationId))fail('FIELD_MAINTENANCE_SUPERVISOR_CONFIG_INVALID');
 for(const k of configKeys.filter(k=>!['format','tenantId','operationId'].includes(k)))if(typeof raw[k]!=='string'||!isAbsolute(raw[k])||resolve(raw[k])!==raw[k])fail('FIELD_MAINTENANCE_SUPERVISOR_CONFIG_INVALID');
 const pins=new Map(),values={};for(const k of ['authorityConfig','runtimeConfig','targetRuntimeConfig','targetMigrationConfig','targetBackupConfig','externalConfig','authConfig','keyFile',...(registered?['registrationConfig']:[])]){const bytes=await readBoundedFieldFile(raw[k],2097152);pins.set(k,sourceFreezeSha(bytes.toString('base64')));if(k!=='keyFile')values[k]=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 const auth=fieldMaintenanceAuth(values.authConfig,true),external=recoveryExternalConfig(values.externalConfig),{clientSecret:_,...publicAuth}=auth;if(external.tenantId!==raw.tenantId||sourceFreezeSha(publicAuth)!==sourceFreezeSha(external.auth))fail('FIELD_MAINTENANCE_SUPERVISOR_AUTH_MISMATCH');
 const check=async()=>{if(sourceFreezeSha(await readMaintenanceJson(configFile))!==expectedSha256)fail('FIELD_MAINTENANCE_SUPERVISOR_CONFIG_CHANGED');for(const [k,sha]of pins)if(sourceFreezeSha((await readBoundedFieldFile(raw[k],2097152)).toString('base64'))!==sha)fail('FIELD_MAINTENANCE_SUPERVISOR_CONFIG_CHANGED');};
 const options={...(registered?{registrationConfig:raw.registrationConfig}:{}),targetRuntime:values.targetRuntimeConfig,targetMigration:values.targetMigrationConfig,targetBackup:values.targetBackupConfig,backupFile:raw.backupFile,keyFile:raw.keyFile},prepareOptions={...options,authConfig:auth,outputDirectory:raw.outputDirectory};
 const readerHistory=[];let current,child,childDone,active=null,closing=false,closeJob,watch,checking=false;
 const withOperation=async fn=>{await check();const op=new FieldRecoveryControlOperation({authority:values.authorityConfig,runtime:values.runtimeConfig,tenantId:raw.tenantId,controlFile:raw.controlFile});try{await op.open();const result=await fn(op);await check();return result;}finally{await op.close();}};
 async function stopChild(){if(!child)return;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await childDone;child=null;}
 async function close(){if(closeJob)return closeJob;closing=true;clearInterval(watch);closeJob=(async()=>{await active?.catch(()=>{});await stopChild();})();return closeJob;}
 async function launch(prepared){
  await check();current={prepared,cap:await readMaintenanceJson(prepared.capabilityFile)};const nonce=randomBytes(32).toString('hex'),env={...process.env};for(const k of Object.keys(env))if(/^IDMS_/i.test(k))delete env[k];
  const owned=fork(resolve('scripts/field-maintenance.mjs'),['--config',prepared.configFile,'--expected-sha256',prepared.configSha256,'--review-bridge'],{windowsHide:true,env,stdio:['ignore','pipe','pipe','ipc']});child=owned;const lifecycle={pid:owned.pid,closed:false};readerHistory.push(lifecycle);if(readerHistory.length>128)readerHistory.shift();let expectedExit=false,output='',timer;
  childDone=new Promise(ok=>owned.once('close',(exitCode,signal)=>{lifecycle.closed=true;lifecycle.exitCode=exitCode;lifecycle.signal=signal;if(!closing&&!expectedExit){closing=true;clearInterval(watch);}ok({exitCode,signal});}));
  const ready=new Promise((ok,no)=>{timer=setTimeout(()=>no(Error('Reader startup timeout')),30000);owned.once('error',no);owned.once('close',()=>no(Error('Reader closed during startup')));owned.stdout.on('data',b=>{output=(output+b.toString()).slice(-4096);if(output.includes('idms-field-maintenance-listening-v1'))ok();});});owned.stderr.resume();
  owned.on('message',m=>{
   if(m?.type==='FIELD_MAINTENANCE_BRIDGE_READY'){owned.send({type:'FIELD_MAINTENANCE_BRIDGE_INIT',nonce});return;}
   if(m?.type!=='FIELD_MAINTENANCE_REVIEW')return;
   if(!['SUBMIT','APPROVE'].includes(m.action)||typeof m.accessToken!=='string'||m.accessToken.length>32768||!m.accessToken||active||closing||m.nonce!==nonce||m.capabilitySha256!==prepared.capabilitySha256||typeof m.id!=='string'||!/^[a-f0-9-]{36}$/.test(m.id)||Buffer.byteLength(JSON.stringify(m))>65536){close().catch(()=>{});return;}
   active=(async()=>{
    let result,error,next;
    try{await withOperation(async op=>{try{result=await op.review(raw.operationId,{...options,action:m.action,planId:m.planId,expectedFactsSha256:m.expectedFactsSha256,supersedesPlanId:m.supersedesPlanId??null,externalConfig:external,accessToken:m.accessToken,assertConfiguration:check});}catch(e){error=code(e);try{await fieldMaintenanceFence(current.cap);return;}catch{}}
     next=await op.prepareMaintenance(raw.operationId,prepareOptions);
    });await check();
    }catch(e){error=code(e);expectedExit=true;owned.send({type:'FIELD_MAINTENANCE_REVIEW_REPLY',nonce,id:m.id,value:{ok:false,code:error,rotation:true,unavailable:true}});await childDone;closing=true;clearInterval(watch);return;}
    expectedExit=!!next;
    if(owned.connected)owned.send({type:'FIELD_MAINTENANCE_REVIEW_REPLY',nonce,id:m.id,value:{ok:!error,...(error?{code:error}:{}),rotation:!!next,...(result?{stage:result.stage,planId:result.planId}: {})}});
    if(next){await childDone;child=null;if(!closing)await launch(next);}
   })().catch(()=>{closing=true;clearInterval(watch);if(owned.exitCode===null)owned.kill('SIGTERM');}).finally(()=>{active=null;});
  });
  try{await ready;}catch(e){await stopChild();throw e;}finally{clearTimeout(timer);}
 }
 try{const prepared=await withOperation(op=>op.prepareMaintenance(raw.operationId,prepareOptions));await launch(prepared);watch=setInterval(async()=>{if(checking||closing)return;checking=true;try{await check();}catch{close().catch(()=>{});}finally{checking=false;}},1000);watch.unref();return {origin:auth.origin,operationId:raw.operationId,close,get readerHistory(){return readerHistory.map(row=>({...row}));},get closing(){return closing;}};}catch(e){await close();throw e;}
}
