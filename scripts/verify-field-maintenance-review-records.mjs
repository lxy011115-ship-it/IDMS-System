import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,link,unlink,rm} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {maintenanceReviewJournal} from './field-maintenance-review-journal.mjs';
const root=resolve('work/field-channel-20261017'),directory=await mkdtemp(resolve(root,'maintenance-review-records-')),control=resolve(directory,'control.json'),operationId=randomUUID(),operations=control+'.operations';await mkdir(operations);
try{
 const empty=await maintenanceReviewJournal(control,operationId),file=resolve(operations,operationId+'.review-submit-'+randomUUID()+'.tmp');await writeFile(file,'partial');const one=await maintenanceReviewJournal(control,operationId);assert.equal(one.entries,1);assert.notEqual(one.sha256,empty.sha256);await writeFile(file,'changed');const changed=await maintenanceReviewJournal(control,operationId);assert.notEqual(changed.sha256,one.sha256);assert.equal((await maintenanceReviewJournal(control,operationId)).sha256,changed.sha256);
 const hardlink=resolve(directory,'linked');await link(file,hardlink);try{await assert.rejects(maintenanceReviewJournal(control,operationId),e=>e.code==='FIELD_BACKUP_FILE_INVALID');assert.equal(await readFile(file,'utf8'),'changed');}finally{await unlink(hardlink);}
 const unknown=resolve(operations,operationId+'.review-unrecognized.json');await writeFile(unknown,'{}');try{await assert.rejects(maintenanceReviewJournal(control,operationId),e=>e.code==='FIELD_MAINTENANCE_REVIEW_JOURNAL_INVALID');assert.equal(await readFile(unknown,'utf8'),'{}');}finally{await unlink(unknown);}
 const alias=resolve(operations,operationId.toUpperCase()+'.REVIEW-submit-'+randomUUID()+'.tmp');await writeFile(alias,'partial');try{await assert.rejects(maintenanceReviewJournal(control,operationId),e=>e.code==='FIELD_MAINTENANCE_REVIEW_JOURNAL_INVALID');assert.equal(await readFile(alias,'utf8'),'partial');}finally{await unlink(alias);}
 await writeFile(file,Buffer.alloc(1048577));await assert.rejects(maintenanceReviewJournal(control,operationId),e=>e.code==='FIELD_BACKUP_FILE_INVALID');assert.equal((await readFile(file)).length,1048577);
 console.log(JSON.stringify({partialStagingIncludedAndMutationDetected:true,unknownNameHardlinkAndOversizeRefused:true,noncanonicalWindowsCaseAliasRefused:true,invalidInputsPreservedWithoutRepair:true,productionAcceptance:false}));
}finally{const rel=relative(root,directory);assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&/^maintenance-review-records-/.test(rel));await rm(directory,{recursive:true,force:true});}
