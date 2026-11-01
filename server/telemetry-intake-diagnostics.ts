export type IntakeStage='IDLE'|'VALIDATING'|'TRANSACTION'|'COMMIT_CONFIRMED'|'ACK_QUEUED'|'ACK_CONFIRMED'|'ACK_UNCONFIRMED'|'FAILED';
const counterNames=['received','stored','rejected','protocolRejected','capacityRejected','integrityRejected','commitUnconfirmed','queueRejected','transactionFailed','ackQueued','ackConfirmed','ackUnconfirmed'] as const;
type Counter=typeof counterNames[number];
export class TelemetryIntakeDiagnostics {
 private counters=Object.fromEntries(counterNames.map(k=>[k,0])) as Record<Counter,number>;
 private stage:IntakeStage='IDLE';private code='NOT_OBSERVED';private serial=0;
 private increment(k:Counter){this.counters[k]=Math.min(Number.MAX_SAFE_INTEGER,this.counters[k]+1);}
 begin(){this.increment('received');this.serial=this.serial===Number.MAX_SAFE_INTEGER?1:this.serial+1;const id=this.serial;this.stage='VALIDATING';this.code='IN_PROGRESS';
  return {stage:(stage:IntakeStage)=>{if(id===this.serial)this.stage=stage;},protocolRejected:()=>{this.increment('protocolRejected');if(id===this.serial){this.stage='FAILED';this.code='PROTOCOL_REJECTED';}},committed:(status:'STORED'|'REJECTED')=>{this.increment(status==='STORED'?'stored':'rejected');if(id===this.serial){this.stage='COMMIT_CONFIRMED';this.code='BUSINESS_COMMITTED';}},ackQueued:()=>{this.increment('ackQueued');if(id===this.serial)this.stage='ACK_QUEUED';},acknowledged:(confirmed:boolean)=>{this.increment(confirmed?'ackConfirmed':'ackUnconfirmed');if(id===this.serial){this.stage=confirmed?'ACK_CONFIRMED':'ACK_UNCONFIRMED';this.code=confirmed?'BUSINESS_ACK_BROKER_CONFIRMED':'ACK_UNCONFIRMED';}},failed:(error:unknown)=>{
   const supplied=(error as {code?:unknown})?.code;
   const [counter,code]:[Counter,string]=supplied==='MEMORY_BUDGET'?['capacityRejected','MEMORY_BUDGET']:supplied==='COMMIT_UNCONFIRMED'?['commitUnconfirmed','COMMIT_UNCONFIRMED']:supplied==='WRITE_POSTIMAGE_MISMATCH'?['integrityRejected','WRITE_POSTIMAGE_MISMATCH']:['CAPACITY_BUSY','QUEUE_EXPIRED','CAPACITY_CLOSING','REQUEST_CANCELLED'].includes(String(supplied))?['queueRejected','QUEUE_REJECTED']:['transactionFailed','TRANSACTION_FAILED'];
   this.increment(counter);if(id===this.serial){this.stage='FAILED';this.code=code;}return code;
  }};
 }
 snapshot(){return {format:1,stage:this.stage,code:this.code,counters:{...this.counters},scope:'PROCESS_OBSERVATION_ONLY',endToEndDeliveryConfirmed:false};}
}
