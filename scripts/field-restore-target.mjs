import {canonical} from '../server/imports.ts';
import {quoteIdentifier as q} from '../server/postgres-schema.ts';
import {fieldRestoreRoleTag} from './field-restore-record.mjs';
import {sourceSecurityFrame,applySourceFrozenPrivileges} from './field-source-freeze-security.mjs';
import {grantPolicy} from './database-migrations.mjs';
import {grantRestoredFieldPolicy,validateUnreboundRestoredSchema} from './field-restore-security.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});},same=(a,b)=>canonical(a)===canonical(b);
export async function checkRestoreTarget(client,c,state){
 const expected=state.roles.roles,names=Object.values(expected).map(r=>r.name),rows=(await client.query("SELECT oid::text,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig,shobj_description(oid,'pg_authid') AS comment FROM pg_roles WHERE rolname=ANY($1::text[])",[names])).rows;
 if(rows.length!==4)fail('FIELD_RESTORE_TARGET_ROLE_CHANGED');const modes={};
 for(const [kind,e]of Object.entries(expected)){const r=rows.find(x=>x.rolname===e.name);if(!r||r.oid!==e.oid||r.comment!==fieldRestoreRoleTag(c.intent,kind)||r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolinherit||r.rolreplication||r.rolbypassrls||r.rolconnlimit!==-1||r.rolvaliduntil!==null||r.rolconfig!==null)fail('FIELD_RESTORE_TARGET_ROLE_CHANGED');modes[kind]=r.rolcanlogin;}
 if(modes.owner||modes.app||modes.backup&&modes.migrator)fail('FIELD_RESTORE_TARGET_ROLE_CHANGED');
 const memberships=(await client.query('SELECT roleid::text,member::text,admin_option,inherit_option,set_option FROM pg_auth_members WHERE roleid=ANY($1::oid[]) OR member=ANY($1::oid[])',[Object.values(expected).map(r=>r.oid)])).rows;
 const desired=modes.migrator?[{roleid:expected.owner.oid,member:expected.migrator.oid,admin_option:false,inherit_option:false,set_option:true}]:[];
 if(!same(memberships,desired))fail('FIELD_RESTORE_TARGET_MEMBERSHIP_CHANGED');
 const db=(await client.query('SELECT oid::text,datname,datdba::text,datallowconn,datistemplate,datconnlimit FROM pg_database WHERE datname=$1',[c.account.database])).rows[0];
 if(!db||db.oid!==state.provision.database.oid||db.datdba!==expected.owner.oid||!db.datallowconn||db.datistemplate||db.datconnlimit!==-1)fail('FIELD_RESTORE_TARGET_DATABASE_CHANGED');
 const acl=(await client.query("SELECT x.grantee::text AS grantee,x.privilege_type AS privilege,x.is_grantable,x.grantor::text AS grantor FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) x WHERE d.oid=$1::oid AND x.grantee<>d.datdba ORDER BY x.grantee,x.privilege_type",[db.oid])).rows;
 const wanted=(modes.backup?[expected.app,expected.backup]:modes.migrator?[expected.migrator]:[]).map(r=>({grantee:r.oid,privilege:'CONNECT',is_grantable:false,grantor:expected.owner.oid})).sort((a,b)=>BigInt(a.grantee)<BigInt(b.grantee)?-1:1);
 if(!same(acl,wanted))fail('FIELD_RESTORE_TARGET_DATABASE_ACL_CHANGED');
 return modes.backup?'SEALED':modes.migrator?'WRITER':'PREPARED';
}
export async function openRestoreWriter(client,c,state,check){
 const mode=await checkRestoreTarget(client,c,state);if(mode==='SEALED')fail('FIELD_RESTORE_SEALED_BEFORE_DATA_COMPLETE');if(mode==='WRITER')return;
 await client.query('BEGIN');try{await client.query(`GRANT ${q(c.account.ownerRole)} TO ${q(c.migrator)} WITH INHERIT FALSE,SET TRUE,ADMIN FALSE;GRANT CONNECT ON DATABASE ${q(c.account.database)} TO ${q(c.migrator)};ALTER ROLE ${q(c.migrator)} LOGIN`);await check();await client.query('/* IDMS_FIELD_RESTORE_WRITER_COMMIT */ COMMIT');}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
 if(await checkRestoreTarget(client,c,state)!=='WRITER')fail('FIELD_RESTORE_WRITER_UNCONFIRMED');
}
export async function checkUnsealedRestoreBaseline(client,c){
 const wanted=c.manifest.facts.relations.map(r=>({schema:r.schema,name:r.table,kind:r.kind}));wanted.push({schema:'public',name:'audit_ledger_sequence_no_seq',kind:'S'});const order=a=>a.sort((x,y)=>(x.schema+'.'+x.name).localeCompare(y.schema+'.'+y.name));
 const actual=(await client.query("SELECT n.nspname AS schema,c.relname AS name,c.relkind::text AS kind,pg_get_userbyid(c.relowner) AS owner,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f','S')")).rows;
 if(actual.some(r=>r.owner!==c.account.ownerRole||r.relacl!==null)||!same(order(actual.map(({owner,relacl,...r})=>r)),order(wanted)))fail('FIELD_RESTORE_UNSEALED_CATALOG_CHANGED');
 const schemas=(await client.query("SELECT nspname,pg_get_userbyid(nspowner) AS owner,nspacl FROM pg_namespace WHERE nspname!~'^pg_' AND nspname<>'information_schema' ORDER BY nspname COLLATE \"C\"")).rows;if(schemas.length!==2||schemas[0].nspname!=='idms_field'||schemas[1].nspname!=='public'||schemas.some(r=>r.owner!==c.account.ownerRole||r.nspacl!==null))fail('FIELD_RESTORE_UNSEALED_CATALOG_CHANGED');
 if((await client.query("SELECT 1 FROM pg_default_acl UNION ALL SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','idms_field') AND a.attacl IS NOT NULL UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','idms_field') AND (p.proacl IS NOT NULL OR pg_get_userbyid(p.proowner)<>$1) LIMIT 1",[c.account.ownerRole])).rowCount)fail('FIELD_RESTORE_UNSEALED_CATALOG_CHANGED');
}
export async function sealRestoredTarget(client,c,state,tenant,check){
 const mode=await checkRestoreTarget(client,c,state);if(mode==='SEALED'){await sourceSecurityFrame(client,c.account,c.migrator,'FROZEN');return;}
 await checkUnsealedRestoreBaseline(client,c);await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
 try{await client.query(`SET LOCAL ROLE ${q(c.account.ownerRole)}`);await grantPolicy(client,c.account);await grantRestoredFieldPolicy(client,c.account);await client.query(`REVOKE ALL ON DATABASE ${q(c.account.database)} FROM ${q(c.migrator)};RESET ROLE;ALTER ROLE ${q(c.backupAccount.user)} LOGIN`);await applySourceFrozenPrivileges(client,c.account,c.migrator);await validateUnreboundRestoredSchema(client,c.account,c.migrator,c.sourceAccount,tenant);await check();await client.query('/* IDMS_FIELD_RESTORE_SEAL_COMMIT */ COMMIT');}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
 if(await checkRestoreTarget(client,c,state)!=='SEALED')fail('FIELD_RESTORE_SEAL_UNCONFIRMED');
}
