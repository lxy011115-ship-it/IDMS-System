import type {IncomingMessage,ServerResponse} from 'node:http';
import {CapacityError,limits,resident,requestResources,requestSignal} from './capacity.ts';
let active=0,closing=false;const tenants=new Map<string,number>();
export function stopHttpAdmission(){closing=true;}
export function httpCapacitySnapshot(){return {active,tenants:tenants.size,closing};}
export async function withRequestCapacity<T>(req:IncomingMessage,res:ServerResponse,task:()=>Promise<T>):Promise<T>{
 if(closing)throw new CapacityError(503,'服务正在排空，请稍后重试','CAPACITY_CLOSING');if(active>=limits.http)throw new CapacityError();active++;
 const controller=new AbortController(),accounts:ReturnType<typeof resident.account>[]=[];let tenant:string|undefined,handlerDone=false,responseDone=res.writableFinished||res.destroyed,released=false,bodyStarted=false,output:ReturnType<typeof resident.account>|undefined,stream=false;
 const cleanup=()=>{if(released||!handlerDone||!responseDone)return;released=true;active--;if(tenant){const n=(tenants.get(tenant)||1)-1;if(n)tenants.set(tenant,n);else tenants.delete(tenant);}for(const account of accounts)account.release();req.off('aborted',aborted);res.off('finish',finished);res.off('close',closed);};
 const aborted=()=>controller.abort();const finished=()=>{responseDone=true;cleanup();};const closed=()=>{responseDone=true;if(!res.writableFinished)controller.abort();cleanup();};req.once('aborted',aborted);res.once('finish',finished);res.once('close',closed);
 const resources={signal:controller.signal,bindTenant(id:string){if(tenant===id)return;if(tenant)throw Error('HTTP tenant binding cannot change');if((tenants.get(id)||0)>=limits.tenantHttp)throw new CapacityError(429,'当前企业请求已满，请稍后重试');tenant=id;tenants.set(id,(tenants.get(id)||0)+1);},reserveBody(file:boolean){if(bodyStarted)throw new CapacityError(400,'请求体不能重复读取','BODY_ALREADY_READ');bodyStarted=true;const account=resident.account('body');try{account.grow(file?limits.fileParseBytes:limits.jsonParseBytes);}catch(e){account.release();throw e;}accounts.push(account);},reserveOutput(bytes:number){if(stream)throw new CapacityError(500,'响应模式不能混用','RESPONSE_MODE');if(!output){output=resident.account('response');accounts.push(output);}if(bytes>output.bytes)output.grow(bytes-output.bytes);},reserveStreamOutput(bytes:number,window:number){if(output||stream||!Number.isSafeInteger(bytes)||bytes<0||bytes>limits.responseBytes||!Number.isSafeInteger(window)||window<1||window>Math.max(1,bytes))throw new CapacityError(503,'导出响应计划无效或超过容量','RESPONSE_PLAN');const account=resident.account('response');try{account.grow(window);}catch(e){account.release();throw e;}output=account;accounts.push(account);stream=true;},prepareResult(value:unknown){if(!res.destroyed&&['POST','PUT','PATCH','DELETE'].includes(req.method||'')&&!req.url?.startsWith('/api/v1/auth/'))resources.reserveOutput(Buffer.byteLength(JSON.stringify(value)));}};
 try{if(req.aborted||res.destroyed)controller.abort();return await requestResources.run(resources,task);}finally{handlerDone=true;cleanup();}
}
export function bindRequestTenant(tenant:string){requestResources.getStore()?.bindTenant(tenant);}
export function reserveResponse(bytes:number){requestResources.getStore()?.reserveOutput(bytes);}
export function reserveStreamResponse(bytes:number,window:number){const resources=requestResources.getStore();if(!resources?.reserveStreamOutput)throw new CapacityError(503,'请求缺少流式响应准入上下文','CAPACITY_CONTEXT');resources.reserveStreamOutput(bytes,window);}
export function reserveCommandResult(value:unknown){requestResources.getStore()?.prepareResult(value);}
export async function readRequestBytes(req:IncomingMessage,max:number):Promise<Buffer>{
 const resources=requestResources.getStore();if(!resources)throw new CapacityError(503,'请求缺少容量准入上下文','CAPACITY_CONTEXT');
 resources.reserveBody(max>1024*1024);const declared=req.headers['content-length'];if(declared!==undefined&&(!/^\d+$/.test(String(declared))||Number(declared)>max)){req.pause();throw new CapacityError(413,'请求体超过大小限制','BODY_TOO_LARGE');}
 if(resources.signal.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');if(req.readableEnded)return Buffer.alloc(0);
 return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[];let bytes=0,done=false;
  const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',error);req.once('error',()=>{});req.off('aborted',abort);resources.signal.removeEventListener('abort',abort);};
  const fail=(e:unknown)=>{if(done)return;done=true;req.pause();cleanup();chunks.length=0;reject(e);};
  const data=(chunk:Buffer|string)=>{const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=value.length;if(bytes>max){fail(new CapacityError(413,'请求体超过大小限制','BODY_TOO_LARGE'));return;}chunks.push(Buffer.from(value));};
  const end=()=>{if(done)return;done=true;cleanup();const result=Buffer.concat(chunks);chunks.length=0;resolve(result);};
  const error=(e:Error)=>fail(e),abort=()=>fail(new CapacityError(499,'请求已取消，尚未开始的任务已撤销','REQUEST_CANCELLED'));
  const timer=setTimeout(()=>fail(new CapacityError(408,'接收请求体超时，任务尚未开始','BODY_TIMEOUT')),limits.bodyTimeoutMs);timer.unref?.();req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',abort);resources.signal.addEventListener('abort',abort,{once:true});if(requestSignal()?.aborted)abort();
 });
}
