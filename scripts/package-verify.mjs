import unzipper from 'unzipper';
import {createHash} from 'node:crypto';
import {safePackageName} from './package-policy.mjs';

export async function verifyDemoPackage(path){
 const zip=await unzipper.Open.file(path),seen=new Set(),entries=new Map();for(const file of zip.files){const mode=(file.externalFileAttributes>>>16)&0o170000;if(file.type!=='File'||mode&&mode!==0o100000||file.flags&1)throw Error('Package contains a directory, link, encryption or unsupported entry');safePackageName(file.path);const key=file.path.toLowerCase();if(seen.has(key))throw Error('Package contains a duplicate entry');seen.add(key);entries.set(file.path,file);}
 const mf=entries.get('package-manifest.json');if(!mf||mf.uncompressedSize>16*1024*1024)throw Error('Package manifest is missing or oversized');const manifest=JSON.parse((await mf.buffer()).toString('utf8'));
 if(manifest.format!==1||manifest.purpose!=='OFFLINE_MANUAL_DEMO'||!Array.isArray(manifest.files)||manifest.files.length>50000||manifest.files.length+1!==zip.files.length)throw Error('Package manifest does not cover the archive');let bytes=0;const names=new Set();
 for(const expected of manifest.files){safePackageName(expected.name);if(names.has(expected.name)||expected.name==='package-manifest.json'||!Number.isSafeInteger(expected.bytes)||expected.bytes<0||!/^[a-f0-9]{64}$/.test(expected.sha256))throw Error('Invalid package manifest entry');names.add(expected.name);bytes+=expected.bytes;if(bytes>512*1024*1024)throw Error('Package exceeds its expansion budget');const file=entries.get(expected.name);if(!file||file.uncompressedSize!==expected.bytes)throw Error('Package entry length differs: '+expected.name);const hash=createHash('sha256');let read=0;for await(const chunk of file.stream()){read+=chunk.length;if(read>expected.bytes)throw Error('Package expanded past its manifest');hash.update(chunk);}if(read!==expected.bytes||hash.digest('hex')!==expected.sha256)throw Error('Package entry checksum differs: '+expected.name);}
 return {manifest,files:manifest.files.length,expandedBytes:bytes,verified:true};
}
