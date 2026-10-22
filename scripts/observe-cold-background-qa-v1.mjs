// Explicit CI-only observation. No debugger, inspector port, query or parameter logging.
import pg from 'pg';
import {resolve,dirname} from 'node:path';
import {mkdirSync,openSync,fstatSync,writeSync,closeSync,constants} from 'node:fs';
import {DomainError} from '../server/service.ts';
import {createHash} from 'node:crypto';
const NativeError=globalThis.Error,trace=process.env.IDMS_COLD_QA_TRACE_ID;let fd,count=0,emitting=false;
if(trace){
 if(!/^(?:[a-f0-9]{12}|[0-9]{9,15}-[0-9]{1,3})$/.test(trace))throw Error('QA_TRACE_ID');
 const file=resolve('work/qa-exception-observations-20261022',trace+'.jsonl');mkdirSync(dirname(file),{recursive:true,mode:0o700});
 fd=openSync(file,constants.O_APPEND|constants.O_CREAT|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
 const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw Error('QA_TRACE_FILE');
}
function record(error,tag=null){
 if(emitting||count>=400||!error)return;emitting=true;
 try{
  const raw=error.code,message=typeof error.message==='string'?error.message:'',protocol=/^(?:GOVERNANCE_|MAINTENANCE_|PREDICTIVE_|STATE_MAP_|AUTH_AUDIT_|DOMAIN_|BRANCH_|COLD_|AUTHORITY_)[A-Z0-9_]{1,90}$/;
  const sqlState=typeof raw==='string'&&/^[A-Z0-9]{5}$/.test(raw)?raw:null,ioCode=['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENETUNREACH'].includes(raw)?raw:null,type=['TypeError','ReferenceError','RangeError','SyntaxError','AssertionError'].includes(error.name)?error.name:null;
  const nativeCode=typeof raw==='string'&&/^ERR_[A-Z0-9_]{1,64}$/.test(raw)?'DOMAIN_NATIVE_'+raw:null;
  const code=protocol.test(message)?message:message==='Query read timeout'?'PG_CLIENT_QUERY_TIMEOUT':message==='Connection terminated unexpectedly'?'PG_CLIENT_CONNECTION_ENDED':message==='Unsupported state or unable to authenticate data'?'DOMAIN_CRYPTO_AUTHENTICATION_FAILED':nativeCode??(tag==='DOMAIN_NON_DOMAIN_ERROR'?'DOMAIN_NON_DOMAIN_ERROR_SHA256_'+createHash('sha256').update(message.slice(0,4096)).digest('hex').toUpperCase():tag);
  if(!code&&!sqlState&&!ioCode&&!type)return;count++;
  const stack=String(new NativeError().stack??''),locations=[...stack.matchAll(/([A-Za-z0-9_.-]+\.(?:mjs|js|ts)):(\d+):\d+/g)],location=locations.find(m=>m[1]!=='observe-cold-background-qa-v1.mjs');
  const text=JSON.stringify({event:'IDMS_COLD_QA_EXCEPTION_V1',at:Date.now(),pid:process.pid,code,sqlState,ioCode,type,file:location?.[1]??null,line:location?Number(location[2]):null,rawErrorPrinted:false});
  if(fd!==undefined)writeSync(fd,text+'\n');else console.error(text);
 }catch{console.error('IDMS_QA_TRACE_WRITE_FAILED');}finally{emitting=false;}
}
// Keep the original Error prototype and exact thrown objects; observe static protocol codes only.
globalThis.Error=new Proxy(NativeError,{apply(target,thisArg,args){const value=Reflect.apply(target,thisArg,args);record(value);return value;},construct(target,args,newTarget){const value=Reflect.construct(target,args,newTarget);record(value);return value;}});
const instance=Function.prototype[Symbol.hasInstance];
Object.defineProperty(DomainError,Symbol.hasInstance,{configurable:true,value:function(value){const matches=instance.call(this,value);if(!matches&&instance.call(NativeError,value))record(value,'DOMAIN_NON_DOMAIN_ERROR');return matches;}});
const connect=pg.Client.prototype.connect;
pg.Client.prototype.connect=function(callback){
 if(typeof callback==='function')return connect.call(this,function(error,...values){record(error,'PG_CLIENT_CONNECTION_FAILURE');return callback.call(this,error,...values);});
 try{const value=connect.call(this);return value&&typeof value.then==='function'?value.catch(error=>{record(error,'PG_CLIENT_CONNECTION_FAILURE');throw error;}):value;}catch(error){record(error,'PG_CLIENT_CONNECTION_FAILURE');throw error;}
};
const query=pg.Client.prototype.query;
pg.Client.prototype.query=function(...args){
 const text=typeof args[0]==='string'?args[0]:'',tag=text.includes('governance_jobs_v4.find_v4')?'GOVERNANCE_SQL_FIND_FAILURE':text.includes('predictive_jobs_v4.find_v4')?'PREDICTIVE_SQL_FIND_FAILURE':text.includes('maintenance_jobs_v4.find_v4')?'MAINTENANCE_SQL_FIND_FAILURE':null;
 const last=args.length-1;if(typeof args[last]==='function'){const callback=args[last];args[last]=function(error,...values){record(error,tag);return callback.call(this,error,...values);};}
 try{const value=query.apply(this,args);return value&&typeof value.then==='function'?value.catch(error=>{record(error,tag);throw error;}):value;}catch(error){record(error,tag);throw error;}
};
process.once('exit',()=>{if(fd!==undefined)closeSync(fd);});
