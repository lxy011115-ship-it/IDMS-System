import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import pg from 'pg';
import type {ClientConfig} from 'pg';
import {checkAuthAuditConnectionV4,type AuthAuditQueueBindingV4,type AuthAuditClaimV4} from './auth-audit-source-v4.ts';
/** Renew independently of business-root verification or other work on the main thread. */
export function startAuthAuditHeartbeatV4(account:ClientConfig,binding:AuthAuditQueueBindingV4,claim:AuthAuditClaimV4){
 let lost=false,stopping=false;const worker=new Worker(new URL(import.meta.url),{workerData:{account,binding,lease:{eventId:claim.header.eventId,scope:claim.header.scope,owner:claim.owner,token:claim.token,fence:claim.fence}}}),ended=new Promise<void>(resolve=>worker.once('exit',()=>{if(!stopping)lost=true;resolve();}));worker.on('error',()=>{lost=true;});worker.on('message',m=>{if(m==='LOST')lost=true;});return {assertLive(){if(lost)throw Error('AUTH_AUDIT_LEASE_LOST');},async stop(){stopping=true;worker.postMessage('STOP');await ended;}};
}
if(!isMainThread&&workerData?.lease){
 let stop=false,wake:(()=>void)|undefined;parentPort!.on('message',m=>{if(m==='STOP'){stop=true;wake?.();}});
 try{while(!stop){await new Promise<void>(ok=>{const t=setTimeout(()=>{wake=undefined;ok();},10000);wake=()=>{clearTimeout(t);wake=undefined;ok();};});if(stop)break;const c=new pg.Client({...workerData.account,connectionTimeoutMillis:3000,query_timeout:15000});c.on('error',()=>{});try{await c.connect();await c.query('BEGIN');await checkAuthAuditConnectionV4(c,workerData.binding,true);const l=workerData.lease;await c.query('SELECT auth_audit_v4.renew_v4($1,$2,$3,$4,$5)',[l.scope,l.eventId,l.owner,l.token,l.fence]);await checkAuthAuditConnectionV4(c,workerData.binding,true);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end().catch(()=>{});}}}
 catch{parentPort!.postMessage('LOST');}finally{parentPort!.close();}
}
