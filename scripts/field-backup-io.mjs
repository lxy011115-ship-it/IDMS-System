import {constants} from 'node:fs';
import {open,lstat,realpath,mkdtemp,unlink,rmdir,readdir} from 'node:fs/promises';
import {resolve,dirname,basename,relative,isAbsolute,join} from 'node:path';
import {privateDirectory} from './backup-support.mjs';
import {backupError,fieldBackupLimits} from './field-backup-manifest.mjs';
const fail=code=>{throw backupError(code);};
export function backupCheckSignal(signal){if(signal?.aborted)fail('FIELD_BACKUP_CANCELLED');}
const equalPath=(a,b)=>(process.platform==='win32'?a.toLowerCase():a)===(process.platform==='win32'?b.toLowerCase():b);
export async function backupNoLinks(path){let p=resolve(path);for(;;){const s=await lstat(p);if(s.isSymbolicLink())fail('FIELD_BACKUP_PATH_INVALID');const parent=dirname(p);if(parent===p)break;p=parent;}}
export async function backupDirectory(path){const p=resolve(path);await backupNoLinks(p);const s=await lstat(p);if(!s.isDirectory()||!equalPath(await realpath(p),p))fail('FIELD_BACKUP_PATH_INVALID');return p;}
const sameInode=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
export async function backupRegular(path,max){const p=resolve(path);await backupDirectory(dirname(p));const before=await lstat(p,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(max))fail('FIELD_BACKUP_FILE_INVALID');const file=await open(p,constants.O_RDONLY|(constants.O_NOFOLLOW||0));try{const s=await file.stat({bigint:true});if(!sameInode(before,s)||s.nlink!==1n||s.size>BigInt(max))fail('FIELD_BACKUP_FILE_INVALID');return {file,path:p,stat:s};}catch(e){await file.close();throw e;}}
export async function backupUnchanged(entry){const s=await entry.file.stat({bigint:true});if(!sameInode(s,entry.stat)||s.size!==entry.stat.size||s.mtimeNs!==entry.stat.mtimeNs||s.ctimeNs!==entry.stat.ctimeNs||s.nlink!==1n)fail('FIELD_BACKUP_INPUT_CHANGED');}
export async function readExactly(file,bytes,position){const b=Buffer.alloc(bytes);let at=0;while(at<bytes){const r=await file.read(b,at,bytes-at,position+at);if(!r.bytesRead)fail('FIELD_BACKUP_TRUNCATED');at+=r.bytesRead;}return b;}
export async function writeExactly(file,data,position){let at=0;while(at<data.length){const r=await file.write(data,at,data.length-at,position+at);if(!r.bytesWritten)fail('FIELD_BACKUP_WRITE_FAILED');at+=r.bytesWritten;}}
export async function eachChunk(file,start,bytes,consume,signal){const b=Buffer.alloc(fieldBackupLimits.chunkBytes);let at=0;while(at<bytes){backupCheckSignal(signal);const r=await file.read(b,0,Math.min(b.length,bytes-at),start+at);if(!r.bytesRead)fail('FIELD_BACKUP_TRUNCATED');await consume(b.subarray(0,r.bytesRead));at+=r.bytesRead;}backupCheckSignal(signal);}
export class BackupWorkspace {
 #parent;#path;#identity;#files=new Map();#closed=false;
 static async create(parent){const owner=new BackupWorkspace();owner.#parent=await backupDirectory(parent);owner.#path=await mkdtemp(join(owner.#parent,'field-backup-stage-'));owner.#identity=await lstat(owner.#path,{bigint:true});try{await privateDirectory(owner.#path);return owner;}catch(e){await owner.cleanup();throw e;}}
 get path(){return this.#path;}
 async createFile(name){if(this.#closed||!['archive.bin','plaintext.bin','dump.pgdump'].includes(name)||this.#files.has(name))fail('FIELD_BACKUP_WORKSPACE_INVALID');await this.assertOwned();const path=join(this.#path,name),file=await open(path,'wx+',0o600);try{this.#files.set(name,await file.stat({bigint:true}));return {file,path};}catch(e){await file.close();throw e;}}
 async assertOwned(){if(this.#closed)fail('FIELD_BACKUP_WORKSPACE_INVALID');const rel=relative(this.#parent,resolve(this.#path));if(isAbsolute(rel)||rel.startsWith('..')||!/^field-backup-stage-[A-Za-z0-9]{6}$/.test(basename(this.#path)))fail('FIELD_BACKUP_WORKSPACE_INVALID');await backupDirectory(this.#path);if(!sameInode(this.#identity,await lstat(this.#path,{bigint:true})))fail('FIELD_BACKUP_WORKSPACE_INVALID');}
 async cleanup(){if(this.#closed)return;await this.assertOwned();const names=await readdir(this.#path);if(names.some(n=>!this.#files.has(n)))fail('FIELD_BACKUP_UNKNOWN_WORKSPACE_FILE');for(const name of names){const s=await lstat(join(this.#path,name),{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||!sameInode(s,this.#files.get(name)))fail('FIELD_BACKUP_WORKSPACE_INVALID');}for(const name of names)await unlink(join(this.#path,name));await rmdir(this.#path);this.#closed=true;}
}
