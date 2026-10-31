import {lstat,open,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {RuntimeProbeError,probeNeed} from './runtime-probe-error.ts';
export async function runtimeCheckedPath(path:string){
 path=resolve(path);for(let p=path;;p=dirname(p)){const s=await lstat(p);probeNeed(!s.isSymbolicLink(),'LINKED_INPUT_REFUSED');if(p===dirname(p))break;}
 probeNeed(await realpath(path)===path,'LINKED_INPUT_REFUSED');return path;
}
export async function runtimeBoundedFile(path:string,max:number){
 try{
  path=await runtimeCheckedPath(path);const before=await lstat(path);probeNeed(before.isFile()&&before.nlink===1&&before.size<=max,'INPUT_SIZE_OR_TYPE');
  const f=await open(path,'r');try{const s=await f.stat();probeNeed(s.ino===before.ino&&s.size===before.size&&s.mtimeMs===before.mtimeMs,'INPUT_CHANGED');const buffer=Buffer.alloc(before.size+1);let count=0;while(count<buffer.length){const {bytesRead}=await f.read(buffer,count,buffer.length-count,null);if(!bytesRead)break;count+=bytesRead;}const after=await f.stat(),current=await lstat(await runtimeCheckedPath(path));probeNeed(count===before.size&&after.ino===before.ino&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&current.ino===before.ino&&current.size===before.size&&current.mtimeMs===before.mtimeMs,'INPUT_CHANGED');return buffer.subarray(0,count);}finally{await f.close();}
 }catch(e:any){if(e instanceof RuntimeProbeError)throw e;if(e.code==='ENOENT')throw new RuntimeProbeError('INPUT_MISSING','NOT_CONFIGURED');throw new RuntimeProbeError('INPUT_UNREADABLE','UNKNOWN');}
}
