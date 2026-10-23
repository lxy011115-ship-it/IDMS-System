import {readFile,lstat,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const predictorHashV1=value=>createHash('sha256').update(value).digest('hex');
export const predictorNeedV1=(value,code)=>{if(!value)throw Error(code);};
const need=predictorNeedV1,normal=file=>process.platform==='win32'?resolve(file).toLowerCase():resolve(file);
export const predictorUuidV1=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export async function readPredictorFileV1(file,max=2*1024**2){
 need(typeof file==='string'&&file.length>0&&file.length<=2048&&!/[\x00-\x1f\x7f]/.test(file),'PREDICTOR_FILE_PATH');
 const path=resolve(file),before=await lstat(path);need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size>0&&before.size<=max&&normal(await realpath(path))===normal(path),'PREDICTOR_FILE');
 const bytes=await readFile(path),after=await lstat(path);need(after.isFile()&&after.nlink===1&&before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'PREDICTOR_FILE_CHANGED');return{path,bytes,sha256:predictorHashV1(bytes)};
}
export function predictorRuntimeV1(value){
 need(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='format,host,port,purpose,serviceToken'&&value.format===1&&value.purpose==='PREDICTOR_SERVICE','PREDICTOR_CONFIG_FIELDS');
 need(value.host==='127.0.0.1'&&Number.isInteger(value.port)&&value.port>0&&value.port<=65535,'PREDICTOR_CONFIG_ENDPOINT');
 need(typeof value.serviceToken==='string'&&value.serviceToken.length>=32&&value.serviceToken.length<=4096&&!/[\r\n]/.test(value.serviceToken),'PREDICTOR_CONFIG_CREDENTIAL');
 return{format:1,purpose:'PREDICTOR_SERVICE',host:value.host,port:value.port,serviceToken:value.serviceToken};
}
export async function assertPredictorPinsV1(pins){for(const pin of pins)need((await readPredictorFileV1(pin.path)).sha256===pin.sha256,'PREDICTOR_INPUT_CHANGED');}
export async function predictorNodeIdentityV1(){
 const path=process.execPath,before=await lstat(path);need(before.isFile()&&!before.isSymbolicLink(),'PREDICTOR_NODE_FILE');const h=createHash('sha256');for await(const part of createReadStream(path))h.update(part);const after=await lstat(path);need(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'PREDICTOR_NODE_CHANGED');return{path,sha256:h.digest('hex'),bytes:before.size};
}
/** Seal the fixed runtime's actual relative-import closure, including TypeScript inputs. */
export async function predictorSourcePinsV1(){
 const root=fileURLToPath(new URL('../',import.meta.url)),seen=new Map();let bytes=0;
 async function visit(file){const path=resolve(file);if(seen.has(normal(path)))return;const rel=relative(root,path);need(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'PREDICTOR_SOURCE_PATH');const entry=await readPredictorFileV1(path);bytes+=entry.bytes.length;need(seen.size<512&&bytes<=32*1024**2,'PREDICTOR_SOURCE_LIMIT');seen.set(normal(path),{path,sha256:entry.sha256});const text=entry.bytes.toString('utf8');for(const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g))if(match[1].startsWith('.'))await visit(resolve(dirname(path),match[1]));}
 for(const name of ['predictor-runtime-v1.mjs','predictor-managed-entry-v1.mjs','predictor-lifecycle-v1.mjs'])await visit(fileURLToPath(new URL('./'+name,import.meta.url)));
 for(const name of ['package.json','package-lock.json']){const entry=await readPredictorFileV1(resolve(root,name));seen.set(normal(entry.path),{path:entry.path,sha256:entry.sha256});}
 return[...seen.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
