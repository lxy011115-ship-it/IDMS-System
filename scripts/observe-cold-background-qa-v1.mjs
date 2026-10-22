// Optional CI-only, in-process exception observation. No inspector port is opened.
import {Session} from 'node:inspector';
import {basename,resolve,dirname} from 'node:path';
import {mkdirSync,openSync,fstatSync,writeSync,closeSync,constants} from 'node:fs';
const session=new Session();session.connect();let count=0;const sources=new Map();
const trace=process.env.IDMS_COLD_QA_TRACE_ID;let fd;
if(trace){if(!/^(?:[a-f0-9]{12}|[0-9]{9,15}-[0-9]{1,3})$/.test(trace))throw Error('QA_TRACE_ID');const path=resolve('work/qa-exception-observations-20261022',trace+'.jsonl');mkdirSync(dirname(path),{recursive:true,mode:0o700});fd=openSync(path,constants.O_APPEND|constants.O_CREAT|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw Error('QA_TRACE_FILE');}
session.on('Debugger.scriptParsed',({params})=>sources.set(params.scriptId,basename(String(params.url??'').replaceAll('\\','/'))));
session.on('Debugger.paused',({params})=>{
 const finish=(properties=[])=>{
  try{
   const message=String(params.data?.description??''),match=message.match(/^[^\n:]+:\s*((?:GOVERNANCE_|MAINTENANCE_|PREDICTIVE_|STATE_MAP_|AUTH_AUDIT_|DOMAIN_|BRANCH_|COLD_|AUTHORITY_)[A-Z0-9_]{1,90})(?:\n|$)/),raw=properties.find(p=>p.name==='code')?.value?.value,sqlState=typeof raw==='string'&&/^[A-Z0-9]{5}$/.test(raw)?raw:null,ioCode=['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENETUNREACH'].includes(raw)?raw:null,type=['TypeError','ReferenceError','RangeError','SyntaxError','AssertionError'].includes(params.data?.className)?params.data.className:null,knownMessage=message.startsWith('Error: Query read timeout\n')?'PG_CLIENT_QUERY_TIMEOUT':message.startsWith('Error: Connection terminated unexpectedly\n')?'PG_CLIENT_CONNECTION_ENDED':null;
   if((match||sqlState||ioCode||type||knownMessage)&&count++<200){const frame=params.callFrames?.[0],url=String(frame?.url??''),file=basename(url.replaceAll('\\','/'))||sources.get(frame?.location?.scriptId)||'',text=JSON.stringify({event:'IDMS_COLD_QA_EXCEPTION_V1',at:Date.now(),pid:process.pid,code:match?.[1]??knownMessage,sqlState,ioCode,type,file:/^[A-Za-z0-9_.-]+\.(?:mjs|js|ts)$/.test(file)?file:null,line:Number.isInteger(frame?.location?.lineNumber)?frame.location.lineNumber+1:null,rawErrorPrinted:false});console.error(text);if(fd!==undefined)try{writeSync(fd,text+'\n');}catch{console.error('IDMS_QA_TRACE_WRITE_FAILED');}}
  }finally{session.post('Debugger.resume',()=>{});}
 };
 if(params.data?.objectId)session.post('Runtime.getProperties',{objectId:params.data.objectId,ownProperties:true,generatePreview:false},(error,result)=>finish(error?[]:result?.result??[]));else finish();
});
session.post('Debugger.enable',()=>session.post('Debugger.setPauseOnExceptions',{state:'all'}));
process.once('exit',()=>{session.disconnect();if(fd!==undefined)closeSync(fd);});
