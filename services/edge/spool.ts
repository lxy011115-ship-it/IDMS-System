import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {openExistingSqlite} from '../existing-sqlite.ts';
import { authenticAck, sha, signEvent, type EdgeSource, type TelemetryEvent, type TelemetryAck } from '../../integrations/telemetry.ts';
export class EdgeSpool {
  db:DatabaseSync; source:EdgeSource; capacity:number;
  constructor(path:string,source:EdgeSource,capacity=10000,{existingOnly=false}={}){
    this.source=source;this.capacity=capacity;
    if(existingOnly){this.db=openExistingSqlite(path,'edge',source);this.db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');return;}
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES('sequence','0');
      CREATE TABLE IF NOT EXISTS pending (event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING',attempts INTEGER NOT NULL DEFAULT 0,last_attempt INTEGER NOT NULL DEFAULT 0,reason TEXT);
      CREATE TABLE IF NOT EXISTS acknowledged (event_id TEXT PRIMARY KEY,digest TEXT NOT NULL,acknowledged_at TEXT NOT NULL);
    `);
    const binding=this.db.prepare('SELECT value FROM metadata WHERE name=?').get('source') as {value:string}|undefined;
    const expected=sha({tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion});
    if(binding&&binding.value!==expected){this.db.close();throw Error('Spool belongs to another source or mapping; do not relabel buffered data');}
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('source',expected);
  }
  append(input:Pick<TelemetryEvent,'tagCode'|'nodeId'|'eventTime'|'value'|'unit'|'quality'>){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const count=this.db.prepare('SELECT count(*) AS n FROM pending').get() as {n:number};if(count.n>=this.capacity)throw Error('SPOOL_CAPACITY_REACHED');
      const sequence=Number((this.db.prepare("SELECT value FROM metadata WHERE name='sequence'").get() as {value:string}).value)+1;
      if(!Number.isSafeInteger(sequence))throw Error('Sequence exhausted');
      const event=signEvent({version:1,eventId:randomUUID(),tenantId:this.source.tenantId,edgeId:this.source.edgeId,deviceCode:this.source.deviceCode,mapVersion:this.source.mapVersion,sequenceNo:sequence,...input},this.source.signingKey);
      this.db.prepare('INSERT INTO pending(event_id,payload,digest) VALUES(?,?,?)').run(event.eventId,JSON.stringify(event),sha(event));
      this.db.prepare("UPDATE metadata SET value=? WHERE name='sequence'").run(String(sequence));this.db.exec('COMMIT');return event;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  ready(limit=20,retryMs=5000){return this.db.prepare("SELECT event_id,payload FROM pending WHERE state='PENDING' AND last_attempt<=? ORDER BY rowid LIMIT ?").all(Date.now()-retryMs,limit) as {event_id:string;payload:string}[];}
  attempted(id:string){this.db.prepare('UPDATE pending SET attempts=attempts+1,last_attempt=? WHERE event_id=?').run(Date.now(),id);}
  acknowledge(input:unknown){
    if(!authenticAck(input,this.source.acknowledgementKey)||input.tenantId!==this.source.tenantId||input.edgeId!==this.source.edgeId||input.version!==1||!['STORED','REJECTED'].includes(input.status))return false;
    const row=this.db.prepare('SELECT digest FROM pending WHERE event_id=?').get(input.eventId) as {digest:string}|undefined;if(!row||row.digest!==input.digest)return false;
    this.db.exec('BEGIN IMMEDIATE');try{
      if(input.status==='STORED'){
        this.db.prepare('INSERT OR IGNORE INTO acknowledged VALUES(?,?,?)').run(input.eventId,input.digest,new Date().toISOString());
        this.db.prepare('DELETE FROM pending WHERE event_id=?').run(input.eventId);
      }else this.db.prepare("UPDATE pending SET state='REJECTED',reason=? WHERE event_id=?").run(input.reason||'REJECTED',input.eventId);
      this.db.exec('COMMIT');return true;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  stats(){return {pending:Number((this.db.prepare("SELECT count(*) AS n FROM pending WHERE state='PENDING'").get() as {n:number}).n),rejected:Number((this.db.prepare("SELECT count(*) AS n FROM pending WHERE state='REJECTED'").get() as {n:number}).n),acknowledged:Number((this.db.prepare('SELECT count(*) AS n FROM acknowledged').get() as {n:number}).n),sequence:Number((this.db.prepare("SELECT value FROM metadata WHERE name='sequence'").get() as {value:string}).value)};}
  close(){this.db.close();}
}
