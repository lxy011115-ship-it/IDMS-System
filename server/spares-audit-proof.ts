import type pg from 'pg';
import {digest,canonical} from './imports.ts';
import {WeightedCache,holdValue} from './capacity.ts';
import {SparesAuditChain,sparesAuditFailure,checkSparesRead,type SpareAuditRow} from './spares-audit-chain.ts';
import {hasSpareProofScope,stageSpareProof} from './spares-proof-scope.ts';
import {streamRows} from './pg-row-stream.ts';

export interface SpareSegmentMetadata {segment:string;count:string;first:string;last:string;fingerprint:string}
interface Proof extends SpareSegmentMetadata {generation:string;tenant:string;firstPrevious:string;lastHash:string}
const hex=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const decimal=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=9223372036854775807n;
export const spareProofGenerationSql=`/* IDMS_SPARES_PROOF_GENERATION */ SELECT current_database() AS database,current_user AS username,
 current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
 (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
 pg_postmaster_start_time()::text AS server_started,inet_server_addr()::text AS address,inet_server_port()::text AS port,
 floor(pg_snapshot_xmax(pg_current_snapshot())::text::numeric/4294967296)::text AS xid_epoch,
 c.oid::text AS relation_oid,pg_relation_filenode(c.oid)::text AS relation_file,c.xmin::text AS catalog_xmin,c.relnamespace::text AS namespace_oid,c.reltoastrelid::text AS toast_oid,c.relkind
 FROM pg_class c WHERE c.oid='idms_spares.events'::regclass`;
export const spareSegmentMetadataSql=`/* IDMS_SPARES_SEGMENT_METADATA */ SELECT floor((sequence::numeric-1)/256)::bigint::text AS segment,count(*)::text AS count,
 min(sequence)::text AS first,max(sequence)::text AS last,
 encode(sha256(convert_to(string_agg(sequence::text||':'||tableoid::text||':'||xmin::text||':'||ctid::text,',' ORDER BY sequence),'UTF8')),'hex') AS fingerprint
 FROM idms_spares.events WHERE tenant_id=$1 GROUP BY floor((sequence::numeric-1)/256)::bigint ORDER BY floor((sequence::numeric-1)/256)::bigint`;
