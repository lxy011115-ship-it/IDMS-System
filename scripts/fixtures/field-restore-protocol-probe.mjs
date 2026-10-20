import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import pg from 'pg';
import {FieldRecoveryFiles} from '../field-recovery-files.mjs';
import {fieldRestoreTool} from '../field-restore-flow-record.mjs';
import {canonical} from '../../server/imports.ts';
import {quoteIdentifier as q} from '../../server/postgres-schema.ts';
import {closeSourceConnection} from '../field-source-freeze.mjs';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
const mode=process.env.IDMS_FIELD_RESTORE_PROTOCOL_MODE,arg=n=>process.argv[process.argv.indexOf(n)+1];
if(!process.send||process.env.NODE_ENV!=='test'||!['COPY_HOLD_CONTROLLER_KILL','COPY_HOLD_ORPHAN_CONTROLLER_KILL','COMMIT_DROP_DATA','COMMIT_DROP_VERIFIED','OBSERVE_ROLLBACK'].includes(mode)||!/^fieldarchiveqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned protocol probe required');
const directory=await realpath(process.env.IDMS_FIELD_RESTORE_QA_DIRECTORY),base=await realpath(resolve('work/field-channel-20261017')),rel=relative(base,directory),target=JSON.parse(await readFile(arg('--target-runtime-config'))),database=target.tenants.acme.database;
if(isAbsolute(rel)||rel.startsWith('..')||!/^formal-archive-[a-f0-9]{10}$/.test(basename(directory))||!/^idms_fieldarchivetarget_[a-f0-9]{10}$/.test(database)||resolve(arg('--control-file'))!==resolve(directory,'recovery.json')||arg('--action')!=='restore-target')throw Error('Owned protocol paths required');
let injected=false,completed=false,tool,proxyPort;const connect=pg.Client.prototype.connect,query=pg.Client.prototype.query,spawn=childProcess.spawn;
async function requestProxy(applicationName,user,kind){return new Promise((ok,no)=>{const timer=setTimeout(()=>{process.off('message',reply);no(Error('Owned protocol supervisor did not answer'));},15000),reply=m=>{if(m.type!=='RESTORE_PROXY_READY')return;clearTimeout(timer);process.off('message',reply);if(!Number.isInteger(m.port)||m.port<1||m.port>65535){no(Error('Invalid owned proxy port'));return;}ok(m.port);};process.on('message',reply);process.send({type:'RESTORE_PROXY_REQUEST',mode,host:target.host,port:target.port,database,user,applicationName,kind,...(tool?{tool}: {})});});}
pg.Client.prototype.connect=async function(...args){
 if(mode==='COMMIT_DROP_VERIFIED'&&!injected&&this.database===database&&this.connectionParameters.application_name==='idms-restore-control-'+arg('--operation-id')){injected=true;const port=await requestProxy(this.connectionParameters.application_name,'idms_bootstrap','CONTROL'),native=this.connection.connect;this.connection.connect=function(){return native.call(this,port,'127.0.0.1');};}
 const value=await connect.apply(this,args),row=(await query.call(this,'SELECT pid,backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];process.send?.({type:'BACKEND',...row});return value;
};
const record=FieldRecoveryFiles.prototype.recordRestoreTool;
FieldRecoveryFiles.prototype.recordRestoreTool=async function(raw){
 const value=await record.call(this,raw);
 if(!injected&&raw.kind==='APPLY'&&raw.section==='data'){
  if(['COPY_HOLD_CONTROLLER_KILL','COPY_HOLD_ORPHAN_CONTROLLER_KILL','COMMIT_DROP_DATA'].includes(mode)){injected=true;tool=fieldRestoreTool(raw);proxyPort=await requestProxy(tool.applicationName,database+'_migrator','PSQL');}
  if(mode==='OBSERVE_ROLLBACK'){
   injected=true;const authority=JSON.parse(await readFile(arg('--authority-config'))),db=new pg.Client({host:target.host,port:target.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database});
   try{await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const tables=(await db.query("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','idms_field') AND c.relkind='r'")).rows;assert.equal(tables.length,34);for(const r of tables)assert.equal((await db.query('SELECT count(*)::text AS n FROM '+q(r.nspname)+'.'+q(r.relname))).rows[0].n,'0');assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND application_name=$2',[database,process.env.IDMS_FIELD_RESTORE_OLD_APPLY_NAME])).rows[0].n,0);await db.query('ROLLBACK');process.send?.({type:'ROLLBACK_OBSERVED',all34PhysicalTablesEmptyBeforeReapply:true,oldCopyBackendActuallyAbsentBeforeReapply:true});}finally{await closeSourceConnection(db);}
  }
 }
 return value;
};
childProcess.spawn=function(program,args,options){
 if(mode==='COPY_HOLD_ORPHAN_CONTROLLER_KILL'&&tool&&program===tool.program&&canonical(args)===canonical(tool.args)){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{process.send?.({type:'STOP_SUPERVISED_NATIVE',toolId:tool.toolId});return true;};
  const receive=m=>{if(m.toolId!==tool.toolId)return;if(m.type==='SUPERVISED_NATIVE_LAUNCHED')child.pid=m.pid;if(m.type==='SUPERVISED_NATIVE_CLOSE'){process.off('message',receive);child.stdout.end();child.stderr.end();child.emit('close',m.code,m.signal);}};process.on('message',receive);
  process.send({type:'LAUNCH_SUPERVISED_NATIVE',program,args,env:{...options.env,PGHOST:'127.0.0.1',PGPORT:String(proxyPort),PGSSLMODE:'disable',PGGSSENCMODE:'disable'},toolId:tool.toolId});return child;
 }
 if(tool&&program===tool.program&&canonical(args)===canonical(tool.args)){if(options.env.PGDATABASE!==database||options.env.PGUSER!==database+'_migrator'||options.env.PGAPPNAME!==tool.applicationName)throw Error('Owned native target binding changed');const child=spawn(program,args,{...options,env:{...options.env,PGHOST:'127.0.0.1',PGPORT:String(proxyPort),PGSSLMODE:'disable',PGGSSENCMODE:'disable'}});process.send?.({type:'NATIVE_PROCESS',pid:child.pid,toolId:tool.toolId});child.once('close',(code,signal)=>process.send?.({type:'NATIVE_CLOSE',pid:child.pid,toolId:tool.toolId,code,signal}));return child;}
 return spawn(program,args,options);
};syncBuiltinESMExports();
process.on('disconnect',()=>{if(!completed)process.exit(3);});await import('../field-recovery.mjs');completed=true;process.disconnect?.();
