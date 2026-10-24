import {readFile,lstat} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {RuntimeColdReadOnlyPreparationV3} from './runtime-cold-review-prepare-v5.mjs';
let control;
try{
 if(process.argv.length!==5||!['PREPARE','STATUS'].includes(process.argv[2])||!isAbsolute(process.argv[3]))throw Error('COLD_REVIEW_ENTRY_ARGUMENTS');const file=resolve(process.argv[3]),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024**2)throw Error('COLD_REVIEW_ENTRY_FILE');const raw=JSON.parse(await readFile(file,'utf8'));if(!raw||Object.keys(raw).sort().join(',')!=='config,format,purpose'||raw.format!==3||raw.purpose!=='COLD_READONLY_REVIEW_V3')throw Error('COLD_REVIEW_ENTRY_PURPOSE');control=new RuntimeColdReadOnlyPreparationV3(raw.config);const result=await control[process.argv[2]==='PREPARE'?'prepare':'status']({recoveryId:process.argv[4]});console.log(JSON.stringify(result));
}catch(e){const code=/^[A-Z][A-Z0-9_]{3,120}$/.test(e.code??'')?e.code:/^[A-Z][A-Z0-9_]{3,120}$/.test(e.message)?e.message:'COLD_REVIEW_ENTRY_FAILED';console.error(JSON.stringify({code,messageSha256:createHash('sha256').update(String(e.message)).digest('hex')}));process.exitCode=1;}
finally{try{await control?.close();}catch(e){console.error(JSON.stringify({code:'COLD_REVIEW_ENTRY_CLOSE_UNPROVEN',messageSha256:createHash('sha256').update(String(e.message)).digest('hex')}));process.exitCode=1;}}
