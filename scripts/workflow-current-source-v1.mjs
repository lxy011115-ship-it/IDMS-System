import pg from'pg';
import{randomUUID}from'node:crypto';
import{resolve,dirname}from'node:path';
import{realpath}from'node:fs/promises';
import{canonical}from'../server/imports.ts';
import{readOwnedApplicationFieldSourcePrivateV1}from'./application-lifecycle-v4.mjs';
import{readApplicationFileV1,applicationBindingV1}from'./runtime-application-config-v1.mjs';
import{readRuntimeColdControlV1}from'./runtime-cold-portable-control-v1.mjs';
import{readRuntimeColdReviewV3}from'./runtime-cold-readonly-control-v5.mjs';
import{workflowReviewFrozenInventoryV1,inspectWorkflowReviewSourceRoleV1,reviewSourceNeedV1 as need,reviewSourceHashV1 as hash}from'./workflow-review-source-facts-v1.mjs';
import{inspectWorkflowReaderHbaV1}from'./workflow-review-source-hba-v1.mjs';
import{inspectRuntimeWriteFenceCatalogV1}from'./runtime-write-fence-catalog-v1.mjs';

const owned=new WeakMap(),same=(a,b)=>canonical(a)===canonical(b),normal=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p),samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&normal(a)===normal(b),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sorted=v=>[...v].sort();

