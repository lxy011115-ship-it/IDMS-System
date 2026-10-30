import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {workflowQuote as q,workflowRequire as need} from './workflow-archive-facts.mjs';
// Runtime lock, not a persistent permission change or an HTTP middleware gate.
// Source workflow NOLOGIN/connlimit-zero is a separate durable fence.
export class WorkflowUpgradeOutboxGate {
 constructor(deployment,bindings,systemIdentifier,operationId=randomUUID()){this.deployment=deployment;this.bindings=bindings;this.systemIdentifier=systemIdentifier;this.applicationName='idms-wf-outbox-'+operationId.replaceAll('-','');this.held=[];this.failed=false;}
 async acquire(){
  need(this.held.length===0,'WF_UPGRADE_GATE_ALREADY_HELD');const d=this.deployment;
  try{for(const tenantId of Object.keys(this.bindings).sort()){
   const a=this.bindings[tenantId],c=new pg.Client({host:d.host,port:d.port,user:'idms_bootstrap',password:d.bootstrapPassword,database:a.database,application_name:this.applicationName,connectionTimeoutMillis:3000,query_timeout:5000});c.on('error',()=>{this.failed=true;});await c.connect();const entry={tenantId,client:c};this.held.push(entry);
   const identity=(await c.query("SELECT current_database() AS database,pg_backend_pid() AS pid,(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_start,(SELECT system_identifier::text FROM pg_control_system()) AS system,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid")).rows[0];need(identity.database===a.database&&identity.system===this.systemIdentifier,'WF_UPGRADE_GATE_BINDING');
   const table=(await c.query("SELECT c.oid::text,pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid='public.workflow_outbox'::regclass")).rows[0];need(table&&table.owner===a.ownerRole,'WF_UPGRADE_GATE_TABLE');
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout=0");need((await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS held',['workflow-upgrade-outbox-v1:'+this.systemIdentifier+':'+identity.database_oid])).rows[0].held,'WF_UPGRADE_GATE_BUSY');await c.query('LOCK TABLE public.workflow_outbox IN SHARE MODE');
   const counts=(await c.query("SELECT count(*)::integer AS total,count(*) FILTER(WHERE status='PENDING')::integer AS pending,count(*) FILTER(WHERE lease_until>clock_timestamp())::integer AS live_leases FROM public.workflow_outbox")).rows[0];need(counts.pending===0&&counts.live_leases===0,'WF_UPGRADE_GATE_NOT_DRAINED');Object.assign(entry,{identity,table,counts});
  }await this.assertHeld();return this.summary();}catch(e){await this.release();throw e;}
 }
 async assertHeld(){
  need(!this.failed&&this.held.length===Object.keys(this.bindings).length,'WF_UPGRADE_GATE_LOST');
  for(const e of this.held){const c=e.client;need(c.getTransactionStatus?.()==='T','WF_UPGRADE_GATE_LOST');need((await c.query("SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND pid=$1 AND locktype='relation' AND relation=$2::oid AND mode='ShareLock' AND granted",[e.identity.pid,e.table.oid])).rowCount===1,'WF_UPGRADE_GATE_LOST');const r=(await c.query("SELECT count(*) FILTER(WHERE status='PENDING')::integer AS pending,count(*) FILTER(WHERE lease_until>clock_timestamp())::integer AS live_leases FROM public.workflow_outbox")).rows[0];need(r.pending===0&&r.live_leases===0,'WF_UPGRADE_GATE_NOT_DRAINED');}
 }
 summary(){return this.held.map(e=>({tenantId:e.tenantId,databaseOid:e.identity.database_oid,gateBackendPid:e.identity.pid,backendStart:e.identity.backend_start,applicationName:this.applicationName,tableOid:e.table.oid,total:e.counts.total,pending:e.counts.pending,liveLeases:e.counts.live_leases,mode:'SHARE_TRANSACTION_LOCK'}));}
 async probe(blocked){const results=[];for(const [tenantId,a]of Object.entries(this.bindings)){
  const c=new pg.Client({host:this.deployment.host,port:this.deployment.port,user:a.user,password:a.password,database:a.database,application_name:'idms-workflow-upgrade-gate-probe',connectionTimeoutMillis:3000,statement_timeout:2000});await c.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='200ms'");let error;try{await c.query('LOCK TABLE public.workflow_outbox IN ROW EXCLUSIVE MODE');}catch(e){error=e;}need(blocked?error?.code==='55P03':!error,'WF_UPGRADE_GATE_PROBE');await c.query('ROLLBACK');need((await c.query('SELECT count(*)::integer AS total FROM public.workflow_outbox')).rows[0].total>=0,'WF_UPGRADE_GATE_READ');results.push({tenantId,actualApplicationLogin:true,rowExclusiveDmlLockBlocked:blocked,readStillAllowed:true,noDataWritten:true});}finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}}
  return results;
 }
 async release(){const held=this.held;this.held=[];for(const e of held){await e.client.query('ROLLBACK').catch(()=>{});await e.client.end().catch(()=>{});}}
}
