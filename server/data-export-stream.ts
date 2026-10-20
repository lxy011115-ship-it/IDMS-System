import type {ServerResponse} from 'node:http';
import type pg from 'pg';
import type {AccessContext} from './access.ts';
import {requireAccess} from './access.ts';
import {assetRowsSql,measurementRowsSql,assetSqlItem,measurementSqlItem,validateExportRow} from './data-management-sql.ts';
import {currentSql} from './revision-projection.ts';
import {assetCsvHeaders,measurementCsvHeaders,assetCsvCells,measurementCsvCells,exportFilters} from './data-export.ts';
import {CsvManifest,csvChunks,csvChunkBytes,CsvExportError,csvIntegrityError,type CsvSummary} from './csv-chunks.ts';
import {FairScheduler,limits,sqlScheduler,memoryTask,requestSignal,holdValue,holdAllocation,CapacityError} from './capacity.ts';
import {reserveStreamResponse} from './request-capacity.ts';
import {DomainError} from './service.ts';
export const csvFetchRows=128;
const exportsQueue=new FairScheduler({active:Math.min(2,limits.sqlActive),tenantActive:1,pending:Math.min(8,limits.sqlPending),tenantPending:Math.min(4,limits.tenantSqlPending),waitMs:limits.waitMs});
export const csvExportQueueSnapshot=()=>exportsQueue.snapshot();
export const closeCsvExports=()=>exportsQueue.close();
function checkpoint(signal:AbortSignal|undefined,deadline:number,phase:'PREPARE'|'SEND'){
 if(signal?.aborted)throw new CapacityError(499,'导出已取消','REQUEST_CANCELLED');if(Date.now()>=deadline)throw new CsvExportError(504,'CSV_EXPORT_'+phase+'_TIMEOUT',phase==='PREPARE'?'导出准备超时，请缩小筛选范围后重试':'导出传输超时，请检查连接后重试');
}
type Selection=ReturnType<typeof assetRowsSql>|ReturnType<typeof measurementRowsSql>;
async function boundSql(client:pg.PoolClient,deadline:number,check:()=>void){check();await client.query("SELECT set_config('statement_timeout',$1,true)",[Math.max(1,deadline-Date.now())+'ms']);check();}
async function* scan(client:pg.PoolClient,ctx:AccessContext,selection:Selection,assets:boolean,phase:'PREFLIGHT'|'DELIVERY',check:()=>void,count:{rows:number},deadline:number):AsyncGenerator<unknown[]>{
 const cursor=phase==='PREFLIGHT'?'idms_csv_preflight':'idms_csv_delivery';let opened=false,failed=false,releaseRows=()=>{};
 try{
  await boundSql(client,deadline,check);await client.query(`/* IDMS_CSV_${phase}_DECLARE */ DECLARE ${cursor} NO SCROLL CURSOR FOR `+currentSql(selection.text),selection.values);opened=true;
  while(true){await boundSql(client,deadline,check);const result=await client.query(`/* IDMS_CSV_${phase}_FETCH */ FETCH FORWARD ${csvFetchRows} FROM ${cursor}`);check();if(result.rows.length>csvFetchRows)throw csvIntegrityError();releaseRows=holdValue(result.rows);
   try{if(!result.rows.length)break;for(const row of result.rows){check();validateExportRow(row,ctx,assets);if(!Number.isSafeInteger(count.rows+1))throw csvIntegrityError();count.rows++;yield assets?assetCsvCells(assetSqlItem(row)):measurementCsvCells(measurementSqlItem(row,ctx.tenantId));}}
   finally{result.rows.length=0;releaseRows();releaseRows=()=>{};}
  }
 }catch(error){failed=true;throw error;}finally{releaseRows();if(opened)try{await client.query(`/* IDMS_CSV_${phase}_CLOSE */ CLOSE ${cursor}`);}catch(error){if(!failed)throw error;}}
}
function write(res:ServerResponse,bytes:Buffer,signal:AbortSignal|undefined,deadline:number):Promise<void>{
 return new Promise((resolve,reject)=>{
  let done=false;const cleanup=()=>{clearTimeout(timer);res.off('error',error);res.off('close',closed);signal?.removeEventListener('abort',closed);};
  const finish=(e?:unknown)=>{if(done)return;done=true;cleanup();e?reject(e):resolve();},error=(e:Error)=>finish(e),closed=()=>finish(new CapacityError(499,'导出连接已结束','REQUEST_CANCELLED'));
  const timer=setTimeout(()=>finish(new CsvExportError(504,'CSV_EXPORT_SEND_TIMEOUT','导出传输停滞或超时，请检查连接后重试')),Math.max(1,Math.min(15000,deadline-Date.now())));timer.unref?.();res.once('error',error);res.once('close',closed);signal?.addEventListener('abort',closed,{once:true});
  try{checkpoint(signal,deadline,'SEND');if(res.destroyed||res.writableEnded){closed();return;}res.write(bytes,e=>finish(e));}catch(e){finish(e);}
 });
}
async function end(res:ServerResponse,signal:AbortSignal|undefined,deadline:number){
 await new Promise<void>((resolve,reject)=>{let done=false;const finish=(error?:unknown)=>{if(done)return;done=true;clearTimeout(timer);res.off('error',failed);res.off('close',closed);signal?.removeEventListener('abort',closed);error?reject(error):resolve();},failed=(error:Error)=>finish(error),closed=()=>finish(new CapacityError(499,'导出连接已结束','REQUEST_CANCELLED'));const timer=setTimeout(()=>finish(new CsvExportError(504,'CSV_EXPORT_SEND_TIMEOUT','导出结束超时')),Math.max(1,Math.min(15000,deadline-Date.now())));timer.unref?.();res.once('error',failed);res.once('close',closed);signal?.addEventListener('abort',closed,{once:true});try{checkpoint(signal,deadline,'SEND');res.end(()=>finish());}catch(e){finish(e);}});
}
export async function streamCsvExport(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,assets:boolean,res:ServerResponse,verify:(client:pg.PoolClient)=>Promise<void>){
 requireAccess(ctx,'read');exportFilters(params);const selection=assets?assetRowsSql(ctx,params):measurementRowsSql(ctx,params),headers=assets?assetCsvHeaders:measurementCsvHeaders,signal=requestSignal();
 try{await exportsQueue.run(ctx.tenantId,async()=>{
  const prepareUntil=Date.now()+limits.exportPrepareMs;let summary:CsvSummary|undefined,sendUntil=0;
  const send=async(bytes:Buffer)=>{checkpoint(signal,sendUntil,'SEND');if(!res.headersSent)res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="idms-${assets?'assets':'measurements'}.csv"`,'content-length':summary!.bytes,'x-export-rows':String(summary!.rows),'x-export-sha256':summary!.sha256,'x-content-type-options':'nosniff','cache-control':'no-store'});await write(res,bytes,signal,sendUntil);};
  // The verified final block transfers to the already reserved HTTP window
  // after the transaction and SQL scheduler slot have both been released.
  const tail=await sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{
   const manifest=new CsvManifest(limits.responseBytes),releaseEncoding=holdAllocation(csvChunkBytes*5);let client:pg.PoolClient|undefined,committed=false,phase:'PREPARE'|'SEND'='PREPARE';
   try{
    client=await pool.connect();
    const preparing=()=>checkpoint(signal,prepareUntil,'PREPARE');preparing();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await boundSql(client,prepareUntil,preparing);await verify(client);preparing();const first={rows:0};for await(const chunk of csvChunks(headers,scan(client,ctx,selection,assets,'PREFLIGHT',preparing,first,prepareUntil),preparing))manifest.add(chunk);summary=manifest.seal(first.rows);
    reserveStreamResponse(summary.bytes,Math.min(csvChunkBytes,summary.bytes));phase='SEND';sendUntil=Date.now()+limits.exportSendMs;const sending=()=>checkpoint(signal,sendUntil,'SEND'),second={rows:0};let pending:Buffer|undefined;
    for await(const chunk of csvChunks(headers,scan(client,ctx,selection,assets,'DELIVERY',sending,second,sendUntil),sending)){sending();manifest.verify(chunk);if(pending)await send(pending);pending=chunk;}
    manifest.finishDelivery(second.rows);if(!pending)throw csvIntegrityError();await boundSql(client,sendUntil,sending);await client.query('COMMIT');committed=true;return Buffer.from(pending);
   }catch(error){checkpoint(signal,phase==='PREPARE'?prepareUntil:sendUntil,phase);if((error as any)?.code==='57014')throw new CsvExportError(504,'CSV_EXPORT_'+phase+'_TIMEOUT','导出查询超时，请缩小筛选范围后重试');throw error;}finally{manifest.dispose();releaseEncoding();if(client){if(!committed)await client.query('ROLLBACK').catch(()=>{});client.release();}}
  },true),signal);
  await send(tail);await end(res,signal,sendUntil);
 },signal);}catch(error){if(res.headersSent||res.destroyed){res.destroy();return;}if(error instanceof DomainError)throw error;throw csvIntegrityError();}
}
