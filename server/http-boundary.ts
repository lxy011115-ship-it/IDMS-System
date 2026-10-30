import type {ServerResponse} from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DomainError} from './service.ts';

export function beginHttpResponse(res:ServerResponse){
 const requestId=randomUUID();
 res.setHeader('X-Request-Id',requestId);
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','same-origin');
 // Observe existing inline handlers before considering an enforced script policy.
 res.setHeader('Content-Security-Policy-Report-Only',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
 return requestId;
}
export function publicFailure(error:unknown,requestId:string){
 if(error instanceof DomainError)return {status:error.status,body:{error:error.message.slice(0,4096)}};
 return {status:500,body:{error:'服务器暂时无法完成请求，请稍后重试。',code:'INTERNAL_ERROR',requestId}};
}
export function failureDiagnostic(error:unknown,requestId:string){
 const e=error as {name?:unknown;code?:unknown};
 const safe=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_]{1,60}$/.test(v)?v:'unknown';
 return {requestId,errorName:safe(e?.name),errorCode:safe(e?.code)};
}
export async function readPublicAsset(pathname:string,root=process.cwd()){
 let requested:string;try{requested=decodeURIComponent(pathname==='/'?'index.html':pathname.slice(1));}catch{throw new DomainError(400,'非法路径');}
 if(!requested||requested.includes('..')||/[\\\u0000-\u001f\u007f]/.test(requested))throw new DomainError(400,'非法路径');
 const base=resolve(root,requested==='styles.css'?'src':'public'),path=resolve(base,requested);
 if(!path.startsWith(base+sep))throw new DomainError(400,'非法路径');
 try{
  const actual=await realpath(path),actualBase=await realpath(base);
  if(!actual.startsWith(actualBase+sep))throw new DomainError(400,'非法路径');
  const file=await readFile(actual),mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};
  return {file,contentType:mime[extname(requested)]||'application/octet-stream'};
 }catch(error){if(['ENOENT','ENOTDIR','EISDIR'].includes(String((error as NodeJS.ErrnoException).code)))throw new DomainError(404,'页面或资源不存在');throw error;}
}
