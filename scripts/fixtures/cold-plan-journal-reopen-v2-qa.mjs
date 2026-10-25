import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {dirname,isAbsolute,resolve,relative} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readColdPlanJournalV1} from '../cold-review-plan-journal-v1.mjs';
assert.equal(process.argv.length,3);const file=resolve(process.argv[2]),stat=await lstat(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=16*1024**2);
const v=JSON.parse(await readFile(file,'utf8')),base=dirname(dirname(file)),rel=relative(base,v.context.workDirectory);
assert(v.format==='COLD_PLAN_JOURNAL_REOPEN_INPUT_V2'&&isAbsolute(v.storeFile)&&dirname(v.storeFile)===dirname(file)&&v.context.trust.storeFile===v.storeFile&&isAbsolute(v.context.workDirectory)&&rel&&!rel.startsWith('..')&&!isAbsolute(rel));
const db=new DatabaseSync(v.storeFile,{readOnly:true,allowExtension:false});try{db.exec('BEGIN');const details=JSON.parse(db.prepare('SELECT details FROM cold_control WHERE id=1').get().details),r=await readColdPlanJournalV1({db,details,context:v.context,credentials:v.credentials});db.exec('ROLLBACK');console.log(JSON.stringify({format:'COLD_PLAN_JOURNAL_REOPEN_QA_V2',revision:r.revision,headSha256:r.headSha256,sourceHash:v.context.trust.sourceHash,liveAuthenticationPerformed:false,approvalGranted:false,formalFieldActivationGranted:false,fullGoalComplete:false}));}finally{db.close();}
