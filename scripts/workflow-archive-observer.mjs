import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {workflowRequire as need,workflowSha} from './workflow-archive-facts.mjs';
// The unchanged public fence status is checked before/after owned readers.
// This adapter accounts for only the private archive's own read-only sessions.
export class WorkflowArchiveObserver {
 constructor(config,operationId,fence,lease){this.config=config;this.operationId=operationId;this.fence=fence;this.lease=lease;this.readers=new Map();this.dump=null;this.lost=false;const a=config.authority;this.client=new pg.Client({host:a.host,port:a.port,user:'idms_bootstrap',password:a.bootstrapPassword,database:a.controlDatabase,application_name:'idms-wf-archive-observer',connectionTimeoutMillis:3000,query_timeout:15000});this.client.on('error',()=>{this.lost=true;});}
 async connect(){await this.client.connect();const r=(await this.client.query('SELECT usesysid::text FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];this.operatorOid=r.usesysid;await this.check();}
 async sourceSessions(){await this.client.query('SELECT pg_stat_clear_snapshot()');return (await this.client.query(`SELECT pid,to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,usesysid::text,datid::text,application_name FROM pg_stat_activity WHERE datid=$1::oid ORDER BY pid`,[this.fence.databaseOid])).rows;}
 addReader(row){need(Number.isSafeInteger(row.pid)&&row.usesysid===this.operatorOid&&row.datid===this.fence.databaseOid,'WF_ARCHIVE_READER_BINDING');this.readers.set(row.pid,{...row});}
 expectDump(applicationName){need(!this.dump&&/^wfarc-d-[a-f0-9]{32}$/.test(applicationName),'WF_ARCHIVE_DUMP_BINDING');this.dump={applicationName,seen:null};}
 async check(){
  need(!this.lost,'WF_ARCHIVE_OBSERVER_LOST');const a=this.config.authority,s=this.config.source,c=this.client;
  await c.query('SELECT pg_stat_clear_snapshot()');const lease=(await c.query(`WITH key AS (SELECT hashtextextended($1,0) AS value) SELECT l.pid,p.backend_start::text FROM pg_locks l JOIN pg_stat_activity p ON p.pid=l.pid CROSS JOIN key
   WHERE l.locktype='advisory' AND l.mode='ExclusiveLock' AND l.granted AND l.objsubid=1 AND l.classid=((key.value>>32)&4294967295)::oid AND l.objid=(key.value&4294967295)::oid`,['workflow-freeze-v1:'+a.systemIdentifier+':'+this.fence.databaseOid])).rows;
  need(lease.length===1&&lease[0].pid===this.lease.pid&&lease[0].backend_start===this.lease.backendStart,'WF_ARCHIVE_LEASE_LOST');
  const system=(await c.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0].system_identifier;need(system===a.systemIdentifier,'WF_ARCHIVE_AUTHORITY');
  const op=(await c.query('SELECT source_binding,baseline,baseline_sha256,phase,database_oid::text,drained_at FROM workflow_freeze_operations WHERE operation_id=$1',[this.operationId])).rows[0];
  need(op&&op.phase==='DRAINED'&&canonical(op.source_binding)===canonical(s)&&op.baseline_sha256===this.fence.baselineSha256&&workflowSha(op.baseline)===op.baseline_sha256&&op.database_oid===this.fence.databaseOid&&op.drained_at.toISOString()===this.fence.drainedAt,'WF_ARCHIVE_FENCE_DRIFT');
  const attrs=(await c.query('SELECT d.oid::text AS database_oid,r.oid::text AS role_oid,d.datconnlimit,d.datallowconn,r.rolcanlogin,r.rolsuper FROM pg_database d JOIN pg_roles r ON d.datdba=r.oid WHERE d.datname=$1 AND r.rolname=$2',[s.database,s.user])).rows[0];
  need(attrs&&attrs.database_oid===this.fence.databaseOid&&attrs.role_oid===this.fence.sourceRoleOid&&attrs.datconnlimit===0&&attrs.datallowconn&&!attrs.rolcanlogin&&!attrs.rolsuper,'WF_ARCHIVE_FENCE_DRIFT');
  const sessions=await this.sourceSessions();
  for(const row of sessions){const reader=this.readers.get(row.pid);if(reader){need(canonical(row)===canonical(reader),'WF_ARCHIVE_READER_DRIFT');continue;}
   need(this.dump&&row.application_name===this.dump.applicationName&&row.usesysid===this.operatorOid,'WF_ARCHIVE_UNKNOWN_SESSION');
   if(this.dump.seen)need(canonical(this.dump.seen)===canonical(row),'WF_ARCHIVE_DUMP_SESSION_DRIFT');else this.dump.seen={...row};
  }
  need(sessions.filter(r=>this.dump&&r.application_name===this.dump.applicationName).length<=1,'WF_ARCHIVE_DUMP_SESSION_DRIFT');return op;
 }
 async waitAbsent(applicationName){const end=performance.now()+15000;for(;;){need(!this.lost,'WF_ARCHIVE_OBSERVER_LOST');const rows=(await this.sourceSessions()).filter(r=>r.application_name===applicationName);if(!rows.length)return;need(performance.now()<end,'WF_ARCHIVE_NATIVE_BACKEND_NOT_TERMINAL');await new Promise(ok=>setTimeout(ok,25));}}
 async close(){await this.client.end().catch(()=>{});}
}
