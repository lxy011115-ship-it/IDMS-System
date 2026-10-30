import {lstat,readdir,unlink,rmdir,readFile} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {privateNewFile} from './backup-support.mjs';
import {backupDirectory} from './field-backup-io.mjs';
import {workflowRequire as need} from './workflow-archive-facts.mjs';
import {workflowArchiveOwnerState} from './workflow-archive-native.mjs';
import {authenticateWorkflowArchiveV2} from './workflow-archive-container.mjs';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
// Register before any plaintext file is created. A crash before registration
// can leave only an empty private directory, never untracked plaintext.
export async function authenticateManagedWorkflowArchive(options,owner,onPhase){
 const root=await backupDirectory(options.workDirectory);let recordFile,workspaceDirectory;
 try{
  const opened=await authenticateWorkflowArchiveV2({...options,registerWorkspace:async directory=>{
   const s=await lstat(directory,{bigint:true});workspaceDirectory=directory;recordFile=join(root,'workflow-auth-'+randomUUID()+'.json');
   await privateNewFile(recordFile,canonical({format:'idms-workflow-auth-workspace-v2',owner,directory,identity:{dev:String(s.dev),ino:String(s.ino)}}));
  },onPhase:async phase=>{if(phase==='AUTHENTICATED')await onPhase('AUTHENTICATED');}});
  return {...opened,dispose:async()=>{await opened.dispose();if(recordFile)await unlink(recordFile);}};
 }catch(e){if(recordFile){let absent=false;try{await lstat(workspaceDirectory);}catch(check){if(check.code==='ENOENT')absent=true;else throw check;}if(absent)await unlink(recordFile).catch(check=>{if(check.code!=='ENOENT')throw check;});}throw e;}
}
export async function retireWorkflowAuthenticationWorkspaces(root,owner){
 await backupDirectory(root);
 for(const name of (await readdir(root)).filter(n=>/^workflow-auth-[a-f0-9-]{36}\.json$/.test(n))){
  const file=join(root,name),record=await read(file);need(record.format==='idms-workflow-auth-workspace-v2'&&await workflowArchiveOwnerState(record.owner)==='TERMINAL','WF_ARCHIVE_AUTH_OWNER_LIVE');
  const directory=resolve(record.directory);need(dirname(directory)===root&&/^field-backup-stage-[A-Za-z0-9]{6}$/.test(basename(directory)),'WF_ARCHIVE_AUTH_PATH');
  try{
   await backupDirectory(directory);const s=await lstat(directory,{bigint:true});need(String(s.dev)===record.identity.dev&&String(s.ino)===record.identity.ino,'WF_ARCHIVE_AUTH_PATH');
   const names=await readdir(directory);need(names.every(n=>['plaintext.bin','dump.pgdump'].includes(n)),'WF_ARCHIVE_AUTH_UNKNOWN_FILE');
   for(const n of names){const f=await lstat(join(directory,n),{bigint:true});need(f.isFile()&&!f.isSymbolicLink()&&f.nlink===1n,'WF_ARCHIVE_AUTH_PATH');}
   for(const n of names)await unlink(join(directory,n));await rmdir(directory);
  }catch(e){if(e.code!=='ENOENT')throw e;}
  await unlink(file);
 }
}
