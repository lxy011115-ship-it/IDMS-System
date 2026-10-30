import pg from 'pg';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {canonical} from '../server/imports.ts';
import {authenticateWorkflowArchiveV2} from './workflow-archive-container.mjs';
import {workflowArchiveFacts,workflowArchiveContext,workflowRequire as need,workflowQuote as q} from './workflow-archive-facts.mjs';
import {fieldDatabaseCreateOptions} from './field-capture-context.mjs';
import {applyFieldFactSession} from './field-fact-session.mjs';
import {privateNewFile} from './backup-support.mjs';
// Isolated restore kernel. It never selects an existing database as its target.
export async function restoreWorkflowArchiveV2({authority,backupFile,keyFile,tenantId,targetDatabase,credentialFile,workDirectory,signal}){
 need(new RegExp('^idms_workflowrestore_'+tenantId+'_[a-f0-9]{12}$').test(targetDatabase),'WF_ARCHIVE_TARGET');
 const archive=await authenticateWorkflowArchiveV2({backupFile,keyFile,tenantId,workDirectory,signal});let admin,account,role=false,database=false;
 try{
  need(targetDatabase!==archive.manifest.source.database,'WF_ARCHIVE_TARGET');const m=archive.manifest;
  admin=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:'postgres',connectionTimeoutMillis:3000});await admin.connect();
  need((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$1',[targetDatabase])).rowCount===0,'WF_ARCHIVE_TARGET_EXISTS');
  account={user:targetDatabase,database:targetDatabase,password:randomBytes(32).toString('base64url')};await privateNewFile(credentialFile,JSON.stringify({format:'idms-workflow-isolated-restore-credentials-v2',tenantId,backupId:m.backupId,...account}));
  await admin.query('CREATE ROLE '+q(account.user)+" LOGIN PASSWORD '"+account.password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT");role=true;
  await admin.query('CREATE DATABASE '+q(account.database)+' OWNER '+q(account.user)+' TEMPLATE template0 '+fieldDatabaseCreateOptions(m.context.database));database=true;await admin.query('REVOKE ALL ON DATABASE '+q(account.database)+' FROM PUBLIC');
  // A schema-selected dump explicitly creates public. Only this newly created,
  // empty template0 database may remove its default public schema before restore.
  const empty=new pg.Client({host:authority.host,port:authority.port,...account});await empty.connect();try{await empty.query('DROP SCHEMA public');}finally{await empty.end();}
  const env={...process.env};for(const k of Object.keys(env))if(/^PG/i.test(k))delete env[k];Object.assign(env,{PGHOST:authority.host,PGPORT:String(authority.port),PGUSER:account.user,PGPASSWORD:account.password,PGDATABASE:account.database,PGCONNECT_TIMEOUT:'5'});
  await new Promise((ok,reject)=>{
   let failure,diagnostic='';const child=spawn(join(process.env.LOCALAPPDATA,'IDMS/runtime/pgsql/bin/pg_restore.exe'),['--no-owner','--no-acl','--no-password','--single-transaction','--exit-on-error','--dbname='+account.database,archive.dumpFile],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>{if(diagnostic.length<32768)diagnostic+=b.toString('utf8').slice(0,32768-diagnostic.length);});child.on('error',e=>{failure=e;});const abort=()=>{failure=Object.assign(Error('WF_ARCHIVE_RESTORE_CANCELLED'),{code:'WF_ARCHIVE_RESTORE_CANCELLED'});child.kill();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(abort,300000);
   child.once('close',(code,sig)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(failure||code!==0||sig)reject(failure||Object.assign(Error('WF_ARCHIVE_RESTORE_NATIVE_FAILED'+(/schema "public" already exists/.test(diagnostic)?': PUBLIC_SCHEMA_EXISTS':'')),{code:'WF_ARCHIVE_RESTORE_NATIVE_FAILED'}));else ok();});
  });
  const c=new pg.Client({host:authority.host,port:authority.port,...account});await c.connect();try{
   await applyFieldFactSession(c,m.context.session);await c.query('SET max_parallel_workers_per_gather=0');await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');need(canonical(await workflowArchiveContext(c,targetDatabase))===canonical(m.context),'WF_ARCHIVE_RESTORE_CONTEXT');const facts=await workflowArchiveFacts(c);need(canonical(facts)===canonical(m.facts),'WF_ARCHIVE_RESTORE_FACTS');
  }finally{await c.end();}
  return {account,proof:{format:'idms-workflow-isolated-restored-v2',verifiedAt:new Date().toISOString(),backupId:m.backupId,tenantId,targetDatabase,all38TablesAndTwoSequencesMatchAuthenticatedSource:true,databaseAndSessionContextMatchesAuthenticatedSource:true,fullArchiveAuthenticationBeforeAnyDatabaseAction:true,sourceConnectionRequired:false,automaticActivationApproved:false,productionAcceptance:false}};
 }catch(e){if(admin&&database)await admin.query('DROP DATABASE '+q(account.database)+' WITH (FORCE)');if(admin&&role)await admin.query('DROP ROLE '+q(account.user));throw e;}
 finally{await admin?.end();await archive.dispose();}
}
