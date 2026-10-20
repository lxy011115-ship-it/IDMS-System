import pg from 'pg';
import {readFile,access,unlink} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {authRegistryFile,businessBinding,validateAuthRuntime,verifyAuthStore,keyWitnessBinding} from '../server/auth-store.ts';
import {authStoreSchema,authPrivileges,authSchemaChecksum} from '../server/auth-store-schema.ts';
import {sealState,validateKeyRing} from '../server/auth-state.ts';
import {validateRuntimeConfig} from '../server/postgres-security.ts';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
const q=v=>{if(typeof v!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(v))throw Error('Invalid authentication database identifier');return '"'+v+'"';};
const password=()=>randomBytes(32).toString('base64url');
async function exists(path){try{await access(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function role(c,name,secret,login){const prior=(await c.query('SELECT * FROM pg_roles WHERE rolname=$1',[name])).rows[0];if(!prior)await c.query(`CREATE ROLE ${q(name)} ${login?"LOGIN PASSWORD '"+secret+"'":'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`);else if(prior.rolcanlogin!==login||prior.rolsuper||prior.rolcreatedb||prior.rolcreaterole||prior.rolinherit||prior.rolbypassrls||prior.rolreplication)throw Error('Unexpected preexisting authentication role');}
export async function provisionAuthStore(business,root,{qa=false}={}){
 validateRuntimeConfig(business);if(qa&&Object.values(business.tenants).some(a=>!/^idms_(qa|[a-z]+qa)_/.test(a.database)))throw Error('QA authentication stores require generated QA business databases');
 const binding=businessBinding(business),runtimeFile=authRegistryFile(business),directory=dirname(runtimeFile),deploymentFile=join(directory,'deployment.json'),keyFile=join(directory,'keys.json');await privateDirectory(directory);
 const fresh=!await exists(deploymentFile);let d,ring;
 if(fresh){
  if(await exists(runtimeFile)||await exists(keyFile))throw Error('Unrecognized partial authentication configuration; refusing replacement');
  const database=(qa?'idms_authqa_':'idms_auth_')+binding.slice(0,16);d={format:1,purpose:'AUTH_SESSION_DEPLOYMENT',host:root.host,port:root.port,deploymentDigest:binding,database,ownerRole:database+'_owner',app:{user:database+'_app',password:password()},migrator:{user:database+'_migrator',password:password()},backup:{user:database+'_backup',password:password()},qa};ring={format:1,activeKeyId:'session-'+randomUUID(),keys:[]};ring.keys.push({keyId:ring.activeKeyId,key:randomBytes(32).toString('base64url')});await privateNewFile(keyFile,JSON.stringify(ring));await privateNewFile(deploymentFile,JSON.stringify(d));
 }else{d=JSON.parse(await readFile(deploymentFile,'utf8'));ring=validateKeyRing(JSON.parse(await readFile(keyFile,'utf8')));}
 if(d.purpose!=='AUTH_SESSION_DEPLOYMENT'||d.format!==1||d.deploymentDigest!==binding||d.host!==root.host||d.port!==root.port||d.qa!==qa||!new RegExp('^'+(qa?'idms_authqa_':'idms_auth_')+binding.slice(0,16)+'$').test(d.database)||d.ownerRole!==d.database+'_owner'||d.app.user!==d.database+'_app'||d.migrator.user!==d.database+'_migrator'||d.backup.user!==d.database+'_backup'||[d.app,d.migrator,d.backup].some(a=>typeof a.password!=='string'||!/^[-\w]{40,}$/.test(a.password)))throw Error('Authentication deployment binding/identities changed');
 const runtime=validateAuthRuntime({format:1,purpose:'AUTH_SESSION_RUNTIME',host:d.host,port:d.port,deploymentDigest:binding,account:{...d.app,database:d.database,ownerRole:d.ownerRole,backupRole:d.backup.user},keyFile},binding),admin=new pg.Client({host:root.host,port:root.port,user:'idms_bootstrap',password:root.bootstrapPassword,database:'postgres'});let migration;
 await admin.connect();try{
  await admin.query('SELECT pg_advisory_lock(hashtext($1))',['idms-auth-setup:'+binding]);const db=(await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[d.database])).rows[0];if(fresh&&db)throw Error('Authentication database already exists without recognized deployment evidence');if(db&&db.owner!==d.ownerRole)throw Error('Unknown authentication database owner');
  await role(admin,d.ownerRole,undefined,false);for(const a of [d.app,d.migrator,d.backup])await role(admin,a.user,a.password,true);
  const memberships=(await admin.query('SELECT pg_get_userbyid(member) AS member,pg_get_userbyid(roleid) AS role,admin_option,inherit_option,set_option FROM pg_auth_members WHERE member IN(SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[]))',[[d.ownerRole,d.app.user,d.migrator.user,d.backup.user]])).rows;
  if(memberships.some(m=>m.member!==d.migrator.user||m.role!==d.ownerRole||m.admin_option||m.inherit_option||!m.set_option))throw Error('Unexpected authentication role membership');if(!memberships.length)await admin.query(`GRANT ${q(d.ownerRole)} TO ${q(d.migrator.user)} WITH INHERIT FALSE,SET TRUE`);
  if(!db)await admin.query(`CREATE DATABASE ${q(d.database)} OWNER ${q(d.ownerRole)} TEMPLATE template0`);
  await admin.query(`REVOKE ALL ON DATABASE ${q(d.database)} FROM PUBLIC; GRANT CONNECT ON DATABASE ${q(d.database)} TO ${q(d.app.user)},${q(d.migrator.user)},${q(d.backup.user)}`);
  migration=new pg.Client({host:d.host,port:d.port,user:d.migrator.user,password:d.migrator.password,database:d.database});await migration.connect();await migration.query('BEGIN');
  try{
   await migration.query(`SET LOCAL ROLE ${q(d.ownerRole)}; SET LOCAL search_path TO public,pg_catalog`);const ready=(await migration.query("SELECT to_regclass('public.auth_schema_migrations') AS name")).rows[0].name;
   if(!ready){
    if((await migration.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' LIMIT 1")).rowCount)throw Error('Unknown objects in authentication database');
    await migration.query(`ALTER SCHEMA public OWNER TO ${q(d.ownerRole)}; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${q(d.app.user)},${q(d.backup.user)}; ALTER DEFAULT PRIVILEGES FOR ROLE ${q(d.ownerRole)} IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE ${q(d.ownerRole)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
    await migration.query(authStoreSchema);await migration.query('INSERT INTO auth_store_meta(singleton,deployment_digest,key_check) VALUES(true,$1,$2)',[binding,sealState({marker:'IDMS_AUTH_STORE_V1',deploymentDigest:binding},keyWitnessBinding(binding),ring)]);
    await migration.query('INSERT INTO auth_schema_migrations(version,checksum,deployment_digest,owner_role,app_role,backup_role) VALUES(1,$1,$2,$3,$4,$5)',[authSchemaChecksum,binding,d.ownerRole,d.app.user,d.backup.user]);
    for(const [table,privileges]of Object.entries(authPrivileges))await migration.query(`REVOKE ALL ON TABLE ${q(table)} FROM PUBLIC,${q(d.app.user)},${q(d.backup.user)}; GRANT ${privileges.join(',')} ON TABLE ${q(table)} TO ${q(d.app.user)}; GRANT SELECT ON TABLE ${q(table)} TO ${q(d.backup.user)}`);
   }
   await migration.query('COMMIT');
  }catch(e){await migration.query('ROLLBACK');throw e;}
  await migration.end();migration=undefined;
  const check=new pg.Pool({host:d.host,port:d.port,...d.app,database:d.database});try{const c=await check.connect();try{await verifyAuthStore(c,runtime,ring);for(const a of Object.values(business.tenants))if((await c.query("SELECT has_database_privilege(current_user,$1,'CONNECT') AS allowed",[a.database])).rows[0].allowed)throw Error('Authentication identity must not connect to tenant databases');}finally{c.release();}}finally{await check.end();}
  if(await exists(runtimeFile)){const prior=JSON.parse(await readFile(runtimeFile,'utf8'));if(JSON.stringify(prior)!==JSON.stringify(runtime))throw Error('Authentication runtime configuration differs; explicit migration required');}else await privateNewFile(runtimeFile,JSON.stringify(runtime));return {runtimeFile,deploymentFile,database:d.database,deploymentDigest:binding};
 }finally{await migration?.end().catch(()=>{});await admin.end();}
}
export async function cleanupQaAuthStore(root,reference){
 if(!reference)return;const d=JSON.parse(await readFile(reference.deploymentFile,'utf8'));if(!d.qa||d.deploymentDigest!==reference.deploymentDigest||d.database!==reference.database||!/^idms_authqa_[0-9a-f]{16}$/.test(d.database))throw Error('QA authentication cleanup target is not owned');const owned=typeof root.query!=='function',c=owned?new pg.Client({host:root.host,port:root.port,user:'idms_bootstrap',password:root.bootstrapPassword,database:'postgres'}):root;if(owned)await c.connect();if(Number((await c.query('SELECT inet_server_port() AS port')).rows[0].port)!==d.port)throw Error('QA auth cleanup server mismatch');try{await c.query(`DROP DATABASE IF EXISTS ${q(d.database)} WITH (FORCE)`);for(const role of [d.app.user,d.migrator.user,d.backup.user,d.ownerRole]){if(!role.startsWith(d.database+'_'))throw Error('QA auth role target mismatch');await c.query(`DROP ROLE IF EXISTS ${q(role)}`);}}finally{if(owned)await c.end();}for(const file of [reference.runtimeFile,reference.deploymentFile,join(dirname(reference.runtimeFile),'keys.json')])await unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){if(process.argv.length!==2)throw Error('Session setup takes its binding from private deployment files');const root=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),business=validateRuntimeConfig(JSON.parse(await readFile('.local/postgres-business.json','utf8')));const result=await provisionAuthStore(business,root);console.log(JSON.stringify({status:'shared-authentication-storage-ready',runtimeFile:result.runtimeFile,independentDatabase:true,encryption:'AES-256-GCM',credentialsLogged:false,productionAcceptance:false}));}
