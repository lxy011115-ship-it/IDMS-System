import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import pg from 'pg';
import {canonical} from '../server/imports.ts';
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const quote=v=>'"'+v.replaceAll('"','""')+'"';
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const authorityPattern=/^idms_workflowcontrol_[a-f0-9]{12}$/;
const connection=(a,database)=>({host:a.host,port:a.port,user:'idms_bootstrap',password:a.bootstrapPassword,database,application_name:'idms-workflow-freeze-controller',connectionTimeoutMillis:3000,statement_timeout:15000,query_timeout:18000});
export async function createWorkflowFreezeAuthority(authority,controlDatabase){
 need(authorityPattern.test(controlDatabase),'WF_FENCE_AUTHORITY_NAME');const owner=controlDatabase+'_owner';
 const c=new pg.Client(connection(authority,'postgres'));await c.connect();let role=false,database=false;
 try{
  need((await c.query('SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$2',[controlDatabase,owner])).rowCount===0,'WF_FENCE_AUTHORITY_EXISTS');
  const systemIdentifier=(await c.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0].system_identifier;
  await c.query('CREATE ROLE '+quote(owner)+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT');role=true;
  await c.query('CREATE DATABASE '+quote(controlDatabase)+' OWNER '+quote(owner)+' TEMPLATE template0');database=true;
  await c.query('REVOKE ALL ON DATABASE '+quote(controlDatabase)+' FROM PUBLIC');
  const db=new pg.Client(connection(authority,controlDatabase));await db.connect();
  try{await db.query('BEGIN');await db.query('SET LOCAL ROLE '+quote(owner));await db.query(`CREATE TABLE workflow_freeze_operations (
    operation_id uuid PRIMARY KEY, database_oid oid NOT NULL, source_binding jsonb NOT NULL, baseline jsonb NOT NULL, baseline_sha256 text NOT NULL,
    phase text NOT NULL CHECK(phase IN ('PREPARED','FENCED','DRAINED','RELEASED')), drained_count integer NOT NULL DEFAULT 0,
    prepared_at timestamptz NOT NULL DEFAULT now(), fenced_at timestamptz, drained_at timestamptz, released_at timestamptz);
    CREATE UNIQUE INDEX one_active_workflow_freeze ON workflow_freeze_operations(database_oid) WHERE phase<>'RELEASED';
    REVOKE ALL ON workflow_freeze_operations FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC`);await db.query('COMMIT');}finally{await db.end();}
  return {...authority,controlDatabase,systemIdentifier};
 }catch(e){if(database)await c.query('DROP DATABASE '+quote(controlDatabase)+' WITH (FORCE)');if(role)await c.query('DROP ROLE '+quote(owner));throw e;}finally{await c.end();}
}
function validateConfig(config,operationId){
 need(config?.format==='idms-workflow-freeze-config-v1'&&uuid(operationId),'WF_FENCE_CONFIG');
 const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
 need(exact(config,['format','authority','source'])&&exact(config.authority,['host','port','bootstrapPassword','controlDatabase','systemIdentifier'])&&exact(config.source,['scope','tenantId','database','user']),'WF_FENCE_CONFIG');
 const {authority:a,source:s}=config;need(a&&s&&authorityPattern.test(a.controlDatabase)&&/^[0-9]{10,25}$/.test(a.systemIdentifier)&&a.host==='127.0.0.1'&&Number.isSafeInteger(a.port)&&a.port>0&&a.port<65536&&typeof a.bootstrapPassword==='string'&&a.bootstrapPassword.length>=32,'WF_FENCE_CONFIG');
 need(['acme','sandbox'].includes(s.tenantId)&&s.database===s.user&&s.database!==a.controlDatabase,'WF_FENCE_SOURCE');
 need(s.scope==='QA'&&new RegExp('^idms_workflowupgradeqa_'+s.tenantId+'_[a-f0-9]{10}$').test(s.database)||s.scope==='ORIGINAL_WORKFLOW'&&s.database==='idms_'+s.tenantId+'_workflow','WF_FENCE_SOURCE');
}
async function frame(c,source){
 const db=(await c.query('SELECT oid::text,datname,datdba::text,datallowconn,datistemplate,datconnlimit,datacl::text FROM pg_database WHERE datname=$1',[source.database])).rows[0];
 const role=(await c.query("SELECT oid::text,rolname,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,encode(sha256(convert_to(COALESCE(rolpassword,''),'UTF8')),'hex') AS password_verifier_digest FROM pg_authid WHERE rolname=$1",[source.user])).rows[0];
 need(db&&role&&db.datdba===role.oid&&db.datallowconn&&!db.datistemplate,'WF_FENCE_SOURCE_BINDING');
 need(!role.rolsuper&&!role.rolinherit&&!role.rolcreatedb&&!role.rolcreaterole&&!role.rolreplication&&!role.rolbypassrls,'WF_FENCE_SOURCE_ROLE');
 const membership=(await c.query('SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members WHERE roleid=$1::oid OR member=$1::oid ORDER BY roleid,member',[role.oid])).rows;need(membership.length===0,'WF_FENCE_SOURCE_MEMBERSHIP');
 need((await c.query('SELECT oid FROM pg_database WHERE datdba=$1::oid',[role.oid])).rowCount===1,'WF_FENCE_SHARED_OWNER');
 need((await c.query('SELECT 1 FROM pg_prepared_xacts WHERE database=$1',[source.database])).rowCount===0,'WF_FENCE_PREPARED_TRANSACTION');
 need((await c.query('SELECT 1 FROM pg_subscription WHERE subdbid=$1::oid',[db.oid])).rowCount===0,'WF_FENCE_SUBSCRIPTION');
 await c.query('SELECT pg_stat_clear_snapshot()');
 need((await c.query('SELECT 1 FROM pg_stat_activity WHERE usesysid=$1::oid AND datid IS DISTINCT FROM $2::oid',[role.oid,db.oid])).rowCount===0,'WF_FENCE_ROLE_OTHER_DATABASE');
 return {database:db,role,membership};
}
function expectedFrame(op,frozen){const value=structuredClone(op.baseline);if(frozen){value.database.datconnlimit=0;value.role.rolcanlogin=false;}return value;}
function validOperation(op,config){
 need(op&&op.source_binding&&canonical(op.source_binding)===canonical(config.source)&&op.baseline_sha256===digest(op.baseline)&&op.database_oid===Number(op.baseline.database.oid),'WF_FENCE_OPERATION_BINDING');
 need(op.baseline.role.rolname===config.source.user&&op.baseline.database.datname===config.source.database&&op.baseline.role.rolcanlogin&&op.baseline.database.datconnlimit!==0,'WF_FENCE_OPERATION_BASELINE');
}
/** Holds a session advisory lock across the callback; persistent phases survive controller death. */
export async function withWorkflowFreeze(config,operationId,task,{onPhase=async()=>{}}={}){
 validateConfig(config,operationId);const {authority:a,source:s}=config,c=new pg.Client(connection(a,a.controlDatabase));let lost=false;
 c.on('error',()=>{lost=true;});await c.connect();
 try{
  const identity=(await c.query('SELECT current_database() AS database,pg_is_in_recovery() AS recovery,(SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS pid,(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_start')).rows[0];
  need(identity.database===a.controlDatabase&&identity.system===a.systemIdentifier&&!identity.recovery,'WF_FENCE_AUTHORITY_BINDING');
  const controlOwner=(await c.query('SELECT r.oid::text,r.rolname,r.rolcanlogin,r.rolsuper,r.rolinherit,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database()')).rows[0];
  need(controlOwner.rolname===a.controlDatabase+'_owner'&&['rolcanlogin','rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].every(key=>controlOwner[key]===false),'WF_FENCE_AUTHORITY_OWNER');
  need((await c.query('SELECT 1 FROM pg_auth_members WHERE roleid=$1::oid OR member=$1::oid',[controlOwner.oid])).rowCount===0,'WF_FENCE_AUTHORITY_MEMBERSHIP');
  const controlAcl=(await c.query("SELECT a.grantee::text,a.privilege_type FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() ORDER BY a.privilege_type")).rows;
  need(controlAcl.length===3&&controlAcl.every(row=>row.grantee===controlOwner.oid)&&canonical(controlAcl.map(row=>row.privilege_type))===canonical(['CONNECT','CREATE','TEMPORARY']),'WF_FENCE_AUTHORITY_PRIVILEGES');
  const current=await frame(c,s);const locked=(await c.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held",['workflow-freeze-v1:'+a.systemIdentifier+':'+current.database.oid])).rows[0].held;
  need(locked,'WF_FENCE_BUSY');
  const notify=async phase=>{need(!lost,'WF_FENCE_CONNECTION_LOST');await onPhase(phase,{pid:identity.pid,backendStart:identity.backend_start,operationId});need(!lost,'WF_FENCE_CONNECTION_LOST');};
  const sessions=async op=>{await c.query('SELECT pg_stat_clear_snapshot()');return (await c.query('SELECT pid,backend_start::text,usesysid::text,datid::text FROM pg_stat_activity WHERE datid=$1::oid ORDER BY pid',[op.baseline.database.oid])).rows;};
  const operation=async(lock=false)=>{const row=(await c.query('SELECT * FROM workflow_freeze_operations WHERE operation_id=$1'+(lock?' FOR UPDATE':''),[operationId])).rows[0];need(row,'WF_FENCE_NOT_PREPARED');validOperation(row,config);return row;};
  const verify=async(op,frozen)=>need(canonical(await frame(c,s))===canonical(expectedFrame(op,frozen)),'WF_FENCE_CATALOG_DRIFT');
  const requireNoSessions=(all,stage)=>{if(all.length)throw Object.assign(Error('WF_FENCE_OTHER_SESSION '+stage+' '+JSON.stringify(all)),{code:'WF_FENCE_OTHER_SESSION'});};
  const noUnknown=async op=>{const all=await sessions(op);if(!all.every(r=>r.usesysid===op.baseline.role.oid))throw Object.assign(Error('WF_FENCE_OTHER_SESSION unknown '+JSON.stringify(all)),{code:'WF_FENCE_OTHER_SESSION'});return all;};
  const result=op=>({format:'idms-workflow-freeze-result-v1',operationId,phase:op.phase,databaseOid:String(op.database_oid),sourceRoleOid:op.baseline.role.oid,
    persistentAppLoginDisabled:['FENCED','DRAINED'].includes(op.phase),persistentDatabaseConnectionLimitZero:['FENCED','DRAINED'].includes(op.phase),
    recordedOldBackendDrainCount:op.drained_count,drainedAt:op.drained_at?.toISOString()??null,baselineSha256:op.baseline_sha256,
    privilegedAdministratorOutsideApplicationFenceTrust:true,productionAcceptance:false});
  const api={
   async prepare(){
    await c.query('BEGIN');let op;
    try{
     const existing=(await c.query('SELECT * FROM workflow_freeze_operations WHERE operation_id=$1 FOR UPDATE',[operationId])).rows[0];
     if(existing){validOperation(existing,config);await verify(existing,['FENCED','DRAINED'].includes(existing.phase));if(existing.phase==='DRAINED')need((await sessions(existing)).length===0,'WF_FENCE_OTHER_SESSION');op=existing;}
     else{const baseline=await frame(c,s);need(baseline.role.rolcanlogin&&baseline.database.datconnlimit!==0,'WF_FENCE_UNOWNED_FROZEN_STATE');
      const owned=(await c.query("SELECT 1 FROM workflow_freeze_operations WHERE database_oid=$1::oid AND phase<>'RELEASED'",[baseline.database.oid])).rowCount;need(!owned,'WF_FENCE_OTHER_OPERATION');
      const proposed={baseline};await noUnknown(proposed);
      op=(await c.query("INSERT INTO workflow_freeze_operations(operation_id,database_oid,source_binding,baseline,baseline_sha256,phase) VALUES($1,$2::oid,$3::jsonb,$4::jsonb,$5,'PREPARED') RETURNING *",[operationId,baseline.database.oid,JSON.stringify(s),JSON.stringify(baseline),digest(baseline)])).rows[0];}
     await notify('PREPARE_BEFORE_COMMIT');await c.query('COMMIT');await notify('PREPARED');return result(op);
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
   },
   async freeze(){
    await c.query('BEGIN');let op;
    try{
     op=await operation(true);need(op.phase!=='RELEASED','WF_FENCE_ALREADY_RELEASED');
     if(op.phase==='DRAINED'){await verify(op,true);need((await sessions(op)).length===0,'WF_FENCE_OTHER_SESSION');await c.query('COMMIT');return result(op);}
     if(op.phase==='PREPARED'){
      await verify(op,false);await noUnknown(op);
      await c.query('ALTER ROLE '+quote(s.user)+' NOLOGIN');await c.query('ALTER DATABASE '+quote(s.database)+' CONNECTION LIMIT 0');
      op=(await c.query("UPDATE workflow_freeze_operations SET phase='FENCED',fenced_at=clock_timestamp() WHERE operation_id=$1 RETURNING *",[operationId])).rows[0];
     }else await verify(op,true);
     await notify('FENCE_BEFORE_COMMIT');await c.query('COMMIT');await notify('FENCED');
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
    const end=performance.now()+15000;let count=0;
    for(;;){await verify(op,true);const all=await noUnknown(op);if(!all.length)break;
     need(performance.now()<end,'WF_FENCE_DRAIN_TIMEOUT');
     for(const row of all){await notify('DRAIN_BEFORE_TERMINATE');
      await c.query('SELECT pg_stat_clear_snapshot()');await c.query('SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND datid=$3::oid AND usesysid=$4::oid',[row.pid,row.backend_start,row.datid,row.usesysid]);
      for(;;){await c.query('SELECT pg_stat_clear_snapshot()');if(!(await c.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz',[row.pid,row.backend_start])).rowCount)break;need(performance.now()<end,'WF_FENCE_BACKEND_TERMINAL_UNCONFIRMED');await new Promise(ok=>setTimeout(ok,25));}
      count++;
     }
    }
    await c.query('BEGIN');
    try{op=await operation(true);await verify(op,true);requireNoSessions(await sessions(op),'drain-confirm');
     op=(await c.query("UPDATE workflow_freeze_operations SET phase='DRAINED',drained_count=drained_count+$2,drained_at=clock_timestamp() WHERE operation_id=$1 RETURNING *",[operationId,count])).rows[0];
     await notify('DRAIN_BEFORE_COMMIT');await c.query('COMMIT');await notify('DRAINED');await verify(op,true);requireNoSessions(await sessions(op),'after-drain-commit');return result(op);
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
   },
   async status(){const op=await operation();await verify(op,['FENCED','DRAINED'].includes(op.phase));if(op.phase==='DRAINED')need((await sessions(op)).length===0,'WF_FENCE_OTHER_SESSION');return result(op);},
   async release(){
    await c.query('BEGIN');try{let op=await operation(true);const frozen=['FENCED','DRAINED'].includes(op.phase);await verify(op,frozen);
     if(op.phase!=='RELEASED'){
      need((await sessions(op)).length===0,'WF_FENCE_OTHER_SESSION');
      if(frozen){await c.query('ALTER ROLE '+quote(s.user)+(op.baseline.role.rolcanlogin?' LOGIN':' NOLOGIN'));await c.query('ALTER DATABASE '+quote(s.database)+' CONNECTION LIMIT '+op.baseline.database.datconnlimit);}
      op=(await c.query("UPDATE workflow_freeze_operations SET phase='RELEASED',released_at=clock_timestamp() WHERE operation_id=$1 RETURNING *",[operationId])).rows[0];await verify(op,false);
     }
     await notify('RELEASE_BEFORE_COMMIT');await c.query('COMMIT');await notify('RELEASED');return result(op);
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
   }
  };
  return await task(api);
 }finally{await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});}
}
export async function runWorkflowFreeze(config,operationId,action,options){need(['prepare','freeze','status','release'].includes(action),'WF_FENCE_ACTION');return withWorkflowFreeze(config,operationId,api=>api[action](),options);}
