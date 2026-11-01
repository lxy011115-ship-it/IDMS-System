import {readFile,writeFile,mkdir,readdir,realpath,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {recoveryPlatform,assertRecoveryWritersStopped,prepareRecoveryDatabase,legacyRecoveryAuthority,recoveryRoot,coordinatorFile} from './edge-recovery-platform.mjs';
import {bindingFile,sha,need,jsonFile,runtimeSourceEvidence,StartupError} from './existing-platform-binding.mjs';
import {acquireCoordinator} from './existing-platform-process.mjs';
import {deploymentEvidence,sameDeploymentStructure} from './existing-platform-evidence.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {openExistingSqlite} from '../services/existing-sqlite.ts';
import {proposeSpoolRecovery} from '../services/edge/spool-maintenance.ts';
import {spoolVersion,spoolStorage,quarantineSummary,spoolSourceDigest,spoolKeyDigest} from '../services/edge/spool-v2.ts';
import {exportQuarantine,verifyQuarantineExport} from '../services/edge/spool-export.ts';
const validOperation=id=>typeof id==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id);
export function recoveryArguments(args){
 need(Array.isArray(args)&&args.every(a=>typeof a==='string'),'RECOVERY_ARGUMENTS_INVALID');const action=args[0];
 if(['--inspect','--prepare-database','--plan'].includes(action)){need(args.length===1,'RECOVERY_ARGUMENTS_INVALID');return {action};}
 if(['--status','--export','--verify-export'].includes(action)){need(args.length===2&&validOperation(args[1]),'RECOVERY_OPERATION_REQUIRED');return {action,operationId:args[1]};}
 throw new StartupError('RECOVERY_ACTION_INVALID');
}
async function operationDirectory(id){need(validOperation(id),'RECOVERY_OPERATION_REQUIRED');const directory=join(recoveryRoot,id),s=await lstat(directory);need(s.isDirectory()&&!s.isSymbolicLink()&&await realpath(directory)===directory,'RECOVERY_OPERATION_DIRECTORY_INVALID');return directory;}
export function inspectRecoverySpool(p){
 const db=openExistingSqlite(p.spool,'edge',p.source,{readOnly:true});try{
  db.exec('BEGIN');const version=spoolVersion(db),pending=db.prepare("SELECT count(*) AS n FROM pending WHERE state='PENDING'").get().n,rejected=db.prepare("SELECT count(*) AS n FROM pending WHERE state='REJECTED'").get().n,sequence=Number(db.prepare("SELECT value FROM metadata WHERE name='sequence'").get().value);
  return {spoolVersion:version,pending,rejected,sequence,...spoolStorage(p.spool),...(version===2?{quarantine:quarantineSummary(db)}:{})};
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
export async function planEdgeRecovery(){
 let p=await recoveryPlatform();const release=await acquireCoordinator(coordinatorFile);
 try{
  const current=await recoveryPlatform();need(sha(JSON.stringify(current.binding))===sha(JSON.stringify(p.binding)),'RECOVERY_BINDING_CHANGED');p=current;
  const stopped=await assertRecoveryWritersStopped(p),sourceBefore=await runtimeSourceEvidence(),before=await deploymentEvidence(p.binding),authority=await legacyRecoveryAuthority(p),operationId=randomUUID(),proposal=proposeSpoolRecovery(p.spool,p.source,authority.evidence.durableSequence,authority.digest,operationId);
  const after=await deploymentEvidence(p.binding),sourceAfter=await runtimeSourceEvidence();need(sameDeploymentStructure(before,after)&&sourceBefore.digest===sourceAfter.digest,'RECOVERY_PREFLIGHT_CHANGED');await assertRecoveryWritersStopped(p);
  await privateDirectory(recoveryRoot);need((await readdir(recoveryRoot)).filter(validOperation).length<16,'RECOVERY_PLAN_HISTORY_REVIEW_REQUIRED');const directory=join(recoveryRoot,operationId);await mkdir(directory,{recursive:false,mode:0o700});await privateDirectory(directory);
  const bindingBefore=await readFile(bindingFile);need(sha(JSON.stringify(JSON.parse(bindingBefore.toString('utf8'))))===sha(JSON.stringify(p.binding)),'RECOVERY_BINDING_CHANGED');await privateNewFile(join(directory,'binding-before.json'),bindingBefore);
  const plan={format:'IDMS_EDGE_RECOVERY_PLAN_V2',operationId,project:await realpath(resolve('.')),sourceBefore,sourceAfter,originalBindingSha256:sha(bindingBefore),sourceDigest:spoolSourceDigest(p.source),keyDigest:spoolKeyDigest(p.source),proposal,authority,before,preflightAfter:after,structureAndPrivilegesUnchanged:true,stopped,originalSchemaVersion:inspectRecoverySpool(p).spoolVersion};
  await privateNewFile(join(directory,'plan.private.json'),JSON.stringify(plan,null,2)+'\n');return {status:'RECOVERY_PLANNED',operationId,originalMessages:proposal.originalCount,beforeSequence:proposal.beforeSequence,afterSequence:proposal.afterSequence,readOnlySql:true,sqliteMigrated:false,servicesSwitched:false};
 }finally{await release();}
}
export async function edgeRecoveryMain(args){
 const parsed=recoveryArguments(args);
 if(parsed.action==='--prepare-database')return prepareRecoveryDatabase();
 if(parsed.action==='--plan')return planEdgeRecovery();
 const p=await recoveryPlatform();
 if(parsed.action==='--inspect')return {status:'RECOVERY_INSPECTION',...inspectRecoverySpool(p),readOnly:true};
 const directory=await operationDirectory(parsed.operationId),plan=await jsonFile(join(directory,'plan.private.json'),262144);need(plan.format==='IDMS_EDGE_RECOVERY_PLAN_V2'&&plan.operationId===parsed.operationId&&plan.sourceDigest===spoolSourceDigest(p.source)&&plan.keyDigest===spoolKeyDigest(p.source),'RECOVERY_OPERATION_BINDING_MISMATCH');
 if(parsed.action==='--status')return {status:'PLANNED_NOT_APPLIED',operationId:parsed.operationId,current:inspectRecoverySpool(p),servicesSwitched:false};
 const target=join(directory,'quarantine.private.ndjson');
 if(parsed.action==='--export')return {status:'PRIVATE_QUARANTINE_EXPORTED',operationId:parsed.operationId,...exportQuarantine(p.spool,p.source,target),snapshotOnly:true};
 return {status:'PRIVATE_QUARANTINE_VERIFIED',operationId:parsed.operationId,...verifyQuarantineExport(target,p.source),snapshotOnly:true};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(await edgeRecoveryMain(process.argv.slice(2))));}catch(error){console.error(JSON.stringify({status:'RECOVERY_REFUSED_OR_UNCONFIRMED',code:error instanceof StartupError?error.code:/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:'RECOVERY_VALIDATION_FAILED',automaticRestart:false,forceTermination:false}));process.exitCode=1;}}
