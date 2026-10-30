import assert from 'node:assert/strict';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readColdPlanApprovalsV1,coldPlanApprovalHistoryStatusV1} from '../cold-plan-approval-journal-v1.mjs';
assert.equal(process.argv.length,3);const file=resolve(process.argv[2]),root=resolve('work/cold-plan-approval-tests');
assert(/^[a-f0-9-]{36}[\\/]reopen\.private\.json$/.test(relative(root,file)));assert.equal(await realpath(file),file);const st=await lstat(file);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=1024**2);
const input=JSON.parse(await readFile(file,'utf8'));assert.equal(input.format,'COLD_PLAN_APPROVAL_REOPEN_INPUT_V1');assert.equal(input.storeFile,input.context.trust.storeFile);assert.equal(dirname(input.storeFile),dirname(file));assert.equal(input.context.workDirectory,dirname(file));
const db=new DatabaseSync(input.storeFile,{readOnly:true,allowExtension:false});try{db.exec('BEGIN');const details=JSON.parse(db.prepare('SELECT details FROM cold_control WHERE id=1').get().details),history=await readColdPlanApprovalsV1({db,details,context:input.context,credentials:input.credentials});console.log(JSON.stringify({...coldPlanApprovalHistoryStatusV1(history),actualFreshProcessHistoryRead:true,liveAuthenticationPerformed:false}));db.exec('ROLLBACK');}finally{db.close();}
