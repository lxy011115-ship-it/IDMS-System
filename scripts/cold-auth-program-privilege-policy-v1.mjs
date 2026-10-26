import {authAuditSchemaSqlV4} from './auth-audit-schema-v4.mjs';
import {authPrivileges,authSchemaChecksum} from '../server/auth-store-schema.ts';
import {compileColdProgramPrivilegePolicyV1} from './cold-map-program-privilege-policy-v1.mjs';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
import {canonical} from '../server/imports.ts';
const need=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});},freeze=v=>{if(v&&typeof v==='object'){for(const item of Object.values(v))freeze(item);Object.freeze(v);}return v;};
let loading;
/** Trusted real session-table policy plus the exact real auth-audit installer.
 * This is a source description; it does not grant SQL or runtime authority. */
export function loadColdAuthProgramPrivilegePolicyV1(){return loading??=(async()=>{
 const expected={auth_store_meta:['SELECT'],auth_state:['SELECT','INSERT','UPDATE','DELETE'],auth_schema_migrations:['SELECT']};
 need(canonical(authPrivileges)===canonical(expected),'COLD_AUTH_PROGRAM_SOURCE_POLICY');
 const audit=compileColdProgramPrivilegePolicyV1({schema:'auth_audit_v4',sql:await authAuditSchemaSqlV4({owner:'idms_policy_owner',app:'idms_policy_worker',delivery:'idms_policy_ingress',deployment:'c'.repeat(64),keyCheck:{protocolFixtureOnly:true}})});
 need(audit.schemaUsageRoles.join(',')==='ingress,worker'&&audit.functionExecute.length===10&&audit.tableSelect.length===0,'COLD_AUTH_PROGRAM_SOURCE_POLICY');
 const body={format:'COLD_AUTH_PROGRAM_PRIVILEGE_POLICY_V1',authenticationSchemaChecksum:authSchemaChecksum,sessionTables:expected,audit,defaultAcl:{ownerGlobalFunctionsOwnerOnly:true,allOtherExplicitDefaultsDenied:true},sourceTextDescriptionOnly:true,actualPrivilegesVerified:false,runtimeAuthorityGranted:false,fullRegisteredRoleMatrixVerified:false};return freeze({...body,sha256:hash(body)});
})();}

export function describeColdAuthProgramRolesV1(source,databaseOid,description){
 const roles=source?.inventory?.roles,rows=description?.rows,gate=source?.active?.find(v=>v.databaseOid===databaseOid);
 need(Array.isArray(roles)&&Array.isArray(rows)&&gate&&description.format==='COLD_REGISTRATION_ROLE_RESPONSIBILITY_DESCRIPTION_V2'&&description.allRegisteredResponsibilitiesDescribed===true&&roles.length>0&&roles.length<=256&&new Set(roles.map(v=>v.oid)).size===roles.length&&new Set(rows.map(v=>v.roleOid)).size===roles.length&&canonical(rows.map(v=>v.roleOid).sort())===canonical(roles.map(v=>v.oid).sort())&&Array.isArray(source.registeredRoleOids)&&canonical([...source.registeredRoleOids].sort())===canonical(roles.map(v=>v.oid).sort()),'COLD_AUTH_PROGRAM_ROLE_COVERAGE');
 const roleFor=kind=>{const matches=rows.filter(row=>Array.isArray(row.duties)&&row.duties.some(d=>d.databaseOid===databaseOid&&d.kind===kind));need(matches.length===1,'COLD_AUTH_PROGRAM_ROLE_DUTY');return matches[0].roleOid;};
 const binding={databaseOid,owner:roleFor('ACTIVE_DATABASE_OWNER'),app:roleFor('AUTHENTICATION_RUNTIME'),delivery:roleFor('AUTHENTICATION_DELIVERY_SOURCE'),backup:roleFor('AUTHENTICATION_BACKUP')};
 need(new Set(Object.values(binding).slice(1)).size===4&&gate.ownerOid===binding.owner&&gate.actorOids.includes(binding.app)&&gate.actorOids.includes(binding.delivery)&&!gate.actorOids.includes(binding.backup),'COLD_AUTH_PROGRAM_ROLE_BINDING');return freeze(binding);
}