/** Historical projection only. Caller-provided objects cannot become an owned capability. */
export function validatePriorWorkflowReaderSourceV1(owner,trust,state){
 need(owner?.format==='OWNED_APPLICATION_FIELD_SOURCE_PRIVATE_V1'&&owner.originalTerminal?.normalFullGroup&&owner.originalTerminal.allOwnedTerminalProven&&owner.originalTerminal.allOwnedResourcesRetired&&owner.originalTerminal.exit?.code===0&&owner.originalTerminal.exit.signal===null,'CURRENT_READER_SOURCE_ORIGINAL_OWNER');
 const source=state?.source;need(state?.phase==='ADMITTED'&&trust?.sourceHash===hash(source)&&trust.controlId===source.controlId&&same(applicationBindingV1(state),owner.originalDeploymentBinding),'CURRENT_READER_SOURCE_ORIGINAL_CONTROL');
 need((source.format==='RUNTIME_COLD_SOURCE_V1'&&trust.format==='RUNTIME_COLD_TRUST_V1')||(source.format==='RUNTIME_COLD_REVIEW_SOURCE_V3'&&trust.format==='RUNTIME_COLD_REVIEW_TRUST_V3'),'CURRENT_READER_SOURCE_ORIGINAL_FORMAT');
 const contract=source.format==='RUNTIME_COLD_SOURCE_V1'?source.readerSourceContract:source.readerContract;
 need(contract,'CURRENT_READER_SOURCE_DECLARATION_REQUIRED');need(!(source.format==='RUNTIME_COLD_SOURCE_V1'?Object.hasOwn(source,'readerContract'):Object.hasOwn(source,'readerSourceContract')),'CURRENT_READER_SOURCE_AMBIGUOUS_CONTRACT');
 workflowReviewFrozenInventoryV1(source.inventory,contract,source.inventory.identity.directory);
 need(samePath(contract.sourceDirectory,source.inventory.identity.directory)&&contract.systemIdentifier===source.inventory.identity.system_id,'CURRENT_READER_SOURCE_CONTRACT_DIRECTORY');
 need(state.details.restore?.fullArchiveAuthenticationVerified===true&&state.details.restore.fullFileHashesVerified===true&&state.details.restore.systemIdentifier===contract.systemIdentifier&&state.details.restore.backupId===source.backupId&&samePath(state.details.restore.directory,state.details.targetDirectory),'CURRENT_READER_SOURCE_ORIGINAL_RESTORE');
 need(uuid(contract.installationId)&&same(sorted(contract.readers.map(r=>r.facts.tenantId)),sorted(owner.tenantIds))&&new Set(contract.readers.map(r=>r.facts.tenantId)).size===contract.readers.length,'CURRENT_READER_SOURCE_TENANT_COVERAGE');
 for(const r of contract.readers){
  const f=r.facts,b=source.active.find(b=>b.databaseOid===f.identity.database_oid);need(b&&same(r.fenceBinding,b)&&f.identity.control_oid===source.inventory.identity.control_oid&&f.identity.current_oid===f.identity.control_oid&&f.identity.standby===false&&f.fence.deployment===b.deployment&&f.fence.databaseOid===b.databaseOid&&f.fence.ownerOid===b.ownerOid&&f.fence.controlOid===b.controlOid&&b.actorOids.includes(f.role.oid)&&uuid(f.authorityId)&&hex(f.bpmnSha256),'CURRENT_READER_SOURCE_INITIAL_READER_BINDING');
 }
 return{format:'CURRENT_WORKFLOW_READER_SOURCE_PRIOR_V1',originalControlId:source.controlId,originalSourceHash:trust.sourceHash,originalReaderContractSha256:contract.sha256,systemIdentifier:contract.systemIdentifier,targetDirectory:resolve(state.details.targetDirectory),originalDeploymentBinding:structuredClone(owner.originalDeploymentBinding),originalReaderContract:structuredClone(contract),originalActive:structuredClone(source.active),originalInventory:structuredClone(source.inventory),sourceOnly:true,currentSqlRecaptured:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
}
async function sourceSnapshot(sourceOwner){
 const owner=await readOwnedApplicationFieldSourcePrivateV1(sourceOwner),manifest=owner.registryHeader.manifest,file=await readApplicationFileV1(resolve(dirname(owner.manifestFile),manifest.trustFile));
 need(owner.registryHeader.pins.some(p=>samePath(p.path,file.path)&&p.sha256===file.sha256),'CURRENT_READER_SOURCE_UNPINNED_TRUST');const trust=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(file.bytes));
 const state=trust.format==='RUNTIME_COLD_TRUST_V1'?await readRuntimeColdControlV1(trust):trust.format==='RUNTIME_COLD_REVIEW_TRUST_V3'?await readRuntimeColdReviewV3(trust):null;
 const prior=validatePriorWorkflowReaderSourceV1(owner,trust,state);return{owner,prior};
}
export async function createOwnedCurrentWorkflowReaderSourceV1(sourceOwner){
 const snapshot=await sourceSnapshot(sourceOwner),captureId=randomUUID(),cap=Object.freeze({format:'OWNED_CURRENT_WORKFLOW_READER_SOURCE_V1',captureId});owned.set(cap,{sourceOwner,snapshot,closed:false,blocked:false,job:null,closeJob:null,clients:new Set(),captured:null});return cap;
}
async function current(cap,sourceOwner){
 const r=owned.get(cap);need(r&&!r.closed&&!r.blocked&&r.sourceOwner===sourceOwner,'CURRENT_READER_SOURCE_CAPABILITY');const fresh=await sourceSnapshot(sourceOwner);need(!r.closed&&!r.blocked&&same(fresh,r.snapshot),'CURRENT_READER_SOURCE_ORIGINAL_CHANGED');return r;
}
async function withSql(r,account,database,fn){
 const c=new pg.Client({...account,database,application_name:'idms-current-reader-source-v1',connectionTimeoutMillis:5000,statement_timeout:15000,lock_timeout:5000});c.on('error',()=>{});r.clients.add(c);let problem;
 try{await c.connect();need(!r.closed,'CURRENT_READER_SOURCE_CLOSED');return await fn(c);}
 catch(e){problem=e;throw e;}
 finally{try{const socket=c.connection?.stream,closed=!socket||socket.closed?Promise.resolve():new Promise(ok=>socket.once('close',ok));await c.end();await closed;r.clients.delete(c);}catch(e){r.blocked=true;if(problem)problem.currentReaderSourceCleanupUnproven=true;else throw e;}}
}
/** Uses only original persisted readers and SELECT queries on the currently closed source. */
export function captureOwnedCurrentWorkflowReaderSourceV1(cap,root,{sourceOwner,frame}){
 const r=owned.get(cap);need(r&&!r.closed&&!r.blocked&&r.sourceOwner===sourceOwner&&!r.job&&!r.captured,'CURRENT_READER_SOURCE_CAPABILITY');
 const job=(async()=>{
  await current(cap,sourceOwner);need(root instanceof pg.Client&&root.getTransactionStatus?.()==='I','CURRENT_READER_SOURCE_CONTROL_CLIENT');const p=root.connectionParameters;
  need(p.host==='127.0.0.1'&&Number.isInteger(p.port)&&p.port>1024&&p.port<=65535&&p.database==='postgres'&&typeof p.password==='string'&&p.password.length>=32,'CURRENT_READER_SOURCE_CONTROL_ACCOUNT');
  const identity=(await root.query("SELECT (pg_control_system()).system_identifier::text AS system,current_setting('data_directory') AS directory,session_user::regrole::oid::text AS control,current_user::regrole::oid::text AS current,current_database() AS database,pg_is_in_recovery() AS standby,inet_server_port() AS port")).rows[0],prior=r.snapshot.prior;
  need(identity.system===prior.systemIdentifier&&identity.control===identity.current&&identity.control===prior.originalInventory.identity.control_oid&&!identity.standby&&identity.database==='postgres'&&identity.port===p.port&&samePath(await realpath(identity.directory),prior.targetDirectory),'CURRENT_READER_SOURCE_CURRENT_CLUSTER');
  need(frame?.inventory.identity.system_id===identity.system&&samePath(frame.inventory.identity.directory,prior.targetDirectory)&&frame.inventory.identity.control_oid===identity.control&&same(frame.active,prior.originalActive)&&uuid(frame.closedReceipt?.operationId),'CURRENT_READER_SOURCE_CLOSED_FRAME');
  const sourceDirectory=await realpath(identity.directory),old=prior.originalReaderContract,account={host:p.host,port:p.port,user:p.user,password:p.password},readers=[];
  const hbaReaders=old.readers.map(r=>({role:r.facts.role.rolname,database:r.facts.identity.database}));const hba=await inspectWorkflowReaderHbaV1(root,{sourceDirectory,readers:hbaReaders,expectedSha256:old.hba.sha256});need(same(hba,old.hba),'CURRENT_READER_SOURCE_HBA_CHANGED');
  for(const original of old.readers){
   await current(cap,sourceOwner);const f=original.facts,binding=frame.active.find(b=>b.databaseOid===f.identity.database_oid),closed=frame.closedReceipt.databases.find(d=>d.database===f.identity.database);need(binding&&closed&&same(binding,original.fenceBinding),'CURRENT_READER_SOURCE_REGISTERED_GATE');
   const facts=await withSql(r,account,f.identity.database,async c=>{
    const catalog=await inspectRuntimeWriteFenceCatalogV1(c);need(catalog.catalogHash===binding.catalogHash&&catalog.state.finalized&&catalog.state.catalog_hash===binding.catalogHash&&catalog.state.state==='CLOSED'&&catalog.state.operation===closed.operationId&&catalog.state.revision===String(closed.revision),'CURRENT_READER_SOURCE_GATE_NOT_CLOSED');
    return inspectWorkflowReviewSourceRoleV1(c,{tenantId:f.tenantId,role:f.role.rolname,roleOid:f.role.oid,authorityId:f.authorityId,bpmnSha256:f.bpmnSha256,login:true});
   });
   const{sha256:oldHash,...expected}=structuredClone(f);expected.identity.directory=sourceDirectory;const{sha256:newHash,...actual}=facts;need(hash(expected)===newHash&&same(actual,expected),'CURRENT_READER_SOURCE_ROLE_OR_PRIVILEGES_CHANGED');readers.push({facts,fenceBinding:binding});
  }
  await current(cap,sourceOwner);const finalHba=await inspectWorkflowReaderHbaV1(root,{sourceDirectory,readers:hbaReaders,expectedSha256:old.hba.sha256});need(same(finalHba,hba)&&r.clients.size===0,'CURRENT_READER_SOURCE_FINAL_HBA');
  const body={format:'WORKFLOW_REVIEW_SOURCE_CONTRACT_V1',installationId:old.installationId,systemIdentifier:prior.systemIdentifier,sourceDirectory,hba,readers,businessActivationGranted:false,formalFieldActivationGranted:false},contract={...body,sha256:hash(body)};workflowReviewFrozenInventoryV1(frame.inventory,contract,sourceDirectory);
  const lineage={format:'WORKFLOW_REVIEW_SOURCE_LINEAGE_V1',sourceOwnerCaptureId:sourceOwner.captureId,originalControlId:prior.originalControlId,originalSourceHash:prior.originalSourceHash,originalReaderContractSha256:old.sha256,currentReaderContractSha256:contract.sha256,systemIdentifier:prior.systemIdentifier,maintenanceOperationId:frame.closedReceipt.operationId,originalPersistedReadersOnly:true,actualSqlRolePrivilegesAndHbaRecaptured:true,sourceOnly:true,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
  need(!r.closed,'CURRENT_READER_SOURCE_CLOSED');r.captured={contract,lineage};return structuredClone(r.captured);
 })();r.job=job;void job.catch(()=>{r.blocked=true;}).finally(()=>{if(r.job===job)r.job=null;});return job;
}
export async function revalidateOwnedCurrentWorkflowReaderSourceV1(cap,sourceOwner){const r=await current(cap,sourceOwner);need(!r.job&&r.captured,'CURRENT_READER_SOURCE_CAPTURE_REQUIRED');return structuredClone(r.captured);}
export function closeOwnedCurrentWorkflowReaderSourceV1(cap){const r=owned.get(cap);need(r,'CURRENT_READER_SOURCE_CAPABILITY');if(r.closeJob)return r.closeJob;r.closed=true;return r.closeJob=(async()=>{await r.job?.catch(()=>{});need(r.clients.size===0,'CURRENT_READER_SOURCE_CLEANUP_UNPROVEN');r.snapshot=null;r.sourceOwner=null;r.captured=null;})();}
