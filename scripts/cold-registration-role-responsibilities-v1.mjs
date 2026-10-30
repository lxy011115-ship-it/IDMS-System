import {canonical} from '../server/imports.ts';
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const oid=value=>typeof value==='string'&&/^[1-9][0-9]{0,9}$/.test(value);
const runtimeDuties=['CORE_BUSINESS_HTTP','CORE_QUEUE_HTTP','CORE_BUSINESS_WORKER','CORE_QUEUE_WORKER','AUTHENTICATION_RUNTIME','WORKFLOW_RUNTIME','WORKFLOW_CANCEL','WORKFLOW_RESERVATION'];

/** Describes explicit SOURCE/configuration relationships only; it cannot prove current credentials or grant admission. */
export function describeColdRegistrationRoleResponsibilitiesV1(raw){
  need(exact(raw,['source','runtimeRoles','authenticationDatabaseOid','authenticationBackupRoleOid']),'COLD_REGISTRATION_ROLE_RESPONSIBILITY_INPUT');
  const {source,runtimeRoles,authenticationDatabaseOid,authenticationBackupRoleOid}=raw;
  need(Array.isArray(source?.inventory?.roles)&&Array.isArray(source.registeredRoleOids)&&Array.isArray(source.active)&&Array.isArray(source.retired)&&Array.isArray(source.inventory.memberships)&&Array.isArray(source.readerContract?.readers)&&Array.isArray(runtimeRoles),'COLD_REGISTRATION_ROLE_RESPONSIBILITY_SOURCE');
  const rows=new Map(),names=new Set();
  for(const role of source.inventory.roles){need(oid(role.oid)&&typeof role.rolname==='string'&&!rows.has(role.oid)&&!names.has(role.rolname),'COLD_REGISTRATION_ROLE_RESPONSIBILITY_ROLE_SET');rows.set(role.oid,{roleOid:role.oid,duties:[]});names.add(role.rolname);}
  need(rows.size>0&&new Set(source.registeredRoleOids).size===source.registeredRoleOids.length&&source.registeredRoleOids.length===rows.size&&source.registeredRoleOids.every(value=>rows.has(value)),'COLD_REGISTRATION_ROLE_RESPONSIBILITY_ROLE_SET');
  const add=(roleOid,databaseOid,kind)=>{need(rows.has(roleOid)&&oid(databaseOid),'COLD_REGISTRATION_ROLE_RESPONSIBILITY_BINDING');const row=rows.get(roleOid),duty={databaseOid,kind};if(!row.duties.some(value=>canonical(value)===canonical(duty)))row.duties.push(duty);};
  const ownerOids=new Set();
  for(const gate of source.active){add(gate.ownerOid,gate.databaseOid,'ACTIVE_DATABASE_OWNER');ownerOids.add(gate.ownerOid);}
  for(const retired of source.retired){need(retired.source?.database===retired.database,'COLD_REGISTRATION_ROLE_RESPONSIBILITY_RETIRED');add(retired.source.ownerOid,retired.source.databaseOid,'RETIRED_DATABASE_OWNER');add(retired.source.roleOid,retired.source.databaseOid,'RETIRED_APPLICATION');ownerOids.add(retired.source.ownerOid);}
  for(const reader of source.readerContract.readers)add(reader.facts.role.oid,reader.facts.identity.database_oid,'WORKFLOW_REVIEW_READER');
  const runtimeKeys=new Set();
  for(const runtime of runtimeRoles){
    need(exact(runtime,['roleOid','databaseOid','duty'])&&runtimeDuties.includes(runtime.duty)&&oid(runtime.roleOid)&&oid(runtime.databaseOid),'COLD_REGISTRATION_ROLE_RESPONSIBILITY_RUNTIME');
    const key=canonical(runtime);need(!runtimeKeys.has(key),'COLD_REGISTRATION_ROLE_RESPONSIBILITY_RUNTIME_DUPLICATE');runtimeKeys.add(key);
    const gate=source.active.find(value=>value.databaseOid===runtime.databaseOid);need(gate&&gate.actorOids.includes(runtime.roleOid)&&!ownerOids.has(runtime.roleOid),'COLD_REGISTRATION_ROLE_RESPONSIBILITY_RUNTIME_BINDING');
    add(runtime.roleOid,runtime.databaseOid,runtime.duty);
  }
  const auth=source.active.find(value=>value.databaseOid===authenticationDatabaseOid);
  need(auth&&rows.has(authenticationBackupRoleOid)&&!auth.actorOids.includes(authenticationBackupRoleOid)&&!ownerOids.has(authenticationBackupRoleOid),'COLD_REGISTRATION_ROLE_RESPONSIBILITY_AUTH_BACKUP');
  add(authenticationBackupRoleOid,authenticationDatabaseOid,'AUTHENTICATION_BACKUP');
  for(const membership of source.inventory.memberships){
    if(!rows.has(membership.member)&&!rows.has(membership.roleid))continue;
    need(rows.has(membership.member)&&ownerOids.has(membership.roleid)&&membership.grantor===source.inventory.identity.control_oid&&membership.admin_option===false&&membership.inherit_option===false&&membership.set_option===true,'COLD_REGISTRATION_ROLE_RESPONSIBILITY_MEMBERSHIP');
    need(rows.get(membership.member).duties.length===0,'COLD_REGISTRATION_ROLE_RESPONSIBILITY_CONFLICT');
    for(const gate of source.active.filter(value=>value.ownerOid===membership.roleid))add(membership.member,gate.databaseOid,'OWNER_SET_ROLE_MIGRATOR');
    for(const retired of source.retired.filter(value=>value.source.ownerOid===membership.roleid))add(membership.member,retired.source.databaseOid,'RETIRED_OWNER_SET_ROLE_MIGRATOR');
  }
  for(const row of rows.values())row.duties.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  const described=[...rows.values()].filter(row=>row.duties.length>0).sort((a,b)=>a.roleOid.localeCompare(b.roleOid)),uncoveredRoleOids=[...rows.values()].filter(row=>row.duties.length===0).map(row=>row.roleOid).sort();
  return Object.freeze({format:'COLD_REGISTRATION_ROLE_RESPONSIBILITY_DESCRIPTION_V1',registeredRoles:rows.size,describedRoles:described.length,rows:described,uncoveredRoleOids,runtimeRoleCount:new Set(runtimeRoles.map(value=>value.roleOid)).size,allRegisteredResponsibilitiesDescribed:uncoveredRoleOids.length===0,sourceAndConfigurationDescriptionOnly:true,currentRolePrivilegesVerified:false,currentConfiguredPasswordsVerified:false,fullRegisteredRoleMatrixVerified:false,authorizationGranted:false,formalFieldActivationGranted:false,fullGoalComplete:false});
}
