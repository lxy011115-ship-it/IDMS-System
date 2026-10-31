// Ordinary local startup: use the existing identity database; never provision users or roles.
import {readFile,writeFile,open,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import {existingIdentityContract,reviewedIdentityContract} from './existing-identity-contract.mjs';

export const identityConfigFile=resolve('.local/keycloak-runtime.json');
export async function localConfig(){return JSON.parse(await readFile(identityConfigFile,'utf8'));}
export function validateIdentityConfig(config){
 if(!config||config.version!=='26.8.1'||config.origin!=='http://127.0.0.1:8081'||config.realm!=='idms'||!config.database||!/^[a-z_]+$/.test(config.database.user)||!/^[a-z_]+$/.test(config.database.database)||!/^[\w-]{32,}$/.test(config.database.password))throw Error('Invalid existing local identity configuration');
 return config;
}
const localDatabase=database=>{if(!database||!['127.0.0.1','localhost'].includes(database.host)||!Number.isInteger(database.port)||database.port<1||database.port>65535)throw Error('Invalid local identity database endpoint');};
export async function identityReady(config,realm=config.realm){
 try{const r=await fetch(config.origin+'/realms/'+realm+'/.well-known/openid-configuration',{signal:AbortSignal.timeout(2000)});return r.ok&&(await r.json()).issuer===config.origin+'/realms/'+realm;}catch{return false;}
}
export const identityPortOccupied=()=>new Promise(resolve=>{const socket=net.connect(8081,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));});
export async function assertExistingIdentityStore(config,database){
 localDatabase(database);const c=new pg.Client({host:database.host,port:database.port,user:config.database.user,password:config.database.password,database:config.database.database,connectionTimeoutMillis:5000,query_timeout:5000});
 try{
  await c.connect();await c.query('BEGIN READ ONLY');
  if((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only!=='on')throw Error('Read-only validation required');
  // Keycloak 26.8.1 can create Liquibase bookkeeping tables even when empty initialization is disabled.
  // Refuse before Java is launched unless those existing tables and deployment version are present.
  const tables=(await c.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])",[['realm','migration_model','databasechangelog','databasechangeloglock']])).rows[0];
  if(tables.n!==4)throw Error('Existing identity schema required');
  const names=[...new Set(['master',config.realm])],r=(await c.query("SELECT count(*)::int AS n FROM public.realm WHERE name=ANY($1::text[])",[names])).rows[0];
  if(r.n!==names.length)throw Error('Missing existing identity realm');
  const versions=(await c.query('SELECT version FROM public.migration_model')).rows;
  if(versions.length!==1||versions[0].version!=='26.8.1')throw Error('Identity migration required');
  if(!(await c.query('SELECT 1 FROM public.databasechangelog LIMIT 1')).rowCount)throw Error('Existing identity change-set history required');
  if(JSON.stringify(await existingIdentityContract(c))!==JSON.stringify(reviewedIdentityContract))throw Error('Existing identity schema/change-set binding differs from reviewed fixed-version deployment');
  await c.query('COMMIT');
 }catch{throw Error('Existing identity database is unavailable or uninitialized; run explicit identity setup after administrator review');}finally{await c.end().catch(()=>{});}
}
export function identityEnvironment(config,database,{bootstrap=false,parent=process.env,runtimeRoot}={}){
 localDatabase(database);if(!runtimeRoot)throw Error('Identity runtime path is required');const env={...parent};
 for(const key of Object.keys(env))if(/^(KC_|KCRAW_|QUARKUS_|KEYCLOAK_ADMIN)/i.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS'].includes(key))delete env[key];
 Object.assign(env,{JAVA_HOME:join(runtimeRoot,'jdk-21'),KC_DB:'postgres',KC_DB_URL:`jdbc:postgresql://${database.host}:${database.port}/${config.database.database}`,KC_DB_USERNAME:config.database.user,KC_DB_PASSWORD:config.database.password,KC_HTTP_HOST:'127.0.0.1',KC_HTTP_PORT:'8081',KC_HTTP_MANAGEMENT_HOST:'127.0.0.1',KC_HOSTNAME:config.origin,KC_LOG_LEVEL:'info'});
 if(bootstrap){if(typeof config.admin?.username!=='string'||typeof config.admin?.password!=='string')throw Error('Explicit bootstrap credentials required');env.KC_BOOTSTRAP_ADMIN_USERNAME=config.admin.username;env.KC_BOOTSTRAP_ADMIN_PASSWORD=config.admin.password;}return env;
}
/** Shared by the ordinary coordinator and fixed-version isolated verification. No auto-build/relaunch. */
export function existingIdentityCommand(config,database,{runtimeRoot,port=8081,managementPort=9000}={}){
 const kcRoot=join(runtimeRoot,'keycloak-'+config.version),java=join(runtimeRoot,'jdk-21/bin/java.exe');
 const env=identityEnvironment(config,database,{runtimeRoot});
 Object.assign(env,{KC_HTTP_PORT:String(port),KC_HTTP_ENABLED:'true',KC_HTTP_MANAGEMENT_PORT:String(managementPort),KC_CACHE:'local'});
 const args=['-Xms64m','-Xmx512m','-Dfile.encoding=UTF-8','-Duser.language=en','-Duser.country=US','-Djava.util.logging.manager=org.jboss.logmanager.LogManager','-Djava.util.concurrent.ForkJoinPool.common.threadFactory=io.quarkus.bootstrap.forkjoin.QuarkusForkJoinWorkerThreadFactory','--add-opens=java.base/java.lang=ALL-UNNAMED','--add-opens=java.base/java.util=ALL-UNNAMED',`-Dkc.home.dir=${kcRoot}`,`-Djboss.server.config.dir=${join(kcRoot,'conf')}`,'-cp',join(kcRoot,'lib/quarkus-run.jar'),'io.quarkus.bootstrap.runner.QuarkusEntryPoint','start','--optimized','--spi-connections-jpa--quarkus--migration-strategy=validate','--spi-connections-jpa--quarkus--initialize-empty=false','--spi-connections-jpa--quarkus--auto-create-missing-indexes=false'];
 return {executable:java,args,env,cwd:kcRoot};
}
export async function ensureKeycloakProcess(config,database,{bootstrap=false,probe=()=>identityReady(config,bootstrap?'master':config.realm)}={}){
 validateIdentityConfig(config);localDatabase(database);if(await probe())return {started:false};
 if(await identityPortOccupied())throw Error('Port 8081 is occupied but the configured identity issuer is not ready; no duplicate was launched');
 if(!process.env.LOCALAPPDATA)throw Error('Existing Windows identity runtime path was not configured');const runtime=join(process.env.LOCALAPPDATA,'IDMS/runtime'),kcRoot=join(runtime,'keycloak-'+config.version),java=join(runtime,'jdk-21/bin/java.exe');await access(java);await access(join(kcRoot,'lib/quarkus-run.jar'));
 const args=['-Xms64m','-Xmx512m','-Dfile.encoding=UTF-8','-Duser.language=en','-Duser.country=US','-Djava.util.logging.manager=org.jboss.logmanager.LogManager','-Djava.util.concurrent.ForkJoinPool.common.threadFactory=io.quarkus.bootstrap.forkjoin.QuarkusForkJoinWorkerThreadFactory','--add-opens=java.base/java.lang=ALL-UNNAMED','--add-opens=java.base/java.util=ALL-UNNAMED',`-Dkc.home.dir=${kcRoot}`,`-Djboss.server.config.dir=${join(kcRoot,'conf')}`,'-cp',join(kcRoot,'lib/quarkus-run.jar'),'io.quarkus.bootstrap.runner.QuarkusEntryPoint','start-dev'];
 const env=identityEnvironment(config,database,{bootstrap,runtimeRoot:runtime});let failed=false,live;
 if(!bootstrap){
  await assertExistingIdentityStore(config,database);
  const command=existingIdentityCommand(config,database,{runtimeRoot:runtime}),log=await open('.local/keycloak.log','a');
  try{live=spawn(command.executable,command.args,{cwd:command.cwd,env:command.env,detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});}finally{await log.close();}
  live.once('error',()=>{failed=true;});live.once('exit',()=>{failed=true;});live.unref();
  await writeFile('.local/keycloak-process.json',JSON.stringify({pid:live.pid,executable:java,port:8081,mode:'runtime-validate',autoRestart:false}));
  for(let i=0;i<180;i++){if(failed)break;if(await probe())return {started:true};await new Promise(r=>setTimeout(r,1000));}
  throw Error('Identity runtime validation/startup unconfirmed; no rebuild, initialization or restart performed');
 }
 async function launch(rebuilt=false){const log=await open('.local/keycloak.log','a');try{live=spawn(java,rebuilt?['-Dkc.config.built=true',...args]:args,{cwd:kcRoot,env,detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});}finally{await log.close();}live.once('error',()=>{failed=true;});live.once('exit',code=>{if(code===10&&!rebuilt)void launch(true).catch(()=>{failed=true;});else failed=true;});live.unref();await writeFile('.local/keycloak-process.json',JSON.stringify({pid:live.pid,executable:java,port:8081}));}
 await launch();for(let i=0;i<180;i++){if(failed)break;if(await probe())return {started:true};await new Promise(r=>setTimeout(r,1000));}
 throw Error('Identity readiness is unconfirmed; inspect the recorded process and local log before retrying. No timeout-triggered restart was performed');
}
/** The coordinator has no account-write capability, including when resuming a stopped service. */
export async function existingIdentityRuntime(config,{ready=()=>identityReady(config),occupied=identityPortOccupied,validateStore,start}={}){
 validateIdentityConfig(config);if(await ready())return {started:false};if(await occupied())throw Error('Existing identity issuer is not ready on an occupied port; no duplicate was launched');
 if(!validateStore||!start)throw Error('Existing identity runtime dependencies are required');await validateStore();const result=await start();if(!await ready())throw Error('Configured identity realm is not ready; explicit setup is required, not automatic account repair');return result;
}
export async function ensureExistingKeycloak(){
 let config;try{config=await localConfig();}catch(error){if(error.code==='ENOENT')throw Error('Existing identity configuration is missing; run explicit identity setup first');throw error;}
 let database;const db=async()=>database||=(JSON.parse(await readFile('.local/postgres-runtime.json','utf8')));
 const result=await existingIdentityRuntime(config,{validateStore:async()=>assertExistingIdentityStore(config,await db()),start:async()=>ensureKeycloakProcess(config,await db())});return {config,...result};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){if(process.argv.length>2)throw Error('Ordinary identity startup accepts no provisioning arguments');const result=await ensureExistingKeycloak();console.log(JSON.stringify({ready:true,started:result.started,issuer:result.config.origin+'/realms/'+result.config.realm,accountProvisioning:false,developmentOnly:true}));}
