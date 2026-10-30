import type pg from 'pg';
import {DomainError} from './service.ts';
import {sqlScheduler,memoryTask,requestSignal,CapacityError,accountValue} from './capacity.ts';
import {checkSparesRead} from './spares-audit.ts';
import type {AccessContext} from './access.ts';
import {cancelSpareQuery} from './spares-cancel.ts';
import {beginSpareProofScope,commitSpareProofScope,discardSpareProofScope} from './spares-proof-scope.ts';

export class SpareCommitUnknown extends DomainError {code='SPARES_COMMIT_UNKNOWN';constructor(){super(503,'备件提交结果尚未确认，请使用原请求和幂等键核对');}}
const cancelled=()=>new CapacityError(499,'请求已取消','REQUEST_CANCELLED');
/** Only the borrowed connection can be destroyed. Never cancels another backend
 * or sends privileged SQL. Cancellation after COMMIT starts cannot mean failure. */
function ownership(c:pg.PoolClient){
 let released=false,destroyed=false,committing=false,ended=false,fault=false,deadline=false,cancelRequested=false;let cancelJob:Promise<boolean>|undefined;
 const signal=requestSignal();let finish!:()=>void;const closed=new Promise<void>(resolve=>{finish=resolve;});
 const end=()=>{ended=true;finish();},error=()=>{fault=true;};c.once('end',end);c.on('error',error);
 const destroy=()=>{if(released)return;destroyed=true;released=true;c.release(true);const socket=(c as any).connection?.stream;if(socket&&!socket.destroyed)socket.destroy();};
 const abort=()=>{if(!committing&&!released){cancelRequested=true;cancelJob??=cancelSpareQuery(c);}};signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>{deadline=true;destroy();},30000);timer.unref?.();if(signal?.aborted)abort();
 return {
  get destroyed(){return destroyed;},get timedOut(){return deadline;},
  beginCommit(){checkSparesRead();committing=true;},
  async close(reuse:boolean){
   clearTimeout(timer);signal?.removeEventListener('abort',abort);
   await cancelJob;
   if(!released){if(!reuse||fault||cancelRequested)destroy();else{released=true;c.release();}}
   if(destroyed&&!ended)await closed;c.off('error',error);c.off('end',end);
  }
 };
}
export interface SpareTransactionOptions {write?:boolean;lockPublic?:boolean;verify?:(c:pg.PoolClient)=>Promise<void>}
export async function spareTransaction<T>(pool:pg.Pool,ctx:AccessContext,options:SpareTransactionOptions,run:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
 return sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{
  for(let attempt=0;;attempt++){
   checkSparesRead();let c:pg.PoolClient;try{c=await pool.connect();}catch{checkSparesRead();throw new CapacityError(503,'数据库连接暂不可用，请稍后使用原请求重试','DATABASE_BUSY');}const owned=ownership(c);let committing=false,clean=false,retry=false;
   try{
    checkSparesRead();await c.query(options.write?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL search_path TO pg_catalog,public;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='15s';SET LOCAL idle_in_transaction_session_timeout='20s'");
    beginSpareProofScope(c);
    if(options.lockPublic){if(!options.write)throw new DomainError(503,'原业务共享锁需要写事务');const rows=(await c.query('/* IDMS_SPARES_PUBLIC_LOCK */ SELECT revision::text FROM public.business_state WHERE tenant_id=$1 FOR SHARE',[ctx.tenantId])).rows;if(rows.length!==1)throw new DomainError(503,'当前企业业务状态无法核验');}
    if(options.verify)await options.verify(c);checkSparesRead();const value=await run(c);checkSparesRead();accountValue(value);
    owned.beginCommit();committing=!!options.write;
    const result=await c.query('COMMIT');if(result.command!=='COMMIT')throw new DomainError(503,'事务提交未确认');clean=true;commitSpareProofScope(c);return value;
   }catch(e){
    if(!owned.destroyed){try{clean=(await c.query('ROLLBACK')).command==='ROLLBACK';}catch{clean=false;}}
    if(committing)throw new SpareCommitUnknown();
    if(requestSignal()?.aborted)throw cancelled();
    if(owned.timedOut)throw new DomainError(504,'备件请求处理超时，请稍后重试');
    const code=(e as {code?:string}).code;
    retry=!!options.write&&clean&&!owned.destroyed&&attempt===0&&['40001','40P01'].includes(code||'');
    if(!retry){if(code==='57014')throw new DomainError(504,'备件查询超时，请缩小筛选或稍后重试');if(code==='55P03')throw new DomainError(503,'当前业务正被处理，请稍后使用原请求重试');throw e;}
   }finally{discardSpareProofScope(c);await owned.close(clean);}
   if(!retry)throw new DomainError(503,'备件事务未完成');
  }
 },true),requestSignal());
}
