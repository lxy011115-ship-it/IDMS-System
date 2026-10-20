import {flags} from './backup-support.mjs';
import {fieldSha256} from '../integrations/field-profile.ts';
import {readActivationMaterialFile} from './field-activation-material-files.mjs';
import {executeFieldActivation} from './field-activation-coordinator.mjs';
const keys=['--action','--authority-config','--runtime-config','--target-runtime-config','--target-migration-config','--target-backup-config','--backup-file','--key-file','--control-file','--operation-id','--attempt-id','--plan-id','--tenant','--registration-config','--material-configuration','--external-config','--access-token-file','--expected-facts-sha256'];
let args;
try{
 args=flags(process.argv.slice(2),keys);
 if(keys.filter(k=>k!=='--expected-facts-sha256').some(k=>!args[k])||!['activate','recover'].includes(args['--action'])||args['--action']==='activate'&&!args['--expected-facts-sha256'])throw Error();
 const pins=new Map(),read=async(key,max=2097152)=>{const bytes=await readActivationMaterialFile(args[key],max);try{pins.set(key,{max,sha256:fieldSha256(bytes)});return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}finally{bytes.fill(0);}},json=async key=>JSON.parse(await read(key));
 const authority=await json('--authority-config'),rawRuntime=await json('--runtime-config'),targetRuntime=await json('--target-runtime-config'),targetMigration=await json('--target-migration-config'),targetBackup=await json('--target-backup-config'),externalConfig=await json('--external-config'),accessToken=(await read('--access-token-file',32768)).trim();
 // Pin the private path containers too. Actual leaf materials are inspected
 // by the short-lived capability inside prepare, never supplied as evidence.
 await read('--registration-config');await read('--material-configuration');
 const assertConfiguration=async()=>{for(const [key,pin]of pins){const bytes=await readActivationMaterialFile(args[key],pin.max);try{if(fieldSha256(bytes)!==pin.sha256)throw Object.assign(Error(),{code:'FIELD_ACTIVATION_PRIVATE_CONFIGURATION_CHANGED'});}finally{bytes.fill(0);}}};
 console.log(JSON.stringify(await executeFieldActivation({action:args['--action']==='activate'?'ACTIVATE':'RECOVER',authority,rawRuntime,targetRuntime,targetMigration,targetBackup,externalConfig,accessToken,assertConfiguration,tenantId:args['--tenant'],controlFile:args['--control-file'],operationId:args['--operation-id'],attemptId:args['--attempt-id'],planId:args['--plan-id'],expectedFactsSha256:args['--expected-facts-sha256'],backupFile:args['--backup-file'],keyFile:args['--key-file'],registrationConfig:args['--registration-config'],materialConfiguration:args['--material-configuration']}),null,2));
}catch(error){console.error(JSON.stringify({code:typeof error.code==='string'&&/^FIELD_[A-Z0-9_]+$/.test(error.code)?error.code:'FIELD_ACTIVATION_OPERATION_FAILED',operationId:args?.['--operation-id']||null,attemptId:args?.['--attempt-id']||null,inspectAndRecoverExactAttempt:true,productionAcceptance:false}));process.exitCode=1;}
