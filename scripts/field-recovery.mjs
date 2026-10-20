import {flags} from './backup-support.mjs';
import {FieldRecoveryControlOperation} from './field-recovery-control.mjs';
import {inspectFieldRecoveryControl} from './field-recovery-files.mjs';
import {readBoundedFieldFile} from '../services/field/profile.ts';
let operation;
try{
 const args=flags(process.argv.slice(2),['--action','--authority-config','--runtime-config','--tenant','--control-file','--expected-control-digest','--target-runtime-config','--operation-id','--migration-config','--backup-config','--key-file','--archive-directory','--target-migration-config','--target-backup-config','--backup-file','--auth-config','--output-directory','--plan-id','--expected-facts-sha256','--external-config','--access-token-file','--supersedes-plan-id','--registration-config']);
 if(!args['--tenant']||!args['--control-file'])throw Error();
 if(args['--action']==='status'){
  if(Object.keys(args).length!==3)throw Error();
  console.log(JSON.stringify(await inspectFieldRecoveryControl(args['--control-file'],args['--tenant']),null,2));
 }else{
  for(const key of ['--action','--authority-config','--runtime-config'])if(!args[key])throw Error();
  const action=args['--action'];
  const reviewActions=['submit-review','approve-review','review-status'],reviewCommon=['--operation-id','--target-runtime-config','--target-migration-config','--target-backup-config','--backup-file','--key-file'],reviewWrite=['--plan-id','--expected-facts-sha256','--external-config','--access-token-file'];
  const optional={'submit-review':[...reviewCommon,...reviewWrite,'--supersedes-plan-id','--registration-config'],'approve-review':[...reviewCommon,...reviewWrite,'--registration-config'],'review-status':reviewCommon,'prepare-maintenance':['--operation-id','--target-runtime-config','--target-migration-config','--target-backup-config','--backup-file','--key-file','--auth-config','--output-directory'],'restore-target':['--operation-id','--target-runtime-config','--target-migration-config','--target-backup-config','--backup-file','--key-file'],'prepare-target':['--operation-id','--target-runtime-config','--target-migration-config','--target-backup-config','--backup-file','--key-file'],initialize:[],begin:['--expected-control-digest','--target-runtime-config'],resume:['--operation-id','--migration-config'],'freeze-source':['--operation-id','--migration-config','--target-runtime-config'],archive:['--operation-id','--migration-config','--backup-config','--key-file','--archive-directory']};
  const allowed=optional[action];if(!allowed||Object.keys(args).some(k=>!['--action','--authority-config','--runtime-config','--tenant','--control-file',...allowed].includes(k)))throw Error();
  if(action==='begin'&&!/^[a-f0-9]{64}$/.test(args['--expected-control-digest']||'')||['resume','freeze-source','archive'].includes(action)&&!args['--operation-id']||['freeze-source','archive'].includes(action)&&!args['--migration-config']||action==='archive'&&['--backup-config','--key-file','--archive-directory'].some(k=>!args[k]))throw Error();
  if(['prepare-target','restore-target','prepare-maintenance',...reviewActions].includes(action)&&['--operation-id','--target-runtime-config','--target-migration-config','--target-backup-config','--backup-file','--key-file'].some(k=>!args[k]))throw Error();
  if(action==='prepare-maintenance'&&['--auth-config','--output-directory'].some(k=>!args[k]))throw Error();
  if(['submit-review','approve-review'].includes(action)&&reviewWrite.some(k=>!args[k]))throw Error();
  const read=async p=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedFieldFile(p,2097152))),authority=await read(args['--authority-config']),runtime=await read(args['--runtime-config']);
  operation=new FieldRecoveryControlOperation({authority,runtime,tenantId:args['--tenant'],controlFile:args['--control-file']});await operation.open();
  const migration=args['--migration-config']?await read(args['--migration-config']):undefined;
  let result;
  if(reviewActions.includes(action))result=await operation.review(args['--operation-id'],{action:action==='review-status'?'STATUS':action==='submit-review'?'SUBMIT':'APPROVE',targetRuntime:await read(args['--target-runtime-config']),targetMigration:await read(args['--target-migration-config']),targetBackup:await read(args['--target-backup-config']),backupFile:args['--backup-file'],keyFile:args['--key-file'],...(action==='review-status'?{}:{planId:args['--plan-id'],expectedFactsSha256:args['--expected-facts-sha256'],supersedesPlanId:args['--supersedes-plan-id']||null,externalConfig:await read(args['--external-config']),...(args['--registration-config']?{registrationConfig:args['--registration-config']}:{}),accessToken:new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedFieldFile(args['--access-token-file'],32768)).trim()})});
  else if(['prepare-target','restore-target','prepare-maintenance'].includes(action))result=await operation[action==='prepare-maintenance'?'prepareMaintenance':action==='prepare-target'?'prepareTarget':'restoreTarget'](args['--operation-id'],{targetRuntime:await read(args['--target-runtime-config']),targetMigration:await read(args['--target-migration-config']),targetBackup:await read(args['--target-backup-config']),backupFile:args['--backup-file'],keyFile:args['--key-file'],...(action==='prepare-maintenance'?{authConfig:await read(args['--auth-config']),outputDirectory:args['--output-directory']}: {})});
  else if(action==='archive')result=await operation.archive(args['--operation-id'],{migration,backupConfig:await read(args['--backup-config']),keyFile:args['--key-file'],outputDirectory:args['--archive-directory']});
  else if(action==='freeze-source')result=await operation.freezeSource(args['--operation-id'],migration,args['--target-runtime-config']?await read(args['--target-runtime-config']):undefined);
  else if(action==='initialize')result=await operation.initialize();
  else if(action==='begin')result=await operation.begin({expectedControlDigest:args['--expected-control-digest'],targetRuntime:args['--target-runtime-config']?await read(args['--target-runtime-config']):undefined});
  else result=await operation.resume(args['--operation-id'],migration);
  console.log(JSON.stringify(result,null,2));
 }
}catch(e){console.error(JSON.stringify({code:typeof e.code==='string'&&/^FIELD_[A-Z0-9_]+$/.test(e.code)?e.code:'FIELD_RECOVERY_CONTROL_FAILED',operationId:operation?.operationId||null,stateMayBeClosed:true,inspectAndResumeExactOperation:true,productionAcceptance:false}));process.exitCode=1;}finally{await operation?.close();}
