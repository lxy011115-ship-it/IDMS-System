import {lstat,readdir,readFile,unlink,rmdir} from 'node:fs/promises';
import {resolve,dirname,basename,join} from 'node:path';
import {backupDirectory} from './field-backup-io.mjs';
import {workflowArchiveOwnerState} from './workflow-archive-native.mjs';
import {workflowRequire as need} from './workflow-archive-facts.mjs';
// Called under the target lease only after all previous native readers retire.
// The current invocation's independently registered authentication stays live.
export async function retireWorkflowRestorePlaintext(root,currentOwner){
 await backupDirectory(root);
 for(const name of (await readdir(root)).filter(n=>/^workflow-auth-[a-f0-9-]{36}\.json$/.test(n))){
  const file=join(root,name),r=JSON.parse(await readFile(file,'utf8'));need(r.format==='idms-workflow-auth-workspace-v2','WF_RESTORE_WORKSPACE');
  if(r.owner.pid===currentOwner.pid&&r.owner.startTicks===currentOwner.startTicks&&r.owner.hostId===currentOwner.hostId)continue;
  need(await workflowArchiveOwnerState(r.owner)==='TERMINAL','WF_RESTORE_WORKSPACE_OWNER_LIVE');const directory=resolve(r.directory);need(dirname(directory)===root&&/^field-backup-stage-[A-Za-z0-9]{6}$/.test(basename(directory)),'WF_RESTORE_WORKSPACE');
  try{await backupDirectory(directory);const s=await lstat(directory,{bigint:true});need(String(s.dev)===r.identity.dev&&String(s.ino)===r.identity.ino,'WF_RESTORE_WORKSPACE');const files=await readdir(directory);need(files.every(n=>['plaintext.bin','dump.pgdump'].includes(n)),'WF_RESTORE_WORKSPACE_UNKNOWN_FILE');for(const n of files){const f=await lstat(join(directory,n),{bigint:true});need(f.isFile()&&!f.isSymbolicLink()&&f.nlink===1n,'WF_RESTORE_WORKSPACE');}for(const n of files)await unlink(join(directory,n));await rmdir(directory);}catch(e){if(e.code!=='ENOENT')throw e;}
  await unlink(file);
 }
}
