import {open,lstat,realpath,opendir} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {canonical} from '../server/imports.ts';
import {fieldRecoveryControl} from '../integrations/field-recovery.ts';
import {fieldRegistrationCandidate} from '../server/field-recovery-registration.ts';
import {fieldRecoveryOperationIntent} from './field-recovery-files.mjs';
import {readMaintenanceJson} from './field-maintenance-record.mjs';
import {sourceFreezeSha as sha} from './field-source-freeze-policy.mjs';
import {recoveryHostId,recoveryError} from './field-recovery-lock.mjs';
import {reviewPhase,reviewEqual as same} from './field-recovery-review-record.mjs';
import {externalObject as object,externalUuid as uuid} from './field-recovery-external-config.mjs';
const fail=code=>{throw recoveryError(code);},hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);

// Publication is a subordinate file primitive, never an activation decision.
// The coordinator must authenticate approval, actual DB phase, identities,
// materials and current external state before invoking any transition.
export function activationPublicationIntent(raw){
 object(raw,['format','tenantId','operationId','attemptId','operationIntentSha256','authorityId','ownerHostId','controlPathSha256','planId','planSha256','approvalPhase','registrationSha256','configSha256','before','after','createdAtMs']);
 const r=raw,before=fieldRecoveryControl(r.before),after=fieldRecoveryControl(r.after),approval=reviewPhase(r.approvalPhase);
 if(r.format!=='idms-field-activation-publication-intent-v1'||!uuid(r.operationId)||!uuid(r.attemptId)||!uuid(r.planId)||!['operationIntentSha256','authorityId','ownerHostId','controlPathSha256','planSha256','registrationSha256','configSha256'].every(k=>hash(r[k]))||approval.stage!=='APPROVED'||approval.operationId!==r.operationId||approval.planId!==r.planId||before.tenantId!==r.tenantId||before.state!=='RESTORING'||before.operationId!==r.operationId||after.state!=='ACTIVE'||after.tenantId!==r.tenantId||after.operationId!==null||after.previousActivationId!==null||!same(after.identity,before.identity)||!Number.isSafeInteger(r.createdAtMs)||r.createdAtMs<before.changedAtMs||after.changedAtMs!==r.createdAtMs)fail('FIELD_ACTIVATION_PUBLICATION_INTENT_INVALID');
 return JSON.parse(canonical(r));
}
export class FieldActivationPublication {
 #guard;#file;#dir;#operation;#intent;#busy=null;#closed=false;
 constructor(guard,controlFile){this.#guard=guard;this.#file=resolve(controlFile);const leaf=basename(this.#file);if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(leaf)||/[.]$/.test(leaf)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(leaf))fail('FIELD_ACTIVATION_PUBLICATION_PATH_INVALID');this.#dir=this.#file+'.operations';guard.setWorkspace(this.#file);}
 get intent(){if(!this.#intent)fail('FIELD_ACTIVATION_PUBLICATION_INTENT_REQUIRED');return structuredClone(this.#intent);}
 get controlFile(){return this.#file;}
 async #run(work){if(this.#closed||this.#busy)fail('FIELD_ACTIVATION_PUBLICATION_BUSY');const job=Promise.resolve().then(async()=>{await this.#guard.assertHeld();await this.#guard.barrier();return work();});this.#busy=job;try{return await job;}finally{if(this.#busy===job)this.#busy=null;}}
 path(kind,attemptId=this.#intent?.attemptId,extension='json'){if(!uuid(attemptId)||!['publication','released','active','restoring'].includes(kind)||!['json','tmp'].includes(extension)||!this.#operation)fail('FIELD_ACTIVATION_PUBLICATION_PATH_INVALID');return resolve(this.#dir,this.#operation.operationId+'.activation-'+kind+'-'+attemptId+'.'+extension);}
 async #json(path,maximum=1048576){return readMaintenanceJson(path,maximum);}
 async #maybe(path,maximum){try{return await this.#json(path,maximum);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async #paths(){
  for(const p of [dirname(this.#file),this.#dir]){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink())fail('FIELD_ACTIVATION_PUBLICATION_PATH_INVALID');const actual=await realpath(p);if(process.platform==='win32'?actual.toLowerCase()!==p.toLowerCase():actual!==p)fail('FIELD_ACTIVATION_PUBLICATION_PATH_INVALID');}
  if(this.#operation){let count=0,total=0;const prefix=this.#operation.operationId+'.activation-';for await(const e of await opendir(this.#dir)){
   if(++total>6144)fail('FIELD_ACTIVATION_PUBLICATION_JOURNAL_INVALID');if(!e.name.toLowerCase().startsWith(prefix))continue;
   const match=e.name.slice(this.#operation.operationId.length+1).match(/^activation-(publication|baseline|attempt|prepared|result|released|active|restoring)-([a-f0-9-]{36})\.(json|tmp)$/);
   if(++count>1024||!e.isFile()||e.isSymbolicLink()||!e.name.startsWith(prefix)||!match||!uuid(match[2])||match[1]==='released'&&match[3]!=='json'||['active','restoring'].includes(match[1])&&match[3]!=='tmp')fail('FIELD_ACTIVATION_PUBLICATION_JOURNAL_INVALID');
   const s=await lstat(resolve(this.#dir,e.name));if(s.nlink!==1||s.size>1048576)fail('FIELD_ACTIVATION_PUBLICATION_JOURNAL_INVALID');
  }}
 }
 async #loadOperation(operationId){
  if(!uuid(operationId))fail('FIELD_ACTIVATION_PUBLICATION_OPERATION_INVALID');await this.#paths();
  const operation=fieldRecoveryOperationIntent(await this.#json(resolve(this.#dir,operationId+'.intent.json'),8192));
  if(operation.kind!=='RESTORE'||operation.operationId!==operationId||operation.tenantId!==this.#guard.tenantId||operation.ownerHostId!==recoveryHostId()||operation.authorityId!==this.#guard.authorityId||operation.controlPathSha256!==sha(process.platform==='win32'?this.#file.toLowerCase():this.#file))fail('FIELD_ACTIVATION_PUBLICATION_OPERATION_INVALID');
  this.#operation=operation;await this.#paths();return operation;
 }
 #bind(raw){const i=activationPublicationIntent(raw),o=this.#operation;
  if(i.operationId!==o.operationId||i.tenantId!==o.tenantId||i.operationIntentSha256!==sha(o)||i.authorityId!==o.authorityId||i.ownerHostId!==o.ownerHostId||i.controlPathSha256!==o.controlPathSha256||!same(i.before,o.after)||i.createdAtMs>Date.now())fail('FIELD_ACTIVATION_PUBLICATION_BINDING_CHANGED');return i;
 }
 async #marker(){const m=await this.#maybe(this.#file+'.operation.lock',8192);if(m&&!same(m,this.#operation))fail('FIELD_ACTIVATION_PUBLICATION_MARKER_CHANGED');return m;}
 async #control(){return fieldRecoveryControl(await this.#json(this.#file,2048));}
 async #stage(path,value){
  const existing=await this.#maybe(path,1048576);if(existing){if(!same(existing,value))fail('FIELD_ACTIVATION_PUBLICATION_STAGING_CONFLICT');return;}
  const bytes=Buffer.from(canonical(value));if(bytes.length>1048576)fail('FIELD_ACTIVATION_PUBLICATION_FILE_LIMIT');let h;
  try{h=await open(path,'wx',0o600);const s=await h.stat();if(!s.isFile()||s.nlink!==1)fail('FIELD_ACTIVATION_PUBLICATION_PATH_INVALID');await h.writeFile(bytes);await h.sync();}finally{await h?.close();}
 }
 async prepare({operationId,attemptId,planSha256,approvalPhase,registration,createdAtMs=Date.now()}){return this.#run(async()=>{
  const o=await this.#loadOperation(operationId),candidate=fieldRegistrationCandidate(registration);
  if(!await this.#marker()||!same(await this.#control(),o.after)||candidate.operationId!==operationId||candidate.tenantId!==o.tenantId||candidate.operationIntentSha256!==sha(o)||candidate.controlSha256!==sha(o.after)||!same(candidate.registry.recovery,o.after.identity))fail('FIELD_ACTIVATION_PUBLICATION_BINDING_CHANGED');
  const value=this.#bind({format:'idms-field-activation-publication-intent-v1',tenantId:o.tenantId,operationId,attemptId,operationIntentSha256:sha(o),authorityId:o.authorityId,ownerHostId:o.ownerHostId,controlPathSha256:o.controlPathSha256,planId:approvalPhase.planId,planSha256,approvalPhase,registrationSha256:sha(candidate.registry),configSha256:candidate.configSha256,before:o.after,after:{...o.after,state:'ACTIVE',operationId:null,previousActivationId:null,changedAtMs:createdAtMs},createdAtMs});
  const path=this.path('publication',attemptId),existing=await this.#maybe(path,1048576);if(existing){if(!same(existing,value))fail('FIELD_ACTIVATION_PUBLICATION_INTENT_CONFLICT');}else{const stage=this.path('publication',attemptId,'tmp');await this.#stage(stage,value);await this.#guard.nativeMove({mode:'Journal',controlFile:this.#file,source:stage,destination:path,expectedSha256:'MISSING'});}
  this.#intent=this.#bind(await this.#json(path));return this.intent;
 });}
 async load(operationId,attemptId){return this.#run(async()=>{await this.#loadOperation(operationId);this.#intent=this.#bind(await this.#json(this.path('publication',attemptId)));return this.intent;});}
 async #assert(){if(!this.#intent)fail('FIELD_ACTIVATION_PUBLICATION_INTENT_REQUIRED');await this.#paths();const original=fieldRecoveryOperationIntent(await this.#json(resolve(this.#dir,this.#operation.operationId+'.intent.json'),8192));if(!same(original,this.#operation)||!same(this.#bind(await this.#json(this.path('publication'))),this.#intent))fail('FIELD_ACTIVATION_PUBLICATION_INTENT_CHANGED');await this.#guard.assertHeld();}
 async inspect(){return this.#run(async()=>{await this.#assert();const control=await this.#control(),marker=await this.#marker(),released=await this.#maybe(this.path('released'),8192);if(released&&!same(released,this.#operation)||!same(control,this.#intent.before)&&!same(control,this.#intent.after)||!!marker===!!released)fail('FIELD_ACTIVATION_PUBLICATION_STATE_CONFLICT');return {control,markerPresent:!!marker,released:!!released};});}
 async publish(){return this.#run(async()=>{
  await this.#assert();const current=await this.#control();if(!await this.#marker()||!same(current,this.#intent.before)&&!same(current,this.#intent.after)||await this.#maybe(this.path('released'),8192))fail('FIELD_ACTIVATION_PUBLICATION_STATE_CONFLICT');
  if(same(current,this.#intent.before)){const source=this.path('active',undefined,'tmp');await this.#stage(source,this.#intent.after);await this.#guard.nativeMove({mode:'Publish',controlFile:this.#file,source,destination:this.#file,expectedSha256:sha(current),replace:true});}
  if(!same(await this.#control(),this.#intent.after)||!await this.#marker())fail('FIELD_ACTIVATION_PUBLICATION_UNCONFIRMED');
  await this.#guard.nativeMove({mode:'Release',controlFile:this.#file,source:this.#file+'.operation.lock',destination:this.path('released'),expectedSha256:sha(this.#operation)});
  if(await this.#marker()||!same(await this.#json(this.path('released'),8192),this.#operation)||!same(await this.#control(),this.#intent.after))fail('FIELD_ACTIVATION_PUBLICATION_UNCONFIRMED');return this.intent.after;
 });}
 // Only after the coordinator proves the original APPROVED DB phase and exact
 // FROZEN catalog. Never call after an ACTIVATED transaction has committed.
 async rearmRestoring(){return this.#run(async()=>{
  await this.#assert();const current=await this.#control();if(!same(current,this.#intent.before)&&!same(current,this.#intent.after))fail('FIELD_ACTIVATION_PUBLICATION_STATE_CONFLICT');
  const marker=await this.#marker(),released=await this.#maybe(this.path('released'),8192);if(released&&!same(released,this.#operation)||!!marker===!!released)fail('FIELD_ACTIVATION_PUBLICATION_STATE_CONFLICT');
  if(!marker)await this.#guard.nativeMove({mode:'Rearm',controlFile:this.#file,source:this.path('released'),destination:this.#file+'.operation.lock',expectedSha256:sha(this.#operation)});
  if(!await this.#marker())fail('FIELD_ACTIVATION_PUBLICATION_UNCONFIRMED');
  if(same(current,this.#intent.after)){const source=this.path('restoring',undefined,'tmp');await this.#stage(source,this.#intent.before);await this.#guard.nativeMove({mode:'Publish',controlFile:this.#file,source,destination:this.#file,expectedSha256:sha(current),replace:true});}
  if(!same(await this.#control(),this.#intent.before)||!await this.#marker()||await this.#maybe(this.path('released'),8192))fail('FIELD_ACTIVATION_PUBLICATION_UNCONFIRMED');return this.intent.before;
 });}
 async close(){this.#closed=true;await this.#busy?.catch(()=>{});}
}
