import {lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,dirname,isAbsolute} from 'node:path';
import {canonical} from '../server/imports.ts';
import {fieldEvidenceFailure as fail} from '../server/field-evidence-materials.ts';

// No operational context, database library, child process or network client.
export async function readFieldEvidenceFile(path,maximum){
 if(typeof path!=='string'||!isAbsolute(path))fail('FIELD_EVIDENCE_PATH_INVALID');path=resolve(path);
 for(let p=path;;p=dirname(p)){const s=await lstat(p);if(s.isSymbolicLink())fail('FIELD_EVIDENCE_PATH_INVALID');if(dirname(p)===p)break;}
 const before=await lstat(path,{bigint:true}),actual=await realpath(path);if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>BigInt(maximum)||(process.platform==='win32'?actual.toLowerCase()!==path.toLowerCase():actual!==path))fail('FIELD_EVIDENCE_PATH_INVALID');
 let file,bytes;
 try{file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);const current=await file.stat({bigint:true});if(!current.isFile()||current.size<1n||current.size>BigInt(maximum)||['ino','dev','size','mtimeNs','ctimeNs','nlink'].some(k=>before[k]!==current[k]))fail('FIELD_EVIDENCE_FILE_CHANGED');bytes=Buffer.alloc(Number(current.size));let count=0;while(count<bytes.length){const r=await file.read(bytes,count,bytes.length-count,count);if(!r.bytesRead)fail('FIELD_EVIDENCE_FILE_CHANGED');count+=r.bytesRead;}if((await file.read(Buffer.alloc(1),0,1,count)).bytesRead)fail('FIELD_EVIDENCE_FILE_CHANGED');const after=await file.stat({bigint:true});if(['ino','dev','size','mtimeNs','ctimeNs','nlink'].some(k=>before[k]!==after[k]))fail('FIELD_EVIDENCE_FILE_CHANGED');return bytes;}catch(error){bytes?.fill(0);throw error;}finally{await file?.close();}
}
export function parseFieldEvidenceJson(bytes,{canonicalRequired=false}={}){try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),value=JSON.parse(text);if(canonicalRequired&&text!==canonical(value))fail('FIELD_EVIDENCE_NONCANONICAL');return value;}catch(error){if(error.code?.startsWith('FIELD_EVIDENCE_'))throw error;fail('FIELD_EVIDENCE_JSON_INVALID');}}
export function fieldEvidenceFlags(args,allowed){const r={};for(let i=0;i<args.length;i+=2){if(!allowed.includes(args[i])||Object.hasOwn(r,args[i])||!args[i+1]||args[i+1].startsWith('--'))fail('FIELD_EVIDENCE_ARGUMENTS_INVALID');r[args[i]]=args[i+1];}return r;}
