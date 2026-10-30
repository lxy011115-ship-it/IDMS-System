/** Close once even when work or cleanup throws; retain every failure in occurrence order. */
export async function withRestoreClientR5(client,body,{cleanup=async()=>{},afterClose=async()=>{}}={}){
 const errors=[];let value,clean=false,closed=false;
 try{value=await body();}catch(e){errors.push(e);}
 finally{
  try{await cleanup();clean=true;}catch(e){errors.push(e);}
  finally{try{await client.end();closed=true;}catch(e){errors.push(e);}}
 }
 if(clean&&closed)try{await afterClose();}catch(e){errors.push(e);}
 if(errors.length===1)throw errors[0];
 if(errors.length>1)throw new AggregateError(errors,'RESTORE_R5_MULTIPLE_FAILURES');
 return value;
}
