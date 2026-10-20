import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import pg from 'pg';
import type {ClientConfig} from 'pg';
import type {AiReviewBindingV4} from './ai-review-crypto-v4.ts';
import {checkAiReviewConnectionV4,type AiReviewClaimV4} from './ai-review-source-v4.ts';
export async function startAiReviewHeartbeatV4(account:ClientConfig,binding:AiReviewBindingV4,claim:AiReviewClaimV4){
 let lost=false,stopping=false;const worker=new Worker(new URL(import.meta.url),{workerData:{aiReview:true,account,binding,lease:{id:claim.header.requestId,owner:claim.owner,token:claim.token,fence:claim.fence}}});let readyResolve:()=>void,readyReject:(e:Error)=>void;const ready=new Promise<void>((ok,no)=>{readyResolve=ok;readyReject=no;});
 const ended=new Promise<void>(ok=>worker.once('exit',()=>{if(!stopping)lost=true;readyReject!(Error('AI_REVIEW_LEASE_LOST'));ok();}));worker.on('error',()=>{lost=true;readyReject!(Error('AI_REVIEW_LEASE_LOST'));});worker.on('message',m=>{if(m==='READY')readyResolve!();if(m==='LOST'){lost=true;readyReject!(Error('AI_REVIEW_LEASE_LOST'));}});
 try{await ready;}catch(error){stopping=true;worker.postMessage('STOP');await ended;throw error;}
 return {assertLive(){if(lost)throw Error('AI_REVIEW_LEASE_LOST');},async stop(){stopping=true;worker.postMessage('STOP');await ended;}};
}
if(!isMainThread&&workerData?.aiReview){
 let stop=false,wake:(()=>void)|undefined;parentPort!.on('message',m=>{if(m==='STOP'){stop=true;wake?.();}});
 const renew=async()=>{const c=new pg.Client({...workerData.account,connectionTimeoutMillis:3000,query_timeout:15000});c.on('error',()=>{});try{await c.connect();await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='10s'");await checkAiReviewConnectionV4(c,workerData.binding);const l=workerData.lease;await c.query('SELECT ai_review_v4.renew_v4($1,$2,$3,$4)',[l.id,l.owner,l.token,l.fence]);await checkAiReviewConnectionV4(c,workerData.binding);await c.query('COMMIT');}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{await c.end().catch(()=>{});}};
 try{await renew();parentPort!.postMessage('READY');while(!stop){await new Promise<void>(ok=>{const t=setTimeout(()=>{wake=undefined;ok();},10000);wake=()=>{clearTimeout(t);wake=undefined;ok();};});if(!stop)await renew();}}
 catch{parentPort!.postMessage('LOST');}finally{parentPort!.close();}
}
