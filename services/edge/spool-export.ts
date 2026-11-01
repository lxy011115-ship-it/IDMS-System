import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {openSync,writeSync,readSync,closeSync,fsyncSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {openExistingSqlite} from '../existing-sqlite.ts';
import {authenticEvent,sha,stable,type EdgeSource} from '../../integrations/telemetry.ts';
import {spoolVersion,spoolSourceDigest,spoolKeyDigest,quarantineSummary,quarantineBytes,validSpoolAck,spoolRecoveryLimits,type QuarantineRow} from './spool-v2.ts';

function validRecord(row:QuarantineRow,source:EdgeSource){
 if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!==['event_id','payload','digest','prior_state','attempts','last_attempt','prior_reason','reason','ack_payload','quarantined_at','logical_bytes'].sort().join(',')||typeof row.payload!=='string'||typeof row.ack_payload!=='string'||Buffer.byteLength(row.payload)>8192||Buffer.byteLength(row.ack_payload)>8192||!['PENDING','REJECTED'].includes(row.prior_state)||!Number.isSafeInteger(row.attempts)||row.attempts<0||!Number.isSafeInteger(row.last_attempt)||row.last_attempt<0||!(row.prior_reason===null||typeof row.prior_reason==='string'&&Buffer.byteLength(row.prior_reason)<=8192)||typeof row.quarantined_at!=='string'||!Number.isFinite(Date.parse(row.quarantined_at))||row.logical_bytes!==quarantineBytes(row))throw Error('SPOOL_EXPORT_RECORD_INVALID');
 const e=JSON.parse(row.payload),ack=JSON.parse(row.ack_payload);
 if(!authenticEvent(e,source.signingKey)||e.eventId!==row.event_id||sha(e)!==row.digest||e.tenantId!==source.tenantId||e.edgeId!==source.edgeId||e.deviceCode!==source.deviceCode||e.mapVersion!==source.mapVersion||!Number.isSafeInteger(e.sequenceNo)||e.sequenceNo<1||!validSpoolAck(ack,source)||ack.status!=='REJECTED'||ack.eventId!==row.event_id||ack.digest!==row.digest||(ack.reason||'REJECTED')!==row.reason)throw Error('SPOOL_EXPORT_SIGNATURE_INVALID');
}
function inputFile(path:string){const p=resolve(path),s=lstatSync(p);if(p!==realpathSync(p)||!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>256*1024**2)throw Error('SPOOL_EXPORT_FILE_INVALID');return p;}
const manifestSignature=(source:EdgeSource,manifest:unknown)=>createHmac('sha256',source.acknowledgementKey).update('edge-quarantine-export-v2:'+stable(manifest)).digest('hex');
/** Private local NDJSON artifact; exact original wire strings, no signing keys. */
export function exportQuarantine(path:string,source:EdgeSource,target:string){
 const output=resolve(target),parent=dirname(output);if(parent!==realpathSync(parent)||lstatSync(parent).isSymbolicLink())throw Error('SPOOL_EXPORT_DIRECTORY_INVALID');
 const db=openExistingSqlite(path,'edge',source,{readOnly:true});let fd:number|undefined;
 try{
  if(spoolVersion(db)!==2)throw Error('SPOOL_EXPORT_V2_REQUIRED');db.exec('BEGIN');const summary=quarantineSummary(db);
  if(summary.records>10000||summary.logicalBytes>spoolRecoveryLimits.logicalBytes)throw Error('SPOOL_EXPORT_LIMIT');
  fd=openSync(output,'wx',0o600);const h=createHash('sha256');let count=0,logicalBytes=0;
  const line=(item:unknown,hash=true)=>{const bytes=Buffer.from(JSON.stringify(item)+'\n');if(bytes.length>131072)throw Error('SPOOL_EXPORT_LINE_LIMIT');if(hash)h.update(bytes);let offset=0;while(offset<bytes.length)offset+=writeSync(fd!,bytes,offset);};
  const header={format:'IDMS_EDGE_QUARANTINE_EXPORT_V2',sourceDigest:spoolSourceDigest(source),keyDigest:spoolKeyDigest(source),records:summary.records,logicalBytes:summary.logicalBytes};line(header);
  for(const row of db.prepare('SELECT * FROM quarantine ORDER BY event_id').iterate() as IterableIterator<QuarantineRow>){validRecord(row,source);count++;logicalBytes+=row.logical_bytes;line(row);}
  if(count!==summary.records||logicalBytes!==summary.logicalBytes)throw Error('SPOOL_EXPORT_CONSERVATION_FAILED');
  const digest=h.digest('hex'),manifest={end:true,records:count,logicalBytes,digest};line({...manifest,signature:manifestSignature(source,{header, ...manifest})},false);fsyncSync(fd);return {records:count,logicalBytes,digest};
 }finally{if(fd!==undefined)closeSync(fd);if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
export function verifyQuarantineExport(path:string,source:EdgeSource){
 const fd=openSync(inputFile(path),'r'),decoder=new TextDecoder('utf-8',{fatal:true}),buffer=Buffer.alloc(65536),hash=createHash('sha256');let pending='',lines=0,header:any,footer:any,previous='',count=0,logicalBytes=0;
 const accept=(line:string)=>{
  if(Buffer.byteLength(line)>131072||footer)throw Error('SPOOL_EXPORT_FORMAT_INVALID');const item=JSON.parse(line);lines++;
  if(lines===1){header=item;if(stable(Object.keys(item).sort())!==stable(['format','sourceDigest','keyDigest','records','logicalBytes'].sort())||item.format!=='IDMS_EDGE_QUARANTINE_EXPORT_V2'||item.sourceDigest!==spoolSourceDigest(source)||item.keyDigest!==spoolKeyDigest(source)||!Number.isSafeInteger(item.records)||item.records<0||item.records>10000||!Number.isSafeInteger(item.logicalBytes)||item.logicalBytes<0||item.logicalBytes>spoolRecoveryLimits.logicalBytes)throw Error('SPOOL_EXPORT_HEADER_INVALID');}
  else if(item.end===true){footer=item;return;}
  else{validRecord(item,source);if(item.event_id<=previous||++count>10000)throw Error('SPOOL_EXPORT_ORDER_INVALID');previous=item.event_id;logicalBytes+=item.logical_bytes;if(logicalBytes>spoolRecoveryLimits.logicalBytes)throw Error('SPOOL_EXPORT_LIMIT');}
  hash.update(Buffer.from(line+'\n','utf8'));
 };
 try{
  for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;pending+=decoder.decode(buffer.subarray(0,n),{stream:true});let split;while((split=pending.indexOf('\n'))>=0){accept(pending.slice(0,split));pending=pending.slice(split+1);}if(Buffer.byteLength(pending)>131072)throw Error('SPOOL_EXPORT_LINE_LIMIT');}
  pending+=decoder.decode();if(pending||!header||!footer||Object.keys(footer).sort().join(',')!==['end','records','logicalBytes','digest','signature'].sort().join(',')||count!==header.records||count!==footer.records||logicalBytes!==header.logicalBytes||logicalBytes!==footer.logicalBytes||hash.digest('hex')!==footer.digest||typeof footer.signature!=='string'||!/^[a-f0-9]{64}$/.test(footer.signature))throw Error('SPOOL_EXPORT_INTEGRITY_FAILED');
  const {signature,...manifest}=footer;if(!timingSafeEqual(Buffer.from(signature),Buffer.from(manifestSignature(source,{header,...manifest}))))throw Error('SPOOL_EXPORT_SIGNATURE_INVALID');
  return {records:count,logicalBytes,digest:footer.digest,originalSignaturesVerified:true};
 }finally{closeSync(fd);}
}
