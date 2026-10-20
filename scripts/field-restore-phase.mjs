import {canonical} from '../server/imports.ts';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {quoteIdentifier as q} from '../server/postgres-schema.ts';
const prefix='IDMS_FIELD_RESTORE_PHASE_V1\n',stages=['EMPTY','pre-data','data','post-data','VERIFIED'];
const fail=()=>{throw Object.assign(Error('FIELD_RESTORE_PHASE_INVALID'),{code:'FIELD_RESTORE_PHASE_INVALID'});};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)&&!/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v);
export function fieldRestorePhase(raw){
 const keys=['format','operationId','backupId','restoreIntentSha256','databaseName','databaseOid','stage','previousSha256','contentSha256','auditEventId'];
 if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||Object.keys(raw).length!==keys.length||keys.some(k=>!Object.hasOwn(raw,k))||raw.format!=='idms-field-restore-phase-v1'||!uuid(raw.operationId)||!uuid(raw.backupId)||!hash(raw.restoreIntentSha256)||typeof raw.databaseName!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(raw.databaseName)||typeof raw.databaseOid!=='string'||!/^[1-9][0-9]{0,9}$/.test(raw.databaseOid)||BigInt(raw.databaseOid)>4294967295n||!stages.includes(raw.stage))fail();
 if(raw.stage==='EMPTY'){
  if(raw.previousSha256!==null||raw.contentSha256!==null||raw.auditEventId!==null)fail();
 }else if(!hash(raw.previousSha256)||!hash(raw.contentSha256)||raw.stage==='VERIFIED'&&!uuid(raw.auditEventId)||raw.stage!=='VERIFIED'&&raw.auditEventId!==null)fail();
 return Object.freeze(JSON.parse(canonical(raw)));
}
export function emptyFieldRestorePhase({operationId,backupId,restoreIntentSha256,databaseName,databaseOid}){return fieldRestorePhase({format:'idms-field-restore-phase-v1',operationId,backupId,restoreIntentSha256,databaseName,databaseOid,stage:'EMPTY',previousSha256:null,contentSha256:null,auditEventId:null});}
export function nextFieldRestorePhase(previous,stage,contentSha256,auditEventId=null){const p=fieldRestorePhase(previous);if(stages.indexOf(stage)!==stages.indexOf(p.stage)+1)fail();return fieldRestorePhase({...p,stage,previousSha256:sourceFreezeSha(p),contentSha256,auditEventId});}
export function fieldRestorePhaseSql(raw,ownerRole){const p=fieldRestorePhase(raw);if(typeof ownerRole!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(ownerRole))fail();const comment=(prefix+canonical(p)).replaceAll("'","''");return `SET LOCAL ROLE ${q(ownerRole)};\nCOMMENT ON DATABASE ${q(p.databaseName)} IS '${comment}';\n`;}
export async function readFieldRestorePhase(client,databaseName){const rows=(await client.query("SELECT oid::text AS oid,datname,shobj_description(oid,'pg_database') AS comment FROM pg_database WHERE datname=$1 AND datname=current_database()",[databaseName])).rows;if(rows.length!==1||typeof rows[0].comment!=='string'||!rows[0].comment.startsWith(prefix)||rows[0].comment.length>4096)fail();let p;try{p=fieldRestorePhase(JSON.parse(rows[0].comment.slice(prefix.length)));}catch{fail();}if(p.databaseName!==rows[0].datname||p.databaseOid!==rows[0].oid||rows[0].comment!==prefix+canonical(p))fail();return p;}
export function classifyFieldRestorePhase(actual,previous,next){const a=fieldRestorePhase(actual),p=fieldRestorePhase(previous),n=fieldRestorePhase(next);if(n.previousSha256!==sourceFreezeSha(p)||n.operationId!==p.operationId||n.backupId!==p.backupId||n.restoreIntentSha256!==p.restoreIntentSha256||n.databaseName!==p.databaseName||n.databaseOid!==p.databaseOid||stages.indexOf(n.stage)!==stages.indexOf(p.stage)+1)fail();if(canonical(a)===canonical(n))return 'COMMITTED';if(canonical(a)===canonical(p))return 'PENDING';fail();}
