import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import pg from 'pg';
import {FieldRecoveryFiles} from '../field-recovery-files.mjs';
const mode=process.env.IDMS_FIELD_PREPARE_QA_FAULT,modes=['AFTER_RESTORE_INTENT','BEFORE_ROLES_COMMIT','AFTER_ROLES_COMMIT','DROP_ROLES_APPLICATION_REPLY','AFTER_CREATE_DATABASE','BEFORE_DATABASE_OPEN_COMMIT','AFTER_DATABASE_OPEN_COMMIT','AFTER_PROVISION_RECORD'];
if(!process.send||process.env.NODE_ENV!=='test'||!modes.includes(mode)||!/^fieldarchiveqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned target preparation probe required');
const arg=n=>process.argv[process.argv.indexOf(n)+1],directory=await realpath(process.env.IDMS_FIELD_PREPARE_QA_DIRECTORY),base=await realpath(resolve('work/field-channel-20261017')),rel=relative(base,directory),target=JSON.parse(await readFile(arg('--target-runtime-config')));
if(isAbsolute(rel)||rel.startsWith('..')||!/^formal-archive-[a-f0-9]{10}$/.test(basename(directory))||!/^idms_fieldarchivetarget_[a-f0-9]{10}$/.test(target.tenants.acme.database)||resolve(arg('--control-file'))!==resolve(directory,'recovery.json')||arg('--action')!=='prepare-target')throw Error('Owned target preparation paths required');
let hit=false,completed=false;const query=pg.Client.prototype.query,connect=pg.Client.prototype.connect;
async function hold(stage){if(hit)return;hit=true;process.send?.({type:'ENTERED',stage});await new Promise(()=>{});}
pg.Client.prototype.connect=function(...args){return connect.apply(this,args).then(async r=>{const row=(await query.call(this,'SELECT pid,backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];process.send?.({type:'BACKEND',...row});return r;});};
pg.Client.prototype.query=function(...args){const text=typeof args[0]==='string'?args[0]:args[0]?.text||'';
 if(!hit&&(mode==='BEFORE_ROLES_COMMIT'&&text.includes('IDMS_FIELD_RESTORE_ROLES_COMMIT')||mode==='BEFORE_DATABASE_OPEN_COMMIT'&&text.includes('IDMS_FIELD_RESTORE_DATABASE_OPEN_COMMIT')))return hold(mode).then(()=>query.apply(this,args));
 const p=query.apply(this,args);
 if(!hit&&(text.includes('IDMS_FIELD_RESTORE_ROLES_COMMIT')&&['AFTER_ROLES_COMMIT','DROP_ROLES_APPLICATION_REPLY'].includes(mode)||text.includes('IDMS_FIELD_RESTORE_CREATE_DATABASE')&&mode==='AFTER_CREATE_DATABASE'||text.includes('IDMS_FIELD_RESTORE_DATABASE_OPEN_COMMIT')&&mode==='AFTER_DATABASE_OPEN_COMMIT'))return p.then(async r=>{if(mode==='DROP_ROLES_APPLICATION_REPLY'){hit=true;process.send?.({type:'COMMIT_REPLY_DROPPED',stage:mode});throw Object.assign(Error('Owned role application reply discarded after real COMMIT'),{code:'FIELD_RESTORE_QA_REPLY_LOST'});}await hold(mode);return r;});
 return p;
};
for(const [method,stage]of [['prepareRestoreIntent','AFTER_RESTORE_INTENT'],['recordRestoreProvision','AFTER_PROVISION_RECORD']]){const native=FieldRecoveryFiles.prototype[method];FieldRecoveryFiles.prototype[method]=async function(...args){const r=await native.apply(this,args);if(mode===stage)await hold(stage);return r;};}
process.on('disconnect',()=>{if(!completed)process.exit(3);});await import('../field-recovery.mjs');completed=true;process.disconnect?.();
