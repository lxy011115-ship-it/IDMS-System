import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,lstat,mkdir,chmod} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {safePackageName} from './package-policy.mjs';
import {businessBinding} from '../server/auth-store.ts';

const privateConfigs=['.local/keycloak-runtime.json','.local/postgres-runtime.json','.local/postgres-business.json','.local/postgres-backup.json','.local/postgres-migration.json','.local/backup-keys/tenant-business-v1.json','.local/workflow/runtime.json','.local/workflow/client.json','.local/ai/runtime.json','.local/ai/client.json','.local/mqtt/telemetry-runtime.json'];
export async function knownLocalSecrets(root){
 root=resolve(root);const privateFile=async name=>{const parts=name.split('/');for(let i=1;i<=parts.length;i++){let s;try{s=await lstat(join(root,...parts.slice(0,i)));}catch(error){if(error.code==='ENOENT')return null;throw error;}if(s.isSymbolicLink())throw Error('Linked private scan input requires review');if(i===parts.length){if(!s.isFile()||s.size>256*1024)throw Error('Private scan input requires review');return readFile(join(root,...parts),'utf8');}if(!s.isDirectory())throw Error('Invalid private scan directory');}return null;};
 const values=new Set(),visit=(v,key='')=>{if(typeof v==='string'&&/(password|secret|token|signingkey|privatekey|hmac|apikey|^key$)/i.test(key)&&!/(?:file|path|url|endpoint)$/i.test(key)&&v.length>=8&&v.length<=4096){values.add(v);if(values.size>512)throw Error('Configured credential scan exceeds the review budget');}else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v))visit(x,k);};
 let business;for(const name of privateConfigs){const text=await privateFile(name);if(text!==null){const data=JSON.parse(text);visit(data);if(name==='.local/postgres-business.json')business=data;}}
 const token=await privateFile('.local/service-token');if(token!==null){const v=token.trim();if(v.length>4096)throw Error('Private scan token requires review');if(v.length>=8)values.add(v);}
 if(business){const binding=businessBinding(business);for(const name of ['runtime.json','keys.json','deployment.json']){const text=await privateFile('.local/auth-session-stores/'+binding+'/'+name);if(text!==null)visit(JSON.parse(text));}}
 return [...values].map(v=>Buffer.from(v));
}
export function secretDetector(secrets=[]){
 const window=Math.max(8192,...secrets.map(v=>v.length+256));let tail=Buffer.alloc(0);
 return chunk=>{const data=Buffer.concat([tail,chunk]);if(secrets.some(secret=>data.includes(secret)))throw Error('Configured private credential detected; contents omitted');const text=data.toString('utf8');if(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\r\n]+(?:(?:Proc-Type|DEK-Info):[^\r\n]{1,240}\r?\n|\r?\n){0,4}[A-Za-z0-9+/=\r\n]{40,}/.test(text))throw Error('Private key material detected; contents omitted');
  const patterns=/\b(?:password|clientSecret|apiKey|accessToken|refreshToken)\s*[:=]\s*['"]([A-Za-z0-9+\/_=-]{24,})['"]/gi;let match;while((match=patterns.exec(text))){const v=match[1];if(/[a-z]/.test(v)&&/[A-Z]/.test(v)&&/[0-9]/.test(v)&&! /^(?:fixture|synthetic|example|test-only)/i.test(v))throw Error('Embedded credential literal requires review; contents omitted');}
  tail=Buffer.from(data.subarray(Math.max(0,data.length-window)));
 };
}
export async function snapshotPackageFile(entry,stageRoot,secrets){
 safePackageName(entry.name);const destination=resolve(stageRoot,...entry.name.split('/')),r=relative(resolve(stageRoot),destination);if(r==='..'||r.startsWith('..\\')||r.startsWith('../')||isAbsolute(r))throw Error('Package snapshot escaped its stage');await mkdir(dirname(destination),{recursive:true});const scan=secretDetector(secrets),hash=createHash('sha256');let bytes=0;
 const inspect=new Transform({transform(chunk,_encoding,next){try{scan(chunk);bytes+=chunk.length;hash.update(chunk);next(null,chunk);}catch(error){next(Error(entry.name+': '+error.message));}}});
 await pipeline(createReadStream(entry.path),inspect,createWriteStream(destination,{flags:'wx',mode:entry.mode||0o644}));const after=await lstat(entry.path);if(!after.isFile()||after.isSymbolicLink()||after.size!==entry.bytes||after.mtimeMs!==entry.mtimeMs||after.ino!==entry.ino||bytes!==entry.bytes)throw Error('Package input changed while creating its snapshot: '+entry.name);await chmod(destination,entry.mode||0o644);
 return {name:entry.name,path:destination,bytes,sha256:hash.digest('hex'),mode:entry.mode||0o644};
}
export async function hashPackageFile(path){const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(path)){bytes+=chunk.length;hash.update(chunk);}return {bytes,sha256:hash.digest('hex')};}
