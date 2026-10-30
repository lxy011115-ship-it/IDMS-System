import {randomUUID} from 'node:crypto';
import {link,unlink,lstat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {canonical} from '../server/imports.ts';
import {BackupWorkspace,backupDirectory,backupCheckSignal,backupRegular,readExactly} from './field-backup-io.mjs';
import {coldNeedV1 as need,coldUuidV1,coldEvidenceV1,coldManifestV1} from './pg-cold-image-portable-manifest-v1.mjs';
import {coldToolingV1,coldStoppedV1,coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {coldTreeV1,coldRecheckIdentityV1,coldMaterializeV1} from './pg-cold-image-portable-tree-v1.mjs';
import {sealColdImageV1,authenticateColdImageV1,coldImageMaxBytesV1} from './pg-cold-image-portable-container-v1.mjs';
import {coldConfigV1,coldConfigNamesV1} from './pg-cold-image-config-v1.mjs';
export {generateColdImageKeyV1,coldImageKeyBindingV1,authenticateColdImageV1} from './pg-cold-image-portable-container-v1.mjs';
function outside(root,path){const r=relative(root,resolve(path));need(r!==''&&(r.startsWith('..'+(process.platform==='win32'?'\\':'/'))||r==='..'||isAbsolute(r)),'COLD_IMAGE_PATH_OVERLAP');}
async function validateSourceConfigs(inventory){for(const f of inventory.tree.files){if(!coldConfigNamesV1.has(f.path))continue;const input=await backupRegular(join(inventory.root,...f.path.split('/')),1024**2);try{coldConfigV1(f.path,await readExactly(input.file,Number(input.stat.size),0));}finally{await input.file.close();}}}
/** Offline primitive only. Durable freeze/retirement/admission belongs to its controller. */
export async function captureColdImageV1({sourceDirectory,binDirectory,expectedSystemIdentifier,keyFile,workDirectory,outputDirectory,evidence={},backupId=randomUUID(),signal,onPhase=async()=>{}}){
 need(coldUuidV1(backupId),'COLD_IMAGE_ID');coldEvidenceV1(evidence);const source=await backupDirectory(sourceDirectory),work=await backupDirectory(workDirectory),output=await backupDirectory(outputDirectory);for(const p of [work,output,keyFile,binDirectory])outside(source,p);
 const destination=join(output,backupId+'.idmspgcold');try{await lstat(destination);need(false,'COLD_IMAGE_BACKUP_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
 const tooling=await coldToolingV1(binDirectory),control=await coldStoppedV1(source,tooling,expectedSystemIdentifier);await onPhase('SOURCE_OFFLINE');const inventory=await coldTreeV1(source,signal);await validateSourceConfigs(inventory);
 const manifest=coldManifestV1({format:'IDMS_PG_COLD_IMAGE_V1',backupId,createdAt:new Date().toISOString(),scope:'ENTIRE_SHUT_DOWN_PG16_CLUSTER',restoreMode:'NEW_ISOLATED_DIRECTORY_ONLY',sourceDirectory:source,platform:process.platform,arch:process.arch,tooling:tooling.binding,control,evidence,tree:inventory.tree,totalBytes:inventory.totalBytes,automaticActivationApproved:false,privilegedAdministratorTrustRequired:true});
 const stage=await BackupWorkspace.create(output);let out,linked=false;
 try{out=await stage.createFile('archive.bin');await sealColdImageV1({manifest,sourceDirectory:source,keyFile,out:out.file,signal});await out.file.close();out=null;await onPhase('SEALED');
  const checked=await authenticateColdImageV1({backupFile:join(stage.path,'archive.bin'),keyFile,workDirectory:work,signal});try{need(canonical(checked.manifest)===canonical(manifest),'COLD_IMAGE_SELF_VERIFY');}finally{await checked.dispose();}
  await coldRecheckIdentityV1(inventory);const after=await coldTreeV1(source,signal);need(canonical(after.tree)===canonical(inventory.tree)&&canonical(await coldStoppedV1(source,tooling,expectedSystemIdentifier))===canonical(control),'COLD_IMAGE_SOURCE_CHANGED');need(canonical((await coldToolingV1(binDirectory)).binding)===canonical(tooling.binding),'COLD_IMAGE_PROGRAM_CHANGED');
  const path=join(stage.path,'archive.bin'),proof=await coldFileHashV1(path,coldImageMaxBytesV1,signal);backupCheckSignal(signal);await onPhase('BEFORE_PUBLICATION');await link(path,destination);linked=true;await unlink(path);linked=false;
  return{backupId,file:destination,...proof,files:manifest.tree.files.length,directories:manifest.tree.directories.length,payloadBytes:manifest.totalBytes,systemIdentifier:control.systemIdentifier,automaticActivationApproved:false};
 }finally{await out?.file.close();if(!linked)await stage.cleanup();/* On link/unlink interruption retain both known aliases for explicit recovery; never remove unknown files. */}
}
export async function restoreColdImageV1({backupFile,keyFile,workDirectory,targetDirectory,binDirectory,expectedBackupId,expectedSystemIdentifier,signal,onPhase=async()=>{}}){
 const checked=await authenticateColdImageV1({backupFile,keyFile,workDirectory,signal,onPhase});try{const m=checked.manifest;need(m.backupId===expectedBackupId&&m.control.systemIdentifier===expectedSystemIdentifier,'COLD_IMAGE_IDENTITY');need(m.platform===process.platform&&m.arch===process.arch,'COLD_IMAGE_PLATFORM');outside(m.sourceDirectory,targetDirectory);outside(resolve(targetDirectory),backupFile);outside(resolve(targetDirectory),keyFile);outside(resolve(targetDirectory),workDirectory);
  const tooling=await coldToolingV1(binDirectory);need(canonical(tooling.binding)===canonical(m.tooling),'COLD_IMAGE_PROGRAM_CHANGED');const result=await coldMaterializeV1(checked.plain,checked.start,m,targetDirectory,{signal,onPhase,verifyTarget:async target=>{need(canonical(await coldStoppedV1(target,tooling,expectedSystemIdentifier))===canonical(m.control),'COLD_IMAGE_CONTROL');need(canonical((await coldToolingV1(binDirectory)).binding)===canonical(m.tooling),'COLD_IMAGE_PROGRAM_CHANGED');}});
  return{...result,backupId:m.backupId,systemIdentifier:m.control.systemIdentifier,fullArchiveAuthenticationVerified:true,fullFileHashesVerified:true,sourceAdministratorTrustRequired:true};
 }finally{await checked.dispose();}
}
