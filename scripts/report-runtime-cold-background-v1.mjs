import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Publish bounded failure metadata only; never print an API body or raw error. */
export function summarizeRuntimeColdBackgroundV1(report){
 const message=typeof report.failure?.message==='string'?report.failure.message:'',line=message.split('\n')[0];let httpStatus=null,errorCode=null;
 if(line.startsWith('{"status":'))try{const value=JSON.parse(line);if(Number.isInteger(value.status)&&value.status>=100&&value.status<=599)httpStatus=value.status;const code=value.value?.error;if(typeof code==='string'&&/^(?:SITE_|CONSOLE_|AUTH_|OIDC_|MAINTENANCE_|PREDICTIVE_|GOVERNANCE_|IDMS_|IDENTITY_|COLD_|SESSION_)[A-Z0-9_]{1,80}$/.test(code))errorCode=code;}catch{}
 const location=String(report.failure?.stack??'').match(/([A-Za-z0-9_.-]+\.mjs:\d+:\d+)/)?.[1]??null;
 return {format:'IDMS_COLD_BACKGROUND_DIAGNOSTIC_V1',passed:report.passed===true,checks:Array.isArray(report.checks)?report.checks.length:0,cleanupErrorCount:Array.isArray(report.cleanup?.errors)?report.cleanup.errors.length:null,httpStatus,errorCode,location,rawFailureOrApiBodyPrinted:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.equal(process.argv.length,3);assert.match(process.argv[2],/^[a-f0-9]{12}$/);
 const file=resolve('work/runtime-cold-background-v1-20261022',process.argv[2],'verification.json'),stat=await lstat(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=1024*1024);
 console.log(JSON.stringify(summarizeRuntimeColdBackgroundV1(JSON.parse(await readFile(file,'utf8')))));
}
