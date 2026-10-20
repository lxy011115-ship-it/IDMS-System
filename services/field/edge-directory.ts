import {mkdir,lstat,realpath,opendir} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {fieldEdgeDirectoryName} from './edge-config.ts';
import {fieldFailure} from './error.ts';

export async function prepareFieldEdgeDirectory(root:string,name:string){
 const base=await realpath(root);let path=base;for(const part of fieldEdgeDirectoryName(name).split('/')){path=resolve(path,part);await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())fieldFailure('FIELD_EDGE_SPOOL_DIRECTORY_INVALID');const actual=await realpath(path),rel=relative(base,actual);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))fieldFailure('FIELD_EDGE_SPOOL_DIRECTORY_INVALID');path=actual;}return path;
}
export async function checkFieldEdgeStreams(directory:string,streamId:string,maxStreams:number){
 if(!/^[a-f0-9]{64}$/.test(streamId))fieldFailure('FIELD_EDGE_SPOOL_DIRECTORY_INVALID');const names=new Set<string>(),sidecars:string[]=[];let count=0;for await(const entry of await opendir(directory)){if(++count>maxStreams*3+3||!entry.isFile()||entry.isSymbolicLink())fieldFailure('FIELD_EDGE_SPOOL_DIRECTORY_INVALID');const m=/^stream-([a-f0-9]{64})\.sqlite(?:-(wal|shm))?$/.exec(entry.name);if(!m)fieldFailure('FIELD_EDGE_SPOOL_DIRECTORY_INVALID');if(m[2])sidecars.push(m[1]);else names.add(m[1]);}
 if(sidecars.some(s=>!names.has(s)))fieldFailure('FIELD_EDGE_SPOOL_DIRECTORY_INVALID');if(names.size>maxStreams||!names.has(streamId)&&names.size>=maxStreams)fieldFailure('FIELD_EDGE_STREAM_LIMIT');return {path:resolve(directory,'stream-'+streamId+'.sqlite'),retainedStreams:names.size-(names.has(streamId)?1:0)};
}
