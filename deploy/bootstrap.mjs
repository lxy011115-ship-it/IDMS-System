// Fresh cloud pilot only. Never loads an existing local or customer snapshot.
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {roleLayout,businessRuntime,migrateTenant,backupRuntime,migrationRuntime} from '../scripts/database-migrations.mjs';
import {provisionAuthStore} from '../scripts/auth-session-store.mjs';
import {seedStore} from '../server/store.ts';
import {platformSnapshot} from '../server/import-api.ts';

if(process.env.IDMS_STORAGE)throw Error('Bootstrap must run separately from business runtime');
const secret=()=>randomBytes(32).toString('base64url');
await mkdir('.local',{recursive:true,mode:0o700});
await mkdir('.demo-data',{recursive:true,mode:0o700});
const marker='.local/cloud-bootstrap-complete.json';
try{await access(marker);throw Error('Cloud bootstrap already complete; inspect existing deployment');}catch(e){if(e.code!=='ENOENT')throw e;}
const privateWrite=(name,value)=>writeFile(name,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
let config;
try{config=JSON.parse(await readFile('/srv/idms/private/cloud-deployment.json','utf8'));}
catch(e){
 if(e.code!=='ENOENT')throw e;
 const password=(await readFile('/srv/idms/private/postgres.env','utf8')).match(/^POSTGRES_PASSWORD=([\w-]+)$/m)?.[1];
 if(!password)throw Error('Missing owned PostgreSQL bootstrap credential');
 config={host:'127.0.0.1',port:55434,bootstrapPassword:password,tenants:{},businessRoles:{},identity:{user:'idms_cloud_identity',database:'idms_cloud_identity',password:secret()}};
 for(const tenant of ['acme','sandbox']){
  const account={user:`idms_cloud_${tenant}_app`,database:`idms_cloud_${tenant}`,password:secret()};
  config.tenants[tenant]=account;config.businessRoles[tenant]={...roleLayout(account),telemetry:false};
 }
 await privateWrite('/srv/idms/private/cloud-deployment.json',config);
}
const admin=new pg.Client({host:config.host,port:config.port,user:'idms_bootstrap',password:config.bootstrapPassword,database:'postgres'});
await admin.connect();
try{
 for(const a of [...Object.values(config.tenants),config.identity]){
  if(!/^[a-z_]+$/.test(a.user)||!/^[a-z_]+$/.test(a.database)||!/^[-\w]{40,}$/.test(a.password))throw Error('Invalid generated identity');
  if(!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[a.user])).rowCount)await admin.query(`CREATE ROLE "${a.user}" LOGIN PASSWORD '${a.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`);
  const db=(await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[a.database])).rows[0];
  const layout=Object.entries(config.tenants).find(([,v])=>v.database===a.database);
  if(db&&db.owner!==a.user&&db.owner!==config.businessRoles[layout?.[0]]?.owner)throw Error('Unknown existing database owner');
  if(!db)await admin.query(`CREATE DATABASE "${a.database}" OWNER "${a.user}" TEMPLATE template0`);
  await admin.query(`REVOKE ALL ON DATABASE "${a.database}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${a.database}" TO "${a.user}"`);
 }
}finally{await admin.end();}
const snapshot=platformSnapshot(seedStore());
for(const tenant of Object.keys(config.tenants))await migrateTenant(config,tenant,snapshot);
const business=businessRuntime(config);
await privateWrite('.local/postgres-business.json',business);
await privateWrite('/srv/idms/private/postgres-backup.json',backupRuntime(config));
await privateWrite('/srv/idms/private/postgres-migration.json',migrationRuntime(config));
await provisionAuthStore(business,config);
await privateWrite('/srv/idms/private/keycloak-admin.json',{username:'idms-cloud-bootstrap',password:secret()});
await writeFile('/srv/idms/private/keycloak.env',[
 'KC_DB=postgres',`KC_DB_URL=jdbc:postgresql://127.0.0.1:55434/${config.identity.database}`,`KC_DB_USERNAME=${config.identity.user}`,`KC_DB_PASSWORD=${config.identity.password}`,
 'KC_HTTP_ENABLED=true','KC_HTTP_HOST=127.0.0.1','KC_HTTP_PORT=8084','KC_HOSTNAME=http://127.0.0.1:8084','KC_HOSTNAME_STRICT=true',
 'KC_HTTP_MANAGEMENT_HOST=127.0.0.1','KC_HTTP_MANAGEMENT_PORT=9004','KC_DB_POOL_INITIAL_SIZE=1','KC_DB_POOL_MIN_SIZE=1','KC_DB_POOL_MAX_SIZE=5',
 'JAVA_OPTS_KC_HEAP=-Xms64m -Xmx192m -XX:MaxMetaspaceSize=160m','JAVA_OPTS_APPEND=-XX:ActiveProcessorCount=2',
 'KC_BOOTSTRAP_ADMIN_USERNAME=idms-cloud-bootstrap',`KC_BOOTSTRAP_ADMIN_PASSWORD=${JSON.parse(await readFile('/srv/idms/private/keycloak-admin.json','utf8')).password}`,
].join('\n')+'\n',{flag:'wx',mode:0o600});
await privateWrite(marker,{status:'FRESH_PILOT_DATABASES_READY',productionAcceptance:false,publicExposure:false,createdAt:new Date().toISOString()});
console.log(JSON.stringify({status:'FRESH_PILOT_DATABASES_READY',tenants:2,encryptedSharedSessions:true,customerDataCopied:false,credentialsLogged:false}));

