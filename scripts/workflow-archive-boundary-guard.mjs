import pg from 'pg';
import {lstat,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonical} from '../server/imports.ts';
import {workflowRequire as need,workflowSha} from './workflow-archive-facts.mjs';
import {workflowArchiveKeyBinding} from './workflow-archive-container.mjs';
export class WorkflowArchiveBoundaryGuard {
 constructor(config,operationId,keyFile,keyBinding){this.config=config;this.operationId=operationId;this.keyFile=keyFile;this.keyBinding=keyBinding;this.lost=false;const a=config.authority;this.client=new pg.Client({host:a.host,port:a.port,user:'idms_bootstrap',password:a.bootstrapPassword,database:a.controlDatabase,application_name:'idms-wf-capture-boundary',connectionTimeoutMillis:3000,query_timeout:15000,options:'-c default_transaction_read_only=on'});this.client.on('error',()=>{this.lost=true;});}
 async authorityFrame(){
  const c=this.client,a=this.config.authority;need(!this.lost,'WF_ARCHIVE_AUTHORITY_LOST');await c.query('SELECT pg_stat_clear_snapshot()');
  const identity=(await c.query('SELECT current_database() AS database,pg_is_in_recovery() AS recovery,(SELECT system_identifier::text FROM pg_control_system()) AS system')).rows[0];need(identity.database===a.controlDatabase&&identity.system===a.systemIdentifier&&!identity.recovery,'WF_ARCHIVE_AUTHORITY_DRIFT');
  const database=(await c.query('SELECT oid::text,datname,datdba::text,datallowconn,datistemplate,datconnlimit,datacl::text FROM pg_database WHERE datname=current_database()')).rows[0];
  const owner=(await c.query('SELECT oid::text,rolname,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit FROM pg_roles WHERE oid=$1::oid',[database.datdba])).rows[0];
  need(database.datallowconn&&!database.datistemplate&&owner.rolname===a.controlDatabase+'_owner'&&['rolcanlogin','rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].every(k=>!owner[k]),'WF_ARCHIVE_AUTHORITY_DRIFT');
  const membership=(await c.query('SELECT 1 FROM pg_auth_members WHERE roleid=$1::oid OR member=$1::oid',[owner.oid])).rows;need(membership.length===0,'WF_ARCHIVE_AUTHORITY_DRIFT');
  const acl=(await c.query("SELECT x.grantee::text,x.privilege_type,x.is_grantable FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) x WHERE d.oid=$1::oid ORDER BY x.grantee,x.privilege_type COLLATE \"C\"",[database.oid])).rows;
  need(acl.length===3&&acl.every(r=>r.grantee===owner.oid&&!r.is_grantable)&&canonical(acl.map(r=>r.privilege_type))===canonical(['CONNECT','CREATE','TEMPORARY']),'WF_ARCHIVE_AUTHORITY_DRIFT');
  const table=(await c.query("SELECT c.oid::text,c.relowner::text,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,(SELECT count(*)::integer FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers FROM pg_class c WHERE c.oid=to_regclass('public.workflow_freeze_operations')")).rows[0];
  need(table&&table.relowner===owner.oid&&!table.relrowsecurity&&!table.relforcerowsecurity&&table.triggers===0,'WF_ARCHIVE_AUTHORITY_DRIFT');
  need((await c.query("SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=$1::oid AND x.grantee<>c.relowner",[table.oid])).rowCount===0,'WF_ARCHIVE_AUTHORITY_DRIFT');
  const columns=(await c.query('SELECT attname,format_type(atttypid,atttypmod) AS type,attnotnull FROM pg_attribute WHERE attrelid=$1::oid AND attnum>0 AND NOT attisdropped ORDER BY attnum',[table.oid])).rows;
  const expected=[['operation_id','uuid',true],['database_oid','oid',true],['source_binding','jsonb',true],['baseline','jsonb',true],['baseline_sha256','text',true],['phase','text',true],['drained_count','integer',true],['prepared_at','timestamp with time zone',true],['fenced_at','timestamp with time zone',false],['drained_at','timestamp with time zone',false],['released_at','timestamp with time zone',false]].map(([attname,type,attnotnull])=>({attname,type,attnotnull}));need(canonical(columns)===canonical(expected),'WF_ARCHIVE_AUTHORITY_DRIFT');return {database,owner,acl,table,columns};
 }
 async connect(){await this.client.connect();this.authorityBaseline=await this.authorityFrame();await this.check();}
 get capabilitySha256(){return workflowSha(this.authorityBaseline);}
 async check(){
  const c=this.client,s=this.config.source;need(canonical(await this.authorityFrame())===canonical(this.authorityBaseline),'WF_ARCHIVE_AUTHORITY_DRIFT');
  const op=(await c.query('SELECT source_binding,baseline,baseline_sha256,phase,database_oid::text FROM workflow_freeze_operations WHERE operation_id=$1',[this.operationId])).rows[0];
  need(op&&op.phase==='DRAINED'&&canonical(op.source_binding)===canonical(s)&&workflowSha(op.baseline)===op.baseline_sha256&&op.database_oid===op.baseline.database.oid,'WF_ARCHIVE_SOURCE_CATALOG_DRIFT');
  const database=(await c.query('SELECT oid::text,datname,datdba::text,datallowconn,datistemplate,datconnlimit,datacl::text FROM pg_database WHERE datname=$1',[s.database])).rows[0];
  const role=(await c.query("SELECT oid::text,rolname,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,encode(sha256(convert_to(COALESCE(rolpassword,''),'UTF8')),'hex') AS password_verifier_digest FROM pg_authid WHERE rolname=$1",[s.user])).rows[0];need(database&&role,'WF_ARCHIVE_SOURCE_CATALOG_DRIFT');
  const membership=(await c.query('SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members WHERE roleid=$1::oid OR member=$1::oid ORDER BY roleid,member',[role.oid])).rows;
  const expected=structuredClone(op.baseline);expected.database.datconnlimit=0;expected.role.rolcanlogin=false;need(canonical({database,role,membership})===canonical(expected),'WF_ARCHIVE_SOURCE_CATALOG_DRIFT');
  need((await c.query('SELECT 1 FROM pg_database WHERE datdba=$1::oid',[role.oid])).rowCount===1&&(await c.query('SELECT 1 FROM pg_prepared_xacts WHERE database=$1',[s.database])).rowCount===0&&(await c.query('SELECT 1 FROM pg_subscription WHERE subdbid=$1::oid',[database.oid])).rowCount===0,'WF_ARCHIVE_SOURCE_CATALOG_DRIFT');
  await c.query('SELECT pg_stat_clear_snapshot()');need((await c.query('SELECT 1 FROM pg_stat_activity WHERE usesysid=$1::oid AND datid IS DISTINCT FROM $2::oid',[role.oid,database.oid])).rowCount===0,'WF_ARCHIVE_SOURCE_CATALOG_DRIFT');
  need(canonical(await workflowArchiveKeyBinding(this.keyFile))===canonical(this.keyBinding),'WF_ARCHIVE_KEY_DRIFT');
 }
 async runFiles(directory,identity,{stageProof}={}){
  const names=await readdir(directory),allowed=stageProof?['dump.pgdump','dump.identity.json','closed.json','archive.partial','stage-proof.json']:['dump.pgdump','dump.identity.json','closed.json'];need(names.length===allowed.length&&names.every(n=>allowed.includes(n)),'WF_ARCHIVE_RUN_UNKNOWN_FILE');
  for(const n of names){const f=await lstat(join(directory,n),{bigint:true});need(f.isFile()&&!f.isSymbolicLink()&&f.nlink===1n,n==='dump.pgdump'?'WF_ARCHIVE_DUMP_CHANGED':'WF_ARCHIVE_STAGE_CHANGED');}
  const dump=await lstat(join(directory,'dump.pgdump'),{bigint:true});need(identity&&String(dump.dev)===identity.dev&&String(dump.ino)===identity.ino&&canonical(JSON.parse(await readFile(join(directory,'dump.identity.json'),'utf8')))===canonical(identity),'WF_ARCHIVE_DUMP_CHANGED');
  if(stageProof)need(canonical(JSON.parse(await readFile(join(directory,'stage-proof.json'),'utf8')))===canonical(stageProof),'WF_ARCHIVE_STAGE_CHANGED');
 }
 async rootFiles(root,intent){
  const names=await readdir(root);need(names.length<=4096,'WF_ARCHIVE_WORK_ROOT_NOT_EXCLUSIVE');if(!intent){need(names.length===0,'WF_ARCHIVE_WORK_ROOT_NOT_EXCLUSIVE');return;}
  const uuid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',files=new RegExp('^workflow-run-'+uuid+'(?:\\.closed)?\\.json$'),tools=new RegExp('^workflow-'+intent.backupId+'-tool-'+uuid+'\\.json$'),auth=new RegExp('^workflow-auth-'+uuid+'\\.json$'),runs=new RegExp('^run-'+uuid+'$');
  for(const name of names){const directory=runs.test(name)||/^field-backup-stage-[A-Za-z0-9]{6}$/.test(name),file=name==='workflow-archive-intent.json'||files.test(name)||tools.test(name)||auth.test(name);need(directory||file,'WF_ARCHIVE_WORK_ROOT_NOT_EXCLUSIVE');const s=await lstat(join(root,name),{bigint:true});need(!s.isSymbolicLink()&&(directory?s.isDirectory():s.isFile()&&s.nlink===1n),'WF_ARCHIVE_WORK_ROOT_NOT_EXCLUSIVE');}
 }
 async close(){await this.client.end().catch(()=>{});}
}
