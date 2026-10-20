import {readFile} from 'node:fs/promises';
import {FieldRecoveryAuthorityLock} from '../field-recovery-lock.mjs';
import {FieldRecoveryFiles} from '../field-recovery-files.mjs';
import {openReviewContext} from '../field-recovery-review-context.mjs';
export async function openPublicationQaContext(args){
 const read=key=>readFile(args[key],'utf8').then(JSON.parse);
 const [authority,rawRuntime,targetRuntime,targetMigration,targetBackup]=await Promise.all(['--authority-config','--runtime-config','--target-runtime-config','--target-migration-config','--target-backup-config'].map(read));
 const guard=new FieldRecoveryAuthorityLock(authority,args['--tenant']),files=new FieldRecoveryFiles(guard,args['--control-file']);let c;
 try{await files.validatePath();await guard.acquire();await files.resume(args['--operation-id']);await files.quiet();c=await openReviewContext({authority,rawRuntime,targetRuntime,targetMigration,targetBackup,tenantId:args['--tenant'],guard,files,backupFile:args['--backup-file'],keyFile:args['--key-file']});return {...c,close:async()=>{await c.close();await files.close();await guard.close();}};}catch(e){await c?.close();await files.close();await guard.close();throw e;}
}
