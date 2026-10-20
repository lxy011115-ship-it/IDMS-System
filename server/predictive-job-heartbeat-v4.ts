import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import type {ClientConfig} from 'pg';
import {PredictiveJobStoreV4,type PredictiveQueueBindingV4,type PredictiveQueueClaimV4} from './predictive-job-store-v4.ts';
/** Independent thread: predictive CPU cannot starve the 30-second DB lease. */
export function startPredictiveHeartbeatV4(account:ClientConfig,binding:PredictiveQueueBindingV4,lease:PredictiveQueueClaimV4){
 let lost=false,stopping=false;const worker=new Worker(new URL(import.meta.url),{workerData:{account,binding,lease}});const ended=new Promise<void>(resolve=>worker.once('exit',()=>{if(!stopping)lost=true;resolve();}));worker.on('error',()=>{lost=true;});worker.on('message',message=>{if(message==='LOST')lost=true;});return {assertLive(){if(lost)throw Error('PREDICTIVE_QUEUE_LEASE_LOST');},async stop(){stopping=true;worker.postMessage('STOP');await ended;},get threadId(){return worker.threadId;}};
}
if(!isMainThread&&workerData?.lease){
 const store=new PredictiveJobStoreV4(workerData.account,workerData.binding);let stop=false,wake:(()=>void)|undefined;parentPort!.on('message',m=>{if(m==='STOP'){stop=true;wake?.();}});
 try{while(!stop){await new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=undefined;resolve();},10000);wake=()=>{clearTimeout(timer);wake=undefined;resolve();};});if(stop)break;await store.renew(workerData.lease);}}catch{parentPort!.postMessage('LOST');}finally{parentPort!.close();}
}
