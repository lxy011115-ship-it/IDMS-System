import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {createServer} from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
import {coldToolingV1,coldStoppedV1,coldToolEnvV1} from '../pg-cold-image-portable-tools-v1.mjs';
import {canonical} from '../../server/imports.ts';
const exec=promisify(execFile),samePath=(a,b)=>(process.platform==='win32'?resolve(a).toLowerCase():resolve(a))===(process.platform==='win32'?resolve(b).toLowerCase():resolve(b));
/** Generated QA clusters only. No arbitrary existing PGDATA, port or authority input. */
export async function createOwnedPlatformPgQaV1(binDirectory){
 assert(['win32','linux'].includes(process.platform),'PLATFORM_PG_OS');assert(typeof binDirectory==='string'&&binDirectory.length>0,'PLATFORM_PG_BIN_REQUIRED');if(process.platform==='linux')assert.notEqual(process.getuid(),0,'PLATFORM_PG_NONROOT_REQUIRED');
 const nonce=randomBytes(6).toString('hex'),parent=resolve('work/pg-physical-platform-v1-20261022'),work=join(parent,nonce);await privateDirectory(parent);await mkdir(work,{recursive:false,mode:0o700});await privateDirectory(work);
 const source=join(work,'source'),target=join(work,'restored'),bin=await realpath(binDirectory),tooling=await coldToolingV1(bin),suffix=process.platform==='win32'?'.exe':'',password=randomBytes(32).toString('base64url'),user='idms_bootstrap',processes=[],journal=[];
 // Windows assigns outbound connections from 49152..65535 on this host. A
 // port-zero allocation may be stolen by an unrelated outbound socket while
 // the source is offline. Pick and probe a QA port below that dynamic range.
 let port;for(let i=0;i<40&&port===undefined;i++){const candidate=20000+randomBytes(2).readUInt16BE()%10000,socket=createServer();try{await new Promise((ok,fail)=>{socket.once('error',fail);socket.listen({port:candidate,host:'127.0.0.1',exclusive:true},ok);});port=candidate;await new Promise((ok,fail)=>socket.close(e=>e?fail(e):ok()));}catch(e){if(!['EADDRINUSE','EACCES'].includes(e.code))throw e;}}assert(port!==undefined);assert.notEqual(port,45432);
 const authority={host:'127.0.0.1',port,bootstrapPassword:password},account={host:authority.host,port,user,password,database:'postgres'},credentials=join(work,'cluster.private.json');await privateNewFile(credentials,canonical({format:'OWNED_PLATFORM_PG_QA_V1',nonce,work,source,target,bin,authority}));await privateNewFile(join(work,'bootstrap.private.txt'),password);
 let systemIdentifier,sourceControl,active;
 const event=async(type,value={})=>{const e={sequence:journal.length+1,type,at:new Date().toISOString(),...value};await privateNewFile(join(work,'cluster-event-'+String(e.sequence).padStart(4,'0')+'.json'),canonical(e));journal.push(e);};
 const client=async(database='postgres')=>{const c=new pg.Client({...account,database,application_name:'idms-owned-cold-qa',connectionTimeoutMillis:5000});await c.connect();return c;};
 const identity=async()=>{const c=await client();try{return(await c.query("SELECT current_setting('data_directory') AS directory,(pg_control_system()).system_identifier::text AS system_id,pg_postmaster_start_time()::text AS started,(SELECT count(*)::int FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()) AS others")).rows[0];}finally{await c.end();}};
 const ctl=async args=>new Promise((ok,fail)=>{const child=spawn(tooling.paths.pgCtl,args,{env:coldToolEnvV1(),windowsHide:true,stdio:'ignore'});child.once('error',fail);child.once('exit',code=>code===0?ok():fail(Error('OWNED_PG_CTL_FAILED_'+code)));});
 const pidAbsent=pid=>{try{process.kill(pid,0);return false;}catch(e){assert.equal(e.code,'ESRCH');return true;}};
 const start=async directory=>{
  assert(!active);assert([source,target].includes(directory));assert(!relative(work,directory).startsWith('..'));assert.deepEqual((await coldToolingV1(bin)).binding,tooling.binding);
  if(directory===target){assert(sourceControl);assert.equal(canonical(await coldStoppedV1(source,tooling,systemIdentifier)),canonical(sourceControl));for(const p of processes.filter(p=>p.directory===source)){assert(p.stopped);assert(pidAbsent(p.pid));}await coldStoppedV1(target,tooling,systemIdentifier);}
  await event('START_INTENT',{directory,expectedSystemIdentifier:systemIdentifier??null,port,programs:tooling.binding});
  const paths={data_directory:directory,config_file:join(directory,'postgresql.conf'),hba_file:join(directory,'pg_hba.conf'),ident_file:join(directory,'pg_ident.conf')},options=`-h 127.0.0.1 -p ${port} `+Object.entries(paths).map(([k,p])=>`-c ${k}="${p.replaceAll('\\','/')}"`).join(' ');
  try{await ctl(['start','-D',directory,'-l',join(work,directory===source?'source.log':'restored.log'),'-w','-t','30','-o',options]);}catch(e){const pidFile=await lstat(join(directory,'postmaster.pid')).catch(x=>{if(x.code==='ENOENT')return null;throw x;});if(!pidFile&&systemIdentifier){const control=await coldStoppedV1(directory,tooling,systemIdentifier);await event('START_FAILED_OFFLINE',{directory,port,control,noPidFile:true});}else await event('START_FAILED_UNVERIFIED',{directory,port,pidFilePresent:!!pidFile});throw e;}const row=await identity();assert(samePath(row.directory,directory));assert.equal(row.others,0);if(systemIdentifier)assert.equal(row.system_id,systemIdentifier);else systemIdentifier=row.system_id;
  const lines=(await readFile(join(directory,'postmaster.pid'),'utf8')).split(/\r?\n/),pid=Number(lines[0]);assert(pid>0&&samePath(lines[1],directory)&&Number(lines[3])===port);active={directory,pid,started:row.started,systemIdentifier,port,stopped:false};processes.push(active);await event('STARTED',active);return active;
 };
 const stop=async()=>{if(!active)return;const p=active,row=await identity();assert(samePath(row.directory,p.directory));assert.equal(row.system_id,p.systemIdentifier);assert.equal(row.started,p.started);assert.equal(row.others,0,'OWNED_PG_OTHER_CLIENTS_REMAIN');await event('SMART_STOP_INTENT',{...p,otherClientBackends:row.others});await ctl(['stop','-D',p.directory,'-m','smart','-w','-t','30']);const control=await coldStoppedV1(p.directory,tooling,systemIdentifier);await assert.rejects(lstat(join(p.directory,'postmaster.pid')),{code:'ENOENT'});assert(pidAbsent(p.pid));p.stopped=true;if(p.directory===source)sourceControl=control;active=null;await event('STOPPED',{...p,control,pidAbsent:true});};
 try{const init=await exec(join(bin,'initdb'+suffix),['-D',source,'-U',user,'--pwfile='+join(work,'bootstrap.private.txt'),'-A','scram-sha-256','--encoding=UTF8','--locale=C'],{env:coldToolEnvV1(),windowsHide:true,maxBuffer:256*1024});await privateNewFile(join(work,'initdb.private.json'),JSON.stringify(init));await writeFile(join(source,'postgresql.conf'),`listen_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 80\nshared_buffers = '32MB'\nmax_wal_size = '256MB'\nmin_wal_size = '32MB'\npassword_encryption = 'scram-sha-256'\nfsync = on\nfull_page_writes = on\nsynchronous_commit = on\ntimezone = 'UTC'\n`);await start(source);
  return{nonce,work,source,target,bin,tooling,authority,account,client,identity,processes,journal,event,get systemIdentifier(){return systemIdentifier;},get sourceControl(){return sourceControl;},get active(){return active;},stop,startRestored:()=>start(target)};
 }catch(e){await privateNewFile(join(work,'cluster-failure.private.json'),JSON.stringify({message:e.message,stack:e.stack}));if(active)await stop();throw e;}
}
