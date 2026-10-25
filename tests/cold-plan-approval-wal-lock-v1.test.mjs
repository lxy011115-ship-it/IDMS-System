import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {privateDirectory} from '../scripts/backup-support.mjs';

test('a real WAL writer reservation blocks another writer, preserves readable committed state and permits a fresh write after release',async()=>{
 const dir=resolve('work/cold-plan-approval-wal-tests',randomUUID());await privateDirectory(dir);const file=join(dir,'control.sqlite'),first=new DatabaseSync(file,{allowExtension:false});let second,reader;
 try{assert.equal(first.prepare('PRAGMA journal_mode=WAL').get().journal_mode,'wal');first.exec('CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT NOT NULL);INSERT INTO records VALUES(1,\'original\')');second=new DatabaseSync(file,{allowExtension:false});reader=new DatabaseSync(file,{readOnly:true,allowExtension:false});second.exec('PRAGMA busy_timeout=25');first.exec('BEGIN IMMEDIATE');let blocked;try{second.exec('BEGIN IMMEDIATE');}catch(e){blocked=e;}assert(blocked);assert.equal(blocked.code,'ERR_SQLITE_ERROR');assert.equal(blocked.errcode,5);assert.match(blocked.message,/database is locked/);assert.equal(second.isTransaction,false);assert.equal(reader.prepare('SELECT count(*) AS n FROM records').get().n,1);assert.equal(reader.prepare('SELECT value FROM records WHERE id=1').get().value,'original');first.exec('ROLLBACK');second.exec('BEGIN IMMEDIATE;INSERT INTO records VALUES(2,\'recovered\');COMMIT');assert.equal(reader.prepare('SELECT count(*) AS n FROM records').get().n,2);assert.equal(reader.prepare('PRAGMA journal_mode').get().journal_mode,'wal');}
 finally{for(const db of[reader,second,first])if(db){if(db.isTransaction)db.exec('ROLLBACK');db.close();}}
});
