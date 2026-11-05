import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat,rename,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {EdgeSpool} from '../services/edge/spool.ts';
import {proposeSpoolRecovery,recoverStoppedSpool} from '../services/edge/spool-maintenance.ts';
import {verifyPin} from '../scripts/existing-platform-binding.mjs';
import {canonicalDigest} from '../server/canonical-state.ts';
import {recoveredRuntimeBinding,validateRecoveryBinding,runtimeBindingDigest,replaceRecoveryBinding} from '../scripts/edge-recovery-binding.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
 const project=await mkdtemp(join(tmpdir(),'idms-binding-'));t.after(async()=>{assert(relative(tmpdir(),project).startsWith('idms-binding-'));await rm(project,{recursive:true});});
 const operationId=randomUUID(),directory=join(project,'.local/edge-recovery',operationId);await mkdir(directory,{recursive:true});const source={tenantId:'sandbox',edgeId:'qa-edge',deviceCode:'qa-device',origin:'SIMULATOR',mapVersion:'1',signingKey:randomBytes(32).toString('base64url'),acknowledgementKey:randomBytes(32).toString('base64url'),points:[]},path=join(project,'edge.sqlite'),old=new EdgeSpool(path,source);
 old.append({tagCode:'qa',nodeId:'qa',unit:'qa',eventTime:new Date().toISOString(),value:1,quality:'GOOD'});old.close();const proposal=proposeSpoolRecovery(path,source,20,'a'.repeat(64),operationId),result=await recoverStoppedSpool(path,source,proposal,{directory,assertStopped:async()=>{}});
 const pin=async path=>{const b=await readFile(path);return {path,bytes:b.length,sha256:hash(b)};},telemetry=join(project,'telemetry.json');await writeFile(telemetry,JSON.stringify({sources:[source],edge:{spool:path}}));
 const before={format:1,purpose:'EXISTING_PLATFORM_RUNTIME',project:await (await import('node:fs/promises')).realpath(project),runtime:project,identity:{data:project,systemIdentifier:'qa'},files:{telemetry:await pin(telemetry)}},beforeFile=join(directory,'binding-before.json');await writeFile(beforeFile,JSON.stringify(before));
 const sourceEvidence={digest:'b'.repeat(64),files:4},spool={path,device:proposal.device,inode:proposal.inode},completion={format:'IDMS_EDGE_RECOVERY_COMPLETE_V2',operationId,originalBindingSha256:(await pin(beforeFile)).sha256,source:sourceEvidence,spoolIdentity:spool,receipt:result.receipt,structureAndPrivilegesUnchanged:true,backups:await Promise.all([result.backupPath,result.restorePath].map(pin))},completionFile=join(directory,'completion.private.json');await writeFile(completionFile,JSON.stringify(completion));
 const binding=recoveredRuntimeBinding(before,{operationId,beforeBinding:await pin(beforeFile),completion:await pin(completionFile),source:sourceEvidence,spool,receipt:result.receipt});
 return {project,directory,before,binding,pin,completion,completionFile,sourceEvidence,validate:b=>validateRecoveryBinding(b,{verifyPin,sourceEvidence:async()=>sourceEvidence}),path};
}
test('recovery descriptor validates actual receipt and preserves native reuse digest',async t=>{
 const f=await fixture(t);assert.equal(runtimeBindingDigest(f.before),runtimeBindingDigest(f.binding));const result=await f.validate(f.binding);assert.equal(canonicalDigest(result.receipt),f.binding.recovery.spool.receiptDigest);
 const exact=await lstat(f.path,{bigint:true});assert.equal(f.binding.recovery.spool.inode,exact.ino.toString());assert.equal(f.binding.recovery.spool.device,exact.dev.toString());
 const rounded=structuredClone(f.binding);rounded.recovery.spool.inode=Number(rounded.recovery.spool.inode);await assert.rejects(f.validate(rounded),/SPOOL_BINDING_INVALID/);
});
test('ordinary startup refuses source drift while an explicit read-only stop validation can inspect the original binding',async t=>{
 const f=await fixture(t),sourceEvidence=async()=>({...f.sourceEvidence,digest:'c'.repeat(64)});await assert.rejects(validateRecoveryBinding(f.binding,{verifyPin,sourceEvidence}),/RUNTIME_SOURCE_CHANGED/);await validateRecoveryBinding(f.binding,{verifyPin,sourceEvidence,requireCurrentSource:false});
});
test('completion assertions, backup bytes and source file identity cannot be silently substituted',async t=>{
 const f=await fixture(t);await writeFile(f.completionFile,JSON.stringify({...f.completion,structureAndPrivilegesUnchanged:false}));f.binding.recovery.completion=await f.pin(f.completionFile);await assert.rejects(f.validate(f.binding),/COMPLETION_BINDING_INVALID/);
 await writeFile(f.completionFile,JSON.stringify(f.completion));f.binding.recovery.completion=await f.pin(f.completionFile);const old=await readFile(f.completion.backups[0].path);await writeFile(f.completion.backups[0].path,Buffer.concat([old,Buffer.from('tamper')]));await assert.rejects(f.validate(f.binding),/BOUND_INPUT_CHANGED|INPUT_SIZE_OR_TYPE/);await writeFile(f.completion.backups[0].path,old);
 const previous=f.path+'.original';await rename(f.path,previous);await copyFile(previous,f.path);await assert.rejects(f.validate(f.binding),/SPOOL_FILE_CHANGED/);
});
test('descriptor replacement is atomic and same-operation result loss replays without rewriting',async t=>{
 const f=await fixture(t),file=join(f.project,'binding.json'),original=Buffer.from(JSON.stringify(f.before));await writeFile(file,original);const result=await replaceRecoveryBinding(file,hash(original),f.binding,f.binding.recovery.operationId);assert.equal(result.replayed,false);const inode=(await lstat(file)).ino;assert.equal((await replaceRecoveryBinding(file,hash(original),f.binding,f.binding.recovery.operationId)).replayed,true);assert.equal((await lstat(file)).ino,inode);
 await writeFile(file,'foreign change');await assert.rejects(replaceRecoveryBinding(file,hash(original),f.binding,f.binding.recovery.operationId),/BINDING_CHANGED/);assert.equal(await readFile(file,'utf8'),'foreign change');
});
test('an unknown partial descriptor temporary file is retained and never overwrites the original',async t=>{
 const f=await fixture(t),file=join(f.project,'binding.json'),original=Buffer.from(JSON.stringify(f.before));await writeFile(file,original);const partial=file+'.recovery-'+f.binding.recovery.operationId+'.tmp';await writeFile(partial,'partial');await assert.rejects(replaceRecoveryBinding(file,hash(original),f.binding,f.binding.recovery.operationId),/TEMPORARY_CHANGED/);assert.deepEqual(await readFile(file),original);assert.equal(await readFile(partial,'utf8'),'partial');
});
