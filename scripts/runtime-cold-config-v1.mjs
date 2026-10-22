import {readFile,mkdir,lstat} from 'node:fs/promises';
import {resolve,dirname,join,basename} from 'node:path';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {coldRuntimeNeedV1 as need,coldRuntimeHashV1 as hash} from './runtime-cold-facts-v1.mjs';
import {canonical} from '../server/imports.ts';
/** Copy a private JSON configuration graph. Change SQL passwords only, retain logical/service/key bindings. */
export async function createRuntimeColdConfigGenerationV1(directory,credentials){
 const root=resolve(directory);await mkdir(root,{recursive:false,mode:0o700});await privateDirectory(root);need(credentials.format==='RUNTIME_COLD_CREDENTIALS_V1','COLD_CONFIG_CREDENTIALS');const cache=new Map(),records=[];
 async function clone(file){const source=resolve(file);if(cache.has(source))return cache.get(source);const stat=await lstat(source);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=1024**2,'COLD_CONFIG_FILE');const bytes=await readFile(source),value=JSON.parse(bytes.toString('utf8')),target=join(root,String(cache.size).padStart(4,'0')+'-'+basename(source));cache.set(source,target);
  async function visit(v){if(Array.isArray(v)){const values=[];for(const x of v)values.push(await visit(x));return values;}if(v&&typeof v==='object'){const o={};for(const[k,x]of Object.entries(v)){if(typeof x==='string'&&/File$/.test(k)&&/\.json$/i.test(x)){o[k]=await clone(resolve(dirname(source),x));}else if(Array.isArray(x)&&/Files$/.test(k)){const refs=[];for(const file of x){need(typeof file==='string'&&/\.json$/i.test(file),'COLD_CONFIG_REFERENCE');refs.push(await clone(resolve(dirname(source),file)));}o[k]=refs;}else o[k]=await visit(x);}if(typeof o.user==='string'&&typeof o.password==='string'&&credentials.roles[o.user])o.password=credentials.roles[o.user];return o;}return v;}
  const output=canonical(await visit(value));await privateNewFile(target,output);records.push({source,target,sourceHash:hash(bytes),targetHash:hash(output)});return target;
 }
 return{clone,records,async finish(){await privateNewFile(join(root,'generation-manifest.private.json'),canonical({controlId:credentials.controlId,records}));}};
}
