import {DatabaseSync} from 'node:sqlite';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {IdentityAuthorityGuardV1,authorityRuntimeV1} from '../server/identity-authority-live-v1.ts';
import {fieldMapFrozenProfileV2,frozenMapHashV1 as hash,frozenMapNeedV1 as need,frozenMapUuidV1 as uuid} from './field-map-frozen-profile-v2.mjs';
import {openFieldMapFrozenMaintenanceV4} from './field-map-frozen-maintenance-v4.mjs';
import {createOwnedFieldRecoveryGuardV1} from './field-recovery-owned-guard-v1.mjs';
import {verifyFieldMapFullEvidenceV1} from './field-map-full-evidence-v1.mjs';
import {coldToolingV1,coldStoppedV1,coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {authenticateColdImageV1} from './pg-cold-image-portable-v1.mjs';
import {fieldRecoveryDatabaseBinding} from '../integrations/field-recovery.ts';
const phaseName='FIELD_REVIEW_V1',normal=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p),same=(a,b)=>canonical(a)===canonical(b),exact=(v,k)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
const outside=(file,dir)=>{const p=relative(normal(dir),normal(file));return p!==''&&(p==='..'||p.startsWith('..\\')||p.startsWith('../')||isAbsolute(p));};
export function fieldMapColdReviewConfigV1(raw){
 need(exact(raw,['format','purpose','trust','account','authority','profiles','binDirectory','keyFile','workDirectory'])&&raw.format===1&&raw.purpose==='FIELD_MAP_COLD_REVIEW_V1','FIELD_COLD_REVIEW_CONFIG');
 need(exact(raw.trust,['format','controlId','storeFile','sourceHash'])&&raw.trust.format==='RUNTIME_COLD_TRUST_V1'&&uuid(raw.trust.controlId)&&/^[a-f0-9]{64}$/.test(raw.trust.sourceHash),'FIELD_COLD_REVIEW_TRUST');
 need(exact(raw.account,['host','port','user','password','database'])&&['127.0.0.1','::1'].includes(raw.account.host)&&Number.isInteger(raw.account.port)&&raw.account.port>1024&&raw.account.port<=65535&&raw.account.user==='idms_bootstrap'&&raw.account.database==='postgres'&&typeof raw.account.password==='string'&&raw.account.password.length>=32,'FIELD_COLD_REVIEW_ACCOUNT');
 for(const p of [raw.trust.storeFile,raw.binDirectory,raw.keyFile,raw.workDirectory])need(typeof p==='string'&&isAbsolute(p)&&p.length<=4096&&!/[\x00-\x1f\x7f]/.test(p),'FIELD_COLD_REVIEW_PATH');
 need(Array.isArray(raw.profiles)&&raw.profiles.length>0&&raw.profiles.length<=32,'FIELD_COLD_REVIEW_PROFILES');const profiles=raw.profiles.map(fieldMapFrozenProfileV2);need(new Set(profiles.map(p=>p.tenantId)).size===profiles.length&&new Set(profiles.map(p=>p.binding.databaseOid)).size===profiles.length&&profiles.every(p=>p.fenceBinding.host===raw.account.host&&p.fenceBinding.port===raw.account.port),'FIELD_COLD_REVIEW_PROFILE_BINDING');
 return {...structuredClone(raw),authority:authorityRuntimeV1(structuredClone(raw.authority)),profiles};
}

