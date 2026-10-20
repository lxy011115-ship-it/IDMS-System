import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {closeSourceConnection} from '../field-source-freeze.mjs';
const modes=['AFTER_RUN','AFTER_PLAN','AFTER_APPLY_INTENT','AFTER_PRE_DATA_COMMIT','AFTER_DATA_COMMIT','AFTER_POST_DATA_COMMIT','BEFORE_SEAL_COMMIT','AFTER_SEAL_COMMIT','AFTER_VERIFICATION_INTENT','BEFORE_VERIFIED_COMMIT','AFTER_VERIFIED_COMMIT','AFTER_RESULT'];
export async function exerciseRestoreInterruptions({requested,authority,directory,args,worker,admin,cliArgs}){
 const target=JSON.parse(await readFile(args['--target-runtime-config'])).tenants.acme;
 assert.match(target.database,/^idms_fieldarchivetarget_[a-f0-9]{10}$/);
 const operation=args['--operation-id'],ops=resolve(directory,'recovery.json.operations'),steps=requested==='SEQUENTIAL'?modes:['DROP_VERIFIED_APPLICATION_REPLY'];
 assert.ok(['SEQUENTIAL','DROP_VERIFIED_APPLICATION_REPLY'].includes(requested));
 let previous,oid,sourceSequence;const checkpoints=[];
 const counts=async()=>{const out={};for(const name of await readdir(ops)){if(!name.startsWith(operation+'.restore-tool-')||!name.endsWith('.json'))continue;const t=JSON.parse(await readFile(resolve(ops,name)));if(t.kind==='APPLY')out[t.section]=(out[t.section]||0)+1;}return out;};
 for(const mode of steps){
  const dead=await worker('scripts/fixtures/field-restore-command-probe.mjs',cliArgs,{IDMS_FIELD_RESTORE_QA_MODE:mode,IDMS_FIELD_RESTORE_QA_DIRECTORY:directory});
  assert.equal(dead.entered,true,dead.stderr+dead.stdout);assert.ok(dead.backends.length>0);
  if(mode==='DROP_VERIFIED_APPLICATION_REPLY'){assert.equal(dead.code,0,dead.stderr);const answer=JSON.parse(dead.stdout);assert.equal(answer.targetDataRestored,true);}else assert.ok(dead.code!==0||dead.signal);
  for(const b of dead.backends){const end=Date.now()+15000;while((await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz',[b.pid,b.backend_start])).rowCount){assert.ok(Date.now()<end,'Killed restore backend must actually disappear');await new Promise(ok=>setTimeout(ok,20));}}
  const c=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:target.database});
  let phase,audits=null,revision=null;
  try{
   await c.connect();const row=(await c.query("SELECT oid::text,shobj_description(oid,'pg_database') AS comment FROM pg_database WHERE datname=current_database()")).rows[0];
   if(oid)assert.equal(row.oid,oid);else oid=row.oid;phase=JSON.parse(row.comment.split('\n')[1]);
   assert.equal(phase.operationId,operation);
   const expectedStage={AFTER_RUN:'EMPTY',AFTER_PLAN:'EMPTY',AFTER_APPLY_INTENT:'EMPTY',AFTER_PRE_DATA_COMMIT:'pre-data',AFTER_DATA_COMMIT:'data',AFTER_POST_DATA_COMMIT:'post-data',BEFORE_SEAL_COMMIT:'post-data',AFTER_SEAL_COMMIT:'post-data',AFTER_VERIFICATION_INTENT:'post-data',BEFORE_VERIFIED_COMMIT:'post-data',AFTER_VERIFIED_COMMIT:'VERIFIED',AFTER_RESULT:'VERIFIED',DROP_VERIFIED_APPLICATION_REPLY:'VERIFIED'};assert.equal(phase.stage,expectedStage[mode]);
   if(['data','post-data','VERIFIED'].includes(phase.stage)){assert.equal((await c.query('SELECT count(*)::int AS n FROM idms_field.points')).rows[0].n,2);assert.equal((await c.query('SELECT count(*)::int AS n FROM idms_field.receipts')).rows[0].n,2);audits=(await c.query("SELECT count(*)::int AS n FROM public.audit_ledger WHERE event->>'objectType'='FIELD_TARGET_RESTORE' AND event->>'correlationId'=$1",[operation])).rows[0].n;revision=(await c.query('SELECT revision::text FROM public.business_state')).rows[0].revision;assert.equal(audits,phase.stage==='VERIFIED'?1:0);const sequence=(await c.query('SELECT last_value::text,is_called FROM public.audit_ledger_sequence_no_seq')).rows[0];assert.equal(sequence.is_called,true);if(sourceSequence)assert.equal(sequence.last_value,(BigInt(sourceSequence)+(phase.stage==='VERIFIED'?1n:0n)).toString());else if(phase.stage!=='VERIFIED')sourceSequence=sequence.last_value;}
  }finally{await closeSourceConnection(c);}
  const current=await counts();if(previous){for(const section of ['pre-data','data','post-data'])if(['EMPTY','pre-data','data','post-data','VERIFIED'].indexOf(previous.stage)>['pre-data','data','post-data'].indexOf(section))assert.equal(current[section],previous.counts[section],'Committed section must never be applied again');}
  previous={stage:phase.stage,counts:current};checkpoints.push({mode,actualCommittedStage:phase.stage,actualTargetVerificationAuditCount:audits,actualRevision:revision,allRecordedControllerBackendsActuallyAbsent:true,committedSectionsNotReapplied:true});console.error('Owned restore checkpoint verified: '+mode);
 }
 return {checkpoints,allCheckpointsReached:true,actualControllersTerminalBeforeRetry:true,committedDatabaseOidPreserved:true,committedSectionsNotReapplied:true,applicationReplyDiscardedAfterActualCommit:requested==='DROP_VERIFIED_APPLICATION_REPLY'};
}
