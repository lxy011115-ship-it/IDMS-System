import assert from 'node:assert/strict';
import {readFile,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createWorkflowFreezeAuthority} from './workflow-freeze-control.mjs';
import {restoreWorkflowQa,cleanupWorkflowQa} from '../work/workflow-runtime-upgrade-20261018/workflow-backup.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
const run=promisify(execFile),read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,'')),main=await read('.local/postgres-runtime.json'),copies=await read('work/workflow-runtime-upgrade-20261018/readiness-private-state.json');
const suffix=randomUUID().replaceAll('-','').slice(0,10),nonce=randomUUID().replaceAll('-','').slice(0,12),name='idms_workflowcontrol_'+nonce,operation=randomUUID(),directory=resolve('.local/workflow-freeze-cli-qa',nonce),accounts=[];
const q=v=>'"'+v.replaceAll('"','""')+'"';let authority,proof;
try{
 await privateDirectory(directory);const restored=await restoreWorkflowQa(main,copies.backups.sandbox,'sandbox',suffix);accounts.push(restored.account);
 authority=await createWorkflowFreezeAuthority({host:main.host,port:main.port,bootstrapPassword:main.bootstrapPassword},name);
 const config={format:'idms-workflow-freeze-config-v1',authority,source:{scope:'QA',tenantId:'sandbox',database:restored.account.database,user:restored.account.user}},file=join(directory,'config.json');await privateNewFile(file,JSON.stringify(config));
 const args=['scripts/workflow-freeze.mjs','--config',file,'--operation',operation];
 await assert.rejects(run(process.execPath,[...args,'--action','unknown'],{windowsHide:true}),e=>e.stderr.trim()==='WF_FENCE_ACTION');
 await assert.rejects(run(process.execPath,[...args,'--action','prepare','--action','release'],{windowsHide:true}),e=>e.stderr.includes('WF_FENCE_ARGUMENTS'));
 const call=async action=>JSON.parse((await run(process.execPath,[...args,'--action',action],{windowsHide:true})).stdout);
 assert.equal((await call('prepare')).phase,'PREPARED');const frozen=await call('freeze');assert.equal(frozen.phase,'DRAINED');assert.deepEqual(await call('status'),frozen);assert.deepEqual(await call('freeze'),frozen);
 const released=await call('release');assert.equal(released.phase,'RELEASED');assert.deepEqual(await call('release'),released);
 const c=new pg.Client({host:main.host,port:main.port,...restored.account});await c.connect();try{assert.equal((await c.query('SELECT count(*)::int AS n FROM idms_workflow_cases')).rows[0].n,0);assert.equal((await c.query("SELECT nextval('public.act_evt_log_log_nr__seq')::text AS n")).rows[0].n,'1');}finally{await c.end();}
 proof={verifiedAt:new Date().toISOString(),actual38TableSandboxQaRestore:true,actualProductionCliPrepareFreezeStatusReleaseAndReplays:true,allCliChildCloseAwaited:true,invalidAndDuplicateArgumentsRefused:true,exactReleaseAllowsOriginalApplicationConnectionAndSequenceUse:true,originalWorkflowRolesOrProcessesChanged:false,productionAcceptance:false};
}finally{
 await cleanupWorkflowQa(main,accounts,suffix);
 if(authority){const c=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:'postgres'});await c.connect();try{assert.equal(authority.controlDatabase,name);await c.query('DROP DATABASE '+q(name)+' WITH (FORCE)');await c.query('DROP ROLE '+q(name+'_owner'));}finally{await c.end();}}
 assert.equal(dirname(directory),resolve('.local/workflow-freeze-cli-qa'));await rm(directory,{recursive:true,force:true});
}
assert.ok(proof);proof.ownedQaDatabaseRolesAndCredentialsRemoved=true;await privateNewFile(resolve('outputs/workflow-freeze-cli-verification.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
