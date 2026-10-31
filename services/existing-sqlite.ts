import {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha,type EdgeSource} from '../integrations/telemetry.ts';

export const existingSqliteDefinitions={
 edge:{
  metadata:'CREATE TABLE metadata (name TEXT PRIMARY KEY,value TEXT NOT NULL)',
  pending:"CREATE TABLE pending (event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING',attempts INTEGER NOT NULL DEFAULT 0,last_attempt INTEGER NOT NULL DEFAULT 0,reason TEXT)",
  acknowledged:'CREATE TABLE acknowledged (event_id TEXT PRIMARY KEY,digest TEXT NOT NULL,acknowledged_at TEXT NOT NULL)'
 },
 ai:{reviews:'CREATE TABLE reviews (request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,input TEXT NOT NULL,response TEXT,raw_output TEXT,created_at TEXT NOT NULL)'}
};
const normal=(s:string)=>s.replace(/\bIF NOT EXISTS\s+/ig,'').replace(/\s+/g,' ').trim();
export function validateExistingSqlite(db:DatabaseSync,kind:'edge'|'ai',source?:EdgeSource){
 const tables=db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];
 const expected=existingSqliteDefinitions[kind];
 if(tables.length!==Object.keys(expected).length||tables.some(t=>!Object.hasOwn(expected,t.name)||normal(t.sql)!==normal(expected[t.name as keyof typeof expected])))throw Error('EXISTING_SQLITE_SCHEMA_MISMATCH');
 if(kind==='edge'){
  if(!source)throw Error('EXISTING_SPOOL_SOURCE_REQUIRED');
  const rows=db.prepare("SELECT name,value FROM metadata ORDER BY name").all() as {name:string;value:string}[];
  if(rows.length!==2||rows[0].name!=='sequence'||!/^\d+$/.test(rows[0].value)||!Number.isSafeInteger(Number(rows[0].value))||rows[1].name!=='source'||rows[1].value!==sha({tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion}))throw Error('EXISTING_SPOOL_BINDING_MISMATCH');
 }
}
export function openExistingSqlite(path:string,kind:'edge'|'ai',source?:EdgeSource,{readOnly=false}={}){
 const canonical=realpathSync(path),before=lstatSync(canonical);
 if(!before.isFile()||before.nlink!==1||before.size<512)throw Error('EXISTING_SQLITE_FILE_REQUIRED');
 const db=new DatabaseSync(canonical,{readOnly});
 try{const after=lstatSync(canonical);if(before.ino!==after.ino||before.dev!==after.dev)throw Error('EXISTING_SQLITE_FILE_CHANGED');validateExistingSqlite(db,kind,source);return db;}catch(e){db.close();throw e;}
}
