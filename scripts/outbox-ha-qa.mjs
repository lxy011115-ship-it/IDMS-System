import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
async function wait(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await pause(100);}throw Error('Worker HA verification timed out: '+label);}
export class WorkerReplyGate {
 enabled=false;holdAll=false;holdIds=new Set();calls=new Map();replies=new Map();firstResponse=new Map();
 started(id){if(this.enabled)this.calls.set(id,(this.calls.get(id)||0)+1);}
 async response(id,status,body){if(this.enabled&&!this.firstResponse.has(id))this.firstResponse.set(id,{status,body});if(!this.enabled||(!this.holdAll&&!this.holdIds.has(id)))return {status,body};return new Promise(resolve=>{const rows=this.replies.get(id)||[];rows.push({done:false,release:override=>resolve(override||{status,body})});this.replies.set(id,rows);});}
 release(id,index=0,override){const item=this.replies.get(id)?.[index];if(item&&!item.done){item.done=true;item.release(override);}}
 all(){this.holdAll=false;this.holdIds.clear();for(const [id,rows]of this.replies)rows.forEach((_,i)=>this.release(id,i));}
 count(id){return this.calls.get(id)||0;}
 ready(id,n=1){return (this.replies.get(id)?.length||0)>=n;}
}
export const observedWorkerArgs=()=>['--import',pathToFileURL(resolve('scripts/fixtures/outbox-observer.mjs')).href,'server/index.ts'];
export async function launchPeerWorker(env,onLost){
 const listener=net.createServer();await new Promise(ok=>listener.listen(0,'127.0.0.1',ok));const port=listener.address().port;await new Promise(ok=>listener.close(ok));
 const child=spawn(process.execPath,observedWorkerArgs(),{env:{...env,PORT:String(port),IDMS_DEMO_NAMESPACE:env.IDMS_DEMO_NAMESPACE+'-peer'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let log='';for(const s of [child.stdout,child.stderr])s.on('data',b=>log=(log+b).slice(-5000));child.on('message',m=>{if(m.type==='QA_OUTBOX_LOST')onLost(m.jobId);});
 const base='http://127.0.0.1:'+port;await wait(async()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error('QA peer exited: '+log);try{return (await fetch(base+'/api/v1/health')).ok;}catch{return false;}},'second worker core startup',20000);return {child,base};
}

// Hooks keep this shared failure protocol independent of AI/Flowable business APIs.
export async function exerciseOutboxHa(h){
 const {sql,gate,kind}=h,table=kind==='ai'?'ai_review_outbox':'workflow_outbox',key=kind==='ai'?'request_id':'command_id';let locked=false;
 const row=async id=>(await sql.query(`SELECT *,lease_until>clock_timestamp() AS live FROM ${table} WHERE ${key}=$1`,[id])).rows[0];
 const ownerIndex=async owner=>{for(const i of [0,1])if((await h.health(i)).dispatcherInstanceId===owner)return i;throw Error('Claim owner is not one of the verified QA cores');};
 try{
  await h.start(1);gate.enabled=true;console.log('Worker HA:',kind,'parallel tenants');
  assert.equal((await h.health(0)).backgroundDispatch,'leased-fenced-outbox-v1');assert.notEqual((await h.health(0)).dispatcherInstanceId,(await h.health(1)).dispatcherInstanceId);
  // Another tenant starts while the first provider response remains pending.
  gate.holdAll=true;const a=await h.enqueue('acme','parallel');await wait(()=>gate.ready(a.id),'first held provider receipt');gate.holdAll=false;gate.holdIds.add(a.id);const b=await h.enqueue('sandbox','parallel');await wait(()=>gate.count(b.id)>0,'other tenant dispatch before first completes');assert.equal((await row(a.id)).status,'PENDING');gate.all();await h.settled(a);await h.settled(b);await h.assertDurable(a);await h.assertDurable(b);
  // Keep business persistence blocked while independent heartbeats renew ownership.
  console.log('Worker HA:',kind,'heartbeat through business lock');gate.holdAll=true;const beat=await h.enqueue('acme','heartbeat');await wait(()=>gate.ready(beat.id),'heartbeat held receipt');const initial=await row(beat.id);await sql.query('BEGIN');await sql.query("SELECT revision FROM business_state WHERE tenant_id='acme' FOR UPDATE");locked=true;gate.all();
  await wait(async()=>{const current=await row(beat.id);return current.lease_until.getTime()>initial.lease_until.getTime()+5000;},'heartbeat through blocked business transaction',18000);assert.equal(gate.count(beat.id),1);assert.equal((await row(beat.id)).claim_token,initial.claim_token);await sql.query('ROLLBACK');locked=false;await h.settled(beat);await h.assertDurable(beat);
  // Supersede a still-running request, then deliver its old success or error first.
  for(const outcome of ['success','error']){console.log('Worker HA:',kind,'late '+outcome);
   gate.holdAll=true;const job=await h.enqueue('acme','stale-'+outcome);await wait(()=>gate.ready(job.id),'old held receipt');const old=await row(job.id),oldIndex=await ownerIndex(old.worker_id);
   await sql.query(`UPDATE ${table} SET lease_until=clock_timestamp()-interval '1 second' WHERE ${key}=$1`,[job.id]);const reclaimed=await wait(async()=>{const value=await row(job.id);return value.claim_token!==old.claim_token&&value.worker_id!==old.worker_id?value:false;},'second core expired-claim takeover');await wait(()=>gate.ready(job.id,2),'same-id provider replay');
   gate.release(job.id,0,outcome==='error'?{status:503,body:'{"error":"QA_OLD_FAILURE"}'}:undefined);await wait(()=>h.lost(oldIndex,job.id),'old request discarded after ownership loss');await pause(150);const pending=await row(job.id);assert.equal(pending.status,'PENDING');assert.equal(pending.attempts,0);assert.equal(pending.claim_token,reclaimed.claim_token);assert.equal(pending.response,null);gate.all();await h.settled(job);await h.assertDurable(job);assert.equal(gate.count(job.id),2);
  }
  // A killed process cannot release its lease; the remaining process waits for real expiry.
  console.log('Worker HA:',kind,'crash and real lease expiry');gate.holdAll=true;const crashed=await h.enqueue('acme','crash');await wait(()=>gate.ready(crashed.id),'crash committed upstream receipt');const old=await row(crashed.id),dead=await ownerIndex(old.worker_id),live=1-dead;await h.stop(dead);h.route(live);
  const takeover=await wait(async()=>{const value=await row(crashed.id);return value.claim_token!==old.claim_token&&value.worker_id!==old.worker_id?value:false;},'remaining core real 30-second lease expiry',42000);assert.ok(BigInt(takeover.claim_fence)>BigInt(old.claim_fence));await wait(()=>gate.ready(crashed.id,2),'durable same-id receipt after crash');gate.all();await h.settled(crashed);await h.assertDurable(crashed);assert.equal(gate.count(crashed.id),2);assert.equal((await row(crashed.id)).attempts,0);await h.afterCrash?.(crashed);
  return {twoIndependentCoreDispatchers:true,otherTenantProceedsWhileFirstProviderPending:true,heartbeatUsesIndependentPoolThroughBusinessLock:true,stableLeaseSingleProviderDispatch:true,expiredLiveOwnerSuccessAndErrorDiscarded:true,staleFailureDoesNotConsumeNewOwnerBudget:true,crashedOwnerRealLeaseExpiryTakeover:true,sameCommandOrRequestIdAndDurableProviderReceipt:true,businessAndAuditApplyOnce:true};
 }finally{if(locked)await sql.query('ROLLBACK').catch(()=>{});gate.all();if(!h.alive(0))await h.start(0);h.route(0);await h.stop(1);}
}
