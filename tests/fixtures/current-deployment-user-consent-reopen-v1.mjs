import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {prepareColdCurrentDeploymentContextFileV1,recordColdCurrentDeploymentContextFileV1,closeColdCurrentDeploymentContextFileV1} from '../../scripts/cold-current-deployment-review-context-files-v5.mjs';
import {readColdCurrentDeploymentUserConsentV1} from '../../scripts/cold-current-deployment-user-consent-journal-v1.mjs';
const input=JSON.parse(await readFile(process.argv[2],'utf8')),owner=await prepareColdCurrentDeploymentContextFileV1({context:input.context,request:input.request,workDirectory:input.workDirectory,mode:'REOPEN_ONLY'}),db=new DatabaseSync(input.databaseFile,{allowExtension:false});
try{db.exec('BEGIN');const d=JSON.parse(db.prepare('SELECT details FROM cold_control WHERE id=1').get().details),c=await recordColdCurrentDeploymentContextFileV1(owner,{db,details:d});assert(c.alreadyRecorded);const result=await readColdCurrentDeploymentUserConsentV1(owner,{db,details:d});assert(result.durableConsentRecorded&&result.historicalDataOnly&&!result.currentUserAuthenticated);db.exec('ROLLBACK');console.log(JSON.stringify(result));}finally{if(db.isOpen){if(db.isTransaction)db.exec('ROLLBACK');db.close();}await closeColdCurrentDeploymentContextFileV1(owner);}
