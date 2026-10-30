import {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync} from 'node:fs';
import {mkdir,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {applicationHashV1 as hash,applicationNeedV1 as need,applicationManifestV1} from './runtime-application-config-v1.mjs';

const events=new Set(['LAUNCH_INTENT','READY','STOP_INTENT','DRAINING','CLOSED','EXIT','GROUP_READY','GROUP_STOPPING','GROUP_CLOSED','FAILED']);
/** Lifecycle facts are checked in addition to hashes; a valid hash cannot invent a normal stop. */
export function applicationRegistryLifecycleV1(header,values){
 const slots=new Map(header.manifest.components.map(c=>[c.id,{component:c,launched:false,ready:false,stop:null,draining:false,closed:false,exit:null,pid:null}]));let groupReady=false,stopping=false,terminal=false;
 for(const value of values){
  need(!terminal,'APPLICATION_REGISTRY_AFTER_TERMINAL');const s=value.componentId?slots.get(value.componentId):null;
  if(['LAUNCH_INTENT','READY','STOP_INTENT','DRAINING','CLOSED','EXIT'].includes(value.event))need(s,'APPLICATION_REGISTRY_COMPONENT');
  if(value.event==='LAUNCH_INTENT'){need(!stopping&&!s.launched&&value.kind===s.component.kind&&/^[a-f0-9]{64}$/.test(value.configSha256),'APPLICATION_REGISTRY_LAUNCH');if(s.component.kind==='SITE')need([...slots.values()].filter(x=>x.component.kind!=='SITE').every(x=>x.ready&&!x.exit),'APPLICATION_REGISTRY_INGRESS_EARLY');s.launched=true;s.configSha256=value.configSha256;}
  else if(value.event==='READY'){need(!stopping&&s.launched&&!s.ready&&!s.exit&&Number.isInteger(value.pid)&&value.pid>0&&value.configSha256===s.configSha256&&value.kind===s.component.kind&&canonical(value.binding)===canonical(header.manifest.binding)&&canonical(value.tenantIds)===canonical(s.component.kind==='SITE'?[...header.manifest.tenantIds].sort():[s.component.tenantId]),'APPLICATION_REGISTRY_READY');s.ready=true;s.pid=value.pid;}
  else if(value.event==='STOP_INTENT'){need(stopping&&s.launched&&!s.exit&&!s.stop&&/^[a-f0-9-]{36}$/.test(value.requestId)&&(s.pid===null||value.pid===s.pid),'APPLICATION_REGISTRY_STOP');const site=[...slots.values()].find(x=>x.component.kind==='SITE');if(s.component.kind!=='SITE')need(!site.launched||site.exit,'APPLICATION_REGISTRY_INGRESS_STILL_LIVE');s.stop=value.requestId;}
  else if(value.event==='DRAINING'){need(s.stop===value.requestId&&!s.draining&&!s.closed&&!s.exit&&value.pid===s.pid,'APPLICATION_REGISTRY_DRAIN');s.draining=true;}
  else if(value.event==='CLOSED'){need(s.stop===value.requestId&&!s.closed&&!s.exit&&(!s.ready||s.draining)&&(s.pid===null||value.pid===s.pid),'APPLICATION_REGISTRY_CLOSE');s.closed=true;}
  else if(value.event==='EXIT'){need(s.launched&&!s.exit&&(s.pid===null||s.pid===value.pid)&&(value.code===null||Number.isInteger(value.code))&&(value.signal===null||typeof value.signal==='string'),'APPLICATION_REGISTRY_EXIT');s.exit={code:value.code,signal:value.signal};}
  else if(value.event==='GROUP_READY'){need(!groupReady&&!stopping&&[...slots.values()].every(s=>s.ready&&!s.exit),'APPLICATION_REGISTRY_GROUP_READY');groupReady=true;}
  else if(value.event==='GROUP_STOPPING'){need(!stopping&&/^[a-f0-9-]{36}$/.test(value.requestId),'APPLICATION_REGISTRY_GROUP_STOP');stopping=true;}
  else if(value.event==='GROUP_CLOSED'){need(stopping&&[...slots.values()].every(s=>s.ready&&s.closed&&s.exit?.code===0&&s.exit.signal===null),'APPLICATION_REGISTRY_GROUP_CLOSE');terminal=true;}
  else if(value.event==='FAILED'){need(stopping,'APPLICATION_REGISTRY_GROUP_FAILURE');terminal=true;}
  else throw Error('APPLICATION_REGISTRY_EVENT');
 }
 return{groupReady,stopping,terminal};
}
export async function createApplicationRegistryV1(directory,manifest,pins){
 manifest=applicationManifestV1(manifest);need(Array.isArray(pins)&&pins.length>0&&pins.length<=256,'APPLICATION_REGISTRY_PINS');
 const root=resolve(directory),parent=dirname(root),actualParent=await realpath(parent),normalize=p=>process.platform==='win32'?p.toLowerCase():p;need(normalize(actualParent)===normalize(parent),'APPLICATION_REGISTRY_PARENT_ALIAS');await mkdir(root,{recursive:false,mode:0o700});await privateDirectory(root);const storeFile=join(root,'applications.sqlite'),ownerId=randomUUID(),header={format:'RUNTIME_APPLICATION_REGISTRY_V1',ownerId,ownerPid:process.pid,manifest,pins},body=canonical(header),headerHash=hash(body);
 await privateNewFile(storeFile,Buffer.alloc(0));const db=new DatabaseSync(storeFile,{allowExtension:false});
 try{db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE application_meta(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL,body_hash TEXT NOT NULL,sequence INTEGER NOT NULL,tip TEXT NOT NULL);CREATE TABLE application_events(sequence INTEGER PRIMARY KEY,body TEXT NOT NULL,body_hash TEXT NOT NULL,previous_hash TEXT NOT NULL);');db.prepare('INSERT INTO application_meta VALUES(1,?,?,0,?)').run(body,headerHash,headerHash);}finally{db.close();}
 const trust={format:'RUNTIME_APPLICATION_REGISTRY_TRUST_V1',storeFile,ownerId,headerHash};await privateNewFile(join(root,'trust.json'),canonical(trust));return trust;
}
async function open(trust,write){
 need(trust?.format==='RUNTIME_APPLICATION_REGISTRY_TRUST_V1','APPLICATION_REGISTRY_TRUST');
 const path=resolve(trust.storeFile),normalize=p=>process.platform==='win32'?p.toLowerCase():p;
 // WAL checkpoints legitimately change the database bytes and mtime. Bind its
 // regular file identity; validate content under the SQLite snapshot and hash chain.
 function identity(){const s=lstatSync(path,{bigint:true});need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.size>0n&&s.size<=2n*1024n**2n&&normalize(realpathSync(path))===normalize(path),'APPLICATION_REGISTRY_FILE');return s;}
 const before=identity(),assertIdentity=()=>{const current=identity();need(current.dev===before.dev&&current.ino===before.ino,'APPLICATION_REGISTRY_FILE_REPLACED');};
 let db;try{db=new DatabaseSync(path,{readOnly:!write,allowExtension:false,timeout:3000});assertIdentity();if(write)db.exec('PRAGMA synchronous=FULL;');return{db,assertIdentity};}catch(e){db?.close();throw e;}
}
function inspect(db,trust){
 const meta=db.prepare('SELECT * FROM application_meta WHERE id=1').get();need(meta&&meta.body_hash===trust.headerHash&&hash(meta.body)===trust.headerHash,'APPLICATION_REGISTRY_HEADER');const header=JSON.parse(meta.body);need(canonical(header)===meta.body&&header.ownerId===trust.ownerId,'APPLICATION_REGISTRY_OWNER');
 const rows=db.prepare('SELECT * FROM application_events ORDER BY sequence').all(),values=[];let previous=trust.headerHash;
 for(const[rowIndex,row]of rows.entries()){need(row.sequence===rowIndex+1&&row.previous_hash===previous&&hash(row.previous_hash+'\n'+row.body)===row.body_hash,'APPLICATION_REGISTRY_CHAIN');const value=JSON.parse(row.body);need(canonical(value)===row.body&&value.sequence===row.sequence&&value.ownerId===trust.ownerId&&events.has(value.event),'APPLICATION_REGISTRY_EVENT');previous=row.body_hash;values.push(value);}
 need(rows.length===meta.sequence&&previous===meta.tip,'APPLICATION_REGISTRY_TIP');const lifecycle=applicationRegistryLifecycleV1(header,values);return{header,events:values,sequence:rows.length,tip:previous,lifecycle};
}
export async function readApplicationRegistryV1(trust){const{db,assertIdentity}=await open(trust,false);try{db.exec('BEGIN;');const value=inspect(db,trust);assertIdentity();db.exec('COMMIT;');assertIdentity();return value;}finally{db.close();}}
export async function appendApplicationRegistryV1(trust,event,details={}){
 const fields={LAUNCH_INTENT:['componentId','kind','configSha256'],READY:['componentId','pid','configSha256','kind','tenantIds','binding'],STOP_INTENT:['componentId','pid','requestId'],DRAINING:['componentId','pid','requestId'],CLOSED:['componentId','pid','requestId'],EXIT:['componentId','pid','code','signal'],GROUP_READY:[],GROUP_STOPPING:['requestId'],GROUP_CLOSED:[],FAILED:['errorCode']};
 need(events.has(event)&&details&&typeof details==='object'&&!Array.isArray(details),'APPLICATION_REGISTRY_EVENT');need(Object.keys(details).sort().join(',')===[...fields[event]].sort().join(','),'APPLICATION_REGISTRY_DETAILS');
 if('errorCode'in details)need(typeof details.errorCode==='string'&&/^[A-Z][A-Z0-9_]{3,120}$/.test(details.errorCode),'APPLICATION_REGISTRY_ERROR_CODE');
 const{db,assertIdentity}=await open(trust,true);try{db.exec('BEGIN IMMEDIATE;');const current=inspect(db,trust),value={ownerId:trust.ownerId,sequence:current.sequence+1,event,at:Date.now(),...details},body=canonical(value);need(Buffer.byteLength(body)<=16384,'APPLICATION_REGISTRY_EVENT_SIZE');applicationRegistryLifecycleV1(current.header,[...current.events,value]);const digest=hash(current.tip+'\n'+body);db.prepare('INSERT INTO application_events VALUES(?,?,?,?)').run(value.sequence,body,digest,current.tip);db.prepare('UPDATE application_meta SET sequence=?,tip=? WHERE id=1').run(value.sequence,digest);assertIdentity();db.exec('COMMIT;');assertIdentity();return value;}catch(e){try{db.exec('ROLLBACK;');}catch{}throw e;}finally{db.close();}
}
