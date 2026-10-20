import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,basename} from 'node:path';
import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {inspectFieldRecoveryRegistration,loadFieldPlatformConfig} from './field-config.ts';
import {fieldRecoveryFixture} from '../scripts/fixtures/field-recovery-fixture.mjs';
import {fieldProfileFixture} from '../scripts/fixtures/field-certificate-fixture.mjs';
import {fieldMqttDeclaration} from '../scripts/fixtures/field-mqtt-fixture.mjs';
import {publicFieldProfile} from '../services/field/profile.ts';
import {fieldLeaseKeyId} from '../integrations/field-lease.ts';
import {fieldSha256} from '../integrations/field-profile.ts';
import {stable} from '../integrations/telemetry.ts';
async function fixture(run:(f:any)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'idms-recovery-registration-')),path=join(root,'platform.json'),controlFile=join(root,'recovery.json'),before=fieldRecoveryFixture(),control={...before,identity:{...before.identity,activationId:randomUUID()},state:'RESTORING' as const,operationId:randomUUID(),previousActivationId:before.identity.activationId},keys=generateKeyPairSync('ed25519'),requestKey=randomBytes(32),eventKey=randomBytes(32),privateProfile:any=fieldProfileFixture();privateProfile.format='idms-field-channel-profile-v2';privateProfile.transport=fieldMqttDeclaration(privateProfile.source,{eventKeySha256:fieldSha256(eventKey),acknowledgementKeyId:fieldLeaseKeyId(keys.publicKey)});
 const raw={format:'idms-field-platform-config-v2',leaseSigningKeyFile:'signer.pem',tenants:[{tenantId:'acme',recoveryFile:'recovery.json',channels:[{profile:publicFieldProfile(privateProfile),requestKeyFile:'request.bin',eventKeyFile:'event.bin'}]}]},main={format:'idms-field-recovery-intent-v1',tenantId:'acme',operationId:control.operationId,kind:'RESTORE',ownerHostId:'1'.repeat(64),authorityId:'2'.repeat(64),controlPathSha256:fieldSha256(process.platform==='win32'?controlFile.toLowerCase():controlFile),before,after:control,createdAtMs:control.changedAtMs},intentFile=join(controlFile+'.operations',control.operationId+'.intent.json');
 try{
  await mkdir(controlFile+'.operations');await writeFile(path,JSON.stringify(raw));await writeFile(controlFile,stable(control));await writeFile(controlFile+'.operation.lock',stable(main));await writeFile(intentFile,stable(main));await writeFile(join(root,'signer.pem'),keys.privateKey.export({type:'pkcs8',format:'pem'}));await writeFile(join(root,'request.bin'),requestKey);await writeFile(join(root,'event.bin'),eventKey);
  await run({root,path,controlFile,control,raw,main,intentFile,keys,requestKey,eventKey});
 }finally{requestKey.fill(0);eventKey.fill(0);const rel=relative(tmpdir(),root);assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&basename(root).startsWith('idms-recovery-registration-'));await rm(root,{recursive:true,force:true});}
}
test('恢复注册材料检查只返回绑定新身份的公开候选，正常运行加载器仍拒绝RESTORING',async()=>fixture(async f=>{
 const files=await Promise.all([f.path,f.controlFile,f.controlFile+'.operation.lock',f.intentFile].map(p=>readFile(p))),candidate=await inspectFieldRecoveryRegistration(f.path,f.controlFile,f.control);
 assert.equal(candidate.registry.format,'idms-field-registry-v2');assert.deepEqual(candidate.registry.recovery,f.control.identity);assert.equal(candidate.registrySha256,fieldSha256(stable(candidate.registry)));assert.equal(candidate.fieldEnabled,false);assert.equal(candidate.activationGranted,false);assert.ok(!('signingKey'in candidate)&&!('channels'in candidate)&&!('recovery'in candidate));for(const secret of [f.requestKey.toString('base64'),f.eventKey.toString('base64'),'PRIVATE KEY','request.bin','event.bin'])assert.ok(!JSON.stringify(candidate).includes(secret));await assert.rejects(loadFieldPlatformConfig(f.path));
 assert.deepEqual(await Promise.all([f.path,f.controlFile,f.controlFile+'.operation.lock',f.intentFile].map(p=>readFile(p))),files);
}));
test('恢复注册候选拒绝缺少或冲突的原始操作、旧身份、跨企业和不完整通道',async()=>fixture(async f=>{
 const check=()=>inspectFieldRecoveryRegistration(f.path,f.controlFile,f.control);await unlink(f.controlFile+'.operation.lock');await assert.rejects(check());await writeFile(f.controlFile+'.operation.lock',stable(f.main));await writeFile(f.intentFile,stable({...f.main,authorityId:'3'.repeat(64)}));await assert.rejects(check());await writeFile(f.intentFile,stable(f.main));
 await assert.rejects(inspectFieldRecoveryRegistration(f.path,f.controlFile,{...f.control,identity:{...f.control.identity,activationId:randomUUID()}}));
 for(const mutate of [(r:any)=>r.tenants[0].tenantId='sandbox',(r:any)=>r.tenants[0].channels=[],(r:any)=>r.tenants[0].recoveryFile='../recovery.json',(r:any)=>r.tenants[0].channels[0].eventKeyFile='request.bin']){const raw=structuredClone(f.raw);mutate(raw);await writeFile(f.path,JSON.stringify(raw));await assert.rejects(check());}await writeFile(f.path,JSON.stringify(f.raw));await check();
}));
