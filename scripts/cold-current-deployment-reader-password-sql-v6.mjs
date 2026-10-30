import pg from 'pg';
import {resolve,isAbsolute} from 'node:path';
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {canonical} from '../server/imports.ts';

const owned=new WeakMap(),exact=(v,k)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const oid=v=>typeof v==='string'&&/^[1-9][0-9]{0,9}$/.test(v),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const name=v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(v),same=(a,b)=>canonical(a)===canonical(b),norm=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
const q=v=>'"'+v.replaceAll('"','""')+'"',literal=v=>"'"+v.replaceAll("'","''")+"'";
const verifier=v=>typeof v==='string'&&/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/.test(v)&&v.split('$')[1].split(':')[1]===Buffer.from(v.split('$')[1].split(':')[1],'base64').toString('base64')&&v.split('$')[2].split(':').every(s=>s===Buffer.from(s,'base64').toString('base64'));
const sql=(c,text,values)=>pg.Client.prototype.query.call(c,text,values);
function transaction(c){need(c instanceof pg.Client&&!Object.hasOwn(c,'query')&&pg.Client.prototype.getTransactionStatus.call(c)==='T','CURRENT_READER_SQL_ORIGINAL_TRANSACTION');}
function input(raw,historical=false){
  need(exact(raw,['binding','readers','expiresAt']),'CURRENT_READER_SQL_INPUT');const b=raw.binding;
  need(exact(b,['controlId','sourceHash','reviewId','operationId','intentSha256','systemIdentifier','targetDirectory','host','port','controlOid'])&&[b.controlId,b.reviewId,b.operationId].every(uuid)&&b.reviewId!==b.operationId&&[b.sourceHash,b.intentSha256].every(hex)&&typeof b.systemIdentifier==='string'&&/^[0-9]{16,20}$/.test(b.systemIdentifier)&&typeof b.targetDirectory==='string'&&isAbsolute(b.targetDirectory)&&resolve(b.targetDirectory)===b.targetDirectory&&b.host==='127.0.0.1'&&Number.isInteger(b.port)&&b.port>1024&&b.port<=65535&&oid(b.controlOid),'CURRENT_READER_SQL_BINDING');
  const at=Date.parse(raw.expiresAt);need(Number.isSafeInteger(at)&&new Date(at).toISOString()===raw.expiresAt&&(historical||at>Date.now()&&at<=Date.now()+30000),'CURRENT_READER_SQL_DEADLINE');
  need(Array.isArray(raw.readers)&&raw.readers.length>0&&raw.readers.length<=32,'CURRENT_READER_SQL_READERS');const ids=new Set(),names=new Set(),tenants=new Set(),databases=new Set();
  for(const r of raw.readers){need(exact(r,['tenantId','role','roleOid','database','databaseOid','originalVerifier','newVerifier'])&&typeof r.tenantId==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(r.tenantId)&&name(r.role)&&r.role.startsWith('idms_wr_')&&oid(r.roleOid)&&r.roleOid!==b.controlOid&&name(r.database)&&r.database!=='postgres'&&oid(r.databaseOid)&&verifier(r.originalVerifier)&&verifier(r.newVerifier)&&r.originalVerifier!==r.newVerifier&&!ids.has(r.roleOid)&&!names.has(r.role)&&!tenants.has(r.tenantId)&&!databases.has(r.databaseOid),'CURRENT_READER_SQL_READER');ids.add(r.roleOid);names.add(r.role);tenants.add(r.tenantId);databases.add(r.databaseOid);}
  return structuredClone(raw);
}
async function identity(c,b){
  transaction(c);await sql(c,'SELECT pg_stat_clear_snapshot()');const r=(await sql(c,"SELECT (pg_control_system()).system_identifier::text AS system_id,current_setting('data_directory') AS directory,host(inet_server_addr()) AS host,inet_server_port() AS port,current_database() AS database,session_user::regrole::oid::text AS session_oid,current_user::regrole::oid::text AS current_oid,current_user AS name,pg_is_in_recovery() AS standby,pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS started,txid_current()::text AS transaction_id,extract(epoch FROM pg_postmaster_start_time())::text AS postmaster_started,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,(SELECT count(*)::int FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()) AS others,(SELECT count(*)::int FROM pg_prepared_xacts) AS prepared FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];
  need(r&&r.system_id===b.systemIdentifier&&norm(r.directory)===norm(b.targetDirectory)&&r.host===b.host&&r.port===b.port&&r.database==='postgres'&&r.session_oid===b.controlOid&&r.current_oid===b.controlOid&&r.name==='idms_bootstrap'&&!r.standby&&r.isolation==='serializable'&&r.read_only==='off'&&r.others===0&&r.prepared===0,'CURRENT_READER_SQL_TARGET_OR_QUIESCENCE');return r;
}
async function catalogs(c){
  const roles=(await sql(c,'SELECT oid::text,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolconnlimit,rolvaliduntil::text,rolbypassrls FROM pg_authid ORDER BY pg_authid.oid')).rows;
  const memberships=(await sql(c,'SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor')).rows;
  const databases=(await sql(c,'SELECT oid::text,datname,datdba::text,encoding,datcollate,datctype,datistemplate,datallowconn,datconnlimit,datacl::text FROM pg_database ORDER BY pg_database.oid')).rows;
  const passwords=(await sql(c,'SELECT oid::text,rolname,rolpassword FROM pg_authid ORDER BY pg_authid.oid')).rows;
  const settings=(await sql(c,'SELECT setdatabase::text,setrole::text,setconfig FROM pg_db_role_setting ORDER BY setdatabase,setrole')).rows;
  return{roles,memberships,databases,passwords,settings};
}
function roleBindings(snapshot,readers,kind){
  for(const r of readers){const role=snapshot.roles.find(v=>v.oid===r.roleOid),password=snapshot.passwords.find(v=>v.oid===r.roleOid),database=snapshot.databases.find(v=>v.oid===r.databaseOid);need(role&&role.rolname===r.role&&!role.rolsuper&&!role.rolcreatedb&&!role.rolcreaterole&&!role.rolreplication&&!role.rolbypassrls&&password?.rolname===r.role&&password.rolpassword===r[kind]&&database?.datname===r.database,'CURRENT_READER_SQL_ORIGINAL_ROLE_OR_PASSWORD');}
}
function expectedPasswords(s){return s.snapshot.passwords.map(r=>({...r,rolpassword:s.raw.readers.find(v=>v.roleOid===r.oid)?.newVerifier??r.rolpassword}));}
function stableCatalogs(a,b){return same(a.roles,b.roles)&&same(a.memberships,b.memberships)&&same(a.databases,b.databases)&&same(a.settings,b.settings);}
function record(handle){const s=owned.get(handle);need(s&&!s.closed,'CURRENT_READER_SQL_HANDLE_NOT_MINTED');return s;}
function fresh(s){need(Date.now()<Date.parse(s.raw.expiresAt),'CURRENT_READER_SQL_EXPIRED');}
function view(s){return Object.freeze({format:'CURRENT_DEPLOYMENT_READER_PASSWORD_SQL_STAGE_V6',controlId:s.raw.binding.controlId,sourceHash:s.raw.binding.sourceHash,reviewId:s.raw.binding.reviewId,operationId:s.raw.binding.operationId,intentSha256:s.raw.binding.intentSha256,readers:s.raw.readers.length,capturedAt:s.capturedAt,expiresAt:s.raw.expiresAt,phase:s.phase,privateBaselineMac:s.mac,callerOwnsSqlTransaction:true,sqlCommitPerformed:false,sourceOrCurrentUserOrDurableOperationVerified:false,allCurrentTargetFactsVerified:false,newPurposeHeldCreated:false,programStartupGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false});}

/** Internal SQL primitive: the trusted coordinator must authenticate SOURCE/users and durable intent first. */
export async function prepareColdCurrentDeploymentReaderPasswordSqlV6(client,raw){
  transaction(client);const value=input(raw);await identity(client,value.binding);await sql(client,'LOCK TABLE pg_catalog.pg_authid,pg_catalog.pg_auth_members,pg_catalog.pg_database,pg_catalog.pg_db_role_setting IN SHARE ROW EXCLUSIVE MODE');const frame=await identity(client,value.binding),snapshot=await catalogs(client);roleBindings(snapshot,value.readers,'originalVerifier');const handle=Object.freeze({}),key=randomBytes(32),s={client,raw:value,frame,snapshot,key,capturedAt:new Date().toISOString(),phase:'PREPARED',attempted:false,busy:false,closed:false};s.mac=createHmac('sha256',key).update(canonical({binding:value.binding,snapshot})).digest('hex');owned.set(handle,s);fresh(s);return handle;
}
export function inspectColdCurrentDeploymentReaderPasswordSqlV6(handle){return view(record(handle));}

/** Only stages PASSWORD changes. No connection, COMMIT, ROLLBACK, role grant or process is created here. */
export async function stageColdCurrentDeploymentReaderPasswordSqlV6(handle){
  const s=record(handle);need(!s.attempted&&!s.busy&&s.phase==='PREPARED','CURRENT_READER_SQL_ATTEMPT_CONSUMED');s.attempted=true;s.busy=true;s.phase='ATTEMPTED';try{
    fresh(s);need(same(await identity(s.client,s.raw.binding),s.frame),'CURRENT_READER_SQL_ORIGINAL_BACKEND_OR_TRANSACTION');const before=await catalogs(s.client);need(same(before,s.snapshot),'CURRENT_READER_SQL_BASELINE_CHANGED');fresh(s);
    for(const r of s.raw.readers){fresh(s);await sql(s.client,'ALTER ROLE '+q(r.role)+' PASSWORD '+literal(r.newVerifier));}
    const after=await catalogs(s.client);need(stableCatalogs(after,s.snapshot)&&same(after.passwords,expectedPasswords(s)),'CURRENT_READER_SQL_UNEXPECTED_DELTA');roleBindings(after,s.raw.readers,'newVerifier');need(same(await identity(s.client,s.raw.binding),s.frame),'CURRENT_READER_SQL_ORIGINAL_BACKEND_OR_TRANSACTION');fresh(s);s.phase='STAGED';return view(s);
  }catch(error){s.phase='FAILED';throw error;}finally{s.busy=false;}
}

/** New real connection, after the original socket closed. Facts only; it cannot restore any current authorization. */
export async function observeColdCurrentDeploymentReaderPasswordSqlV6(client,handle){
  const s=record(handle);need(!s.busy&&s.attempted&&['STAGED','FAILED'].includes(s.phase),'CURRENT_READER_SQL_OBSERVATION_PHASE');need(client!==s.client&&s.client.connection?.stream?.closed===true,'CURRENT_READER_SQL_ORIGINAL_CONNECTION_NOT_CLOSED');s.busy=true;try{
    const frame=await identity(client,s.raw.binding);need(frame.pid!==s.frame.pid||frame.started!==s.frame.started,'CURRENT_READER_SQL_NEW_BACKEND_REQUIRED');await sql(client,'LOCK TABLE pg_catalog.pg_authid,pg_catalog.pg_auth_members,pg_catalog.pg_database,pg_catalog.pg_db_role_setting IN SHARE ROW EXCLUSIVE MODE');const actual=await catalogs(client);need(stableCatalogs(actual,s.snapshot),'CURRENT_READER_SQL_OBSERVED_CATALOG_DRIFT');const original=same(actual.passwords,s.snapshot.passwords),installed=same(actual.passwords,expectedPasswords(s));need(original!==installed,'CURRENT_READER_SQL_MIXED_OR_UNKNOWN_RESULT');
    return{...view(s),format:'CURRENT_DEPLOYMENT_READER_PASSWORD_SQL_OBSERVATION_V6',classification:installed?'ALL_INSTALLED':'ALL_ORIGINAL',actualAllRolePasswordsCompared:actual.passwords.length,allOriginalRoleAndMembershipAndDatabaseAttributesUnchanged:true,originalConnectionActuallyClosed:true,newBackendActuallyRead:true,observedAfterOriginalProofExpiry:Date.now()>=Date.parse(s.raw.expiresAt),currentAuthorizationGranted:false,uniqueDurableOperationOrFinalBusinessCommitProven:false};
  }finally{s.busy=false;}
}
export function closeColdCurrentDeploymentReaderPasswordSqlV6(handle){const s=record(handle);need(!s.busy,'CURRENT_READER_SQL_BUSY');s.closed=true;s.key.fill(0);for(const r of s.raw.readers){r.originalVerifier='';r.newVerifier='';}for(const r of s.snapshot.passwords)r.rolpassword=null;s.client=null;s.snapshot=null;return{closed:true,callerSqlClientClosed:false,programStartupGranted:false,businessWritesEnabled:false,fullGoalComplete:false};}


const recoveryRecords=new WeakMap(),recoveryObservations=new WeakMap();
const recoveryDomain='IDMS_CURRENT_DEPLOYMENT_READER_SQL_RECOVERY_V1\nSNAPSHOT\n'.replaceAll('\\n','\n');
const bindingKeys=['controlId','sourceHash','reviewId','operationId','intentSha256','systemIdentifier','targetDirectory','host','port','controlOid'];
const frameKeys=['system_id','directory','host','port','database','session_oid','current_oid','name','standby','pid','started','transaction_id','postmaster_started','isolation','read_only','others','prepared'];
const roleKeys=['oid','rolname','rolsuper','rolinherit','rolcreaterole','rolcreatedb','rolcanlogin','rolreplication','rolconnlimit','rolvaliduntil','rolbypassrls'];
const memberKeys=['roleid','member','grantor','admin_option','inherit_option','set_option'];
const databaseKeys=['oid','datname','datdba','encoding','datcollate','datctype','datistemplate','datallowconn','datconnlimit','datacl'];
function recoveryMac(key,body){need(hex(key)&&!/^0+$/.test(key),'CURRENT_READER_RECOVERY_KEY');const bytes=Buffer.from(key,'hex');try{return createHmac('sha256',bytes).update(recoveryDomain+canonical(body)).digest('hex');}finally{bytes.fill(0);}}
function recoveryOptions(raw){need(exact(raw,['key','expectedBinding'])&&exact(raw.expectedBinding,bindingKeys),'CURRENT_READER_RECOVERY_OPTIONS');return raw;}
function orderedOids(rows){return rows.every((v,i)=>oid(v.oid)&&(i===0||BigInt(rows[i-1].oid)<BigInt(v.oid)));}
function catalogSnapshot(value,readers){
  need(exact(value,['roles','memberships','databases','passwords','settings'])&&Buffer.byteLength(canonical(value))<=1024**2,'CURRENT_READER_RECOVERY_CATALOG');
  const{roles,memberships,databases,passwords,settings}=value;
  need(Array.isArray(roles)&&roles.length>0&&roles.length<=4096&&orderedOids(roles)&&roles.every(r=>exact(r,roleKeys)&&typeof r.rolname==='string'&&Buffer.byteLength(r.rolname)>0&&Buffer.byteLength(r.rolname)<=63&&['rolsuper','rolinherit','rolcreaterole','rolcreatedb','rolcanlogin','rolreplication','rolbypassrls'].every(k=>typeof r[k]==='boolean')&&Number.isInteger(r.rolconnlimit)&&(r.rolvaliduntil===null||typeof r.rolvaliduntil==='string')),'CURRENT_READER_RECOVERY_ROLES');
  const roleIds=new Set(roles.map(r=>r.oid));need(new Set(roles.map(r=>r.rolname)).size===roles.length,'CURRENT_READER_RECOVERY_ROLES');
  need(Array.isArray(passwords)&&passwords.length===roles.length&&passwords.every((r,i)=>exact(r,['oid','rolname','rolpassword'])&&r.oid===roles[i].oid&&r.rolname===roles[i].rolname&&(r.rolpassword===null||typeof r.rolpassword==='string'&&r.rolpassword.length<=512)),'CURRENT_READER_RECOVERY_PASSWORDS');
  need(Array.isArray(memberships)&&memberships.length<=32768&&memberships.every(r=>exact(r,memberKeys)&&['roleid','member','grantor'].every(k=>roleIds.has(r[k]))&&['admin_option','inherit_option','set_option'].every(k=>typeof r[k]==='boolean'))&&new Set(memberships.map(r=>[r.roleid,r.member,r.grantor].join(':'))).size===memberships.length,'CURRENT_READER_RECOVERY_MEMBERSHIPS');
  need(Array.isArray(databases)&&databases.length>0&&databases.length<=1024&&orderedOids(databases)&&databases.every(r=>exact(r,databaseKeys)&&typeof r.datname==='string'&&roleIds.has(r.datdba)&&Number.isInteger(r.encoding)&&typeof r.datcollate==='string'&&typeof r.datctype==='string'&&typeof r.datistemplate==='boolean'&&typeof r.datallowconn==='boolean'&&Number.isInteger(r.datconnlimit)&&(r.datacl===null||typeof r.datacl==='string'))&&new Set(databases.map(r=>r.datname)).size===databases.length,'CURRENT_READER_RECOVERY_DATABASES');
  const dbIds=new Set(databases.map(r=>r.oid));need(Array.isArray(settings)&&settings.length<=32768&&settings.every(r=>exact(r,['setdatabase','setrole','setconfig'])&&(r.setdatabase==='0'||dbIds.has(r.setdatabase))&&(r.setrole==='0'||roleIds.has(r.setrole))&&Array.isArray(r.setconfig)&&r.setconfig.length<=1024&&r.setconfig.every(v=>typeof v==='string'&&v.length<=32768))&&new Set(settings.map(r=>r.setdatabase+':'+r.setrole)).size===settings.length,'CURRENT_READER_RECOVERY_SETTINGS');
  roleBindings(value,readers,'originalVerifier');return value;
}
function recoveryBody(body,expected){
  need(exact(body,['format','purpose','sqlInput','originalFrame','originalCatalogs','capturedAt','currentAuthorizationGranted','stageCapabilityRestored'])&&body.format==='CURRENT_DEPLOYMENT_READER_SQL_RECOVERY_RECORD_V1'&&body.purpose==='HISTORICAL_READER_PASSWORD_SQL_RESULT_OBSERVATION_ONLY'&&body.currentAuthorizationGranted===false&&body.stageCapabilityRestored===false,'CURRENT_READER_RECOVERY_BODY');
  const raw=input(body.sqlInput,true),b=raw.binding;need(exact(expected,bindingKeys)&&same(expected,b),'CURRENT_READER_RECOVERY_CONTEXT');
  const at=Date.parse(body.capturedAt),until=Date.parse(raw.expiresAt);need(Number.isSafeInteger(at)&&new Date(at).toISOString()===body.capturedAt&&until>at&&until-at<=30000,'CURRENT_READER_RECOVERY_WINDOW');
  const f=body.originalFrame;need(exact(f,frameKeys)&&f.system_id===b.systemIdentifier&&typeof f.directory==='string'&&norm(f.directory)===norm(b.targetDirectory)&&f.host===b.host&&f.port===b.port&&f.database==='postgres'&&f.session_oid===b.controlOid&&f.current_oid===b.controlOid&&f.name==='idms_bootstrap'&&f.standby===false&&Number.isInteger(f.pid)&&f.pid>0&&typeof f.started==='string'&&/^[0-9]+(?:\.[0-9]+)?$/.test(f.started)&&typeof f.postmaster_started==='string'&&/^[0-9]+(?:\.[0-9]+)?$/.test(f.postmaster_started)&&typeof f.transaction_id==='string'&&/^[1-9][0-9]*$/.test(f.transaction_id)&&f.isolation==='serializable'&&f.read_only==='off'&&f.others===0&&f.prepared===0,'CURRENT_READER_RECOVERY_ORIGINAL_FRAME');
  catalogSnapshot(body.originalCatalogs,raw.readers);return body;
}
/** Private signed data for the coordinator to store BEFORE any password DDL or COMMIT. */
export function createColdCurrentDeploymentReaderPasswordRecoveryRecordV1(handle,raw){
  const options=recoveryOptions(raw),s=record(handle);need(!s.busy&&!s.attempted&&s.phase==='PREPARED','CURRENT_READER_RECOVERY_PREPARED_REQUIRED');fresh(s);transaction(s.client);
  const body={format:'CURRENT_DEPLOYMENT_READER_SQL_RECOVERY_RECORD_V1',purpose:'HISTORICAL_READER_PASSWORD_SQL_RESULT_OBSERVATION_ONLY',sqlInput:structuredClone(s.raw),originalFrame:structuredClone(s.frame),originalCatalogs:structuredClone(s.snapshot),capturedAt:s.capturedAt,currentAuthorizationGranted:false,stageCapabilityRestored:false};recoveryBody(body,options.expectedBinding);return{body,signature:recoveryMac(options.key,body)};
}
/** Authentication of retained data only. This never recreates a stage handle or refreshes expiry. */
export function verifyColdCurrentDeploymentReaderPasswordRecoveryRecordV1(value,raw){
  const options=recoveryOptions(raw);need(exact(value,['body','signature'])&&hex(value.signature)&&Buffer.byteLength(canonical(value))<=2*1024**2,'CURRENT_READER_RECOVERY_RECORD');const body=structuredClone(value.body),actual=recoveryMac(options.key,body);need(timingSafeEqual(Buffer.from(value.signature,'hex'),Buffer.from(actual,'hex')),'CURRENT_READER_RECOVERY_SIGNATURE');recoveryBody(body,options.expectedBinding);const handle=Object.freeze({});recoveryRecords.set(handle,{body,signature:value.signature,busy:false,closed:false});return handle;
}
function recoveryOwner(handle){const s=recoveryRecords.get(handle);need(s&&!s.closed,'CURRENT_READER_RECOVERY_HANDLE_NOT_MINTED');return s;}
export function inspectColdCurrentDeploymentReaderPasswordRecoveryV1(handle){const s=recoveryOwner(handle),r=s.body.sqlInput;return Object.freeze({format:'CURRENT_DEPLOYMENT_READER_SQL_RECOVERY_STATUS_V1',controlId:r.binding.controlId,sourceHash:r.binding.sourceHash,reviewId:r.binding.reviewId,operationId:r.binding.operationId,intentSha256:r.binding.intentSha256,privateRecordMac:s.signature,readerCount:r.readers.length,capturedAt:s.body.capturedAt,originalExpiresAt:r.expiresAt,historicalDataOnly:true,currentAuthorizationGranted:false,stageCapabilityRestored:false,programStartupGranted:false,businessWritesEnabled:false,fullGoalComplete:false});}
/** A new actual backend must find the original framed backend absent, under the complete original target binding. */
export async function observeColdCurrentDeploymentReaderPasswordRecoveryV1(client,handle){
  const s=recoveryOwner(handle);need(!s.busy,'CURRENT_READER_RECOVERY_BUSY');s.busy=true;try{const body=s.body,raw=body.sqlInput,frame=await identity(client,raw.binding);need(frame.pid!==body.originalFrame.pid||frame.started!==body.originalFrame.started,'CURRENT_READER_RECOVERY_NEW_BACKEND_REQUIRED');
    await sql(client,'LOCK TABLE pg_catalog.pg_authid,pg_catalog.pg_auth_members,pg_catalog.pg_database,pg_catalog.pg_db_role_setting IN SHARE ROW EXCLUSIVE MODE');const actual=await catalogs(client);need(stableCatalogs(actual,body.originalCatalogs),'CURRENT_READER_SQL_OBSERVED_CATALOG_DRIFT');const original=same(actual.passwords,body.originalCatalogs.passwords),expected=body.originalCatalogs.passwords.map(r=>({...r,rolpassword:raw.readers.find(v=>v.roleOid===r.oid)?.newVerifier??r.rolpassword})),installed=same(actual.passwords,expected);need(original!==installed,'CURRENT_READER_SQL_MIXED_OR_UNKNOWN_RESULT');need(same(await identity(client,raw.binding),frame),'CURRENT_READER_SQL_ORIGINAL_BACKEND_OR_TRANSACTION');
    const observation=Object.freeze({}),proof={format:'CURRENT_DEPLOYMENT_READER_SQL_RECOVERY_OBSERVATION_V1',binding:structuredClone(raw.binding),privateRecordMac:s.signature,classification:installed?'ALL_INSTALLED':'ALL_ORIGINAL',originalFrame:structuredClone(body.originalFrame),actualNewFrame:frame,observedAt:new Date().toISOString(),originalExpiresAt:raw.expiresAt,comparedRolePasswordRows:actual.passwords.length,originalFramedBackendAbsent:true,allRoleMembershipDatabaseAndSettingsCatalogsUnchanged:true,allFourSharedCatalogLocksHeld:true,observedAfterOriginalProofExpiry:Date.now()>=Date.parse(raw.expiresAt),historicalDataOnly:true,currentAuthorizationGranted:false,stageCapabilityRestored:false,uniqueDurableInstallationOperationProven:false,programStartupGranted:false,newPurposeHeldCreated:false,businessWritesEnabled:false,fullGoalComplete:false};recoveryObservations.set(observation,proof);return observation;
  }finally{s.busy=false;}
}
/** Trusted journal bridge: actual observations cannot be supplied as copied public JSON. */
export function readColdCurrentDeploymentReaderPasswordRecoveryObservationV1(handle,expected){const value=recoveryObservations.get(handle);need(value,'CURRENT_READER_RECOVERY_OBSERVATION_NOT_MINTED');need(exact(expected,['binding','privateRecordMac'])&&same(expected.binding,value.binding)&&expected.privateRecordMac===value.privateRecordMac,'CURRENT_READER_RECOVERY_OBSERVATION_CONTEXT');return structuredClone(value);}
export function inspectColdCurrentDeploymentReaderPasswordRecoveryObservationV1(handle){const value=recoveryObservations.get(handle);need(value,'CURRENT_READER_RECOVERY_OBSERVATION_NOT_MINTED');const{binding,originalFrame,actualNewFrame,...safe}=value;return Object.freeze({...safe,actualTargetIdentityAndNewBackendVerified:true,privatePathsOrCredentialsPublished:false});}
export function closeColdCurrentDeploymentReaderPasswordRecoveryV1(handle){const s=recoveryOwner(handle);need(!s.busy,'CURRENT_READER_RECOVERY_BUSY');s.closed=true;for(const r of s.body.sqlInput.readers){r.originalVerifier='';r.newVerifier='';}for(const r of s.body.originalCatalogs.passwords)r.rolpassword=null;s.body=null;return{closed:true,currentAuthorizationGranted:false,stageCapabilityRestored:false,fullGoalComplete:false};}
