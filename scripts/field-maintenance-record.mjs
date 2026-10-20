import {opendir} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {TextDecoder} from 'node:util';
import {canonical} from '../server/imports.ts';
import {fieldCaptureContext} from './field-capture-context.mjs';
import {fieldRecoveryControl,fieldRecoveryDatabaseBinding} from '../integrations/field-recovery.ts';
import {fieldRestoreIntent,fieldRestoreRoles,fieldRestoreProvision,bindFieldRestoreRoles,bindFieldRestoreProvision} from './field-restore-record.mjs';
import {fieldRestoreResult,fieldRestoreVerification} from './field-restore-flow-record.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {recoveryHostId} from './field-recovery-lock.mjs';
import {backupRegular,backupUnchanged,readExactly} from './field-backup-io.mjs';
import {maintenanceReviewJournal} from './field-maintenance-review-journal.mjs';
import {reviewPhase} from './field-recovery-review-record.mjs';
import {fieldRestorePhase} from './field-restore-phase.mjs';
export const maintenanceFailure=code=>Object.assign(Error(code),{code});
const fail=()=>{throw maintenanceFailure('FIELD_MAINTENANCE_RECORD_INVALID');};
const object=(v,keys)=>{if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();return v;};
const text=(v,max)=>{if(typeof v!=='string'||!v||v.length>max||/[\u0000-\u001f\u007f]/.test(v))fail();return v;};
const hash=v=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail();};
const uuid=v=>{if(typeof v!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v))fail();};
const id=v=>{if(typeof v!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(v))fail();};
const copy=v=>{const r=JSON.parse(canonical(v));const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}};freeze(r);return r;};
export function fieldMaintenanceAuth(raw,privateConfig=false){
 const a=object(raw,['mode','issuer','audience','clientId','origin',...(privateConfig&&raw?.clientSecret!==undefined?['clientSecret']:[])]);
 if(a.mode!=='oidc')fail();for(const k of ['issuer','origin'])text(a[k],2048);text(a.audience,128);text(a.clientId,128);if(a.clientId==='idms-web')fail();if(a.clientSecret!==undefined)text(a.clientSecret,4096);
 const issuer=new URL(a.issuer),origin=new URL(a.origin);for(const u of [issuer,origin])if(u.username||u.password||u.search||u.hash||u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))fail();
 if(a.issuer.endsWith('/')||origin.origin!==a.origin||origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||!Number.isInteger(Number(origin.port))||Number(origin.port)<1024||Number(origin.port)>65535||Number(origin.port)===4010)fail();return copy(a);
}
export function fieldMaintenanceCapability(raw){
 const v2=raw?.format==='idms-field-maintenance-capability-v2',c=object(raw,['format','tenantId','sessionId','operationId','backupId','ownerHostId','createdAt','expiresAt','controlFile','controlSha256','operationIntentSha256','restoreIntentSha256','rolesSha256','provisionSha256','resultSha256','verificationSha256','factsSha256','catalogSha256','phaseSha256','captureContext','account','auth',...(v2?['review']:[])]);
 if(!v2&&c.format!=='idms-field-maintenance-capability-v1'||typeof c.tenantId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(c.tenantId))fail();for(const k of ['sessionId','operationId','backupId'])uuid(c[k]);for(const k of ['ownerHostId','controlSha256','operationIntentSha256','restoreIntentSha256','rolesSha256','provisionSha256','resultSha256','verificationSha256','factsSha256','catalogSha256','phaseSha256'])hash(c[k]);
 if(v2){object(c.review,['phase','journalSha256']);hash(c.review.journalSha256);const phase=c.review.phase;if(phase?.format==='idms-field-recovery-review-phase-v1')reviewPhase(phase);else if(fieldRestorePhase(phase).stage!=='VERIFIED')fail();if(sourceFreezeSha(phase)!==c.phaseSha256||phase.contentSha256!==c.factsSha256||phase.operationId!==c.operationId||phase.backupId!==c.backupId||phase.databaseName!==c.account?.database)fail();}
 for(const k of ['createdAt','expiresAt'])if(typeof c[k]!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c[k])||!Number.isFinite(Date.parse(c[k]))||new Date(c[k]).toISOString()!==c[k])fail();if(Date.parse(c.expiresAt)<=Date.parse(c.createdAt)||Date.parse(c.expiresAt)-Date.parse(c.createdAt)>1800000)fail();
 text(c.controlFile,4096);if(resolve(c.controlFile)!==c.controlFile)fail();fieldCaptureContext(c.captureContext);
 const a=object(c.account,['host','port','database','user','ownerRole','backupRole','migrator','telemetry']);text(a.host,256);if(!['127.0.0.1','localhost','::1'].includes(a.host)||!Number.isInteger(a.port)||a.port<1||a.port>65535||typeof a.telemetry!=='boolean')fail();for(const k of ['database','user','ownerRole','backupRole','migrator'])id(a[k]);if(new Set([a.user,a.ownerRole,a.backupRole,a.migrator]).size!==4)fail();fieldMaintenanceAuth(c.auth);return copy(c);
}
export function fieldMaintenanceReaderConfig(raw){
 const r=object(raw,['format','purpose','capabilityFile','capabilitySha256','reader','auth','authJournalKey']);if(r.format!==1||r.purpose!=='FIELD_RECOVERY_MAINTENANCE_READER')fail();text(r.capabilityFile,128);if(basename(r.capabilityFile)!==r.capabilityFile||r.capabilityFile!=='capability.json')fail();hash(r.capabilitySha256);if(typeof r.authJournalKey!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(r.authJournalKey)||Buffer.from(r.authJournalKey,'base64url').length!==32)fail();
 const a=object(r.reader,['host','port','database','user','password']);text(a.host,256);if(!Number.isInteger(a.port)||a.port<1||a.port>65535)fail();id(a.database);id(a.user);if(a.user==='idms_bootstrap'||a.user==='postgres')fail();text(a.password,1024);if(a.password.length<32)fail();fieldMaintenanceAuth(r.auth,true);return copy(r);
}
export async function readMaintenanceJson(path,max=131072){
 const entry=await backupRegular(path,max);try{const bytes=await readExactly(entry.file,Number(entry.stat.size),0);await backupUnchanged(entry);const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!bytes.equals(Buffer.from(canonical(value))))fail();return value;}finally{await entry.file.close();}
}
export async function fieldMaintenanceFence(raw,now=Date.now()){
 const c=fieldMaintenanceCapability(raw);if(c.ownerHostId!==recoveryHostId()||Date.parse(c.createdAt)>now||Date.parse(c.expiresAt)<=now)throw maintenanceFailure('FIELD_MAINTENANCE_EXPIRED');
 const control=fieldRecoveryControl(await readMaintenanceJson(c.controlFile,2048)),marker=await readMaintenanceJson(c.controlFile+'.operation.lock',8192),dir=c.controlFile+'.operations',main=await readMaintenanceJson(resolve(dir,c.operationId+'.intent.json'),8192);
 if(sourceFreezeSha(control)!==c.controlSha256||control.state!=='RESTORING'||control.operationId!==c.operationId||control.tenantId!==c.tenantId||control.identity.databaseBindingSha256!==fieldRecoveryDatabaseBinding({host:c.account.host,port:c.account.port,database:c.account.database,user:c.account.user})||sourceFreezeSha(marker)!==c.operationIntentSha256||sourceFreezeSha(main)!==c.operationIntentSha256||main.kind!=='RESTORE'||canonical(main.after)!==canonical(control)||main.operationId!==c.operationId||main.tenantId!==c.tenantId)throw maintenanceFailure('FIELD_MAINTENANCE_FENCE_CHANGED');
 if(c.review){if((await maintenanceReviewJournal(c.controlFile,c.operationId)).sha256!==c.review.journalSha256)throw maintenanceFailure('FIELD_MAINTENANCE_REVIEW_JOURNAL_CHANGED');}else for await(const entry of await opendir(dir))if(entry.name.toLowerCase().startsWith(c.operationId+'.review-'))throw maintenanceFailure('FIELD_MAINTENANCE_REVIEW_STARTED');
 const values={};for(const [key,leaf,validator]of [['intent','restore-intent',fieldRestoreIntent],['roles','restore-roles',fieldRestoreRoles],['provision','restore-provision',fieldRestoreProvision],['result','restore-result',fieldRestoreResult],['verification','restore-verification',fieldRestoreVerification]])values[key]=validator(await readMaintenanceJson(resolve(dir,c.operationId+'.'+leaf+'.json'),8192));
 const hashes={intent:c.restoreIntentSha256,roles:c.rolesSha256,provision:c.provisionSha256,result:c.resultSha256,verification:c.verificationSha256};for(const key of Object.keys(values))if(sourceFreezeSha(values[key])!==hashes[key]||values[key].operationId!==c.operationId)throw maintenanceFailure('FIELD_MAINTENANCE_FENCE_CHANGED');
 bindFieldRestoreRoles(values.roles,values.intent);bindFieldRestoreProvision(values.provision,values.intent,values.roles);if(values.intent.backupId!==c.backupId||values.intent.captureContextSha256!==sourceFreezeSha(c.captureContext)||!c.review&&(values.result.finalFactsSha256!==c.factsSha256||values.result.phaseSha256!==c.phaseSha256)||values.result.verificationIntentSha256!==c.verificationSha256||c.review&&(c.review.phase.restorePhaseSha256??c.phaseSha256)!==values.result.phaseSha256)throw maintenanceFailure('FIELD_MAINTENANCE_FENCE_CHANGED');
 for(const key of ['host','port','database','user','ownerRole','backupRole'])if(c.account[key]!==values.intent.targetBinding[key])throw maintenanceFailure('FIELD_MAINTENANCE_FENCE_CHANGED');if(c.account.migrator!==values.intent.migratorRole)throw maintenanceFailure('FIELD_MAINTENANCE_FENCE_CHANGED');
 return {...values,control,main};
}
