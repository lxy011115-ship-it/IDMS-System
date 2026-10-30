import pg from 'pg';
import {resolve,isAbsolute} from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
import {canonical} from '../server/imports.ts';

const owned=new WeakMap(),exact=(v,k)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const oid=v=>typeof v==='string'&&/^[1-9][0-9]{0,9}$/.test(v),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const name=v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(v),same=(a,b)=>canonical(a)===canonical(b),norm=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
const q=v=>'"'+v.replaceAll('"','""')+'"',literal=v=>"'"+v.replaceAll("'","''")+"'";
const verifier=v=>typeof v==='string'&&/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/.test(v)&&v.split('$')[1].split(':')[1]===Buffer.from(v.split('$')[1].split(':')[1],'base64').toString('base64')&&v.split('$')[2].split(':').every(s=>s===Buffer.from(s,'base64').toString('base64'));
const sql=(c,text,values)=>pg.Client.prototype.query.call(c,text,values);
function transaction(c){need(c instanceof pg.Client&&!Object.hasOwn(c,'query')&&pg.Client.prototype.getTransactionStatus.call(c)==='T','CURRENT_READER_SQL_ORIGINAL_TRANSACTION');}
function input(raw){
  need(exact(raw,['binding','readers','expiresAt']),'CURRENT_READER_SQL_INPUT');const b=raw.binding;
  need(exact(b,['controlId','sourceHash','reviewId','operationId','intentSha256','systemIdentifier','targetDirectory','host','port','controlOid'])&&[b.controlId,b.reviewId,b.operationId].every(uuid)&&b.reviewId!==b.operationId&&[b.sourceHash,b.intentSha256].every(hex)&&typeof b.systemIdentifier==='string'&&/^[0-9]{16,20}$/.test(b.systemIdentifier)&&typeof b.targetDirectory==='string'&&isAbsolute(b.targetDirectory)&&resolve(b.targetDirectory)===b.targetDirectory&&b.host==='127.0.0.1'&&Number.isInteger(b.port)&&b.port>1024&&b.port<=65535&&oid(b.controlOid),'CURRENT_READER_SQL_BINDING');
  const at=Date.parse(raw.expiresAt);need(Number.isSafeInteger(at)&&new Date(at).toISOString()===raw.expiresAt&&at>Date.now()&&at<=Date.now()+30000,'CURRENT_READER_SQL_DEADLINE');
  need(Array.isArray(raw.readers)&&raw.readers.length>0&&raw.readers.length<=32,'CURRENT_READER_SQL_READERS');const ids=new Set(),names=new Set(),tenants=new Set(),databases=new Set();
  for(const r of raw.readers){need(exact(r,['tenantId','role','roleOid','database','databaseOid','originalVerifier','newVerifier'])&&typeof r.tenantId==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(r.tenantId)&&name(r.role)&&r.role.startsWith('idms_wr_')&&oid(r.roleOid)&&r.roleOid!==b.controlOid&&name(r.database)&&r.database!=='postgres'&&oid(r.databaseOid)&&verifier(r.originalVerifier)&&verifier(r.newVerifier)&&r.originalVerifier!==r.newVerifier&&!ids.has(r.roleOid)&&!names.has(r.role)&&!tenants.has(r.tenantId)&&!databases.has(r.databaseOid),'CURRENT_READER_SQL_READER');ids.add(r.roleOid);names.add(r.role);tenants.add(r.tenantId);databases.add(r.databaseOid);}
  return structuredClone(raw);
}
async function identity(c,b){
  transaction(c);const r=(await sql(c,"SELECT (pg_control_system()).system_identifier::text AS system_id,current_setting('data_directory') AS directory,host(inet_server_addr()) AS host,inet_server_port() AS port,current_database() AS database,session_user::regrole::oid::text AS session_oid,current_user::regrole::oid::text AS current_oid,current_user AS name,pg_is_in_recovery() AS standby,pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS started,txid_current()::text AS transaction_id,extract(epoch FROM pg_postmaster_start_time())::text AS postmaster_started,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,(SELECT count(*)::int FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()) AS others,(SELECT count(*)::int FROM pg_prepared_xacts) AS prepared FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];
  need(r&&r.system_id===b.systemIdentifier&&norm(r.directory)===norm(b.targetDirectory)&&r.host===b.host&&r.port===b.port&&r.database==='postgres'&&r.session_oid===b.controlOid&&r.current_oid===b.controlOid&&r.name==='idms_bootstrap'&&!r.standby&&r.isolation==='serializable'&&r.read_only==='off'&&r.others===0&&r.prepared===0,'CURRENT_READER_SQL_TARGET_OR_QUIESCENCE');return r;
}
async function catalogs(c){
  const roles=(await sql(c,'SELECT oid::text,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolconnlimit,rolvaliduntil::text,rolbypassrls FROM pg_authid ORDER BY oid')).rows;
  const memberships=(await sql(c,'SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor')).rows;
  const databases=(await sql(c,'SELECT oid::text,datname,datdba::text,encoding,datcollate,datctype,datistemplate,datallowconn,datconnlimit,datacl::text FROM pg_database ORDER BY oid')).rows;
  const passwords=(await sql(c,'SELECT oid::text,rolname,rolpassword FROM pg_authid ORDER BY oid')).rows;
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
function view(s){return Object.freeze({format:'CURRENT_DEPLOYMENT_READER_PASSWORD_SQL_STAGE_V2',controlId:s.raw.binding.controlId,sourceHash:s.raw.binding.sourceHash,reviewId:s.raw.binding.reviewId,operationId:s.raw.binding.operationId,intentSha256:s.raw.binding.intentSha256,readers:s.raw.readers.length,capturedAt:s.capturedAt,expiresAt:s.raw.expiresAt,phase:s.phase,privateBaselineMac:s.mac,callerOwnsSqlTransaction:true,sqlCommitPerformed:false,sourceOrCurrentUserOrDurableOperationVerified:false,allCurrentTargetFactsVerified:false,newPurposeHeldCreated:false,programStartupGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false});}

/** Internal SQL primitive: the trusted coordinator must authenticate SOURCE/users and durable intent first. */
export async function prepareColdCurrentDeploymentReaderPasswordSqlV2(client,raw){
  transaction(client);const value=input(raw);await identity(client,value.binding);await sql(client,'LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE');const frame=await identity(client,value.binding),snapshot=await catalogs(client);roleBindings(snapshot,value.readers,'originalVerifier');const handle=Object.freeze({}),key=randomBytes(32),s={client,raw:value,frame,snapshot,key,capturedAt:new Date().toISOString(),phase:'PREPARED',attempted:false,busy:false,closed:false};s.mac=createHmac('sha256',key).update(canonical({binding:value.binding,snapshot})).digest('hex');owned.set(handle,s);fresh(s);return handle;
}
export function inspectColdCurrentDeploymentReaderPasswordSqlV2(handle){return view(record(handle));}

/** Only stages PASSWORD changes. No connection, COMMIT, ROLLBACK, role grant or process is created here. */
export async function stageColdCurrentDeploymentReaderPasswordSqlV2(handle){
  const s=record(handle);need(!s.attempted&&!s.busy&&s.phase==='PREPARED','CURRENT_READER_SQL_ATTEMPT_CONSUMED');s.attempted=true;s.busy=true;s.phase='ATTEMPTED';try{
    fresh(s);need(same(await identity(s.client,s.raw.binding),s.frame),'CURRENT_READER_SQL_ORIGINAL_BACKEND_OR_TRANSACTION');const before=await catalogs(s.client);need(same(before,s.snapshot),'CURRENT_READER_SQL_BASELINE_CHANGED');fresh(s);
    for(const r of s.raw.readers){fresh(s);await sql(s.client,'ALTER ROLE '+q(r.role)+' PASSWORD '+literal(r.newVerifier));}
    const after=await catalogs(s.client);need(stableCatalogs(after,s.snapshot)&&same(after.passwords,expectedPasswords(s)),'CURRENT_READER_SQL_UNEXPECTED_DELTA');roleBindings(after,s.raw.readers,'newVerifier');need(same(await identity(s.client,s.raw.binding),s.frame),'CURRENT_READER_SQL_ORIGINAL_BACKEND_OR_TRANSACTION');fresh(s);s.phase='STAGED';return view(s);
  }catch(error){s.phase='FAILED';throw error;}finally{s.busy=false;}
}

/** New real connection, after the original socket closed. Facts only; it cannot restore any current authorization. */
export async function observeColdCurrentDeploymentReaderPasswordSqlV2(client,handle){
  const s=record(handle);need(!s.busy&&s.attempted&&['STAGED','FAILED'].includes(s.phase),'CURRENT_READER_SQL_OBSERVATION_PHASE');need(client!==s.client&&s.client.connection?.stream?.closed===true,'CURRENT_READER_SQL_ORIGINAL_CONNECTION_NOT_CLOSED');s.busy=true;try{
    const frame=await identity(client,s.raw.binding);need(frame.pid!==s.frame.pid||frame.started!==s.frame.started,'CURRENT_READER_SQL_NEW_BACKEND_REQUIRED');await sql(client,'LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE');const actual=await catalogs(client);need(stableCatalogs(actual,s.snapshot),'CURRENT_READER_SQL_OBSERVED_CATALOG_DRIFT');const original=same(actual.passwords,s.snapshot.passwords),installed=same(actual.passwords,expectedPasswords(s));need(original!==installed,'CURRENT_READER_SQL_MIXED_OR_UNKNOWN_RESULT');
    return{...view(s),format:'CURRENT_DEPLOYMENT_READER_PASSWORD_SQL_OBSERVATION_V2',classification:installed?'ALL_INSTALLED':'ALL_ORIGINAL',actualAllRolePasswordsCompared:actual.passwords.length,allOriginalRoleAndMembershipAndDatabaseAttributesUnchanged:true,originalConnectionActuallyClosed:true,newBackendActuallyRead:true,observedAfterOriginalProofExpiry:Date.now()>=Date.parse(s.raw.expiresAt),currentAuthorizationGranted:false,uniqueDurableOperationOrFinalBusinessCommitProven:false};
  }finally{s.busy=false;}
}
export function closeColdCurrentDeploymentReaderPasswordSqlV2(handle){const s=record(handle);need(!s.busy,'CURRENT_READER_SQL_BUSY');s.closed=true;s.key.fill(0);for(const r of s.raw.readers){r.originalVerifier='';r.newVerifier='';}for(const r of s.snapshot.passwords)r.rolpassword=null;s.client=null;s.snapshot=null;return{closed:true,callerSqlClientClosed:false,programStartupGranted:false,businessWritesEnabled:false,fullGoalComplete:false};}
