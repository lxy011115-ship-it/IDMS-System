import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import pg from 'pg';
const exec=promisify(execFile),script=resolve('scripts/core-upgrade-process.ps1');
export async function coreProcess(mode,{planFile,retirementFile,pid,port,pgPort}={}){
 const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Mode',mode];
 if(planFile)args.push('-PlanFile',planFile);if(retirementFile)args.push('-RetirementFile',retirementFile);if(pid)args.push('-ProcessIdToCapture',String(pid));if(port)args.push('-ListenerPort',String(port));if(pgPort)args.push('-DatabasePort',String(pgPort));
 const r=await exec('powershell.exe',args,{windowsHide:true,encoding:'utf8',maxBuffer:2*1024**2});return JSON.parse(r.stdout.replace(/^\uFEFF/,''));
}
export async function coreDatabaseBackends(authority,databases){
 const c=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:'postgres',application_name:'idms-core-ownership',connectionTimeoutMillis:3000});await c.connect();
 try{return(await c.query("SELECT pid,backend_start::text AS started,datname,datid::text AS database_oid,usename,client_addr::text AS address,client_port,application_name,state FROM pg_stat_activity WHERE backend_type='client backend' AND datname=ANY($1::text[]) ORDER BY pid",[databases])).rows;}finally{await c.end();}
}
export async function assertCoreDatabaseOwnership({authority,databases,accounts,processSnapshot,gateSummary=[],requireCoreAbsent=false}){
 const rows=await coreDatabaseBackends(authority,databases),ports=new Set(processSnapshot?.postgresClientPorts||[]),seen=new Set();
 for(const r of rows){
  const gate=gateSummary.find(g=>g.backendPid===r.pid&&g.backendStarted===r.started&&g.databaseOid===r.database_oid&&g.applicationName===r.application_name);
  if(gate){assert.equal(r.usename,'idms_bootstrap');seen.add(gate.backendPid);continue;}
  assert.ok(!requireCoreAbsent,'Unexpected source backend remains after core retirement');assert.ok(accounts.some(a=>a.database===r.datname&&a.user===r.usename),'Unrecognized source database principal');assert.ok(['127.0.0.1/32','::1/128'].includes(r.address)&&ports.has(r.client_port),'Unowned source application/auth backend');
 }
 assert.equal(seen.size,gateSummary.length,'Expected actual maintenance backend missing');
 return {verifiedAt:new Date().toISOString(),sourceBackendCount:rows.length,onlyPinnedCoreAndMaintenanceBackends:true,allMaintenanceBackendIdentitiesPresent:seen.size===gateSummary.length,actualCoreBackendsAbsent:requireCoreAbsent,backendIdentities:rows.map(r=>({pid:r.pid,started:r.started,databaseOid:r.database_oid}))};
}
