import type {IncomingMessage,ServerResponse} from 'node:http';
import {FieldMapPlatformV1} from './field-map-platform-v1.ts';
import {withRequestCapacity,readRequestBytes,reserveResponse} from './request-capacity.ts';
import {requestSignal} from './capacity.ts';
import {DomainError} from './service.ts';
const paths=new Set(['/api/v1/field-channel/lease','/api/v1/field-channel/lease/check']);
/** Mount in the unified HTTP server before cookie/session routes. Owns no listener. */
export function createFieldMapHttpHandlerV1(platform:FieldMapPlatformV1){return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
 let url:URL;try{url=new URL(req.url??'','http://idms.invalid');}catch{return false;}if(!paths.has(url.pathname))return false;
 try{await withRequestCapacity(req,res,async()=>{
  if(req.method!=='POST')throw new DomainError(405,'现场机器接口仅支持POST');if(req.url!==url.pathname)throw new DomainError(400,'现场机器接口不接受查询或路径别名');if(req.headers.origin!==undefined||req.headers.cookie!==undefined)throw new DomainError(401,'现场机器接口不接受浏览器会话');if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw new DomainError(415,'现场机器接口需要JSON');
  let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readRequestBytes(req,4096)));}catch(e){if(e instanceof DomainError||typeof(e as any)?.status==='number')throw e;throw new DomainError(400,'请求JSON无效');}
  const result=url.pathname.endsWith('/check')?await platform.checkCurrent(raw,requestSignal()):await platform.issue(raw,requestSignal());const body=JSON.stringify(result);reserveResponse(Buffer.byteLength(body));if(!res.destroyed){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(body);}
 });}catch(e){if(!res.destroyed&&!res.writableEnded){const code=String((e as any)?.code??(e as Error)?.message??''),status=typeof(e as any)?.status==='number'?(e as any).status:/FIELD_(LEASE_REQUEST_INVALID|CHECK_REQUEST_INVALID|MAP_REQUEST_AUTH|MAP_REQUEST_IDENTITY)/.test(code)?401:/FIELD_.*(CONFLICT|STALE|EXPIRED|APPROVAL)/.test(code)?409:503;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({error:status===401?'现场请求认证失败':status===409?'现场注册或准入条件已变化':'现场接口暂不可用'}));}}return true;
};}
