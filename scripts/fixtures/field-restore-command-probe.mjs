import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import pg from 'pg';
import {FieldRecoveryFiles} from '../field-recovery-files.mjs';
export const restoreCommandFaults=['AFTER_RUN','AFTER_PLAN','AFTER_APPLY_INTENT','AFTER_PRE_DATA_COMMIT','AFTER_DATA_COMMIT','AFTER_POST_DATA_COMMIT','BEFORE_SEAL_COMMIT','AFTER_SEAL_COMMIT','AFTER_VERIFICATION_INTENT','BEFORE_VERIFIED_COMMIT','AFTER_VERIFIED_COMMIT','AFTER_RESULT'];
const mode=process.env.IDMS_FIELD_RESTORE_QA_MODE;
if(!process.send||process.env.NODE_ENV!=='test'||![...restoreCommandFaults,'DROP_VERIFIED_APPLICATION_REPLY'].includes(mode)||!/^fieldarchiveqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned restore command probe required');
const arg=n=>process.argv[process.argv.indexOf(n)+1],directory=await realpath(process.env.IDMS_FIELD_RESTORE_QA_DIRECTORY),base=await realpath(resolve('work/field-channel-20261017')),rel=relative(base,directory),target=JSON.parse(await readFile(arg('--target-runtime-config')));
if(isAbsolute(rel)||rel.startsWith('..')||!/^formal-archive-[a-f0-9]{10}$/.test(basename(directory))||!/^idms_fieldarchivetarget_[a-f0-9]{10}$/.test(target.tenants.acme.database)||resolve(arg('--control-file'))!==resolve(directory,'recovery.json')||arg('--action')!=='restore-target')throw Error('Owned restore command paths required');
let hit=false,completed=false;const query=pg.Client.prototype.query,connect=pg.Client.prototype.connect;
// An inherited libpq service must never replace the configured target.
process.env.PGSERVICE='owned_missing_restore_service';process.env.PGSERVICEFILE=resolve(directory,'owned-missing-service.conf');
async function hold(){if(hit)return;hit=true;process.send?.({type:'ENTERED',stage:mode});await new Promise(()=>{});}
pg.Client.prototype.connect=function(...args){return connect.apply(this,args).then(async r=>{const row=(await query.call(this,'SELECT pid,backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];process.send?.({type:'BACKEND',...row});return r;});};
pg.Client.prototype.query=function(...args){
 const text=typeof args[0]==='string'?args[0]:args[0]?.text||'',seal=text.includes('IDMS_FIELD_RESTORE_SEAL_COMMIT'),verified=text.includes('IDMS_FIELD_TARGET_RESTORE_VERIFIED_COMMIT');
 if(!hit&&(mode==='BEFORE_SEAL_COMMIT'&&seal||mode==='BEFORE_VERIFIED_COMMIT'&&verified))return hold().then(()=>query.apply(this,args));
 const p=query.apply(this,args);if(!p?.then)return p;
 return p.then(async r=>{
  if(hit)return r;
  if(mode==='AFTER_SEAL_COMMIT'&&seal||mode==='AFTER_VERIFIED_COMMIT'&&verified)await hold();
  if(mode==='DROP_VERIFIED_APPLICATION_REPLY'&&verified){hit=true;process.send?.({type:'COMMIT_REPLY_DROPPED',stage:mode});throw Object.assign(Error('Owned restore COMMIT application reply discarded'),{code:'FIELD_RESTORE_QA_REPLY_LOST'});}
  const stages={AFTER_PRE_DATA_COMMIT:'pre-data',AFTER_DATA_COMMIT:'data',AFTER_POST_DATA_COMMIT:'post-data'};
  if(stages[mode]&&text.includes("shobj_description(oid,'pg_database')")&&r.rows?.[0]?.comment?.startsWith('IDMS_FIELD_RESTORE_PHASE_V1\n')){const phase=JSON.parse(r.rows[0].comment.split('\n')[1]);if(phase.stage===stages[mode])await hold();}
  return r;
 });
};
for(const [method,stage]of [['recordRestoreRun','AFTER_RUN'],['recordRestorePlan','AFTER_PLAN'],['recordRestoreTool','AFTER_APPLY_INTENT'],['recordRestoreVerification','AFTER_VERIFICATION_INTENT'],['recordRestoreResult','AFTER_RESULT']]){
 const native=FieldRecoveryFiles.prototype[method];FieldRecoveryFiles.prototype[method]=async function(...args){const r=await native.apply(this,args);if(mode===stage&&(method!=='recordRestoreTool'||args[0].kind==='APPLY'))await hold();return r;};
}
process.on('disconnect',()=>{if(!completed)process.exit(3);});await import('../field-recovery.mjs');completed=true;process.disconnect?.();
