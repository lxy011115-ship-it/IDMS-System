import {randomUUID} from 'node:crypto';
import {fieldStreamBinding,fieldStreamId,decodeFieldMessage} from '../../integrations/field-event.ts';
import {publicFieldProfileDigest} from '../../integrations/field-profile.ts';
import {FieldLeaseClient} from './lease-client.ts';
import {LeasedFieldReadOnlyClient} from './leased-readonly.ts';
import {FieldMqttTransport} from './mqtt-transport.ts';
import {FieldSpool} from './spool.ts';
import {FieldEdgeLock} from './edge-lock.ts';
import {prepareFieldEdgeDirectory,checkFieldEdgeStreams} from './edge-directory.ts';
import {clearFieldEdgeConfiguration,type FieldEdgeConfiguration} from './edge-config.ts';
import {FieldChannelError,fieldFailure} from './error.ts';

type Event={type:string;code?:string;pending?:number;rejected?:number;acknowledged?:number;sequence?:number;retainedStreams?:number};
type AckWaiter={eventId:string;resolve:()=>void;reject:(e:unknown)=>void};
export class FieldEdgeRunner {
 readonly #config:FieldEdgeConfiguration;readonly #emit:(event:Readonly<Event>)=>void;readonly #controller=new AbortController();readonly #lock:FieldEdgeLock;readonly #digest:string;
 #sdk:FieldLeaseClient|null=null;#reader:LeasedFieldReadOnlyClient|null=null;#mqtt:FieldMqttTransport|null=null;#spool:FieldSpool|null=null;#directory='';#waiter:AckWaiter|null=null;#job:Promise<void>|null=null;#started=false;#stopJob:Promise<unknown>|null=null;#onceExpired=false;
 constructor(config:FieldEdgeConfiguration,emit:(event:Readonly<Event>)=>void=()=>{}){this.#config=config;this.#emit=emit;this.#lock=new FieldEdgeLock(config.profile.source);this.#digest=publicFieldProfileDigest(config.publicProfile);}
 #event(event:Event){try{this.#emit(Object.freeze({...event}));}catch{}}
 #check(){if(this.#controller.signal.aborted)fieldFailure('FIELD_EDGE_STOPPED');if(!this.#lock.held)fieldFailure('FIELD_EDGE_LOCK_LOST');}
 #stats(type:string){const s=this.#spool?.stats();this.#event({type,...(s?{pending:s.pending,rejected:s.rejected,acknowledged:s.acknowledged,sequence:s.sequence}:{})});}
 #code(e:unknown){return e instanceof FieldChannelError?e.code:'FIELD_EDGE_OPERATION_FAILED';}
 async #delay(ms:number){if(this.#controller.signal.aborted)return;await new Promise<void>(ok=>{const done=()=>{clearTimeout(timer);this.#controller.signal.removeEventListener('abort',done);ok();},timer=setTimeout(done,ms);this.#controller.signal.addEventListener('abort',done,{once:true});});}
 async #disconnect(){const client=this.#mqtt;if(client){await client.close();if(this.#mqtt===client)this.#mqtt=null;}}
 async #selectSpool(){this.#check();const c=this.#config,sdk=this.#sdk!,lease=sdk.currentLease(),id=fieldStreamId(fieldStreamBinding(c.publicProfile,lease,c.lease.publicKey));if(this.#spool?.streamId===id)return;
  this.#spool?.close();this.#spool=null;const entry=await checkFieldEdgeStreams(this.#directory,id,c.spool.maxStreams);this.#check();sdk.authorize({profileDigest:this.#digest,phase:'OPEN_EDGE_SPOOL'});this.#spool=new FieldSpool(entry.path,{profile:c.publicProfile,contextLease:lease,eventKey:c.eventKey,platformPublicKey:c.lease.publicKey,capacity:c.spool.capacity,maxBytes:c.spool.maxBytes,authorize:()=>{this.#check();sdk.authorize({profileDigest:this.#digest,phase:'EDGE_SPOOL'});return sdk.currentLease();}});this.#event({type:'FIELD_EDGE_STREAM',retainedStreams:entry.retainedStreams});
 }
 async #ensure(){await this.#disconnect();this.#check();const sdk=this.#sdk!;await sdk.stopWatching();this.#check();await sdk.ensureLease({signal:this.#controller.signal});this.#check();sdk.startWatching();await this.#selectSpool();}
 async #connect(){this.#check();if(this.#mqtt?.state().ready)return;await this.#disconnect();const c=this.#config,client=new FieldMqttTransport({profile:c.publicProfile,url:c.mqtt.url,role:'EDGE',materials:c.mqtt.materials,authorize:p=>{this.#check();this.#sdk!.authorize(p);},receive:async bytes=>{this.#check();const raw=decodeFieldMessage(bytes);if(this.#spool!.acknowledge(raw)){const body=(raw as any).body;this.#stats(body.status==='STORED'?'FIELD_EDGE_STORED':'FIELD_EDGE_REJECTED');const waiter=this.#waiter;if(waiter?.eventId===body.eventId)waiter?.resolve();}}});this.#mqtt=client;await client.start({signal:this.#controller.signal});this.#check();}
 async #flush(limit:number){const c=this.#config;let sent=0;while(sent<limit){this.#check();let lease;try{lease=this.#sdk!.currentLease();}catch{}if(!lease||lease.body.expiresAtMs-Date.now()<=Math.max(c.lease.renewBeforeMs,250))await this.#ensure();await this.#selectSpool();const record=this.#spool!.ready(1,c.schedule.retryMs)[0];if(!record)return;await this.#connect();this.#check();const waiting=new Promise<void>((resolve,reject)=>{this.#waiter={eventId:record.eventId,resolve,reject};});void waiting.catch(()=>{});const waiter=this.#waiter!,timer=setTimeout(()=>waiter.reject(new FieldChannelError('FIELD_EDGE_ACK_TIMEOUT')),c.schedule.ackTimeoutMs);
   try{if(!this.#spool!.attempted(record.eventId,record.digest))fieldFailure('FIELD_EDGE_EVENT_CHANGED');await this.#mqtt!.publish(Buffer.from(record.payload),{signal:this.#controller.signal});await waiting;sent++;}finally{clearTimeout(timer);if(this.#waiter===waiter)this.#waiter=null;}
  }
 }
 stop(){if(this.#controller.signal.aborted)return;this.#controller.abort();this.#waiter?.reject(new FieldChannelError('FIELD_EDGE_STOPPED'));this.#stopJob=Promise.allSettled([this.#reader?.close(),this.#mqtt?.close()]);}
 async run(options:{once?:boolean;signal?:AbortSignal}={}){if(this.#started)fieldFailure('FIELD_EDGE_ALREADY_STARTED');this.#started=true;const abort=()=>this.stop();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)this.stop();const job=this.#run(!!options.once);this.#job=job;try{return await job;}finally{options.signal?.removeEventListener('abort',abort);}}
 async #run(once:boolean){let timer:ReturnType<typeof setTimeout>|undefined,unsubscribe:(()=>void)|undefined,complete=false;const c=this.#config;
  try{if(this.#controller.signal.aborted)fieldFailure('FIELD_EDGE_STOPPED');await this.#lock.acquire();this.#check();this.#event({type:'FIELD_EDGE_LOCKED'});this.#directory=await prepareFieldEdgeDirectory(c.root,c.spool.directory);this.#check();this.#sdk=new FieldLeaseClient({profile:c.publicProfile,requestKey:c.lease.requestKey,platformPublicKey:c.lease.publicKey,url:c.lease.url,timeoutMs:c.lease.timeoutMs,renewBeforeMs:c.lease.renewBeforeMs});this.#reader=new LeasedFieldReadOnlyClient(c.profile,c.opcua,this.#sdk);c.lease.requestKey.fill(0);c.opcua.privateKeyPem.fill(0);c.opcua.password=undefined;unsubscribe=this.#sdk.onRevoked(()=>{this.#waiter?.reject(new FieldChannelError('FIELD_EDGE_LEASE_REVOKED'));if(this.#mqtt)void this.#mqtt.close();});if(once)timer=setTimeout(()=>{this.#onceExpired=true;this.stop();},c.schedule.onceTimeoutMs);
   let nextRead=0,captured=false,failures=0;while(!this.#controller.signal.aborted){try{await this.#ensure();this.#check();if((!once||!captured)&&performance.now()>=nextRead){if(this.#spool!.canAppendBatch()){const observed=await this.#reader!.readOnce({signal:this.#controller.signal});this.#check();await this.#selectSpool();this.#spool!.append(randomUUID(),observed);captured=true;nextRead=performance.now()+c.schedule.sampleIntervalMs;this.#stats('FIELD_EDGE_ENQUEUED');}else{this.#stats('FIELD_EDGE_BACKPRESSURE');nextRead=performance.now()+c.schedule.retryMs;}}
    await this.#flush(c.schedule.batchLimit);this.#check();const stats=this.#spool!.stats();if(once&&stats.rejected)fieldFailure('FIELD_EDGE_QUARANTINED');if(once&&captured&&!stats.pending){this.#stats('FIELD_EDGE_COMPLETE');complete=true;break;}failures=0;await this.#delay(once?c.schedule.retryMs:Math.max(20,Math.min(c.schedule.retryMs,nextRead-performance.now())));
   }catch(e){if(this.#controller.signal.aborted)break;await this.#disconnect();const code=this.#code(e);this.#event({type:'FIELD_EDGE_RETRY',code});if(once||/^FIELD_(?:SPOOL_|EDGE_(?:LOCK|STREAM|SPOOL_DIRECTORY|QUARANTINED))/.test(code))throw e;failures++;await this.#delay(Math.min(30000,c.schedule.retryBackoffMs*2**Math.min(failures-1,5)));}}
   if(this.#onceExpired)fieldFailure('FIELD_EDGE_ONCE_TIMEOUT');
  }finally{clearTimeout(timer);this.stop();await this.#stopJob;await this.#disconnect();await this.#reader?.close();if(!this.#reader)await this.#sdk?.close();unsubscribe?.();this.#spool?.close();this.#spool=null;clearFieldEdgeConfiguration(c);await this.#lock.close();this.#event({type:'FIELD_EDGE_STOPPED',...(complete?{code:'COMPLETE'}:{})});}
 }
 async close(){this.stop();await this.#job?.catch(()=>{});}
}
