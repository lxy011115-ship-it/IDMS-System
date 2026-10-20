import {AsyncResource} from 'node:async_hooks';
import pg from 'pg';
// Bind the submitting resource context, retain at most one extra driver row,
// and drain a validation failure before rejecting the owning read.
export function streamRows<T>(client:pg.PoolClient,text:string,onRow:(row:T)=>void,discard:()=>void,values?:unknown[]):Promise<void>{
 return new Promise((resolve,reject)=>{
  let failure:unknown,stopped=false,discarded=false;const clear=()=>{if(discarded)return;discarded=true;try{discard();}catch{}};
  const query=new pg.Query(text,values,AsyncResource.bind((error:Error|undefined,result?:pg.QueryResult)=>{stopped=true;result?.rows.splice(0);if(error||failure){clear();reject(error||failure);}else resolve();}));
  query.on('row',AsyncResource.bind((row:T,result?:{rows:unknown[]})=>{if(result)result.rows.length=0;if(stopped||failure)return;try{onRow(row);}catch(error){failure=error;clear();}}));
  try{client.query(query);}catch(error){stopped=true;clear();reject(error);}
 });
}
