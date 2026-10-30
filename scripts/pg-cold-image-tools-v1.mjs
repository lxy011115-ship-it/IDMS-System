import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {backupDirectory,backupRegular,backupUnchanged,eachChunk} from './field-backup-io.mjs';
import {coldNeedV1 as need} from './pg-cold-image-manifest-v1.mjs';
const exec=promisify(execFile);
export async function coldFileHashV1(path,max=2*1024**3,signal){const f=await backupRegular(path,max),h=createHash('sha256');try{await eachChunk(f.file,0,Number(f.stat.size),b=>h.update(b),signal);await backupUnchanged(f);return{bytes:Number(f.stat.size),sha256:h.digest('hex')};}finally{await f.file.close();}}
export function coldToolEnvV1(){const env={...process.env,LC_ALL:'C',LANG:'C',LC_MESSAGES:'C'};for(const k of Object.keys(env))if(/^PG/i.test(k))delete env[k];return env;}
export async function coldToolingV1(binDirectory){const bin=await backupDirectory(binDirectory),suffix=process.platform==='win32'?'.exe':'',paths={postgres:join(bin,'postgres'+suffix),pgCtl:join(bin,'pg_ctl'+suffix),control:join(bin,'pg_controldata'+suffix)},version=(await exec(paths.postgres,['--version'],{env:coldToolEnvV1(),windowsHide:true,maxBuffer:65536})).stdout.trim();need(/^postgres \(PostgreSQL\) 16\.\d+(?:\.\d+)?$/.test(version),'COLD_IMAGE_PG_VERSION');const hashes=await Promise.all([paths.postgres,paths.pgCtl,paths.control].map(p=>coldFileHashV1(p,128*1024**2)));return{paths,binding:{version,postgresSha256:hashes[0].sha256,pgCtlSha256:hashes[1].sha256,controlSha256:hashes[2].sha256}};}
export async function coldStoppedV1(directory,tooling,expectedSystemIdentifier){
 const root=await backupDirectory(directory);let pid=false;try{await lstat(join(root,'postmaster.pid'));pid=true;}catch(e){if(e.code!=='ENOENT')throw e;}need(!pid,'COLD_IMAGE_SOURCE_RUNNING');
 let code;try{await exec(tooling.paths.pgCtl,['status','-D',root],{env:coldToolEnvV1(),windowsHide:true,maxBuffer:65536});code=0;}catch(e){code=e.code;}need(code===3,'COLD_IMAGE_SOURCE_RUNNING');
 const result=await exec(tooling.paths.control,['-D',root],{env:coldToolEnvV1(),windowsHide:true,maxBuffer:128*1024}),rows=new Map(result.stdout.split(/\r?\n/).filter(s=>s.includes(':')).map(s=>[s.slice(0,s.indexOf(':')).trim(),s.slice(s.indexOf(':')+1).trim()]));need(!result.stderr.trim(),'COLD_IMAGE_CONTROL_DIAGNOSTIC');
 const value={systemIdentifier:rows.get('Database system identifier'),controlVersion:rows.get('pg_control version number'),catalogVersion:rows.get('Catalog version number'),state:rows.get('Database cluster state'),checkpoint:rows.get('Latest checkpoint location'),sha256:(await coldFileHashV1(join(root,'global/pg_control'),65536)).sha256};
 need(value.state==='shut down'&&value.systemIdentifier===expectedSystemIdentifier,'COLD_IMAGE_SOURCE_NOT_CLEAN');return value;
}
