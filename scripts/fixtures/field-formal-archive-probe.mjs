import {readFile,realpath} from 'node:fs/promises';
import {readFileSync,writeFileSync} from 'node:fs';
import cp from 'node:child_process';
import {promisify} from 'node:util';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import pg from 'pg';
const modes={recordArchiveIntent:'AFTER_INTENT',recordArchiveTool:'AFTER_TOOL',recordArchiveReady:'AFTER_READY',publishArchive:'AFTER_PUBLICATION',recordArchiveResult:'AFTER_RESULT'},mode=process.env.IDMS_FIELD_ARCHIVE_QA_MODE;
if(!process.send||process.env.NODE_ENV!=='test'||!/^fieldarchiveqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||'')||![...Object.values(modes),'BEFORE_NATIVE_MOVE','AFTER_NATIVE_MOVE','OBSERVE','LEGACY_V2'].includes(mode))throw Error('Owned archive fault environment required');
const arg=n=>process.argv[process.argv.indexOf(n)+1],directory=await realpath(process.env.IDMS_FIELD_ARCHIVE_QA_DIRECTORY),rel=relative(await realpath(resolve('work/field-channel-20261017')),directory),runtime=JSON.parse(await readFile(arg('--runtime-config')));
if(isAbsolute(rel)||rel.startsWith('..')||!/^formal-archive-[a-f0-9]{10}$/.test(basename(directory))||!/^idms_fieldarchiveqa_acme_[a-f0-9]{10}$/.test(runtime.tenants.acme.database)||resolve(arg('--control-file'))!==resolve(directory,'recovery.json'))throw Error('Owned archive fault paths required');
const nativeExec=cp.execFile,nativeListen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){if(args[0]?.path?.includes('idms-field-recovery-commit-'))this.once('error',()=>process.send?.({type:'WAITING_NATIVE_GATE'}));return nativeListen.apply(this,args);};
let nativeHit=false;
function wrapped(file,args,options,callback){
 if(!nativeHit&&['BEFORE_NATIVE_MOVE','AFTER_NATIVE_MOVE'].includes(mode)&&Array.isArray(args)&&args[args.indexOf('-Mode')+1]==='Archive'){
  nativeHit=true;
  const id=randomUUID(),helper=resolve(directory,'helper-'+id+'.ps1'),hold=resolve(directory,'helper-'+id+'.hold'),signal=resolve(directory,'helper-'+id+'.signal'),literal=s=>"'"+s.replaceAll("'","''")+"'",marker=mode==='BEFORE_NATIVE_MOVE'?'# QA_HOLD_BEFORE_MOVE':'# QA_HOLD_AFTER_MOVE';
  const source=readFileSync(args[args.indexOf('-File')+1],'utf8');if(!source.includes(marker))throw Error('Owned native archive checkpoint missing');
  const gate=`[IO.File]::WriteAllText(${literal(signal)},$PID.ToString()+':'+[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString())\n $qaEnd=[DateTime]::UtcNow.AddSeconds(60)\n while([IO.File]::Exists(${literal(hold)}) -and [DateTime]::UtcNow -lt $qaEnd){[Threading.Thread]::Sleep(25)}`;
  writeFileSync(hold,'OWNED QA');writeFileSync(helper,source.replace(marker,gate));const altered=[...args];altered[altered.indexOf('-File')+1]=helper;
  process.send?.({type:'LAUNCH_HELPER_REQUEST',file,args:altered,hold,signal,stage:mode});return null;
 }
 return nativeExec.call(cp,file,args,options,callback);
}
Object.defineProperty(wrapped,promisify.custom,{value:(...args)=>new Promise((ok,no)=>wrapped(...args,(error,stdout,stderr)=>error?no(error):ok({stdout,stderr})))});cp.execFile=wrapped;syncBuiltinESMExports();
const {FieldRecoveryFiles}=await import('../field-recovery-files.mjs');
if(mode==='LEGACY_V2'){const native=FieldRecoveryFiles.prototype.recordArchiveIntent;FieldRecoveryFiles.prototype.recordArchiveIntent=function(raw){const {captureContextSha256,...old}=raw;return native.call(this,{...old,format:'idms-field-archive-intent-v1'});};}
const connect=pg.Client.prototype.connect,query=pg.Client.prototype.query;
pg.Client.prototype.connect=function(...args){return connect.apply(this,args).then(async r=>{const row=(await query.call(this,'SELECT pid,backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];process.send?.({type:'BACKEND',...row});return r;});};
for(const [method,stage]of Object.entries(modes)){const native=FieldRecoveryFiles.prototype[method];FieldRecoveryFiles.prototype[method]=async function(...args){const r=await native.apply(this,args);if(stage===mode){process.send?.({type:'ENTERED',stage});await new Promise(()=>{});}return r;};}
let completed=false;process.on('disconnect',()=>{if(!completed)process.exit(3);});
await import('../field-recovery.mjs');
completed=true;
process.disconnect?.();
