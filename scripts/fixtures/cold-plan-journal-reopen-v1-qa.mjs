import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readColdPlanJournalV1} from '../cold-review-plan-journal-v1.mjs';
assert.equal(process.argv.length,3);const file=resolve(process.argv[2]),v=JSON.parse(await readFile(file,'utf8'));
assert(v.format==='COLD_PLAN_JOURNAL_REOPEN_INPUT_V1'&&isAbsolute(v.storeFile)&&dirname(v.storeFile)===dirname(file)&&v.context.workDirectory===dirname(file));
const db=new DatabaseSync(v.storeFile,{readOnly:true,allowExtension:false});try{db.exec('BEGIN');const details=JSON.parse(db.prepare('SELECT details FROM cold_control WHERE id=1').get().details),r=await readColdPlanJournalV1({db,details,context:v.context,credentials:v.credentials});db.exec('ROLLBACK');console.log(JSON.stringify({format:'COLD_PLAN_JOURNAL_REOPEN_QA_V1',revision:r.revision,headSha256:r.headSha256,sourceHash:v.context.trust.sourceHash,liveAuthenticationPerformed:false,approvalGranted:false,formalFieldActivationGranted:false,fullGoalComplete:false}));}finally{db.close();}
