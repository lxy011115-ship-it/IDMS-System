import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {report,work,cases,familyArguments,mapArguments} from './fixtures/cold-symbolic-program-consumer-v1-input.mjs';
import {verifyColdCoreFieldCompositionIndependentQaV9} from '../scripts/fixtures/cold-core-field-composition-independent-v9-qa.mjs';
import {verifyColdSymbolicProgramFamilyIndependentQaV1 as family,verifyColdSymbolicMapProgramPrivilegesIndependentQaV1 as map} from '../scripts/fixtures/cold-symbolic-program-consumer-v1-qa.mjs';
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
function seal(v){const {sha256,...body}=v;v.sha256=hash(body);}
function rejectFamily(kind,change){const args=structuredClone(familyArguments(kind));change(args.proof,args);seal(args.proof);assert.throws(()=>family(args));}
function rejectMap(change){const args=structuredClone(mapArguments());change(args);seal(args.queue.queueSql.programPrivileges);seal(args.queue.queueSql);assert.throws(()=>map(args));}
for(const c of cases)test('full recorded '+c.item.mode+' case retains all seven databases, raw roots, audit, peers and complete privilege decisions',async()=>{
 const result=await verifyColdCoreFieldCompositionIndependentQaV9({work,r:report,item:c.item,state:c.state});
 assert.equal(result.fullDatabasesBound,7);assert.equal(result.registeredRolesDescribed,29);
 assert.equal(result.currentMapRootsIndependentlyRebuilt,2);assert.equal(result.originalWorkflowSnapshotsReverified,4);
 assert.equal(result.originalPeerEvidenceFilesReverified,21);assert(result.originalShortLivedHelperBracketsReverified>=64);
 assert.equal(result.sharedSql.sqlScopeCount,23);assert.equal(result.sharedSql.actualDatabaseCount,7);
 assert.equal(result.sharedSql.newProgramSqlScopesIndependentlyRebuilt,15);
 assert.equal(result.sharedSql.databaseRoles.individuallyRebuiltActualSqlDecisions,1218);
 assert.equal(result.sharedSql.ownerCapabilities.independentlyRebuiltCapabilityDecisions,609);
 assert.equal(result.sharedSql.ownerCapabilities.actualSwitchAttempts,17);
 assert.deepEqual(result.mapProgramProofs.map(v=>v.independentlyRebuiltPrivilegeDecisions),[25520,25520]);
 assert.equal(result.allProgramPrivilegeDecisionsIndependentlyRebuilt,138417);
 assert.equal(result.configuredRuntimePasswordProofsBound,12);assert.equal(result.retiredBackupPrivilegeProofsBound,2);
 assert(result.authenticationAuditOffline.rawNamespaceCiphertextsIndependentlyDecrypted);
 assert(result.authenticationAuditOffline.allBusinessReceiptsCursorsAndV4AuditsBidirectionallyMatched);
 assert(result.originalCombinedMaterialWindowRevalidated&&result.finalFieldOriginalPeerEvidenceFileReverified);
 assert.equal(result.currentSqlOidcOrTransportReplayed,false);assert.equal(result.fullGoalComplete,false);
});
test('rehashing an unauthorized authentication schema grant does not authorize it',()=>rejectFamily('auth',(p,a)=>{
 const row=p.schemaObservations.find(v=>v.privileges.CREATE),other=a.source.registeredRoleOids.find(v=>!row.privileges.CREATE.includes(v));assert(other);row.privileges.CREATE.push(other);
}));
test('workflow function executor must be a registered role with its exact duty',()=>rejectFamily('workflow',p=>{p.functionObservations[0].executors.push('4294967295');}));
test('retired backup cannot lose required SELECT even with a consistent proof digest',()=>rejectFamily('retired',p=>{
 const row=p.relationObservations.find(v=>v.privileges.SELECT?.length);assert(row);row.privileges.SELECT.pop();
}));
test('maintenance large object execution is refused for every configured role',()=>rejectFamily('fence',(p,a)=>{p.largeObjectFunctions[0].executors.push(a.source.registeredRoleOids[0]);}));
test('map grant options cannot be added by rehashing both enclosing proofs',()=>rejectMap(a=>{
 const row=a.queue.queueSql.programPrivileges.schemaObservations.find(v=>Object.hasOwn(v.privileges,'USAGE WITH GRANT OPTION'));assert(row);row.privileges['USAGE WITH GRANT OPTION'].push(a.source.registeredRoleOids[0]);
}));
test('every resolved map function target remains covered',()=>rejectMap(a=>{a.queue.queueSql.programPrivileges.functionResolutions.pop();}));
test('an extra managed map object cannot be omitted from the comparison',()=>rejectMap(a=>{
 const p=a.queue.queueSql.programPrivileges,row=structuredClone(p.relationObservations[0]);row.name='unexpected_private_table';row.oid='4294967294';p.relationObservations.push(row);
}));
test('map object owner must match the actual SOURCE owner',()=>rejectMap(a=>{
 const row=a.queue.queueSql.programPrivileges.relationObservations[0];row.owner_oid=a.source.registeredRoleOids.find(v=>v!==row.owner_oid);
}));
test('configured reader metadata must match the actual current role',()=>rejectMap(a=>{
 const p=a.queue.queueSql.programPrivileges,row=p.configuredRoleMetas[0];row.other_oid=p.binding.worker;
}));
test('the original material window cannot be extended by one millisecond',()=>rejectMap(a=>{a.files.expiresAt=new Date(Date.parse(a.files.expiresAt)+1).toISOString();}));
