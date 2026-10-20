import assert from 'node:assert/strict';
import {readFile,writeFile,rename,lstat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
export async function exerciseArchivePublicationRecords({directory,args,cli,result}){
 assert.match(basename(directory),/^formal-archive-[a-f0-9]{10}$/);
 const root=resolve(directory),owned=path=>{const p=resolve(path),r=relative(root,p);assert.ok(!isAbsolute(r)&&!r.startsWith('..'));return p;};
 const final=owned(result.file),journal=owned(resolve(root,'recovery.json.operations',result.operationId)),ready=journal+'.archive-ready.json',done=journal+'.archive-result.json';
 const originalDone=await readFile(done),originalReady=await readFile(ready);assert.ok((await lstat(final)).size<2*1024*1024);const originalArchive=await readFile(final);
 try{const corrupt=JSON.parse(originalDone);corrupt.archiveSha256='0'.repeat(64);await writeFile(done,canonical(corrupt));assert.equal((await cli('archive',args,1)).code,'FIELD_ARCHIVE_RECORD_INVALID');}finally{await writeFile(done,originalDone);}
 const held=owned(resolve(root,'held-final-'+randomUUID()+'.bin'));
 try{await rename(final,held);assert.equal((await cli('archive',args,1)).code,'FIELD_ARCHIVE_COMPLETED_FILE_MISSING');}finally{await rename(held,final);}
 try{const corrupt=Buffer.from(originalArchive);corrupt[60]^=1;await writeFile(final,corrupt);assert.equal((await cli('archive',args,1)).code,'FIELD_ARCHIVE_CIPHERTEXT_CHANGED');}finally{await writeFile(final,originalArchive);}
 const heldReady=owned(resolve(root,'held-ready-'+randomUUID()+'.json')),heldDone=owned(resolve(root,'held-result-'+randomUUID()+'.json'));let movedReady=false,movedDone=false;
 try{await rename(ready,heldReady);movedReady=true;await rename(done,heldDone);movedDone=true;assert.equal((await cli('archive',args,1)).code,'FIELD_ARCHIVE_UNOWNED_DESTINATION');}finally{if(movedReady)await rename(heldReady,ready);if(movedDone)await rename(heldDone,done);}
 assert.deepEqual(await readFile(ready),originalReady);assert.deepEqual(await readFile(done),originalDone);assert.deepEqual(await readFile(final),originalArchive);
 const repeat=await cli('archive',args);assert.equal(repeat.backupId,result.backupId);assert.equal(repeat.archiveSha256,result.archiveSha256);
 return {corruptCompletedRecordRefused:true,missingCompletedFileNeverRegenerated:true,changedCiphertextNeverOverwritten:true,evenAuthenticFinalFileNotAdoptedWithoutReadyRecord:true,onlyOwnedQaFilesRestoredAndExactOriginalArchiveReused:true};
}
