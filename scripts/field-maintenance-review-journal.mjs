import {opendir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {backupRegular,backupUnchanged,readExactly} from './field-backup-io.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
// Include interrupted, unpublished staging files: their later publication must revoke the reader.
export async function maintenanceReviewJournal(controlFile,operationId){
 const entries=[];let total=0;
 for await(const e of await opendir(controlFile+'.operations')){
  if(!e.name.toLowerCase().startsWith(operationId+'.review-'))continue;
  if(entries.length>=1024||!e.isFile()||!new RegExp('^'+operationId+'\\.review-(baseline|plan|submit|approve|result)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.(json|tmp)$').test(e.name))throw Object.assign(Error('FIELD_MAINTENANCE_REVIEW_JOURNAL_INVALID'),{code:'FIELD_MAINTENANCE_REVIEW_JOURNAL_INVALID'});
  const file=await backupRegular(resolve(controlFile+'.operations',e.name),1048576);
  try{const size=Number(file.stat.size);total+=size;if(total>16777216)throw Object.assign(Error('FIELD_MAINTENANCE_REVIEW_JOURNAL_LIMIT'),{code:'FIELD_MAINTENANCE_REVIEW_JOURNAL_LIMIT'});const bytes=await readExactly(file.file,size,0);await backupUnchanged(file);entries.push({name:e.name,size,sha256:createHash('sha256').update(bytes).digest('hex')});}finally{await file.file.close();}
 }
 entries.sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)));
 return {entries:entries.length,sha256:sourceFreezeSha(entries)};
}