export function spareProofGeneration(row:Record<string,unknown>,endpoint:{host:unknown;port:unknown}){
 const names=['database','username','database_oid','server_started','xid_epoch','relation_oid','relation_file','catalog_xmin','namespace_oid','toast_oid'];
 if(row.isolation!=='repeatable read'||!['on','off'].includes(String(row.read_only))||row.relkind!=='r'||names.some(k=>typeof row[k]!=='string'||!row[k])||typeof endpoint.host!=='string'||!endpoint.host||!Number.isInteger(Number(endpoint.port))||Number(endpoint.port)<1||Number(endpoint.port)>65535)throw sparesAuditFailure();
 if(!decimal(row.xid_epoch)||!decimal(row.database_oid)||!decimal(row.relation_oid)||!decimal(row.relation_file)||!decimal(row.namespace_oid)||!decimal(row.toast_oid)||!decimal(row.catalog_xmin))throw sparesAuditFailure();
 if(row.address!==null&&(typeof row.address!=='string'||!row.address)||row.port!==null&&(!decimal(row.port)||BigInt(row.port)===0n||BigInt(row.port)>65535n))throw sparesAuditFailure();
 if(row.address===null&&!endpoint.host.startsWith('/'))throw sparesAuditFailure();
 return digest(canonical({endpoint:{host:endpoint.host,port:Number(endpoint.port)},...row,read_only:'verified-snapshot'}));
}
export function spareSegmentBounds(row:SpareSegmentMetadata,index:bigint,revision:bigint){
 const first=index*256n+1n,last=first+255n<revision?first+255n:revision;
 if(first>revision||row.segment!==index.toString()||row.first!==first.toString()||row.last!==last.toString()||row.count!==(last-first+1n).toString()||!hex(row.fingerprint))throw sparesAuditFailure();return {first,last};
}
export class SpareAuditProofCache {
 private cache:WeightedCache<string,Proof>;private stats={metadataRows:0,verifiedSegments:0,reusedSegments:0,bodyRows:0};
 constructor(entries=1024){if(!Number.isInteger(entries)||entries<1||entries>1024)throw Error('Invalid proof cache size');this.cache=new WeightedCache({entries,bytes:4*1024*1024,entryBytes:2048,idleMs:60000});}
 clear(){this.cache.clear();this.stats={metadataRows:0,verifiedSegments:0,reusedSegments:0,bodyRows:0};}
 snapshot(){return {...this.cache.snapshot(),...this.stats};}
 async verify(c:pg.PoolClient,tenant:string,revision:string){
  if(!hasSpareProofScope(c)||!decimal(revision))throw sparesAuditFailure();checkSparesRead();
  // Prevent table rewrite/replace between the generation probe and metadata read.
  await c.query('/* IDMS_SPARES_AUDIT_LOCK */ LOCK TABLE idms_spares.events IN ACCESS SHARE MODE');
  const generations=(await c.query(spareProofGenerationSql)).rows;if(generations.length!==1)throw sparesAuditFailure();
  const generation=spareProofGeneration(generations[0],{host:(c as any).host,port:(c as any).port}),head=BigInt(revision),batch={complete:false};let index=0n,sequence=0n,previous='GENESIS',open=false;
  try{
   await c.query('DECLARE idms_spares_proof_metadata NO SCROLL CURSOR FOR '+spareSegmentMetadataSql,[tenant]);open=true;
   while(true){
    checkSparesRead();const rows=(await c.query('FETCH FORWARD 16 FROM idms_spares_proof_metadata')).rows as SpareSegmentMetadata[];if(rows.length>16)throw sparesAuditFailure();if(!rows.length)break;const release=holdValue(rows);
    try{for(const row of rows){
     checkSparesRead();this.stats.metadataRows++;const bounds=spareSegmentBounds(row,index,head),key=digest(canonical({generation,tenant,segment:row.segment})),cached=this.cache.get(key);
     if(cached&&cached.generation===generation&&cached.tenant===tenant&&cached.fingerprint===row.fingerprint&&cached.first===row.first&&cached.last===row.last&&cached.count===row.count){
      if(cached.firstPrevious!==previous||!hex(cached.lastHash))throw sparesAuditFailure();previous=cached.lastHash;sequence=bounds.last;this.stats.reusedSegments++;
     }else{
      const chain=new SparesAuditChain(tenant);chain.sequence=bounds.first-1n;chain.previous=previous;const firstPrevious=previous;
      await streamRows<SpareAuditRow>(c,'/* IDMS_SPARES_SEGMENT_BODY */ SELECT sequence::text,site_code,body,hash FROM idms_spares.events WHERE tenant_id=$1 AND sequence>=$2::bigint AND sequence<=$3::bigint ORDER BY idms_spares.events.sequence',r=>{const releaseRow=holdValue(r);try{chain.accept(r);this.stats.bodyRows++;}finally{releaseRow();}},()=>{},[tenant,bounds.first.toString(),bounds.last.toString()]);
      const result=chain.finish(bounds.last.toString());sequence=result.sequence;previous=result.previous;this.stats.verifiedSegments++;
      const proof:Proof={...row,generation,tenant,firstPrevious,lastHash:previous};stageSpareProof(c,key,proof,()=>{if(batch.complete)this.cache.set(key,proof);});
     }
     index++;
    }}finally{release();}
   }
   if(sequence!==head||index!==(head+255n)/256n)throw sparesAuditFailure();await c.query('CLOSE idms_spares_proof_metadata');open=false;checkSparesRead();batch.complete=true;return {sequence,previous};
  }finally{if(open)await c.query('CLOSE idms_spares_proof_metadata').catch(()=>{});}
 }
}
export const spareAuditProofCache=new SpareAuditProofCache();
