import assert from 'node:assert/strict';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import pg from 'pg';
import {FieldRecoveryFiles} from '../field-recovery-files.mjs';
import {archiveTool} from '../field-archive-record.mjs';
import {canonical} from '../../server/imports.ts';
import {closeSourceConnection} from '../field-source-freeze.mjs';
const mode=process.env.IDMS_FIELD_ARCHIVE_EXPORT_MODE,arg=n=>process.argv[process.argv.indexOf(n)+1];
if(!process.send||process.env.NODE_ENV!=='test'||!['DIRECT_COPY_OUT','SUPERVISED_COPY_OUT','OBSERVE_RETRY'].includes(mode)||!/^fieldarchiveqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned export probe required');
const directory=await realpath(process.env.IDMS_FIELD_ARCHIVE_EXPORT_DIRECTORY),base=await realpath(resolve('work/field-channel-20261017')),rel=relative(base,directory),runtime=JSON.parse(await readFile(arg('--runtime-config'))),backup=JSON.parse(await readFile(arg('--backup-config'))),database=runtime.tenants.acme.database,operation=arg('--operation-id');
if(isAbsolute(rel)||rel.startsWith('..')||!/^formal-archive-[a-f0-9]{10}$/.test(basename(directory))||!/^idms_fieldarchiveqa_acme_[a-f0-9]{10}$/.test(database)||resolve(arg('--control-file'))!==resolve(directory,'recovery.json')||arg('--action')!=='archive')throw Error('Owned export paths required');
const connect=pg.Client.prototype.connect,query=pg.Client.prototype.query,spawn=cp.spawn,exec=promisify(cp.execFile);let tool,proxyPort,injected=false,completed=false;
process.env.PGSERVICE='owned_missing_archive_service';process.env.PGSERVICEFILE=resolve(directory,'owned-missing-service.conf');
pg.Client.prototype.connect=async function(...args){const value=await connect.apply(this,args),row=(await query.call(this,'SELECT pid,backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];process.send?.({type:'BACKEND',...row});return value;};
async function requestProxy(){return new Promise((ok,no)=>{const timer=setTimeout(()=>{process.off('message',answer);no(Error('Owned export supervisor did not answer'));},15000),answer=m=>{if(m.type!=='EXPORT_PROXY_READY')return;clearTimeout(timer);process.off('message',answer);if(!Number.isInteger(m.port)||m.port<1||m.port>65535){no(Error('Invalid owned export proxy port'));return;}ok(m.port);};process.on('message',answer);process.send({type:'EXPORT_PROXY_REQUEST',mode,tool,host:runtime.host,port:runtime.port,database,user:backup.tenants.acme.user});});}
const record=FieldRecoveryFiles.prototype.recordArchiveTool;
FieldRecoveryFiles.prototype.recordArchiveTool=async function(raw){
 if(mode==='OBSERVE_RETRY'&&!injected){
  injected=true;const oldFile=resolve(process.env.IDMS_FIELD_ARCHIVE_OLD_TOOL_FILE),old=archiveTool(JSON.parse(await readFile(oldFile))),expected=resolve(directory,'recovery.json.operations',operation+'.archive-tool-'+old.runId+'.json');assert.equal(oldFile,expected);assert.equal(old.operationId,operation);assert.equal(old.dumpFile,resolve(directory,'recovery.json.operations',operation+'.archive-dump-'+old.runId+'.tmp'));
  await assert.rejects(lstat(old.dumpFile),e=>e.code==='ENOENT');const state=(await exec(resolve(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('scripts/fixtures/field-owned-process-state.ps1'),'-ProcessId',process.env.IDMS_FIELD_ARCHIVE_OLD_PID,'-StartTicks',process.env.IDMS_FIELD_ARCHIVE_OLD_TICKS],{windowsHide:true,maxBuffer:8192})).stdout.trim();assert.equal(state,'TERMINAL');
  const authority=JSON.parse(await readFile(arg('--authority-config'))),db=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:'postgres'});try{await db.connect();assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND application_name=$2',[database,old.applicationName])).rows[0].n,0);}finally{await closeSourceConnection(db);}
  process.send?.({type:'EXPORT_RETRY_OBSERVED',oldNativeActuallyTerminalBeforeNewTool:true,oldSourceDumpBackendActuallyAbsent:true,oldPartialDumpActuallyRemovedBeforeNewTool:true});
 }
 const value=await record.call(this,raw);if(mode!=='OBSERVE_RETRY'&&!injected){injected=true;tool=archiveTool(raw);proxyPort=await requestProxy();}return value;
};
cp.spawn=function(program,args,options){
 if(tool&&program===tool.program&&canonical(args)===canonical(tool.args)){
  for(const [key,value]of Object.entries({PGDATABASE:database,PGUSER:backup.tenants.acme.user,PGAPPNAME:tool.applicationName}))assert.ok(options.env[key]===value,'Owned export environment binding changed: '+key);
  assert.equal(options.env.PGSERVICE,undefined);assert.equal(options.env.PGSERVICEFILE,undefined);const env={...options.env,PGHOST:'127.0.0.1',PGPORT:String(proxyPort),PGSSLMODE:'disable',PGGSSENCMODE:'disable'};
  if(mode==='SUPERVISED_COPY_OUT'){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{process.send?.({type:'STOP_SUPERVISED_EXPORT',runId:tool.runId});return true;};const answer=m=>{if(m.runId!==tool.runId)return;if(m.type==='SUPERVISED_EXPORT_LAUNCHED')child.pid=m.pid;if(m.type==='SUPERVISED_EXPORT_CLOSE'){process.off('message',answer);child.stdout.end();child.stderr.end();child.emit('close',m.code,m.signal);}};process.on('message',answer);process.send({type:'LAUNCH_SUPERVISED_EXPORT',program,args,env,runId:tool.runId});return child;}
  const child=spawn(program,args,{...options,env});process.send?.({type:'EXPORT_NATIVE_PROCESS',pid:child.pid,runId:tool.runId});child.once('close',(code,signal)=>process.send?.({type:'EXPORT_NATIVE_CLOSE',pid:child.pid,runId:tool.runId,code,signal}));return child;
 }
 return spawn(program,args,options);
};syncBuiltinESMExports();
process.on('disconnect',()=>{if(!completed)process.exit(3);});await import('../field-recovery.mjs');completed=true;process.disconnect?.();
