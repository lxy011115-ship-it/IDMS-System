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
 const trace=process.env.IDMS_COLD_QA_TRACE_ID;if(trace){assert.match(trace,/^(?:[a-f0-9]{12}|[0-9]{9,15}-[0-9]{1,3})$/);const log=resolve('work/qa-exception-observations-20261022',trace+'.jsonl'),stat=await lstat(log);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=2*1024*1024);const records=(await readFile(log,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));for(const row of records){assert.equal(Object.keys(row).sort().join(','),'at,code,event,file,ioCode,line,pid,rawErrorPrinted,sqlState,type');assert.equal(row.event,'IDMS_COLD_QA_EXCEPTION_V1');assert.equal(row.rawErrorPrinted,false);assert(Number.isSafeInteger(row.at)&&row.at>0&&Number.isInteger(row.pid)&&row.pid>0);assert(row.code===null||/^(?:GOVERNANCE_|MAINTENANCE_|PREDICTIVE_|STATE_MAP_|AUTH_AUDIT_|DOMAIN_|BRANCH_|COLD_|AUTHORITY_|PG_CLIENT_)[A-Z0-9_]{1,90}$/.test(row.code));assert(row.sqlState===null||/^[A-Z0-9]{5}$/.test(row.sqlState));assert(row.ioCode===null||['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENETUNREACH'].includes(row.ioCode));assert(row.type===null||['TypeError','ReferenceError','RangeError','SyntaxError','AssertionError'].includes(row.type));assert(row.file===null||/^[A-Za-z0-9_.-]+\.(?:mjs|js|ts)$/.test(row.file));assert(row.line===null||Number.isInteger(row.line)&&row.line>0);}for(const row of records.slice(-300))console.log(JSON.stringify(row));}
}
