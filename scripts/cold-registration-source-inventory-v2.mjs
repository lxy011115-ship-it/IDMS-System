import {dirname,isAbsolute} from 'node:path';
import {readRuntimeColdReviewV3} from './runtime-cold-readonly-control-v5.mjs';
import {validateColdSourceFullFactsV1} from './cold-source-full-facts-v2.mjs';
import {workflowReviewFrozenInventoryV1,reviewSourceNeedV1 as need,reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';

const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const oid=v=>typeof v==='string'&&/^[1-9][0-9]{0,9}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const unique=(items,key,code)=>{need(Array.isArray(items)&&items.length>0,code);const result=new Map();for(const item of items){const id=key(item);need(typeof id==='string'&&id.length>0&&!result.has(id),code);result.set(id,item);}return result;};
const sameSet=(a,b)=>a.size===b.size&&[...a.keys()].every(k=>b.has(k));
const sort=rows=>rows.sort((a,b)=>a.databaseOid.localeCompare(b.databaseOid));

/** Historical source projection only. This value is never an approval or runtime capability. */
export function coldRegistrationSourceInventoryV2(source,{sourceHash,controlDirectory}){
 need(source?.format==='RUNTIME_COLD_REVIEW_SOURCE_V3'&&hex(sourceHash)&&hash(source)===sourceHash&&typeof controlDirectory==='string'&&isAbsolute(controlDirectory),'COLD_REGISTRATION_SOURCE_BINDING');
 validateColdSourceFullFactsV1(source,source.fullFacts,controlDirectory);
 workflowReviewFrozenInventoryV1(source.inventory,source.readerContract,source.inventory.identity.directory);
 const databases=unique(source.inventory.databases,d=>d.datname,'COLD_REGISTRATION_DATABASE_SET');
 const databaseIds=unique(source.inventory.databases,d=>d.oid,'COLD_REGISTRATION_DATABASE_OIDS');
 const roles=unique(source.inventory.roles,r=>r.oid,'COLD_REGISTRATION_ROLE_SET');
 need([...databaseIds.keys(),...roles.keys(),source.inventory.identity.control_oid].every(oid),'COLD_REGISTRATION_OIDS');
 const registered=unique(source.registeredRoleOids,id=>id,'COLD_REGISTRATION_REGISTERED_ROLES');
 need(sameSet(roles,registered),'COLD_REGISTRATION_REGISTERED_ROLES');
 const structures=unique(source.structures,s=>s.database,'COLD_REGISTRATION_STRUCTURE_SET');
 need(sameSet(databases,structures)&&[...structures.values()].every(s=>hex(s.sha256)),'COLD_REGISTRATION_STRUCTURE_SET');
 const active=unique(source.active,b=>b.database,'COLD_REGISTRATION_ACTIVE_SET');
 const retired=new Map();need(Array.isArray(source.retired),'COLD_REGISTRATION_RETIRED_SET');
 for(const r of source.retired){need(r&&typeof r.database==='string'&&!retired.has(r.database)&&!active.has(r.database),'COLD_REGISTRATION_RETIRED_SET');retired.set(r.database,r);}
 need(sameSet(databases,new Map([...active,...retired])),'COLD_REGISTRATION_DATABASE_PARTITION');
 const closed=unique(source.closedReceipt?.databases,d=>d.database,'COLD_REGISTRATION_CLOSED_SET');
 need(source.closedReceipt.operationId===source.maintenanceOperationId&&source.closedReceipt.manifestSha256===source.maintenanceTrust?.manifestSha256&&source.closedReceipt.manifestSha256===hash(source.active)&&sameSet(active,closed),'COLD_REGISTRATION_CLOSED_SET');
 for(const b of active.values()){
  const d=databases.get(b.database);need(d&&d.oid===b.databaseOid&&d.datdba===b.ownerOid&&roles.has(b.ownerOid)&&b.systemIdentifier===source.inventory.identity.system_id&&b.controlOid===source.inventory.identity.control_oid&&hex(b.catalogHash),'COLD_REGISTRATION_ACTIVE_BINDING');
  const actors=unique(b.actorOids,id=>id,'COLD_REGISTRATION_ACTORS');need([...actors.keys()].every(id=>roles.has(id)),'COLD_REGISTRATION_ACTORS');
  const c=closed.get(b.database);need(uuid(c.operationId)&&c.deployment===b.deployment&&/^[1-9][0-9]*$/.test(String(c.revision)),'COLD_REGISTRATION_CLOSED_BINDING');
 }
 for(const r of retired.values()){const d=databases.get(r.database);need(r.source?.database===r.database&&r.source.databaseOid===d.oid&&roles.has(r.source.roleOid)&&r.largeObjectWriteDenied===true&&r.proof,'COLD_REGISTRATION_RETIRED_BINDING');}
 const maps=source.fullFacts.databases.filter(d=>d.map!==null);
 const readers=unique(source.readerContract.readers,r=>r.facts.tenantId,'COLD_REGISTRATION_WORKFLOW_TENANTS');
 const tenantSet=unique(maps,d=>d.map.tenantId,'COLD_REGISTRATION_MAP_TENANTS');
 need(sameSet(tenantSet,readers),'COLD_REGISTRATION_TENANT_COVERAGE');
 const tenants=maps.map(d=>{
  const m=d.map,r=readers.get(m.tenantId),f=r.facts,b=active.get(f.identity.database);
  need(b&&b.databaseOid===f.identity.database_oid&&f.fence.deployment===b.deployment&&f.fence.databaseOid===b.databaseOid&&f.fence.controlOid===b.controlOid&&f.fence.ownerOid===b.ownerOid&&b.actorOids.includes(f.role.oid)&&hash(r.fenceBinding)===hash(b)&&uuid(f.authorityId)&&hex(f.bpmnSha256),'COLD_REGISTRATION_WORKFLOW_BINDING');
  return{tenantId:m.tenantId,mapDatabaseOid:d.databaseOid,sourceMapFactsSha256:m.facts.factsSha256,sourcePayloadSha256:m.facts.payloadSha256,sourceMapEvidenceSha256:m.evidenceSha256,workflowDatabaseOid:b.databaseOid,workflowReaderRoleOid:f.role.oid,workflowRoleFactsSha256:f.sha256,workflowDefinitionSha256:hash(f.definition),workflowCommandAuthorityId:f.authorityId,bpmnSha256:f.bpmnSha256};
 }).sort((a,b)=>a.tenantId.localeCompare(b.tenantId));
 const a=source.sourceAuthority;need(a&&hex(a.hash)&&Number.isSafeInteger(a.epoch)&&a.epoch>=0&&uuid(a.authorityId)&&typeof a.issuer==='string','COLD_REGISTRATION_IDENTITY_SOURCE');
 need(Array.isArray(source.proofs)&&source.proofs.length>0&&source.proofs.every(p=>hex(p.sha256)&&p.binding&&typeof p.binding==='object'),'COLD_REGISTRATION_LIFECYCLE_SOURCE');
 const rows=sort(source.fullFacts.databases.map(d=>({database:d.database,databaseOid:d.databaseOid,kind:active.has(d.database)?'ACTIVE':'RETIRED',structureSha256:structures.get(d.database).sha256,sqlFactsSha256:d.sqlFacts.sha256,sqlRelationCount:d.sqlFacts.relations.length,totalRows:d.sqlFacts.totalRows,totalBytes:d.sqlFacts.totalBytes,sourceDescriptorSha256:hash(d),registrationBindingSha256:hash(active.get(d.database)??retired.get(d.database)),closedReceiptSha256:active.has(d.database)?hash(closed.get(d.database)):null})));
 const body={format:'COLD_REGISTRATION_SOURCE_INVENTORY_V2',controlId:source.controlId,backupId:source.backupId,sourceHash,sourceFullFactsSha256:source.fullFacts.sha256,systemIdentifier:source.inventory.identity.system_id,controlRoleOid:source.inventory.identity.control_oid,maintenanceOperationId:source.maintenanceOperationId,databases:rows,roles:[...roles.values()].map(r=>({oid:r.oid,name:r.rolname,originalAttributesSha256:hash(r)})).sort((a,b)=>a.oid.localeCompare(b.oid)),membershipsSha256:hash(source.inventory.memberships),tenants,identityAuthority:{authorityId:a.authorityId,epoch:a.epoch,hash:a.hash,issuer:a.issuer},readerContractSha256:source.readerContract.sha256,readerHbaSha256:source.readerContract.hba.sha256,lifecycleProofs:source.proofs.map(p=>({sourceProofSha256:p.sha256,originalBindingSha256:hash(p.binding)})),completeCapturedSourceDatabaseInventory:true,sourceOnly:true,currentRuntimeMaterialsVerified:false,currentIdentityVerified:false,independentApprovalGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 return{...body,sha256:hash(body)};
}

/** Reads the original control store; caller cannot replace its source with a purported inventory. */
export async function readColdRegistrationSourceInventoryV2(trust){
 need(trust&&Object.keys(trust).sort().join(',')==='controlId,format,sourceHash,storeFile','COLD_REGISTRATION_TRUST');
 const before=await readRuntimeColdReviewV3(trust),inventory=coldRegistrationSourceInventoryV2(before.source,{sourceHash:trust.sourceHash,controlDirectory:dirname(trust.storeFile)}),after=await readRuntimeColdReviewV3(trust);
 need(hash(before.source)===hash(after.source),'COLD_REGISTRATION_SOURCE_CHANGED');return inventory;
}
