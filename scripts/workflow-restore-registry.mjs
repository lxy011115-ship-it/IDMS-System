import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {workflowRequire as need,workflowSha,workflowQuote as q} from './workflow-archive-facts.mjs';
import {readFieldDatabaseContext} from './field-capture-context.mjs';
const phases=['INTENT','ROLE_CREATED','DB_CREATING','DB_READY','RESTORING','RESTORED','RESETTING','VERIFIED'];
export const restoreConnection=(a,database,application_name)=>({host:a.host,port:a.port,user:'idms_bootstrap',password:a.bootstrapPassword,database,application_name,connectionTimeoutMillis:3000,query_timeout:30000,options:'-c timezone=UTC -c max_parallel_workers_per_gather=0'});
export async function restoreRoleFrame(c,name){
 const r=(await c.query("SELECT oid::text,rolname,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,encode(sha256(convert_to(COALESCE(rolpassword,''),'UTF8')),'hex') AS password_verifier_digest FROM pg_authid WHERE rolname=$1",[name])).rows[0];
 if(!r)return null;
 const membership=(await c.query('SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members WHERE roleid=$1::oid OR member=$1::oid ORDER BY roleid,member',[r.oid])).rows;
 need(!r.rolcanlogin&&!r.rolsuper&&!r.rolinherit&&!r.rolcreatedb&&!r.rolcreaterole&&!r.rolreplication&&!r.rolbypassrls&&r.rolconnlimit===0&&membership.length===0,'WF_RESTORE_ROLE_DRIFT');return {...r,membership};
}
export async function restoreDatabaseFrame(c,name){
 const r=(await c.query('SELECT oid::text,datname,datdba::text,datallowconn,datistemplate,datconnlimit FROM pg_database WHERE datname=$1',[name])).rows[0];if(!r)return null;
 const acl=(await c.query("SELECT a.grantee::text,a.privilege_type,a.is_grantable FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=$1 ORDER BY a.grantee,a.privilege_type COLLATE \"C\"",[name])).rows;
 return {...r,acl,context:await readFieldDatabaseContext(c,name)};
}
export function requireRestoreDatabase(frame,name,role,context,{initial=false}={}){
 need(frame&&frame.datname===name&&frame.datdba===role.oid&&frame.datallowconn&&!frame.datistemplate&&frame.datconnlimit===0&&canonical(frame.context)===canonical(context),'WF_RESTORE_DATABASE_DRIFT');
 const owner=frame.acl.filter(a=>a.grantee===role.oid),others=frame.acl.filter(a=>a.grantee!==role.oid);
 need(owner.length===3&&canonical(owner.map(a=>a.privilege_type))===canonical(['CONNECT','CREATE','TEMPORARY'])&&owner.every(a=>!a.is_grantable),'WF_RESTORE_DATABASE_ACL');
 need(others.length===0||initial&&others.length===2&&canonical(others.map(a=>a.privilege_type))===canonical(['CONNECT','TEMPORARY'])&&others.every(a=>a.grantee==='0'&&!a.is_grantable),'WF_RESTORE_DATABASE_ACL');
}
export class WorkflowRestoreRegistry {
 constructor(authority,target){this.authority=authority;this.target=target;this.lost=false;this.client=new pg.Client(restoreConnection(authority,authority.controlDatabase,'idms-workflow-restore-registry'));this.client.on('error',()=>{this.lost=true;});}
 async connect(){
  const a=this.authority;need(a&&a.host==='127.0.0.1'&&Number.isSafeInteger(a.port)&&a.port>0&&a.port<65536&&/^idms_workflowcontrol_[a-f0-9]{12}$/.test(a.controlDatabase)&&/^[0-9]{10,25}$/.test(a.systemIdentifier)&&typeof a.bootstrapPassword==='string'&&a.bootstrapPassword.length>=32,'WF_RESTORE_AUTHORITY');
  await this.client.connect();const c=this.client;
  const identity=(await c.query("SELECT current_database() AS database,pg_is_in_recovery() AS recovery,(SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS pid,current_setting('server_version_num') AS version")).rows[0];
  need(identity.database===a.controlDatabase&&identity.system===a.systemIdentifier&&!identity.recovery&&/^16\d{4}$/.test(identity.version),'WF_RESTORE_AUTHORITY');this.pid=identity.pid;
  const owner=(await c.query('SELECT r.oid::text,r.rolname,r.rolcanlogin,r.rolsuper,r.rolinherit,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database()')).rows[0];
  need(owner.rolname===a.controlDatabase+'_owner'&&['rolcanlogin','rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].every(k=>owner[k]===false),'WF_RESTORE_AUTHORITY_OWNER');
  need((await c.query('SELECT 1 FROM pg_auth_members WHERE roleid=$1::oid OR member=$1::oid',[owner.oid])).rowCount===0,'WF_RESTORE_AUTHORITY_MEMBERSHIP');
  const acl=(await c.query("SELECT a.grantee::text,a.privilege_type FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() ORDER BY a.privilege_type COLLATE \"C\"")).rows;
  need(acl.length===3&&acl.every(r=>r.grantee===owner.oid)&&canonical(acl.map(r=>r.privilege_type))===canonical(['CONNECT','CREATE','TEMPORARY']),'WF_RESTORE_AUTHORITY_ACL');
  this.key='workflow-restore-v1:'+a.systemIdentifier+':'+this.target;
  need((await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[this.key])).rows[0].locked,'WF_RESTORE_BUSY');
  await c.query('BEGIN');try{
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('workflow-restore-registry-v1',0))");
   if(!(await c.query("SELECT to_regclass('public.workflow_restore_jobs') AS table")).rows[0].table){
    await c.query('SET LOCAL ROLE '+q(owner.rolname));await c.query(`CREATE TABLE public.workflow_restore_jobs (
     operation_id uuid PRIMARY KEY,target_name text NOT NULL UNIQUE,request_json jsonb NOT NULL,request_sha256 text NOT NULL,
     state_json jsonb NOT NULL,state_sha256 text NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
     REVOKE ALL ON public.workflow_restore_jobs FROM PUBLIC`);
   }
   const shape=(await c.query("SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull FROM pg_attribute a WHERE a.attrelid='public.workflow_restore_jobs'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum")).rows;
   need(canonical(shape)===canonical([['operation_id','uuid'],['target_name','text'],['request_json','jsonb'],['request_sha256','text'],['state_json','jsonb'],['state_sha256','text'],['updated_at','timestamp with time zone']].map(([attname,type])=>({attname,type,attnotnull:true}))),'WF_RESTORE_REGISTRY_SCHEMA');
   const table=(await c.query("SELECT c.relowner::text,c.relrowsecurity,c.relforcerowsecurity,(SELECT count(*)::integer FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers FROM pg_class c WHERE c.oid='public.workflow_restore_jobs'::regclass")).rows[0];
   need(table.relowner===owner.oid&&!table.relrowsecurity&&!table.relforcerowsecurity&&table.triggers===0,'WF_RESTORE_REGISTRY_OWNER');
   need((await c.query("SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='public.workflow_restore_jobs'::regclass AND a.grantee<>c.relowner")).rowCount===0,'WF_RESTORE_REGISTRY_ACL');
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 }
 async lease(){need(!this.lost,'WF_RESTORE_LEASE_LOST');const held=(await this.client.query(`WITH k AS (SELECT hashtextextended($1,0) AS v) SELECT 1 FROM pg_locks l CROSS JOIN k WHERE l.locktype='advisory' AND l.pid=pg_backend_pid() AND l.pid=$2 AND l.mode='ExclusiveLock' AND l.granted AND l.objsubid=1 AND l.classid=((k.v>>32)&4294967295)::oid AND l.objid=(k.v&4294967295)::oid`,[this.key,this.pid])).rowCount;need(held===1,'WF_RESTORE_LEASE_LOST');}
 async load(operationId,request){
  await this.lease();this.operationId=operationId;this.request=request;this.requestSha=workflowSha(request);const c=this.client;
  let row=(await c.query('SELECT * FROM public.workflow_restore_jobs WHERE operation_id=$1',[operationId])).rows[0];this.fresh=!row;
  if(!row){need((await c.query('SELECT 1 FROM public.workflow_restore_jobs WHERE target_name=$1',[this.target])).rowCount===0,'WF_RESTORE_TARGET_CLAIMED');
   need((await c.query('SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$1',[this.target])).rowCount===0,'WF_RESTORE_TARGET_EXISTS');
   const state={format:'idms-workflow-restore-state-v1',phase:'INTENT',credentialSha256:null,role:null,database:null,run:null,proof:null};
   row=(await c.query('INSERT INTO public.workflow_restore_jobs(operation_id,target_name,request_json,request_sha256,state_json,state_sha256) VALUES($1,$2,$3::jsonb,$4,$5::jsonb,$6) RETURNING *',[operationId,this.target,canonical(request),this.requestSha,canonical(state),workflowSha(state)])).rows[0];
  }
  need(row.target_name===this.target&&row.request_sha256===workflowSha(row.request_json)&&row.request_sha256===this.requestSha&&canonical(row.request_json)===canonical(request),'WF_RESTORE_REQUEST_CHANGED');
  need(row.state_sha256===workflowSha(row.state_json)&&row.state_json.format==='idms-workflow-restore-state-v1'&&phases.includes(row.state_json.phase),'WF_RESTORE_STATE_DRIFT');this.state=row.state_json;this.stateSha=row.state_sha256;
 }
 async save(next){await this.lease();need(phases.includes(next.phase),'WF_RESTORE_PHASE');const sha=workflowSha(next);need((await this.client.query('UPDATE public.workflow_restore_jobs SET state_json=$2::jsonb,state_sha256=$3,updated_at=clock_timestamp() WHERE operation_id=$1 AND state_sha256=$4',[this.operationId,canonical(next),sha,this.stateSha])).rowCount===1,'WF_RESTORE_STATE_DRIFT');this.state=next;this.stateSha=sha;}
 async transaction(action){const old=structuredClone(this.state),sha=this.stateSha;await this.client.query('BEGIN');try{await action();await this.client.query('COMMIT');}catch(e){await this.client.query('ROLLBACK').catch(()=>{});this.state=old;this.stateSha=sha;throw e;}}
 async close(){await this.client.query('ROLLBACK').catch(()=>{});await this.client.end().catch(()=>{});}
}
