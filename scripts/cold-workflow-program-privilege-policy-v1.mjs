import {workflowCancelSchemaSqlV1} from './workflow-cancel-schema-v1.mjs';
import {workflowCancelReservationSchemaSqlV1} from './workflow-cancel-reservation-schema-v1.mjs';
import {compileColdProgramPrivilegePolicyV1,splitColdProgramSqlStatementsV1} from './cold-map-program-privilege-policy-v1.mjs';
import {canonical} from '../server/imports.ts';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
const need=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});},freeze=v=>{if(v&&typeof v==='object'){for(const item of Object.values(v))freeze(item);Object.freeze(v);}return v;};let loading;
export function loadColdWorkflowProgramPrivilegePolicyV1(){return loading??=(async()=>{
 const options={owner:'idms_policy_owner',tenantId:'qa',authorityId:'12345678-1234-1234-1234-123456789abc'},cancel=await workflowCancelSchemaSqlV1({...options,reconciler:'idms_policy_worker'}),reservation=await workflowCancelReservationSchemaSqlV1({...options,reconciler:'idms_policy_ingress'});
 const statements=splitColdProgramSqlStatementsV1(cancel),cross=statements.filter(v=>/^GRANT\s+SELECT,UPDATE\s+ON\s+public\./i.test(v));
 need(cross.length===1&&cross[0]==='GRANT SELECT,UPDATE ON public.idms_workflow_cases,public.idms_workflow_commands TO "idms_policy_owner"','COLD_WORKFLOW_PROGRAM_OWNER_GRANT');
 const cancelPolicy=compileColdProgramPrivilegePolicyV1({schema:'idms_workflow_cancel_v1',sql:statements.filter(v=>v!==cross[0]).join(';\n')+';'}),reservationPolicy=compileColdProgramPrivilegePolicyV1({schema:'idms_workflow_reservation_v1',sql:reservation});
 need(cancelPolicy.functionExecute.length===2&&reservationPolicy.functionExecute.length===3,'COLD_WORKFLOW_PROGRAM_ENTRY_POLICY');
 const body={format:'COLD_WORKFLOW_PROGRAM_PRIVILEGE_POLICY_V1',cancel:cancelPolicy,reservation:reservationPolicy,originalCancelInstallerSha256:hash(cancel),originalReservationInstallerSha256:hash(reservation),ownerPublicTableSelfGrantRetained:cross[0],publicRuntimeTablePrivileges:['SELECT','INSERT','UPDATE','DELETE'],publicReaderTablePrivileges:['SELECT'],allOtherOrdinaryPrivilegesDenied:true,sourceTextDescriptionOnly:true,actualPrivilegesVerified:false,runtimeAuthorityGranted:false,fullRegisteredRoleMatrixVerified:false};return freeze({...body,sha256:hash(body)});
})();}

export function describeColdWorkflowProgramRolesV1(source,databaseOid,description){
 const roles=source?.inventory?.roles,rows=description?.rows,reader=source?.readerContract?.readers?.find(v=>v.facts?.identity.database_oid===databaseOid),gate=source?.active?.find(v=>v.databaseOid===databaseOid);
 need(Array.isArray(roles)&&Array.isArray(rows)&&roles.length>0&&roles.length<=256&&reader&&gate&&description.format==='COLD_REGISTRATION_ROLE_RESPONSIBILITY_DESCRIPTION_V2'&&description.allRegisteredResponsibilitiesDescribed===true&&new Set(rows.map(v=>v.roleOid)).size===roles.length&&new Set(roles.map(v=>v.oid)).size===roles.length&&canonical(rows.map(v=>v.roleOid).sort())===canonical(roles.map(v=>v.oid).sort())&&Array.isArray(source.registeredRoleOids)&&canonical([...source.registeredRoleOids].sort())===canonical(roles.map(v=>v.oid).sort()),'COLD_WORKFLOW_PROGRAM_ROLE_COVERAGE');
 const roleFor=kind=>{const found=rows.filter(row=>Array.isArray(row.duties)&&row.duties.some(d=>d.kind===kind&&d.databaseOid===databaseOid));need(found.length===1,'COLD_WORKFLOW_PROGRAM_ROLE_DUTY');return found[0].roleOid;};
 const binding={databaseOid,tenantId:reader.facts.tenantId,owner:roleFor('ACTIVE_DATABASE_OWNER'),app:roleFor('WORKFLOW_RUNTIME'),cancel:roleFor('WORKFLOW_CANCEL'),reservation:roleFor('WORKFLOW_RESERVATION'),reader:roleFor('WORKFLOW_REVIEW_READER')};
 need(binding.owner===gate.ownerOid&&binding.owner===reader.facts.fence.ownerOid&&binding.reader===reader.facts.role.oid&&new Set([binding.owner,binding.app,binding.reader,binding.cancel]).size===4&&![binding.owner,binding.app,binding.reader].includes(binding.reservation)&&canonical([...new Set([binding.app,binding.cancel,binding.reservation,binding.reader])].sort())===canonical([...gate.actorOids].sort()),'COLD_WORKFLOW_PROGRAM_SOURCE_ROLE_BINDING');return freeze(binding);
}