/** Durable claim/status only. No APPROVE, activation, ordinary HTTP or SQL mutation entry. */
export class FieldMapColdReviewControlV1 {
 #config;#busy=false;#closed=false;#resources=new Set();
 constructor(config){this.#config=fieldMapColdReviewConfigV1(config);}
 async #open(){const c=this.#config,s=await lstat(c.trust.storeFile);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=32*1024**2,'FIELD_COLD_REVIEW_STORE');const db=new DatabaseSync(c.trust.storeFile,{allowExtension:false,timeout:3000});try{db.exec('PRAGMA synchronous=FULL;PRAGMA busy_timeout=3000;BEGIN IMMEDIATE;');return db;}catch(e){db.close();throw e;}}
 #read(db){const c=this.#config,r=db.prepare('SELECT * FROM cold_control WHERE id=1').get();need(r&&r.control_id===c.trust.controlId&&r.body_hash===c.trust.sourceHash&&hash(r.body)===c.trust.sourceHash&&hash(r.details)===r.details_hash,'FIELD_COLD_REVIEW_STORE_BINDING');const source=JSON.parse(r.body),details=JSON.parse(r.details);need(canonical(source)===r.body&&canonical(details)===r.details&&source.format==='RUNTIME_COLD_SOURCE_V1'&&source.controlId===c.trust.controlId&&uuid(source.backupId)&&source.inventory&&source.closedReceipt,'FIELD_COLD_REVIEW_SOURCE');return {source,details,phase:r.phase};}
 async #authority(s){const h=await new IdentityAuthorityGuardV1(this.#config.authority).assertCurrent();need(h.event.authorityId===s.source.sourceAuthority.authorityId&&h.event.epoch>=s.source.sourceAuthority.epoch&&h.event.issuer===s.source.sourceAuthority.issuer&&h.event.binding.systemIdentifier!==s.source.inventory.identity.system_id,'FIELD_COLD_REVIEW_CURRENT_AUTHORITY');return h;}
 async #material(s){
  const c=this.#config,source=s.source,d=s.details;need(['RESTORED',phaseName].includes(s.phase)&&d.targetDirectory&&d.restore?.backupId===source.backupId&&d.restore?.systemIdentifier===source.inventory.identity.system_id&&d.restore.fullArchiveAuthenticationVerified&&d.restore.fullFileHashesVerified,'FIELD_COLD_REVIEW_RESTORED_REQUIRED');
  need(normal(await realpath(d.targetDirectory))===normal(d.targetDirectory)&&normal(d.targetDirectory)!==normal(source.inventory.identity.directory),'FIELD_COLD_REVIEW_TARGET');
  for(const file of [c.trust.storeFile,c.keyFile,c.workDirectory,c.binDirectory])for(const dir of [source.inventory.identity.directory,d.targetDirectory])need(outside(file,dir),'FIELD_COLD_REVIEW_MATERIAL_IN_PGDATA');
  const tooling=await coldToolingV1(c.binDirectory);need(same(tooling.binding,d.tooling),'FIELD_COLD_REVIEW_PROGRAM_CHANGED');const sourceControl=await coldStoppedV1(source.inventory.identity.directory,tooling,source.inventory.identity.system_id);need(same(sourceControl,d.sourceControl),'FIELD_COLD_REVIEW_SOURCE_NOT_RETIRED');
  const file=await coldFileHashV1(d.backup.file);need(file.sha256===d.backup.sha256&&file.bytes===d.backup.bytes&&d.backup.backupId===source.backupId,'FIELD_COLD_REVIEW_BACKUP_CHANGED');
  const authenticated=await authenticateColdImageV1({backupFile:d.backup.file,keyFile:c.keyFile,workDirectory:c.workDirectory});try{const m=authenticated.manifest;need(m.backupId===source.backupId&&m.control.systemIdentifier===source.inventory.identity.system_id&&same(m.control,d.sourceControl)&&m.evidence?.coldControlId===source.controlId&&m.evidence.sourceHash===c.trust.sourceHash&&m.evidence.maintenanceOperationId===source.maintenanceOperationId,'FIELD_COLD_REVIEW_ARCHIVE_BINDING');}finally{await authenticated.dispose();}
  const configBinding={trust:c.trust,account:{host:c.account.host,port:c.account.port,user:c.account.user,database:c.account.database},authority:c.authority,profiles:c.profiles,workDirectory:c.workDirectory,keyFile:c.keyFile,binDirectory:c.binDirectory,tooling:tooling.binding,keyFileSha256:createHash('sha256').update(await readFile(c.keyFile)).digest('hex'),backupSha256:file.sha256,targetDirectory:d.targetDirectory};
  for(const p of c.profiles){const gate=source.active.find(v=>v.databaseOid===p.binding.databaseOid),structure=source.structures.find(v=>v.database===p.fenceBinding.database),closed=source.closedReceipt.databases.find(v=>v.database===p.fenceBinding.database);need(same(p.inventory,source.inventory)&&normal(p.targetDirectory)===normal(d.targetDirectory)&&same(gate,p.fenceBinding)&&structure?.sha256===p.structureSha256&&closed?.operationId===p.closed.operationId&&String(closed?.revision)===p.closed.revision,'FIELD_COLD_REVIEW_CAPTURE_BINDING');}
  return {bindingSha256:hash(configBinding),sourceControl,tooling};
 }
 async #facts(s,recoveryId){
  const c=this.#config,results=[],maps=[];
  for(const gate of s.source.active){const resource={client:new pg.Client({...c.account,database:gate.database,connectionTimeoutMillis:5000}),guard:null};this.#resources.add(resource);resource.client.on('error',()=>{});let problem;try{await resource.client.connect();const present=(await resource.client.query("SELECT to_regnamespace('state_map_v1')::text AS value")).rows[0].value;if(present){const m=(await resource.client.query('SELECT tenant FROM state_map_v1._meta')).rows;need(m.length===1,'FIELD_COLD_REVIEW_MAP_META');maps.push({database:gate.database,tenantId:m[0].tenant});}}catch(e){problem=e;throw e;}finally{try{await this.#retire(resource);}catch(e){if(!problem)throw e;problem.resourceCleanupUnproven=true;}}}
  need(same(maps.sort((a,b)=>a.tenantId.localeCompare(b.tenantId)),c.profiles.map(p=>({database:p.fenceBinding.database,tenantId:p.tenantId})).sort((a,b)=>a.tenantId.localeCompare(b.tenantId))),'FIELD_COLD_REVIEW_MAP_COVERAGE');
  for(const p of c.profiles){let guard,client,snapshot,problem;const resource={client:null,guard:null};this.#resources.add(resource);
   try{guard=await createOwnedFieldRecoveryGuardV1({authority:{host:c.account.host,port:c.account.port,bootstrapPassword:c.account.password},profile:p,controlFile:join(dirname(c.trust.storeFile),'field-'+p.tenantId+'-'+recoveryId+'.control')});resource.guard=guard;
    client=new pg.Client({...c.account,database:p.fenceBinding.database,connectionTimeoutMillis:5000});resource.client=client;client.on('error',()=>{});await client.connect();await client.query('BEGIN');snapshot=await openFieldMapFrozenMaintenanceV4(client,p,[guard]);const evidenceFile=join(c.workDirectory,'field-full-'+recoveryId+'-'+p.tenantId+'-'+randomUUID()+'.jsonl'),captured=await snapshot.fullFacts(evidenceFile);await snapshot.close();snapshot=null;await client.query('ROLLBACK');
    const independent=await verifyFieldMapFullEvidenceV1({file:evidenceFile,expectedFacts:captured.facts,workDirectory:c.workDirectory});need(independent.entireCurrentRootIndependentlyRebuilt&&independent.fullDomainPayloadIndependentlyReconstructed,'FIELD_COLD_REVIEW_FULL_EVIDENCE');const writer=p.inventory.roles.find(r=>r.oid===p.binding.roleOid),evidence=await coldFileHashV1(evidenceFile);results.push({tenantId:p.tenantId,database:p.fenceBinding.database,binding:p.binding,head:captured.facts.head,facts:captured.facts,evidenceFile,evidenceSha256:evidence.sha256,databaseBindingSha256:fieldRecoveryDatabaseBinding({host:c.account.host,port:c.account.port,database:p.fenceBinding.database,user:writer.rolname})});
   }catch(e){problem=e;throw e;}finally{
    try{await this.#retire(resource);}catch(e){if(!problem)throw e;problem.resourceCleanupUnproven=true;}
   }
  }return results;
 }
 async #retire(resource){
  const errors=[],client=resource.client;if(client){try{if(['T','E'].includes(client.getTransactionStatus?.()))await client.query('ROLLBACK');}catch(e){errors.push(e);}const socket=client.connection?.stream,terminal=!socket||socket.closed?Promise.resolve():new Promise(ok=>socket.once('close',ok));try{await client.end();await terminal;resource.client=null;}catch(e){errors.push(e);}}
  try{await resource.guard?.close();resource.guard=null;}catch(e){errors.push(e);}if(!resource.client&&!resource.guard)this.#resources.delete(resource);if(errors.length)throw Object.assign(Error('FIELD_COLD_REVIEW_RESOURCE_CLOSE_UNPROVEN'),{code:'FIELD_COLD_REVIEW_RESOURCE_CLOSE_UNPROVEN',cause:errors[0]});
 }
 async #run(action,{recoveryId}){
  need(!this.#closed&&!this.#busy&&uuid(recoveryId),'FIELD_COLD_REVIEW_REQUEST');need(this.#resources.size===0,'FIELD_COLD_REVIEW_CLEANUP_REQUIRED');this.#busy=true;let db;
  try{db=await this.#open();const s=this.#read(db);need(action==='CLAIM'?['RESTORED',phaseName].includes(s.phase):s.phase===phaseName,'FIELD_COLD_REVIEW_PHASE');const prior=s.details.fieldReview;
   if(s.phase===phaseName){need(prior?.format==='FIELD_MAP_COLD_REVIEW_CLAIM_V1'&&prior.recoveryId===recoveryId&&prior.coldControlId===this.#config.trust.controlId&&prior.sourceHash===this.#config.trust.sourceHash&&prior.backupId===s.source.backupId&&uuid(prior.deploymentId)&&Array.isArray(prior.baselines)&&prior.baselines.length===this.#config.profiles.length&&prior.reviewApproved===false&&prior.activationGranted===false,'FIELD_COLD_REVIEW_OPERATION_CONFLICT');for(const b of prior.baselines){const {factsSha256,...body}=b.facts??{};need(uuid(b.activationId)&&hash(body)===factsSha256&&outside(b.evidenceFile,s.details.targetDirectory),'FIELD_COLD_REVIEW_BASELINE_INVALID');const rel=relative(this.#config.workDirectory,b.evidenceFile);need(rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel),'FIELD_COLD_REVIEW_EVIDENCE_PATH');need((await coldFileHashV1(b.evidenceFile)).sha256===b.evidenceSha256,'FIELD_COLD_REVIEW_EVIDENCE_CHANGED');}}else need(!prior,'FIELD_COLD_REVIEW_UNKNOWN_CLAIM');
   const material=await this.#material(s);if(prior)need(prior.bindingSha256===material.bindingSha256,'FIELD_COLD_REVIEW_CONFIGURATION_CHANGED');const authority=await this.#authority(s),facts=await this.#facts(s,recoveryId);need((await this.#authority(s)).hash===authority.hash,'FIELD_COLD_REVIEW_AUTHORITY_CHANGED_DURING_READ');need(same(await coldStoppedV1(s.source.inventory.identity.directory,material.tooling,s.source.inventory.identity.system_id),material.sourceControl),'FIELD_COLD_REVIEW_SOURCE_CHANGED');
   if(prior)need(same(prior.baselines.map(b=>({tenantId:b.tenantId,head:b.head,factsSha256:b.facts.factsSha256})),facts.map(b=>({tenantId:b.tenantId,head:b.head,factsSha256:b.facts.factsSha256}))),'FIELD_COLD_REVIEW_BASELINE_CHANGED');
   const claim=prior??{format:'FIELD_MAP_COLD_REVIEW_CLAIM_V1',recoveryId,coldControlId:s.source.controlId,backupId:s.source.backupId,sourceHash:this.#config.trust.sourceHash,bindingSha256:material.bindingSha256,createdAt:new Date().toISOString(),deploymentId:randomUUID(),claimAuthority:{authorityId:authority.event.authorityId,epoch:authority.event.epoch,hash:authority.hash},baselines:facts.map(b=>({...b,activationId:randomUUID()})),reviewApproved:false,activationGranted:false};
   if(!prior){s.details.fieldReview=claim;const body=canonical(s.details);db.prepare('UPDATE cold_control SET phase=?,details=?,details_hash=? WHERE id=1').run(phaseName,body,hash(body));}db.exec('COMMIT;');
   return {format:'FIELD_MAP_COLD_REVIEW_STATUS_V1',phase:phaseName,recoveryId,coldControlId:claim.coldControlId,backupId:claim.backupId,deploymentId:claim.deploymentId,alreadyClaimed:!!prior,tenants:claim.baselines.map(b=>({tenantId:b.tenantId,head:b.head,factsSha256:b.facts.factsSha256,activationId:b.activationId,auditEvents:b.facts.auditEvents,entireCurrentRootVerified:true})),currentAuthorityHash:authority.hash,businessWritesEnabled:false,currentOidcReviewerVerified:false,reviewApproved:false,formalFieldActivationGranted:false,fullGoalComplete:false};
  }catch(e){if(db)try{db.exec('ROLLBACK;');}catch{}throw e;}finally{db?.close();this.#busy=false;}
 }
 claim(options){return this.#run('CLAIM',options);}
 status(options){return this.#run('STATUS',options);}
 state(){return Object.freeze({busy:this.#busy,closed:this.#closed,ownedResourceGroups:this.#resources.size});}
 async close(){need(!this.#busy,'FIELD_COLD_REVIEW_BUSY');this.#closed=true;for(const resource of [...this.#resources])await this.#retire(resource);this.#config.account.password='';this.#config.authority.reader.clientSecret='';}
}
