import {canonical} from '../server/imports.ts';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {fieldRestorePhase,classifyFieldRestorePhase} from './field-restore-phase.mjs';
const fail=()=>{throw Object.assign(Error('FIELD_RESTORE_FLOW_RECORD_INVALID'),{code:'FIELD_RESTORE_FLOW_RECORD_INVALID'});};
const obj=(v,keys)=>{if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();return v;};
const hash=v=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail();};
const uuid=v=>{if(typeof v!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v))fail();};
const iso=v=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail();};
const bytes=v=>{if(!Number.isSafeInteger(v)||v<1||v>8*1024**3+1048576)fail();};
const copy=v=>{const out=JSON.parse(canonical(v));const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}};freeze(out);return out;};
export const restoreSections=Object.freeze(['pre-data','data','post-data']);
function base(r,format){if(r.format!==format)fail();uuid(r.operationId);hash(r.restoreIntentSha256);}
export function fieldRestoreRun(raw){const r=obj(raw,['format','operationId','restoreIntentSha256','runId','createdAt']);base(r,'idms-field-restore-run-v1');uuid(r.runId);iso(r.createdAt);return copy(r);}
export function fieldRestoreTool(raw){
 const r=obj(raw,['format','operationId','restoreIntentSha256','runId','toolId','kind','section','program','programSha256','args','ownerHostId','ownerPid','ownerStartTicks','applicationName','inputs','output']);base(r,'idms-field-restore-tool-v1');uuid(r.runId);uuid(r.toolId);hash(r.programSha256);hash(r.ownerHostId);
 if(!['GENERATE','APPLY'].includes(r.kind)||!restoreSections.includes(r.section)||typeof r.program!=='string'||!r.program.length||r.program.length>4096||!Number.isSafeInteger(r.ownerPid)||r.ownerPid<1||typeof r.ownerStartTicks!=='string'||!/^\d{17,20}$/.test(r.ownerStartTicks)||r.applicationName!=='idms-field-restore-'+r.toolId||!Array.isArray(r.args)||r.args.length>12||r.args.some(s=>typeof s!=='string'||s.length>4200)||!Array.isArray(r.inputs)||r.inputs.length!==(r.kind==='GENERATE'?1:3))fail();
 for(const f of r.inputs){obj(f,['path','sha256','bytes']);if(typeof f.path!=='string'||!f.path.length||f.path.length>4096)fail();hash(f.sha256);bytes(f.bytes);}
 if(r.kind==='GENERATE'?(typeof r.output!=='string'||!r.output.length||r.output.length>4096):r.output!==null)fail();return copy(r);
}
export function fieldRestoreWorkSha(r){return sourceFreezeSha({restoreIntentSha256:r.restoreIntentSha256,section:r.section,previousSha256:sourceFreezeSha(r.previous),dumpSha256:r.dumpSha256,sql:r.sql,prefix:r.prefix,generationProgramSha256:r.generationProgramSha256,executionProgramSha256:r.executionProgramSha256});}
export function fieldRestorePlan(raw){
 const r=obj(raw,['format','operationId','restoreIntentSha256','section','runId','previous','next','dumpSha256','sql','prefix','marker','generationProgramSha256','executionProgramSha256']);base(r,'idms-field-restore-plan-v1');uuid(r.runId);if(!restoreSections.includes(r.section))fail();for(const k of ['dumpSha256','generationProgramSha256','executionProgramSha256'])hash(r[k]);for(const k of ['sql','prefix','marker']){obj(r[k],['bytes','sha256']);bytes(r[k].bytes);hash(r[k].sha256);}const p=fieldRestorePhase(r.previous),n=fieldRestorePhase(r.next);
 if(p.operationId!==r.operationId||p.restoreIntentSha256!==r.restoreIntentSha256||n.stage!==r.section||n.contentSha256!==fieldRestoreWorkSha(r)||classifyFieldRestorePhase(n,p,n)!=='COMMITTED')fail();return copy(r);
}
export function fieldRestoreVerification(raw){
 const r=obj(raw,['format','operationId','restoreIntentSha256','provisionSha256','phaseChainSha256','postDataPhaseSha256','sourceFactsSha256','rawFactsSha256','expectedReboundFactsSha256','sourceRootRecord','sourceAuditCount','sourceAuditHead','createdAt']);base(r,'idms-field-restore-verification-intent-v1');for(const k of ['provisionSha256','phaseChainSha256','postDataPhaseSha256','sourceFactsSha256','rawFactsSha256','expectedReboundFactsSha256','sourceAuditHead'])hash(r[k]);if(typeof r.sourceRootRecord!=='string'||Buffer.byteLength(r.sourceRootRecord)>4096||!Number.isSafeInteger(r.sourceAuditCount)||r.sourceAuditCount<3)fail();try{const root=JSON.parse(r.sourceRootRecord);obj(root,['tenant_id','revision','schema_version','payload_digest','updated_at']);if(typeof root.updated_at!=='string'||!Number.isFinite(Date.parse(root.updated_at)))fail();}catch{fail();}iso(r.createdAt);return copy(r);
}
export function fieldRestoreResult(raw){const r=obj(raw,['format','operationId','restoreIntentSha256','verificationIntentSha256','phaseSha256','finalFactsSha256','auditEventId','revision']);base(r,'idms-field-restore-result-v1');for(const k of ['verificationIntentSha256','phaseSha256','finalFactsSha256'])hash(r[k]);uuid(r.auditEventId);if(!Number.isSafeInteger(r.revision)||r.revision<1)fail();return copy(r);}
export function bindRestoreFlow(state,intent,provision){
 const expected=sourceFreezeSha(intent);for(const value of [...state.runs,...state.tools,...state.plans,...[state.verification,state.result].filter(Boolean)])if(value.operationId!==intent.operationId||value.restoreIntentSha256!==expected)fail();
 const runs=new Map(state.runs.map(r=>[r.runId,r]));for(const t of state.tools)if(!runs.has(t.runId))fail();
 let previous;for(const section of restoreSections){const p=state.plans.find(x=>x.section===section);if(!p)break;if(!runs.has(p.runId)||p.previous.backupId!==intent.backupId||!provision||p.previous.databaseName!==provision.database.name||p.previous.databaseOid!==provision.database.oid||previous&&canonical(p.previous)!==canonical(previous))fail();previous=p.next;}
 if(state.plans.length!==restoreSections.filter(s=>state.plans.some(p=>p.section===s)).length||state.plans.some(p=>restoreSections.indexOf(p.section)>0&&!state.plans.some(q=>q.section===restoreSections[restoreSections.indexOf(p.section)-1])))fail();
 if(state.verification){if(state.plans.length!==3||state.verification.provisionSha256!==sourceFreezeSha(provision)||state.verification.phaseChainSha256!==sourceFreezeSha(state.plans)||state.verification.postDataPhaseSha256!==sourceFreezeSha(previous)||state.verification.sourceFactsSha256!==intent.sourceFactsSha256)fail();}
 if(state.result&&(!state.verification||state.result.verificationIntentSha256!==sourceFreezeSha(state.verification)))fail();return state;
}
export function restoreToolArguments(tool,intent,paths){
 const t=fieldRestoreTool(tool);if(t.kind==='GENERATE'){if(t.inputs[0].path!==paths.dump||t.output!==paths.sql)fail();return ['--no-owner','--no-acl','--no-password','--role='+intent.targetBinding.ownerRole,'--section='+t.section,'--file='+paths.sql,paths.dump];}
 if(t.output!==null||canonical(t.inputs.map(f=>f.path))!==canonical([paths.prefix,paths.sql,paths.marker]))fail();return ['--no-psqlrc','--no-password','--quiet','--single-transaction','--set=ON_ERROR_STOP=1','--file='+paths.prefix,'--file='+paths.sql,'--file='+paths.marker];
}
