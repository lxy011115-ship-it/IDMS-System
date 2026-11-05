/** Bound application acknowledgement wait separately from MQTT PUBACK. */
export class EdgePublishWindow {
 private active:{id:string;at:number}|undefined;readonly waitMs:number;
 constructor(waitMs=30000){if(!Number.isSafeInteger(waitMs)||waitMs<1000||waitMs>300000)throw Error('SPOOL_ACK_WINDOW_INVALID');this.waitMs=waitMs;}
 blocked(now=performance.now()){if(this.active&&now-this.active.at>=this.waitMs)this.active=undefined;return !!this.active;}
 begin(id:string,now=performance.now()){if(this.blocked(now))return false;this.active={id,at:now};return true;}
 complete(id:string){if(this.active?.id!==id)return false;this.active=undefined;return true;}
}
