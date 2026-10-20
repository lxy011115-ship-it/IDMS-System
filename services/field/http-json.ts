import {request as httpRequest,type ClientRequest,type IncomingMessage} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {fieldFailure,FieldChannelError} from './error.ts';
export class FieldJsonTransport {
 #active:Promise<unknown>|null=null;#cancel:((code:string)=>void)|null=null;#closed=false;
 state(){return Object.freeze({active:!!this.#active,closed:this.#closed});}
 cancel(){this.#cancel?.('FIELD_LEASE_HTTP_CANCELLED');}
 async post(url:URL,value:unknown,timeoutMs:number,signal?:AbortSignal):Promise<unknown>{
  if(this.#closed)fieldFailure('FIELD_LEASE_HTTP_CLOSED');if(this.#active)fieldFailure('FIELD_LEASE_HTTP_BUSY');if(signal?.aborted)fieldFailure('FIELD_LEASE_HTTP_CANCELLED');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<250||timeoutMs>10000||!['http:','https:'].includes(url.protocol))fieldFailure('FIELD_LEASE_HTTP_INVALID');let bytes:Buffer;try{bytes=Buffer.from(JSON.stringify(value));}catch{fieldFailure('FIELD_LEASE_HTTP_INVALID');}if(bytes.length>4096)fieldFailure('FIELD_LEASE_HTTP_INVALID');
  const work=this.#perform(url,bytes,timeoutMs,signal);this.#active=work;try{return await work;}finally{if(this.#active===work)this.#active=null;}
 }
 #perform(url:URL,bytes:Buffer,timeoutMs:number,signal?:AbortSignal){
  return new Promise<unknown>((resolve,reject)=>{let req:ClientRequest|undefined,res:IncomingMessage|undefined,failure:FieldChannelError|null=null,result:unknown,ended=false,total=0,chunks:Buffer[]=[];let timer:ReturnType<typeof setTimeout>|undefined;
   const fail=(code:string)=>{failure??=new FieldChannelError(code);chunks=[];res?.destroy();req?.destroy();},abort=()=>fail('FIELD_LEASE_HTTP_CANCELLED');
   const response=(incoming:IncomingMessage)=>{res=incoming;incoming.on('aborted',()=>fail('FIELD_LEASE_HTTP_RESPONSE_INVALID'));incoming.on('error',()=>fail('FIELD_LEASE_HTTP_NETWORK_FAILED'));const declared=incoming.headers['content-length'],type=incoming.headers['content-type'];if(incoming.statusCode!==200){fail('FIELD_LEASE_HTTP_DENIED');return;}if(typeof type!=='string'||type.split(';')[0].trim().toLowerCase()!=='application/json'||declared!==undefined&&(!/^[0-9]+$/.test(declared)||Number(declared)>8192)){fail('FIELD_LEASE_HTTP_RESPONSE_INVALID');return;}
    incoming.on('data',(data:Buffer)=>{total+=data.length;if(total>8192){fail('FIELD_LEASE_HTTP_RESPONSE_LIMIT');return;}chunks.push(Buffer.from(data));});incoming.once('end',()=>{ended=true;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{failure??=new FieldChannelError('FIELD_LEASE_HTTP_RESPONSE_INVALID');}chunks=[];});
   };
   try{const options={method:'POST',headers:{'content-type':'application/json','accept':'application/json','content-length':String(bytes.length)},agent:false as const,maxHeaderSize:8192};req=url.protocol==='https:'?httpsRequest(url,{...options,rejectUnauthorized:true,minVersion:'TLSv1.2'},response):httpRequest(url,options,response);
    this.#cancel=fail;req.on('error',()=>{failure??=new FieldChannelError('FIELD_LEASE_HTTP_NETWORK_FAILED');chunks=[];res?.destroy();});req.once('close',()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(this.#cancel===fail)this.#cancel=null;chunks=[];if(failure)reject(failure);else if(!ended)reject(new FieldChannelError('FIELD_LEASE_HTTP_RESPONSE_INVALID'));else resolve(result);});signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>fail('FIELD_LEASE_HTTP_TIMEOUT'),timeoutMs);timer.unref?.();if(signal?.aborted)abort();else req.end(bytes);
   }catch{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(this.#cancel===fail)this.#cancel=null;req?.destroy();reject(new FieldChannelError('FIELD_LEASE_HTTP_NETWORK_FAILED'));}
  });
 }
 async close(){this.#closed=true;this.#cancel?.('FIELD_LEASE_HTTP_CLOSED');await this.#active?.catch(()=>{});}
}
