import {open,lstat} from 'node:fs/promises';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {backupRegular,backupUnchanged,readExactly} from './field-backup-io.mjs';
import {maintenanceFailure} from './field-maintenance-record.mjs';
const fail=()=>{throw maintenanceFailure('FIELD_MAINTENANCE_AUTH_JOURNAL_INVALID');};
export class FieldMaintenanceAuthJournal {
 #path;#key;#session;#sequence=0;#head=null;#bytes=0;#tail=Promise.resolve();#closed=false;
 constructor(path,key,sessionId){if(typeof key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(key)||Buffer.from(key,'base64url').length!==32)fail();this.#path=path;this.#key=Buffer.from(key,'base64url');this.#session=sessionId;}
 #mac(v){return createHmac('sha256',this.#key).update(canonical(v)).digest('hex');}
 #check(raw,sequence,previousHash){
  if(!raw||Object.keys(raw).sort().join(',')!=='action,actorId,actorTenantId,eventAt,format,hash,mac,previousHash,roles,sequence,sessionId'||raw.format!=='idms-field-maintenance-auth-event-v1'||raw.sessionId!==this.#session||raw.sequence!==sequence||raw.previousHash!==previousHash||!['AUTH_LOGIN','AUTH_LOGOUT','RECOVERY_VIEW_READ'].includes(raw.action)||typeof raw.actorId!=='string'||!raw.actorId||raw.actorId.length>128||typeof raw.actorTenantId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(raw.actorTenantId)||!Array.isArray(raw.roles)||raw.roles.length>32||raw.roles.some(r=>typeof r!=='string'||!r||r.length>128)||canonical(raw.roles)!==canonical([...new Set(raw.roles)].sort())||typeof raw.eventAt!=='string'||!Number.isFinite(Date.parse(raw.eventAt))||new Date(raw.eventAt).toISOString()!==raw.eventAt)fail();
  const {hash,mac,...body}=raw;if(typeof hash!=='string'||hash!==sourceFreezeSha(body)||typeof mac!=='string'||!/^[a-f0-9]{64}$/.test(mac)||!timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(this.#mac({...body,hash}),'hex')))fail();return raw;
 }
 async #image(){
  const entry=await backupRegular(this.#path,4*1024**2);try{const bytes=await readExactly(entry.file,Number(entry.stat.size),0);await backupUnchanged(entry);let sequence=0,head=null;if(bytes.length){const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.endsWith('\n'))fail();for(const line of text.slice(0,-1).split('\n')){if(Buffer.byteLength(line)>8192||sequence>=4096)fail();const value=this.#check(JSON.parse(line),sequence+1,head);if(line!==canonical(value))fail();sequence++;head=value.hash;}}return {sequence,head,bytes:bytes.length};}finally{await entry.file.close();}
 }
 async open(){const image=await this.#image();this.#sequence=image.sequence;this.#head=image.head;this.#bytes=image.bytes;return this;}
 append(who,action){
  const work=async()=>{if(this.#closed)fail();const image=await this.#image();if(image.sequence!==this.#sequence||image.head!==this.#head||image.bytes!==this.#bytes||image.sequence>=4096)fail();const body={format:'idms-field-maintenance-auth-event-v1',sessionId:this.#session,sequence:image.sequence+1,previousHash:image.head,eventAt:new Date().toISOString(),actorId:who.actorId,actorTenantId:who.tenantId,roles:[...new Set(who.roles||[])].sort(),action},hash=sourceFreezeSha(body),event={...body,hash,mac:this.#mac({...body,hash})};this.#check(event,event.sequence,image.head);const bytes=Buffer.from(canonical(event)+'\n');if(bytes.length>8192||image.bytes+bytes.length>4*1024**2)fail();const before=await lstat(this.#path,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)fail();const f=await open(this.#path,'a');try{const current=await f.stat({bigint:true});if(current.dev!==before.dev||current.ino!==before.ino||current.nlink!==1n||current.size!==BigInt(image.bytes))fail();await f.writeFile(bytes);await f.sync();}finally{await f.close();}const next=await this.#image();if(next.sequence!==event.sequence||next.head!==hash)fail();this.#sequence=next.sequence;this.#head=next.head;this.#bytes=next.bytes;return {sequence:next.sequence,hash:next.head};};
  const pending=this.#tail.then(work,work);this.#tail=pending.catch(()=>{});return pending;
 }
 async close(){await this.#tail;this.#closed=true;this.#key.fill(0);}
}
